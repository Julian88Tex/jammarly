/**
 * Theme tokens for the pages. The stylesheets ship the same defaults (see theme.css), and this module re-applies
 * the category / interactive / brand colors from the overlay's constants at runtime so the pages and the in-page
 * overlay can never drift apart. Colorblind mode swaps in the Wong palette the overlay uses.
 */
import type { SuggestionCategory } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import {
  BRAND_COLOR,
  CATEGORY_COLORS,
  CATEGORY_COLORS_COLORBLIND,
  CATEGORY_COLORS_DARK,
  CATEGORY_LABELS,
  INTERACTIVE_COLOR,
  INTERACTIVE_COLOR_DARK,
} from '../../content/ui/overlay-api';

export { CATEGORY_LABELS, CATEGORY_COLORS, CATEGORY_COLORS_DARK, BRAND_COLOR, INTERACTIVE_COLOR };

export interface ThemeOptions {
  colorblind?: boolean;
  /** Force a scheme; defaults to prefers-color-scheme. */
  dark?: boolean;
}

export function prefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function categoryVar(category: SuggestionCategory): string {
  return `--jm-${category}`;
}

/** Writes the color tokens onto `root` (normally document.documentElement). */
export function applyTheme(root: HTMLElement, opts: ThemeOptions = {}): void {
  const dark = opts.dark ?? prefersDark();
  const palette = opts.colorblind ? CATEGORY_COLORS_COLORBLIND : dark ? CATEGORY_COLORS_DARK : CATEGORY_COLORS;
  for (const category of CATEGORIES) {
    root.style.setProperty(categoryVar(category), palette[category]);
  }
  root.style.setProperty('--jm-interactive', dark ? INTERACTIVE_COLOR_DARK : INTERACTIVE_COLOR);
  root.style.setProperty('--jm-brand', BRAND_COLOR);
  root.dataset.theme = dark ? 'dark' : 'light';
  if (opts.colorblind) root.dataset.colorblind = 'true';
  else delete root.dataset.colorblind;
}

/** Applies the theme now and again whenever the OS scheme flips. Returns a disposer. */
export function watchTheme(root: HTMLElement, getOptions: () => ThemeOptions): () => void {
  applyTheme(root, getOptions());
  let mq: MediaQueryList | null = null;
  const onChange = (): void => applyTheme(root, getOptions());
  try {
    if (typeof matchMedia === 'function') {
      mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener?.('change', onChange);
    }
  } catch {
    mq = null;
  }
  return () => {
    mq?.removeEventListener?.('change', onChange);
  };
}
