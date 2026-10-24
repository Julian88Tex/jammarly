/**
 * Overlay stylesheet, as a string for `adoptedStyleSheets` with an inline <style> fallback.
 *
 * Rules of the road (docs/ARCHITECTURE.md §3.5, research 01 §8 and reviewer #16):
 * - Every token lives on `:host`, never on `:root` (Grammarly's `--rem` on :root broke sites).
 * - No `@font-face` inside the shadow root (Chromium ignores it): system font stack.
 * - `:host { all: initial }` so page typography never leaks in; `color-scheme: light dark` and dark tokens under
 *   `prefers-color-scheme: dark`; a Wong palette plus per-category dash patterns in colorblind mode; borders under
 *   `forced-colors: active` (Windows High Contrast strips backgrounds, which would erase 2 px underline divs).
 */
import {
  BRAND_COLOR,
  CATEGORY_COLORS,
  CATEGORY_COLORS_COLORBLIND,
  CATEGORY_COLORS_DARK,
  INTERACTIVE_COLOR,
  INTERACTIVE_COLOR_DARK,
} from './overlay-api';

export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

export const HOST_Z_INDEX = 2147483646;

export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  pointer-events: none !important;
  z-index: ${HOST_Z_INDEX} !important;
  display: block;
  overflow: visible;
  color-scheme: light dark;
  direction: ltr;
  font-family: ${FONT_STACK};
  font-size: 14px;
  line-height: 1.4;
  color: var(--jm-text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;

  --jm-correctness: ${CATEGORY_COLORS.correctness};
  --jm-clarity: ${CATEGORY_COLORS.clarity};
  --jm-engagement: ${CATEGORY_COLORS.engagement};
  --jm-delivery: ${CATEGORY_COLORS.delivery};
  --jm-brand: ${BRAND_COLOR};
  --jm-accent: ${INTERACTIVE_COLOR};
  --jm-surface: #FFFFFF;
  --jm-surface-2: #F3F4F6;
  --jm-surface-3: #E9EAEE;
  --jm-text: #0E101A;
  --jm-text-muted: #545454;
  --jm-border: #E3E5EA;
  --jm-gray: #8A8F98;
  --jm-on-accent: #FFFFFF;
  --jm-toast-bg: #1F2128;
  --jm-toast-text: #F5F6F8;
  --jm-shadow: 0 4px 16px rgba(0, 0, 0, .18);
  --jm-radius-card: 8px;
  --jm-radius-btn: 4px;
  --jm-fs-sm: 12px;
  --jm-fs-md: 14px;
  --jm-fs-lg: 16px;
  --jm-tint: 18%;
}

@media (prefers-color-scheme: dark) {
  :host {
    --jm-correctness: ${CATEGORY_COLORS_DARK.correctness};
    --jm-clarity: ${CATEGORY_COLORS_DARK.clarity};
    --jm-engagement: ${CATEGORY_COLORS_DARK.engagement};
    --jm-delivery: ${CATEGORY_COLORS_DARK.delivery};
    --jm-accent: ${INTERACTIVE_COLOR_DARK};
    --jm-surface: #1F2128;
    --jm-surface-2: #2A2D36;
    --jm-surface-3: #353946;
    --jm-text: #F3F4F6;
    --jm-text-muted: #A4A9B2;
    --jm-border: #3A3D47;
    --jm-gray: #6B7280;
    --jm-on-accent: #0E101A;
    --jm-toast-bg: #F3F4F6;
    --jm-toast-text: #0E101A;
    --jm-shadow: 0 4px 16px rgba(0, 0, 0, .5);
  }
}

:host(.jm-colorblind) {
  --jm-correctness: ${CATEGORY_COLORS_COLORBLIND.correctness};
  --jm-clarity: ${CATEGORY_COLORS_COLORBLIND.clarity};
  --jm-engagement: ${CATEGORY_COLORS_COLORBLIND.engagement};
  --jm-delivery: ${CATEGORY_COLORS_COLORBLIND.delivery};
}

*, *::before, *::after { box-sizing: border-box; }

button {
  font: inherit;
  color: inherit;
  margin: 0;
}

.jm-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}

/* ---------------------------------------------------------------- underlines */

.jm-ul-field { position: fixed; left: 0; top: 0; pointer-events: none; }

.jm-ul {
  position: fixed;
  height: 2px;
  border-radius: 1px;
  background: var(--jm-ul-c, var(--jm-gray));
  pointer-events: none;
  transition: height 80ms ease-out, opacity 120ms ease-out;
}
.jm-ul[data-category="correctness"] { --jm-ul-c: var(--jm-correctness); }
.jm-ul[data-category="clarity"] { --jm-ul-c: var(--jm-clarity); }
.jm-ul[data-category="engagement"] { --jm-ul-c: var(--jm-engagement); }
.jm-ul[data-category="delivery"] { --jm-ul-c: var(--jm-delivery); }
.jm-ul.jm-ul-active { height: 3px; }
.jm-ul.jm-ul-pending { opacity: .35; }
.jm-ul[hidden], .jm-ul-tint[hidden] { display: none; }

.jm-ul-tint {
  position: fixed;
  pointer-events: none;
  border-radius: 2px;
  background: color-mix(in srgb, var(--jm-ul-c, var(--jm-gray)) var(--jm-tint), transparent);
}
.jm-ul-tint[data-category="correctness"] { --jm-ul-c: var(--jm-correctness); }
.jm-ul-tint[data-category="clarity"] { --jm-ul-c: var(--jm-clarity); }
.jm-ul-tint[data-category="engagement"] { --jm-ul-c: var(--jm-engagement); }
.jm-ul-tint[data-category="delivery"] { --jm-ul-c: var(--jm-delivery); }

/* colorblind mode: per-category pattern (solid / dashed / dotted / double) */
:host(.jm-colorblind) .jm-ul[data-pattern="dashed"] {
  background: repeating-linear-gradient(90deg, var(--jm-ul-c) 0 6px, transparent 6px 9px);
}
:host(.jm-colorblind) .jm-ul[data-pattern="dotted"] {
  background: repeating-linear-gradient(90deg, var(--jm-ul-c) 0 2px, transparent 2px 4px);
}
:host(.jm-colorblind) .jm-ul[data-pattern="double"] {
  height: 3px;
  background: linear-gradient(var(--jm-ul-c) 0 1px, transparent 1px 2px, var(--jm-ul-c) 2px 3px);
}
:host(.jm-colorblind) .jm-ul.jm-ul-active[data-pattern="double"] { height: 4px; }

/* ---------------------------------------------------------------- card */

.jm-card {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 12px 14px 10px;
  min-width: 280px;
  max-width: 360px;
  width: max-content;
  background: var(--jm-surface);
  color: var(--jm-text);
  border: 1px solid var(--jm-border);
  border-radius: var(--jm-radius-card);
  box-shadow: var(--jm-shadow);
  pointer-events: auto;
  font-size: var(--jm-fs-md);
  line-height: 1.45;
  overflow: visible;
  outline: none;
  animation: jm-in 120ms ease-out;
}
.jm-card[hidden] { display: none; }
.jm-card:focus-visible { box-shadow: var(--jm-shadow), 0 0 0 2px var(--jm-accent); }

.jm-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  font-size: var(--jm-fs-sm);
  color: var(--jm-text-muted);
}
.jm-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--jm-gray);
  flex: none;
}
.jm-dot[data-category="correctness"] { background: var(--jm-correctness); }
.jm-dot[data-category="clarity"] { background: var(--jm-clarity); }
.jm-dot[data-category="engagement"] { background: var(--jm-engagement); }
.jm-dot[data-category="delivery"] { background: var(--jm-delivery); }
.jm-cat { flex: 1 1 auto; }
.jm-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--jm-surface-2);
  color: var(--jm-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .01em;
  white-space: nowrap;
}
.jm-chip[data-tier="A"] { background: color-mix(in srgb, var(--jm-engagement) 15%, transparent); color: var(--jm-engagement); }
.jm-chip[data-tier="C"] { background: color-mix(in srgb, var(--jm-clarity) 15%, transparent); color: var(--jm-clarity); }
.jm-chip[data-stale="true"] { background: color-mix(in srgb, var(--jm-gray) 20%, transparent); color: var(--jm-text-muted); }

.jm-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: transparent;
  color: var(--jm-text-muted);
  cursor: pointer;
}
.jm-iconbtn:hover, .jm-iconbtn:focus-visible { background: var(--jm-surface-2); color: var(--jm-text); outline: none; }
.jm-iconbtn:focus-visible { box-shadow: 0 0 0 2px var(--jm-accent); }
.jm-iconbtn.jm-sm { width: 24px; height: 24px; }
.jm-card-close { margin: -4px -6px -4px 0; }

.jm-title {
  margin: 6px 0 4px;
  font-size: var(--jm-fs-md);
  font-weight: 600;
  line-height: 1.35;
  color: var(--jm-text);
}

.jm-content {
  margin: 4px 0 6px;
  font-size: var(--jm-fs-lg);
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.jm-content[data-kind="rewrite"] .jm-original, .jm-content[data-kind="rewrite"] .jm-replacement { display: block; }
.jm-content[data-kind="rewrite"] .jm-original { margin-bottom: 4px; }
.jm-original {
  color: var(--jm-correctness);
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
}
.jm-content[data-kind="flag"] .jm-original { color: var(--jm-text); text-decoration: none; font-style: italic; }
.jm-arrow { color: var(--jm-text-muted); margin: 0 4px; font-size: var(--jm-fs-md); }
.jm-replacement {
  display: inline;
  padding: 0 2px;
  margin: 0 -2px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--jm-accent);
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}
.jm-replacement:hover, .jm-replacement:focus-visible { background: color-mix(in srgb, var(--jm-accent) 12%, transparent); outline: none; }
.jm-replacement:focus-visible { box-shadow: 0 0 0 2px var(--jm-accent); }

/* sentence card: the whole sentence inline, one button that accepts every change */
.jm-card[data-mode="sentence"] { max-width: 420px; }
.jm-sentence-head { position: absolute; top: 16px; right: 20px; min-height: 0; z-index: 1; }
.jm-sentence {
  display: block;
  width: 100%;
  margin: 0 0 8px;
  padding: 10px 36px 12px 12px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: color-mix(in srgb, var(--jm-accent) 9%, var(--jm-surface));
  color: var(--jm-text);
  font: inherit;
  font-size: var(--jm-fs-lg);
  line-height: 1.5;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.jm-sentence:hover, .jm-sentence:focus-visible { background: color-mix(in srgb, var(--jm-accent) 16%, var(--jm-surface)); outline: none; }
.jm-sentence:focus-visible { box-shadow: 0 0 0 2px var(--jm-accent); }
.jm-sentence-label { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: var(--jm-fs-sm); color: var(--jm-text-muted); }
.jm-sentence-title { margin: 0; font-size: var(--jm-fs-sm); font-weight: 500; color: var(--jm-text-muted); }
.jm-sentence-text { display: block; }
.jm-sentence .jm-original { margin-right: 4px; font-weight: 700; text-decoration-thickness: 2px; }
.jm-sentence-new { color: var(--jm-accent); font-weight: 700; }

.jm-options {
  margin: 2px 0 6px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.jm-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: transparent;
  color: var(--jm-text);
  text-align: left;
  cursor: pointer;
  font-size: var(--jm-fs-md);
}
.jm-option:hover, .jm-option:focus-visible { background: var(--jm-surface-2); outline: none; }
.jm-option[aria-current="true"] { font-weight: 600; }
.jm-option-key {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--jm-surface-3);
  color: var(--jm-text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.jm-explanation {
  margin: 0 0 8px;
  font-size: var(--jm-fs-md);
  color: var(--jm-text-muted);
}
.jm-learn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--jm-accent);
  font-size: var(--jm-fs-sm);
  font-weight: 600;
  cursor: pointer;
}
.jm-learn:hover, .jm-learn:focus-visible { text-decoration: underline; outline: none; }

.jm-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.jm-primary {
  padding: 6px 14px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: var(--jm-accent);
  color: var(--jm-on-accent);
  font-size: var(--jm-fs-md);
  font-weight: 600;
  cursor: pointer;
}
.jm-primary:hover { filter: brightness(1.08); }
.jm-primary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--jm-surface), 0 0 0 4px var(--jm-accent); }
.jm-textbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: transparent;
  color: var(--jm-text-muted);
  font-size: var(--jm-fs-sm);
  cursor: pointer;
  white-space: nowrap;
}
.jm-textbtn:hover, .jm-textbtn:focus-visible { background: var(--jm-surface-2); color: var(--jm-text); outline: none; }
.jm-spacer { flex: 1 1 auto; }
.jm-kbd {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 15%, transparent);
  font-size: 10px;
  font-weight: 600;
}

.jm-more-panel {
  margin-top: 8px;
  padding: 8px 0 0;
  border-top: 1px solid var(--jm-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.jm-more-panel[hidden] { display: none; }
.jm-mi {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: transparent;
  color: var(--jm-text);
  font-size: var(--jm-fs-md);
  text-align: left;
  cursor: pointer;
}
.jm-mi:hover, .jm-mi:focus-visible { background: var(--jm-surface-2); outline: none; }
.jm-mi[disabled] { opacity: .5; cursor: default; }
.jm-mi[disabled]:hover { background: transparent; }
.jm-mi-sub { color: var(--jm-text-muted); font-size: var(--jm-fs-sm); margin-left: auto; }
.jm-mi-sep { height: 1px; margin: 4px 0; background: var(--jm-border); }
.jm-reasons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 8px 0; }
.jm-reasons-label { font-size: var(--jm-fs-sm); color: var(--jm-text-muted); }
.jm-reason {
  padding: 3px 10px;
  border: 1px solid var(--jm-border);
  border-radius: 999px;
  background: transparent;
  color: var(--jm-text);
  font-size: var(--jm-fs-sm);
  cursor: pointer;
}
.jm-reason:hover, .jm-reason:focus-visible { background: var(--jm-surface-2); border-color: var(--jm-gray); outline: none; }

.jm-footer {
  margin: 10px -14px -10px;
  padding: 7px 14px;
  border-top: 1px solid var(--jm-border);
  border-radius: 0 0 var(--jm-radius-card) var(--jm-radius-card);
  background: var(--jm-surface-2);
  color: var(--jm-text-muted);
  font-size: var(--jm-fs-sm);
}

/* ---------------------------------------------------------------- floating button */

.jm-btn-wrap {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px;
  pointer-events: none;
  transform: translateX(-100%);
}
.jm-btn-wrap[hidden] { display: none; }
.jm-btn-wrap.jm-hover { pointer-events: auto; }

.jm-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--jm-brand);
  color: #FFFFFF;
  font-size: var(--jm-fs-sm);
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .22);
  transition: width 150ms ease, height 150ms ease, background-color 150ms ease;
}
.jm-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--jm-surface), 0 0 0 4px var(--jm-accent); }
.jm-btn[data-state="count"] { background: var(--jm-correctness); }
.jm-btn[data-state="setup"], .jm-btn[data-state="off"], .jm-btn[data-state="error"], .jm-btn[data-state="unsupported"] { background: var(--jm-gray); }
.jm-btn[data-state="collapsed"] { width: 6px; height: 6px; box-shadow: none; }
.jm-btn[data-state="collapsed"] > * { display: none; }
.jm-btn .jm-icon-spinner { animation: jm-spin 900ms linear infinite; }
.jm-btn .jm-count { font-size: 11px; font-weight: 700; }
.jm-btn .jm-count.jm-count-wide { font-size: 9px; letter-spacing: -.02em; }
.jm-btn .jm-icon-dot { stroke-width: 5; }

.jm-power {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--jm-surface);
  color: var(--jm-text-muted);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.jm-btn-wrap.jm-hover .jm-power, .jm-btn-wrap:focus-within .jm-power, .jm-power[aria-expanded="true"] { opacity: 1; pointer-events: auto; }
.jm-power:hover, .jm-power:focus-visible { color: var(--jm-correctness); outline: none; }

.jm-tone {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: 999px;
  background: var(--jm-surface);
  color: var(--jm-text);
  font-size: var(--jm-fs-sm);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
  pointer-events: auto;
  white-space: nowrap;
}
.jm-tone[hidden] { display: none; }
.jm-tone-emoji { font-size: 13px; line-height: 1; }

.jm-power-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  min-width: 220px;
  padding: 6px;
  background: var(--jm-surface);
  border: 1px solid var(--jm-border);
  border-radius: var(--jm-radius-card);
  box-shadow: var(--jm-shadow);
  pointer-events: auto;
  animation: jm-in 120ms ease-out;
}
.jm-power-menu[hidden] { display: none; }

/* ---------------------------------------------------------------- menu */

.jm-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  min-width: 260px;
  max-width: 320px;
  padding: 6px;
  background: var(--jm-surface);
  color: var(--jm-text);
  border: 1px solid var(--jm-border);
  border-radius: var(--jm-radius-card);
  box-shadow: var(--jm-shadow);
  pointer-events: auto;
  font-size: var(--jm-fs-md);
  outline: none;
  overflow: visible;
  animation: jm-in 120ms ease-out;
}
.jm-menu[hidden] { display: none; }
.jm-menu-head {
  padding: 4px 8px 6px;
  font-size: var(--jm-fs-sm);
  color: var(--jm-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.jm-menu-head .jm-brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--jm-brand); }

.jm-preview {
  position: absolute;
  top: 0;
  right: calc(100% + 6px);
  width: 280px;
  max-width: 40vw;
  padding: 8px;
  background: var(--jm-surface);
  border: 1px solid var(--jm-border);
  border-radius: var(--jm-radius-card);
  box-shadow: var(--jm-shadow);
  font-size: var(--jm-fs-sm);
  color: var(--jm-text);
}
.jm-preview[hidden] { display: none; }
.jm-preview[data-side="right"] { right: auto; left: calc(100% + 6px); }
.jm-preview-title { margin: 0 0 6px; padding: 0 4px; font-weight: 600; color: var(--jm-text-muted); }
.jm-preview-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  overflow: hidden;
  white-space: nowrap;
}
.jm-preview-row .jm-original, .jm-preview-row .jm-new { overflow: hidden; text-overflow: ellipsis; }
.jm-preview-row .jm-new { font-weight: 600; color: var(--jm-accent); }
.jm-preview-more { padding: 3px 4px; color: var(--jm-text-muted); }

/* ---------------------------------------------------------------- toast */

.jm-toasts {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  max-width: calc(100vw - 32px);
}
.jm-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  background: var(--jm-toast-bg);
  color: var(--jm-toast-text);
  border-radius: var(--jm-radius-card);
  box-shadow: var(--jm-shadow);
  font-size: var(--jm-fs-md);
  pointer-events: auto;
  animation: jm-in 120ms ease-out;
}
.jm-toast-msg { flex: 1 1 auto; }
.jm-toast-undo {
  padding: 4px 10px;
  border: 0;
  border-radius: var(--jm-radius-btn);
  background: color-mix(in srgb, var(--jm-toast-text) 12%, transparent);
  color: ${INTERACTIVE_COLOR_DARK};
  font-weight: 600;
  cursor: pointer;
}
@media (prefers-color-scheme: dark) { .jm-toast-undo { color: ${INTERACTIVE_COLOR}; } }
.jm-toast-undo:hover, .jm-toast-undo:focus-visible { background: color-mix(in srgb, var(--jm-toast-text) 22%, transparent); outline: none; }
.jm-toast-close { color: inherit; opacity: .75; }
.jm-toast-close:hover { opacity: 1; background: color-mix(in srgb, var(--jm-toast-text) 12%, transparent); color: inherit; }

/* ---------------------------------------------------------------- motion & a11y */

@keyframes jm-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes jm-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .jm-card, .jm-menu, .jm-toast, .jm-power-menu { animation: none; }
  .jm-btn, .jm-ul, .jm-power { transition: none; }
  .jm-btn .jm-icon-spinner { animation-duration: 2s; }
}

@media (forced-colors: active) {
  .jm-ul {
    height: 0 !important;
    background: none !important;
    border-bottom: 2px solid LinkText;
    forced-color-adjust: none;
  }
  .jm-ul.jm-ul-active { border-bottom-width: 3px; }
  .jm-ul-tint { display: none; }
  .jm-card, .jm-menu, .jm-toast, .jm-power-menu, .jm-tone, .jm-preview { border: 1px solid CanvasText; box-shadow: none; }
  .jm-btn, .jm-power, .jm-primary, .jm-reason { border: 1px solid ButtonText; }
  .jm-dot { border: 1px solid CanvasText; }
}

.jm-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`;

export type StyleMode = 'adopted' | 'inline';

let sharedSheet: CSSStyleSheet | null | undefined;

/**
 * Apply the overlay stylesheet to a shadow root: constructable stylesheet when supported, inline <style> fallback
 * otherwise (jsdom, very old Chromium). Returns which path was taken.
 */
export function applyStyles(root: ShadowRoot): StyleMode {
  const sheet = getSharedSheet();
  if (sheet && Array.isArray((root as unknown as { adoptedStyleSheets?: unknown }).adoptedStyleSheets)) {
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return 'adopted';
    } catch {
      // fall through to the inline fallback
    }
  }
  const style = document.createElement('style');
  style.setAttribute('data-jm', 'styles');
  style.textContent = OVERLAY_CSS;
  root.appendChild(style);
  return 'inline';
}

function getSharedSheet(): CSSStyleSheet | null {
  if (sharedSheet !== undefined) return sharedSheet;
  sharedSheet = null;
  try {
    if (typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      sharedSheet = sheet;
    }
  } catch {
    sharedSheet = null;
  }
  return sharedSheet;
}

/** Test hook: forget the cached constructable sheet. */
export function resetStyleCache(): void {
  sharedSheet = undefined;
}
