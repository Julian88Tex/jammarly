/**
 * Small widgets shared by the pages: buttons, switches, segmented controls, inline confirms, toasts, form rows.
 * Pure DOM, no HTML strings.
 */
import { h, uid, type Child } from './dom';
import { icon, type IconName } from './icons';

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

export interface ButtonOptions {
  kind?: ButtonKind;
  size?: 'sm' | 'md';
  icon?: IconName;
  label: string;
  /** Visually hidden label (icon-only buttons). */
  iconOnly?: boolean;
  onClick?: (ev: MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  class?: string;
  focusKey?: string;
  type?: 'button' | 'submit';
  ariaExpanded?: boolean;
  ariaHaspopup?: 'menu' | 'dialog' | 'true';
}

export function button(opts: ButtonOptions): HTMLButtonElement {
  const btn = h(
    'button',
    {
      type: opts.type ?? 'button',
      class: ['jm-btn', `jm-btn-${opts.kind ?? 'secondary'}`, opts.size === 'sm' ? 'jm-btn-sm' : null, opts.iconOnly ? 'jm-btn-icon' : null, opts.class],
      disabled: opts.disabled === true,
      title: opts.title,
      'aria-label': opts.iconOnly ? opts.label : undefined,
      'aria-expanded': opts.ariaExpanded === undefined ? undefined : String(opts.ariaExpanded),
      'aria-haspopup': opts.ariaHaspopup,
      dataset: opts.focusKey ? { focusKey: opts.focusKey } : undefined,
    },
    opts.icon ? icon(opts.icon) : null,
    opts.iconOnly ? null : h('span', { class: 'jm-btn-label' }, opts.label),
  );
  if (opts.onClick) btn.addEventListener('click', (ev) => opts.onClick?.(ev as MouseEvent));
  return btn;
}

export interface SwitchOptions {
  checked: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  focusKey?: string;
  /** Render the label visually (default) or only for assistive tech. */
  hideLabel?: boolean;
}

/** An accessible toggle: `role="switch"` button with the label beside it. */
export function switchControl(opts: SwitchOptions): HTMLElement {
  const id = uid('switch');
  const btn = h('button', {
    type: 'button',
    role: 'switch',
    id,
    class: ['jm-switch', opts.checked ? 'is-on' : null],
    'aria-checked': String(opts.checked),
    'aria-label': opts.hideLabel ? opts.label : undefined,
    disabled: opts.disabled === true,
    dataset: opts.focusKey ? { focusKey: opts.focusKey } : undefined,
    onclick: () => opts.onChange(!opts.checked),
  });
  btn.appendChild(h('span', { class: 'jm-switch-knob' }));
  const row = h('div', { class: 'jm-switch-row' });
  if (!opts.hideLabel) {
    row.appendChild(h('label', { class: 'jm-switch-label', for: id }, h('span', { class: 'jm-switch-title' }, opts.label), opts.description ? h('span', { class: 'jm-switch-desc' }, opts.description) : null));
  }
  row.appendChild(btn);
  return row;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export interface SegmentedOptions<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  focusKeyPrefix?: string;
  disabled?: boolean;
}

/** Radiogroup rendered as a row of buttons; arrow keys move between options. */
export function segmented<T extends string>(opts: SegmentedOptions<T>): HTMLElement {
  const group = h('div', { class: 'jm-segmented', role: 'radiogroup', 'aria-label': opts.ariaLabel });
  const buttons: HTMLButtonElement[] = [];
  opts.options.forEach((option, index) => {
    const selected = option.value === opts.value;
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'radio',
        class: ['jm-segment', selected ? 'is-selected' : null],
        'aria-checked': String(selected),
        tabindex: selected ? '0' : '-1',
        title: option.description,
        disabled: opts.disabled === true,
        dataset: opts.focusKeyPrefix ? { focusKey: `${opts.focusKeyPrefix}:${option.value}` } : undefined,
        onclick: () => opts.onChange(option.value),
        onkeydown: (ev: Event) => {
          const key = (ev as KeyboardEvent).key;
          let next = -1;
          if (key === 'ArrowRight' || key === 'ArrowDown') next = (index + 1) % opts.options.length;
          if (key === 'ArrowLeft' || key === 'ArrowUp') next = (index - 1 + opts.options.length) % opts.options.length;
          if (next < 0) return;
          ev.preventDefault();
          const target = opts.options[next];
          if (target) opts.onChange(target.value);
          buttons[next]?.focus();
        },
      },
      option.label,
    );
    buttons.push(btn);
    group.appendChild(btn);
  });
  return group;
}

export interface ConfirmOptions {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Inline confirmation strip (no window.confirm: it is untestable and blocks the page). */
export function inlineConfirm(opts: ConfirmOptions): HTMLElement {
  return h(
    'div',
    { class: 'jm-confirm', role: 'alertdialog', 'aria-label': opts.message },
    h('span', { class: 'jm-confirm-text' }, opts.message),
    button({ kind: opts.danger ? 'danger' : 'primary', size: 'sm', label: opts.confirmLabel, onClick: opts.onConfirm, focusKey: 'confirm:yes' }),
    button({ kind: 'ghost', size: 'sm', label: opts.cancelLabel ?? 'Cancel', onClick: opts.onCancel }),
  );
}

export interface ToastHandle {
  show(message: string, opts?: { actionLabel?: string; onAction?: () => void; durationMs?: number; tone?: 'info' | 'success' | 'error' }): void;
  clear(): void;
  readonly element: HTMLElement;
}

/** A toast region (aria-live polite). One toast at a time; a new one replaces the previous. */
export function createToastHost(): ToastHandle {
  const element = h('div', { class: 'jm-toasts', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (element.firstChild) element.removeChild(element.firstChild);
  };
  return {
    element,
    clear,
    show(message, opts = {}) {
      clear();
      const toast = h('div', { class: ['jm-toast', `jm-toast-${opts.tone ?? 'info'}`], role: 'status' }, h('span', { class: 'jm-toast-text' }, message));
      if (opts.actionLabel && opts.onAction) {
        toast.appendChild(
          button({
            kind: 'link',
            size: 'sm',
            label: opts.actionLabel,
            onClick: () => {
              opts.onAction?.();
              clear();
            },
          }),
        );
      }
      element.appendChild(toast);
      timer = setTimeout(clear, opts.durationMs ?? 4000);
    },
  };
}

export interface FieldRowOptions {
  label: string;
  hint?: Child;
  error?: string | null;
  control: HTMLElement;
  /** Associate the label with this control id (set it on the control). */
  controlId?: string;
  inline?: boolean;
}

/** Settings row: label on the left, control on the right, hint and validation error below. */
export function fieldRow(opts: FieldRowOptions): HTMLElement {
  const id = opts.controlId ?? uid('ctl');
  if (!opts.control.id && (opts.control instanceof HTMLInputElement || opts.control instanceof HTMLSelectElement || opts.control instanceof HTMLTextAreaElement)) {
    opts.control.id = id;
  }
  const labelEl = h('label', { class: 'jm-field-label', for: opts.control.id || undefined }, opts.label);
  const errorEl = opts.error ? h('div', { class: 'jm-field-error', role: 'alert' }, opts.error) : null;
  if (errorEl && opts.control.id) opts.control.setAttribute('aria-invalid', 'true');
  return h(
    'div',
    { class: ['jm-field', opts.inline ? 'jm-field-inline' : null, opts.error ? 'has-error' : null] },
    h('div', { class: 'jm-field-head' }, labelEl, opts.hint ? h('div', { class: 'jm-field-hint' }, opts.hint) : null),
    h('div', { class: 'jm-field-control' }, opts.control, errorEl),
  );
}

/** A category dot colored through the theme token. */
export function categoryDot(category: string, label?: string): HTMLElement {
  return h('span', { class: ['jm-dot', `jm-dot-${category}`], role: label ? 'img' : undefined, 'aria-label': label, 'aria-hidden': label ? undefined : 'true' });
}

/** Small pill chip. */
export function chip(label: string, cls?: string): HTMLElement {
  return h('span', { class: ['jm-chip', cls] }, label);
}

/** A `<select>` with options and a change handler. */
export function select<T extends string>(opts: { options: { value: T; label: string }[]; value: T | string; onChange: (value: T) => void; ariaLabel?: string; disabled?: boolean; focusKey?: string; id?: string }): HTMLSelectElement {
  const el = h('select', { class: 'jm-select', 'aria-label': opts.ariaLabel, disabled: opts.disabled === true, id: opts.id, dataset: opts.focusKey ? { focusKey: opts.focusKey } : undefined });
  for (const option of opts.options) {
    el.appendChild(h('option', { value: option.value, selected: option.value === opts.value }, option.label));
  }
  el.value = String(opts.value);
  el.addEventListener('change', () => opts.onChange(el.value as T));
  return el;
}

/** Empty-state block with an icon, title and body. */
export function emptyState(opts: { icon: IconName; title: string; body?: string; action?: HTMLElement }): HTMLElement {
  return h('div', { class: 'jm-empty' }, h('div', { class: 'jm-empty-icon' }, icon(opts.icon, { size: 22 })), h('div', { class: 'jm-empty-title' }, opts.title), opts.body ? h('p', { class: 'jm-empty-body' }, opts.body) : null, opts.action ?? null);
}

/** Visually hidden text for screen readers. */
export function srOnly(text: string): HTMLElement {
  return h('span', { class: 'jm-sr-only' }, text);
}
