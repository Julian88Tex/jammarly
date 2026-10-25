/**
 * Toasts at the bottom-center of the viewport (inside the shadow host): "Applied N changes — Undo" with an Undo
 * button, 10 s by default, stacking, dismissible, announced politely to screen readers.
 */
import { h, isolatePointerEvents, svgIcon } from './dom';

export const TOAST_DEFAULT_MS = 10_000;

export interface ToastOptions {
  durationMs?: number;
  /** When set, an Undo button is rendered and `onUndo` fires on click. */
  undoLabel?: string;
  onUndo?: () => void;
}

export interface ToastHandle {
  readonly element: HTMLDivElement;
  dismiss(): void;
}

export class ToastStack {
  readonly container: HTMLDivElement;
  private readonly active = new Set<ToastHandle>();

  constructor(parent: HTMLElement) {
    this.container = h('div', { class: 'jm-toasts', 'data-jm': 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-atomic': 'false' });
    parent.appendChild(this.container);
  }

  show(message: string, opts: ToastOptions = {}): ToastHandle {
    const duration = opts.durationMs ?? TOAST_DEFAULT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const element = h('div', { class: 'jm-toast', 'data-jm': 'toast', role: 'status' });
    isolatePointerEvents(element);

    const handle: ToastHandle = {
      element,
      dismiss: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!this.active.has(handle)) return;
        this.active.delete(handle);
        element.remove();
      },
    };

    element.appendChild(h('span', { class: 'jm-toast-msg' }, message));
    if (opts.onUndo) {
      const onUndo = opts.onUndo;
      element.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'jm-toast-undo',
            'data-jm': 'toast-undo',
            onclick: () => {
              handle.dismiss();
              onUndo();
            },
          },
          opts.undoLabel ?? 'Undo',
        ),
      );
    }
    element.appendChild(
      h(
        'button',
        { type: 'button', class: 'jm-iconbtn jm-sm jm-toast-close', 'data-jm': 'toast-close', 'aria-label': 'Dismiss notification', onclick: () => handle.dismiss() },
        svgIcon('close', 13),
      ),
    );

    this.container.appendChild(element);
    this.active.add(handle);
    if (duration > 0 && Number.isFinite(duration)) {
      timer = setTimeout(() => handle.dismiss(), duration);
    }
    return handle;
  }

  count(): number {
    return this.active.size;
  }

  dismissAll(): void {
    for (const t of Array.from(this.active)) t.dismiss();
  }

  dispose(): void {
    this.dismissAll();
    this.container.remove();
  }
}
