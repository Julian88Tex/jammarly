# Jammarly architecture

Jammarly is a Grammarly-class writing assistant: a Chrome (Manifest V3) extension that underlines problems in any
web text field, shows a hover card with a one-click fix, and can accept every suggestion at once, plus a small
companion web app on Vercel that holds the account, pairs devices, syncs settings, and learns the user's voice.

This document is the single source of truth for the design. Research behind each decision lives in the session's
research reports (01 UX, 02 suggestion quality, 03 MV3 techniques, 04 editor integrations, 06 Google Docs/Superhuman/
Slashy, 07 Vercel backend, 08 personalization); decisions below cite them as `[Rnn §x]`.

## 1. Product requirements

1. **Quality.** Suggestions must be anchored to exact spans, meaning-preserving, minimal, and silent on acceptable
   text. Four Grammarly categories: correctness (red), clarity (blue), engagement (green), delivery (purple).
2. **Hover UI.** Grammarly-style underlines, a hover card (title, struck-through original, bold replacement,
   explanation, Accept / Dismiss / Add to dictionary), a floating button per field with a count badge, and a review
   panel listing everything by category.
3. **Accept all.** Three controls: *Accept all grammar*, *Accept all style and tone*, *Accept everything*, applied as
   one transaction with Undo and per-item revert. Grammarly has never shipped this in its extension [R01 §1.7].
4. **Works everywhere.** Textareas, inputs, every common contenteditable editor (Gmail, Slack, Notion, LinkedIn, X,
   Discord, Jira, ChatGPT, Claude.ai, WordPress), the Superhuman and Slashy email apps, and Google Docs.
5. **Learns and syncs.** Learns from what the user accepts and dismisses, builds an editable voice profile, and syncs
   settings and learned state across devices through a Vercel-hosted web app. Backend management is minimal: the
   web app exists to tune suggestions and sync, nothing else.

## 2. Repository layout

```
apps/extension        Chrome MV3 extension (esbuild, vitest + jsdom, Playwright e2e in headless Chromium)
apps/web              Next.js 16 app on Vercel (owner login, device pairing, profile sync, learning, dashboard)
packages/shared       @jammarly/shared: types, text utilities, local rules, prompts, learning, profile schema
```

npm workspaces. The extension bundles `@jammarly/shared` sources; the web app transpiles them.

## 3. Extension

### 3.1 Processes and messaging

| Context | Responsibilities |
|---|---|
| **Content script** (isolated world, every frame) | Field detection, adapters, text model, overlay UI (shadow DOM), hover card, floating button, accept-all menu, undo, feedback events, Google Docs bridge (with a MAIN-world bootstrap). Never holds the API key. |
| **Service worker** | Settings store, engine orchestration (local rules + Claude), block cache, cancellation, Anthropic client, keepalive, sync client to the web app, learning fold, commands, side panel routing, injection into already-open tabs on install. |
| **Side panel** | Review list grouped by category, score, tone, goals, Accept all with preview, per-card actions. Talks only to the service worker. |
| **Popup** | On/off (global and per site), counts, open panel, open options. |
| **Options page** | API key, models, goals, categories, dialect, debounce, disabled sites, dictionary, muted rules, pairing with the web app, privacy, advanced (Google Docs compatibility id). |

Transport: content scripts and the side panel open a long-lived `chrome.runtime.Port` to the service worker. Every
message is a discriminated union in `@jammarly/shared/types` (`PortMessage`). While a Claude request is in flight the
worker streams progress over the port and pings `chrome.runtime.getPlatformInfo()` every 20 s so Chrome does not
terminate it [R03 §8 row 5]. The worker also persists in-flight request ids in `chrome.storage.session`.

### 3.2 Text model and anchoring

* The content script keeps, per field, `text` (plain, UTF-16 offsets), a monotonically increasing `version`, and the
  snapshot text for every version that has an outstanding check.
* Text is split into **blocks** (paragraphs, `splitParagraphs`). Each block is hashed with the prompt version, model,
  goals, dialect, style decisions and voice-profile version into a cache key.
* The engine returns suggestions anchored **relative to a block** by verbatim `original`, `prefix`, `suffix` and
  `occurrence` [R02 §8]. The worker resolves them to absolute offsets with `locateSpan` (exact search, then a
  length-preserving normalized search), validates every guard in [R02 §4.1] (sentence constraint, protected spans,
  no-ops, range trimming) and drops anything it cannot anchor.
* The content script re-validates `text.slice(range) === original` at the current version. If the text moved on since
  the request version it rebases with `rebaseSuggestions` (shift before/after the edit region, drop overlapping).
* Overlaps are resolved with `resolveOverlaps`: correctness > clarity > engagement > delivery, then confidence.
* Suggestions carry a `tier`: **A** mechanical correctness (`auto_apply_safe`), **B** style span edits, **C** sentence
  rewrites with alternatives. Accept-all grammar applies A; Accept-all style applies B; Accept everything applies
  A ∪ B and leaves C pending with a toast [R02 §5].

### 3.3 Engine

* **Local rules** (`@jammarly/shared/rules`) run on every input event inside the content script (≤ 2 ms per block):
  spacing, repeated words, sentence-initial capitalization, lone `i`, a/an, high-precision confusables (`could of`),
  doubled punctuation, trailing whitespace. They never run inside protected spans (`stripUrlsAndCode`).
* **Claude passes** run in the service worker. Default **hybrid** mode: a fast pass with `claude-haiku-5-5`
  (thinking disabled, effort low) when a block is dirty and the user pauses 700 ms or ends a sentence, and a deep
  pass with `claude-opus-5-5` (adaptive thinking, effort medium) after 2.5 s idle, blur, or paste. Modes `quality`
  (Opus only) and `economy` (Haiku only) are settings. Effort is fixed per pass so the prompt cache stays warm
  [R02 reviewer A3].
* Calls use `client.messages.stream()` with `output_config.format` (JSON schema), `cache_control` on the two system
  blocks (contract, voice profile), `AbortController` per field, `maxRetries: 1`, `timeout: 120_000`. The Opus pass
  sends `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'`. `stop_reason === 'refusal'` and
  `'max_tokens'` are handled explicitly (parse is wrapped; never show partial output) [R02 reviewer A6, A7].
* Tone analysis is part of the same response (`document.tone`) and rendered when the field has ≥ 150 characters.
* Cost is tracked per request from `usage` and shown in the side panel and options page.
* **Mock provider** (`provider: 'mock'`) returns deterministic suggestions for tests and demos.

### 3.4 Adapters and edit application

Detection on `focusin` (capture) via `composedPath()[0]`, descending into open shadow roots. Eligible: `textarea`,
text-like `input`, and contenteditable roots at least 38 px tall and not read-only; excluded: password/payment/OTP
inputs, `data-gramm="false"` / `data-gramm_editor="false"` / `data-enable-grammarly="false"` / `data-jammarly="false"`,
code editors (CodeMirror, Monaco, Ace), and Google Docs' hidden input iframe [R03 §8 row 13, R04 §8].

| Adapter | Read | Draw | Apply (ladder, verified after each rung) |
|---|---|---|---|
| Textarea / input | `value` | mirror element with copied typography, `Range.getClientRects` on the mirror text node, scroll-corrected | focus + `setSelectionRange` + `execCommand('insertText')` → native value setter + `InputEvent` |
| Contenteditable (generic, Gmail, ProseMirror, Quill, Notion, Gutenberg) | `serializeEditable` (dom-text) | live `Range` rects via `rectsForOffsets` | Selection on range → `execCommand('insertText')` → synthetic `beforeinput` `insertReplacementText` with `targetRanges` → synthetic `paste` (text/plain) → direct Range mutation + `input` |
| Lexical / Slate / Draft.js profiles | same | same | `beforeinput` first (Slate ignores execCommand), Draft.js selection-sync then `textInput` |
| Google Docs | annotated-canvas text via MAIN-world `_docs_annotate_getAnnotatedText` | SVG `rect[aria-label]` geometry | `setSelection(start,end)` + synthetic `paste` into `docs-texteventtarget-iframe`, verified by re-reading |

Site profiles (`apps/extension/src/content/sites/*.ts`) select the adapter and the ladder order by hostname and
DOM markers, mark Superhuman and Slashy as shortcut-heavy (the card never swallows unhandled keys, no single-letter
shortcuts while the host field is focused), and set the default context (`email`, `chat`, `doc`, `social`).

Accept-all applies the selected non-overlapping edits in descending offset order against one snapshot, verifies
after each edit, stops on divergence and reports what was applied. Only `execCommand` keeps the host's native undo;
Jammarly therefore keeps its own per-field undo stack (text snapshot plus the applied suggestion set) and shows an
"Applied N changes — Undo" toast [R01 reviewer 15].

### 3.5 Overlay UI

* One `<jammarly-root>` host per document with an open shadow root, `position: fixed; inset: 0; pointer-events: none;
  z-index: 2147483646`, `:host { all: initial }`, light/dark via `prefers-color-scheme`. Styles are injected with
  `adoptedStyleSheets`; no `@font-face` inside the shadow root (Chromium ignores them) — system font stack.
* All DOM is built with `createElement` and `textContent`; no `innerHTML` (Trusted Types on Google properties).
* Underlines: one `div` per line fragment, 2 px, category color, re-laid-out on input/scroll/resize/mutation and
  chunked across `requestAnimationFrame`. Hit-testing on throttled `pointermove` against fragment rects.
* Hover card: `popover="manual"` element in the top layer; anatomy per [R01 §10.4]; opens after 100 ms hover intent,
  closes after a 250 ms grace, on `Esc`, click outside, or when the span is edited; shortcuts `a`, `d`, `1–9`, `Esc`
  only while the card has focus.
* Floating button: bottom-right of the field, states idle / checking / count / clean / collapsed / off / error, plus a
  tone chip. Click opens the accept-all menu (counts per group, Accept all grammar / style / everything, open panel,
  turn off here).
* Colors: correctness `#E0372C`, clarity `#2A7DE1`, engagement `#1D9F7A`, delivery `#8B5CF6`; brand `#0E9A74`.

### 3.6 Settings, storage, sync

* Everything lives in `chrome.storage.local` (`settings`, `profile`, `learning`, `device`), written only by the
  service worker. Content scripts get what they need over the port; the API key never leaves the worker.
* `profile` is the shared **profile document** (`ProfileDocument` in `@jammarly/shared/profile`): settings that
  make sense across devices (goals, categories, dialect, custom instructions, dictionary, muted rules, site
  overrides, voice profile, API key encrypted with a per-account key). Scalars are last-writer-wins registers with
  hybrid logical clocks; sets are add-wins observed-remove sets [R07 §9.2]. The same merge code runs on the device
  and the server.
* When paired, the worker polls `GET /api/profile` with `If-None-Match` every 5 minutes (`chrome.alarms`) and pushes
  local ops with `POST /api/profile/ops` two seconds after a change; `412` triggers a merge and retry.
* Unpaired, everything still works locally with the API key entered in the options page.

### 3.7 Learning

* The content script emits `FeedbackEvent`s (`shown`, `accept`, `dismiss` with reason, `ignore`, `edit_after_accept`,
  `add_to_dictionary`, `report_incorrect`) with ≤ 200-char redacted snippets when snippet storage is on [R08 §8.1].
* The worker folds events into per-(scope, rule) counters immediately (scopes host → context → global) and runs the
  deterministic learner: Wilson-bound suppression (n ≥ 8, upper bound < 0.35), demotion, promotion of correctness
  rules to Tier A, dictionary growth from repeated spelling dismissals, dialect inference. Core correctness errors
  with confidence ≥ 0.9 are never learned away [R08 §8.2].
* Learned state (`mutedRules`, `demotedRules`, `dictionary`) is part of the profile document and syncs.
* The **voice profile** is synthesized by Claude from the user's final text samples and decision history, rendered
  as a byte-stable `<user_voice_profile>` system block (400–800 tokens) placed before any volatile content
  [R08 §8.3–8.4]. Synthesis runs in the web app nightly and on demand, and can also run on the device
  ("Learn my voice now") so an unpaired install still improves.

### 3.8 Google Docs

A MAIN-world `document_start` script on `https://docs.google.com/document/*` sets
`window._docs_annotate_canvas_by_ext` to Jammarly's extension id (an advanced setting can substitute a
compatibility id). Docs then renders an SVG annotation layer and exposes `_docs_annotate_getAnnotatedText(id)`
with `getText()`, `getSelection()`, `setSelection()`. The isolated-world bridge polls the text every 125 ms,
positions underlines from `rect[aria-label]` geometry, and applies edits by `setSelection` plus a synthetic `paste`
into the `docs-texteventtarget-iframe` editable, verifying by re-reading [R06 §0]. Whether Google activates this
for a non-publisher account with Jammarly's own id is unknown; the adapter degrades to a clear "Docs: read-only"
state and the side panel still works on pasted text. A stable extension id is pinned with the manifest `key`.

### 3.9 Minimum Chrome

120 (`chrome.alarms` 30 s floor, side panel `open()`, popover, `caretPositionFromPoint` fallback to
`caretRangeFromPoint`). `chrome.storage.local.setAccessLevel` is feature-detected (Chrome 140+).

## 4. Web app (apps/web)

* Next.js 16.4 App Router, Node 24, Fluid Compute, region `iad1`, `maxDuration` 60 for API routes and 300 for the
  learning routes [R07 §9.1].
* **Auth:** single owner. `OWNER_PASSWORD_HASH` (scrypt) + iron-session v9 sealed cookie. Device bearer tokens
  (`jm1.<deviceId>.<secret>`, stored hashed). Upgrade path: Auth.js Google provider.
* **Storage:** one private Vercel Blob store (OIDC). Paths `users/owner/profile.json` (ETag CAS), `.../snapshots/`,
  `.../events/<date>/<device>.jsonl`, `.../devices.json`, `auth/pairings/<id>.json`. Event uploads are batched at
  most hourly per device to respect the Hobby plan's advanced-operation budget [R08 reviewer 36].
* **Pairing:** the dashboard calls `chrome.runtime.sendMessage(EXTENSION_ID, {type:'jammarly.pair', pairingId, code})`
  (`externally_connectable` pinned to the production origin); fallback: the user types the code into the options
  page [R07 §9.4].
* **API:** `/api/auth/login|logout`, `/api/devices` (list, revoke, `pair/start`, `pair/redeem`, `rotate`),
  `/api/profile` (GET with ETag, PUT with If-Match, `ops` merge), `/api/events`, `/api/learning/summary|run`,
  `/api/cron/synthesize` (`CRON_SECRET`), `/api/health`. CORS allowlist = pinned `chrome-extension://` ids.
* **Pages:** Overview, Tuning (goals, categories, custom instructions, dictionary, muted rules, site overrides,
  models and API key), Voice (profile per context: view, edit, lock traits, regenerate, history), Learning
  (acceptance by category, rule table with overrides, "what Jammarly learned"), Devices, Privacy.
* **Learning job:** folds events into counters, runs the deterministic learner, synthesizes the voice profile with
  Claude (`claude-opus-5-5`, structured output, streaming, effort medium), lints it so it can never relax
  correctness, stores a new version and a snapshot.
* **Deployment:** Vercel project `jammarly-web` linked to the GitHub repo with root directory `apps/web`; env vars
  `SESSION_SECRET`, `OWNER_PASSWORD_HASH`, `CRON_SECRET`, `APP_ORIGIN`, `EXTENSION_IDS`; the Anthropic key is entered
  in the dashboard and stored encrypted in the profile document.

## 5. Testing

* Unit: vitest in each workspace (shared: node; extension: jsdom; web: node with an in-memory blob store).
* e2e: Playwright loads `apps/extension/dist` into headless Chromium with the mock engine and fixture pages
  (textarea, contenteditable editors, framework fixtures, Gmail-like compose, iframe, Google Docs mock).
* CI: typecheck, unit, build, e2e on every push and PR.
