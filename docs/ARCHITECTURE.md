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
apps/web              Next.js 16 app on Vercel (JSlice sign-in, device pairing, profile sync, learning, dashboard)
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
| **Options page** | First-run welcome (consent), API key, models, goals, categories, dialect, debounce, disabled sites, dictionary, muted rules, pairing with the web app, privacy, advanced (Google Docs inline auto/off, daily budget). |

**First run.** On `runtime.onInstalled` with `reason === 'install'` the worker opens `options/options.html#welcome`:
(1) a one-paragraph disclosure (text in fields you check is sent to Anthropic with your own key; nothing is sent until
you finish this page) with an explicit **I agree** button that sets `settings.privacy.consentAt`; (2) the API key with
"Test key", or "Pair with the web app"; (3) default sites: "Check everywhere" / "Only sites I turn on" (seeds
`sites.disabled`). Until consent is recorded the worker answers every `check` with `error.code: 'consent-required'`,
local rules still run, `EffectiveConfig.consented` is false and the floating button shows the `setup` state whose click
opens the options page. This is also the Chrome Web Store user-data disclosure requirement [R05 M7].

Transport: content scripts and the side panel open a long-lived `chrome.runtime.Port` to the service worker. Every
message is a discriminated union in `@jammarly/shared/types` (`PortMessage`). While a Claude request is in flight the
worker streams progress over the port, the content script sends `ping` every 20 s, and the worker calls
`chrome.runtime.getPlatformInfo()` every 20 s so Chrome does not terminate it [R03 §8 row 5]. The worker persists
in-flight request ids in `chrome.storage.session` and, on startup, emits `check-result` with
`error.code === 'cancelled'` (retryable) for each of them. **Recovery:** on `port.onDisconnect` the content script
reconnects with backoff, re-sends `hello` and `field-attached`, then re-sends `check` for every outstanding version
whose text hash is unchanged; on `pageshow` (bfcache restore) it reconnects. An e2e test streams a stubbed 60–90 s
response to prove the worker survives; an offscreen-document fallback stays documented as plan B. Opening the side
panel from the in-page button goes through `chrome.runtime.sendMessage` from the click handler (user gesture), not
the port. **Instances:** the content script marks `<html data-jammarly-instance="<id>:<version>">`; a newer instance
(after an update, injected into open tabs via `scripting.executeScript`) dispatches `jammarly:takeover` and the orphan
tears down its overlay, observers and timers; orphans also self-destroy when `chrome.runtime.id` is gone.

### 3.2 Text model and anchoring

* The content script keeps, per field, `text` (plain, UTF-16 offsets), a monotonically increasing `version`, and the
  snapshot text for every version that has an outstanding check.
* Text is split into **blocks** (paragraphs, `splitParagraphs`). Each block is hashed with the prompt version, model,
  goals, dialect, style decisions and voice-profile version into a cache key.
* `CheckRequest` carries **field facts only** (text, blocks, dirty hashes, pass, host, context, field kind,
  DOM-derived protected ranges). The worker merges device settings, the profile document and learned state into the
  prompt; the content script never sees profile-derived prompt inputs.
* The engine returns suggestions anchored **relative to a block** by verbatim `original`, `prefix`, `suffix` and
  `occurrence` (1-based; `locateSpan` takes `occurrence - 1`) [R02 §8]. Blocks are sent as `<block id="b<index>">`.
  The worker resolves anchors with `locateSpan` (exact search, then a length-preserving normalized search, recorded as
  `anchor: 'exact' | 'normalized'`), validates every guard in [R02 §4.1] (sentence constraint, protected spans,
  no-ops, range trimming) and drops anything it cannot anchor. `title` comes from `titleForRule(rule)` in
  `@jammarly/shared/prompts` (a title for every rule id in the contract, "Consider this change" for `other`); the
  model never emits a title.
* The worker **caches block-relative** results (`CachedSuggestion` with `rel` offsets) per cache key; absolute
  `range`, `highlight`, `blockId` and the stable `id = hash(fieldId, blockHash, fingerprint, ordinalInBlock)` are derived at
  serve time, so a paragraph that moved still serves correct offsets and cards never flicker between passes.
* **Cache key** = stable JSON of `{ promptVersion, schemaVersion, model, effort, dialect, goals, context,
  styleDecisions, categories, hash(customInstructions), hash(sorted protected terms), voiceProfileVersion,
  voiceStrength }` plus the block hash. Neighbour context is passed but not keyed. The LRU (≤ 500 blocks) persists in
  `chrome.storage.session` and is reloaded on worker start; after an extension update (`onInstalled` with
  `reason === 'update'`) attached fields are silently re-checked instead of showing empty panels.
* **Pass supersession**: per block hash the worker keeps the result with the highest pass rank (deep > fast > rules);
  a fast result for a block that already has a deep result is ignored; the worker always emits the merged
  best-per-block set with per-block provenance (`CheckResult.blocks`), and skips a fast pass when every dirty block
  already has a deep entry. `tone` is only taken from responses that covered every block.
* The content script owns the merged set. It keeps a per-version `DiffRegion` log from the oldest outstanding
  request version to the current one, rebases results **stepwise** with `rebaseSuggestions` (shift before/after each
  region, drop overlapping), re-runs local rules on every change, and resolves overlaps over rules ∪ LLM.
* **Overlaps** are resolved with `resolveOverlaps` only among span edits (`kind` replace|delete|insert):
  correctness > clarity > engagement > delivery, then confidence. Rewrites and flags stay out of it and are linked to
  the spans inside their sentence via `conflictsWith`. Accepting a rewrite removes its conflicting spans; accepting
  spans inside a rewrite transforms the rewrite's `original` and marks it `stale` ("sentence changed") until the
  next check.
* **Tiers** (also in `types.ts`): **A** = correctness ∧ kind ∈ {replace, delete, insert} ∧ severity error ∧
  confidence ≥ 0.85 ∧ meaningPreserving ∧ autoApplySafe ∧ anchor exact ∧ within one sentence; **B** = clarity,
  engagement or delivery span edits with confidence ≥ 0.7 ∧ meaningPreserving; **C** = rewrites, flags, and anything
  not meaning-preserving. Accept-all grammar applies A; Accept-all style applies B; Accept everything applies A ∪ B
  and leaves C pending (stale, re-checked) with a toast [R02 §5].
* **Dismissal memory**: the worker keeps dismissed fingerprints per `docKey` (30-day TTL) and applied fingerprints per
  field session in `chrome.storage.local`, and filters them before emitting `check-result`; the content script also
  filters the in-flight result. "Add to dictionary", "Turn off suggestions like this" and the dismiss reasons
  `not_this_site` / `never` are profile mutations the worker applies immediately (the content script sends
  `add-to-dictionary`, `mute-rule`, `dismiss` messages; it never constructs profile ops).

### 3.3 Engine

* **Local rules** (`@jammarly/shared/rules`) run on every input event inside the content script (≤ 2 ms per block):
  spacing, repeated words, sentence-initial capitalization, lone `i`, a/an, high-precision confusables (`could of`),
  doubled punctuation, trailing whitespace. They never run inside protected spans (`stripUrlsAndCode`).
* **Claude passes** run in the service worker. Default **hybrid** mode: a fast pass with `claude-haiku-5-5`
  (thinking disabled, effort medium) when a block is dirty and the user pauses 700 ms or ends a sentence, and a deep
  pass with `claude-opus-5-5` (adaptive thinking, effort medium) after 2.5 s idle, blur, or paste. Modes `quality`
  (Opus only) and `economy` (Haiku only) are settings. Effort is fixed per pass so the prompt cache stays warm
  [R02 reviewer A3]; the fast pass moved from low to medium because low effort returned shorter suggestion lists.
  The system prompt (v4) asks for a Grammarly-level pass: every issue in every sentence, several non-overlapping
  suggestions per sentence, calibrated confidence (0.5 floor), with the minimal-edit, verbatim-anchor and meaning
  rules unchanged.
* Calls use `client.messages.stream()` with `output_config.format` (JSON schema), `cache_control` on the two system
  blocks (contract, voice profile), `AbortController` per field, `maxRetries: 1`, `timeout: 120_000`. The Opus pass
  sends `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'`. `stop_reason === 'refusal'` and
  `'max_tokens'` are handled explicitly (parse is wrapped; never show partial output) [R02 reviewer A6, A7].
* **Tone** is a separate Haiku call on the whole field (≥ 150 characters, 1.5 s idle, keyed by the hash of the first
  2,500 characters, thinking disabled, effort low, `max_tokens` 300) with its own byte-stable system prompt and a
  `{ tone, rationale }` schema; it arrives as a `tone` port message. `document.tone` from a suggestion response is
  used only when that response covered every block [R02 §8.6]; in that case no tone call is made at all. Otherwise a
  field gets at most one tone call per minute unless its length changed by 25 % or more.
* **Request budget.** Each call carries ≤ 40 dirty blocks and ≤ ~1,200 words (≈ 2,200 tokens at 1.8 tokens/word;
  longer fields are sharded into several calls) plus ≤ 1 sentence of read-only `context_before` / `context_after`,
  so a normal email is one call per pass. `max_tokens`: fast pass 16,000 (thinking disabled), deep pass 32,000
  (adaptive thinking is billed as output; OTPM limits count generated tokens, not `max_tokens`). On
  `stop_reason === 'max_tokens'` the worker re-requests the same blocks split in half (once); blocks still truncated
  get `error.code: 'truncated'` and the tooltip "Couldn't check one paragraph". At most 3 requests in flight per key
  across tabs. A fast and a deep pass of one field never call at the same time: the deep pass waits for a running
  fast call, and a fast pass that has not sent yet yields to a pending deep pass for the same text and is served
  from its cache entries. A stale request is aborted only while its call has not been sent; a sent call finishes
  silently (filling the cache) and newer requests wait for it, so a burst of edits collapses into one trailing call.
  429 honours `retry-after` through a shared cooldown with two retries; a deep pass still throttled is re-run once
  (after the next successful fast pass for that text, or on its own after the cooldown). A failed pass still carries
  the field's cached suggestions; a partly failed pass emits the successful result first and the error second.
  `enforced_spend_limit_reached` maps to `spend-cap` (not retryable) and 401 to `auth`, each with its own button
  state and tooltip [R02 reviewer A5, A6; R05 M1].
* **Daily budget.** `DeviceSettings.dailyBudgetUsd` (default 2.00; 0 = unlimited). When today's cost reaches it the
  worker skips deep passes (behaves as `economy`); when even Haiku would exceed it, checks answer `error.code: 'budget'`
  and the button shows a budget chip ("Daily budget reached, Haiku only until midnight"). Today's and the month's cost
  are shown next to the setting, in the popup and in the side panel.
* Cost is tracked per request from `usage` (`estimateCostUsd`) and shown in the side panel and options page.
* **Mock provider** (`provider: 'mock'`) returns deterministic suggestions for tests and demos.

### 3.4 Adapters and edit application

Detection on `focusin` (capture) via `composedPath()[0]`, descending into open shadow roots. Eligible: `textarea`,
text-like `input`, and contenteditable roots at least 24 px tall and not read-only; excluded: password/payment/OTP
inputs, code editors (CodeMirror, Monaco, Ace), and Google Docs' hidden input iframe [R03 §8 row 13, R04 §8].
Site opt-out (union of every convention, [R09 §1.6]): the field or an ancestor has `data-gramm`, `data-gramm_editor`
or `data-jammarly` with any value other than `"true"`, or `data-enable-grammarly="false"`, or `data-lt-active="false"`.
Opt-in overrides: `data-enable-grammarly="true"` or `data-jammarly="true"`. `spellcheck="false"` is never an opt-out
(Squire, CodeMirror and others set it for unrelated reasons). A setting "Check fields that sites disabled" exists.
Gmail is detected by `[g_editable="true"]`, not by the localized aria-label. Slack's composer carries
`data-gramm="false"`, so the Slack site profile sets `ignoreSiteOptOut` (and every host gets a "Check here anyway"
item in the floating-button menu, remembered in `settings.ignoreOptOutHosts`). Size gate for every kind:
`clientWidth ≥ 120 && clientHeight ≥ 24`, re-evaluated on `ResizeObserver` so auto-growing fields become eligible
(AI chat prompt boxes start at 24–36 px [R05 C3]); inputs are only `type=text|search|url`, need no small `maxlength`,
and get Claude passes only once they hold ≥ 3 words. When the field is under 40 px tall the floating button is
anchored just outside the field's bottom-right corner instead of inside it.

| Adapter | Read | Draw | Apply (ladder, verified after each rung) |
|---|---|---|---|
| Textarea / input | `value` | mirror element with copied typography, `Range.getClientRects` on the mirror text node, scroll-corrected | focus + `setSelectionRange` + `execCommand('insertText')` → native value setter + `InputEvent` |
| Contenteditable (generic, Gmail, ProseMirror, Quill, Notion, Gutenberg) | `serializeEditable` (dom-text) | live `Range` rects via `rectsForOffsets` | Selection on range → `execCommand('insertText')` → synthetic `beforeinput` `insertReplacementText` with `targetRanges` → synthetic `paste` (text/plain) → direct Range mutation + `input` |
| Lexical / Slate / Draft.js profiles | same | same | `beforeinput` first (Slate ignores execCommand), Draft.js selection-sync then `textInput` |
| Google Docs | annotated-canvas text via MAIN-world `_docs_annotate_getAnnotatedText` | SVG `rect[aria-label]` geometry | `setSelection(start,end)` + synthetic `paste` into `docs-texteventtarget-iframe`, verified by re-reading |

Site profiles (`apps/extension/src/content/sites/*.ts`) select the adapter and the ladder order by hostname and
DOM markers, mark Superhuman (`mail.superhuman.com`, Squire editor: plain `execCommand('insertText')` persists, own
undo stack), Slashy (`www.slashy.com`, Gmail-compatible single-letter shortcuts) and Gmail as shortcut-heavy (the
card never swallows unhandled keys; no single-letter shortcuts while the host field is focused), carry debounce
multipliers (Superhuman/Slashy: fast pass 900 ms, deep pass 4 s), and set the default context [R09 §1.4, §1.5].

`FieldAdapter.applyEdit` is **asynchronous** and returns an `EditOutcome` (`applied | reverted | mismatch |
unsupported | composing`, the rung used, and the post-apply text). Each write is verified immediately, at the next
animation frame and at +150 ms (NBSP-normalized), because Lexical reverts foreign mutations up to ~100 ms later and
Slate throttles selection. A rung is never re-run (Lexical duplicates). Deletions use a deletion ladder (native API →
`beforeinput deleteContentBackward` with the range selected → `execCommand('delete')`), never an empty paste
[R04 §4.6]. Nothing is written while an IME composition is active (`isComposing()`); accepts queue until
`compositionend` + 50 ms and re-validate `original` first.

Accept-all applies the selected non-overlapping edits in descending offset order against one snapshot, verifies
after each edit, aborts on the first mismatch and reports what was applied (`BatchEditOutcome`). Only `execCommand`
keeps the host's native undo, one step per edit; Jammarly therefore defines **undo as inverse edits**: each
`ApplyTransaction` stores the applied edits with post-apply ranges; undo maps them through later diff regions,
re-validates `text.slice(range) === replacement`, and applies the inverses right-to-left through the same ladder.
Whole-text snapshot restore is reserved for `textarea`/`input`. An `input` event with `inputType` `historyUndo` or
`historyRedo` is treated as an ordinary text change (rebase, recompute `undoAvailable`, mark the transaction
partially reverted). The toast reads "Applied N changes — Undo" and the panel offers per-item revert
[R01 reviewer 15, R02 reviewer B4].

`FieldAdapter.getProtectedRanges()` returns the union of `contenteditable=false` islands, replaced elements, zero-width
characters and site-profile containers (`.gmail_quote`, `.gmail_signature`, `[data-lexical-decorator]`,
`.ProseMirror-widget`); the worker masks them with same-length spaces before prompting and the content script
re-checks intersection at apply time.

### 3.5 Overlay UI

* One `<jammarly-root>` host per document with an open shadow root, `position: fixed; inset: 0; pointer-events: none;
  z-index: 2147483646`, `:host { all: initial }`, light/dark via `prefers-color-scheme`. Styles are injected with
  `adoptedStyleSheets`; no `@font-face` inside the shadow root (Chromium ignores them) — system font stack.
* All DOM is built with `createElement` and `textContent`; no `innerHTML` (Trusted Types on Google properties).
* Underlines: one `div` per line fragment, 2 px, category color, re-laid-out on input/scroll/resize/mutation and
  chunked across `requestAnimationFrame`. Hit-testing on throttled `pointermove` against fragment rects.
* Hover card: `popover="manual"` element in the top layer; anatomy per [R01 §10.4]: category dot + label, title,
  struck-through original followed by the bold replacement (clicking the replacement accepts), options 1–9 for
  rewrites, explanation (`Learn more` expands past 140 chars), actions (Accept, Dismiss, Add to dictionary for
  spelling, More: report incorrect / turn off suggestions like this on this site or everywhere / dismiss reasons), and
  the footer "Jammarly helps you write clearly and mistake-free." until the first accept or dismiss. Tier A shows an
  "Auto" chip, Tier C "Rewrite", stale rewrites "Sentence changed". Opens after 100 ms hover intent, closes after a
  250 ms grace, on `Esc`, click outside, or when the span is edited; shortcuts `a`, `d`, `1–9`, `Esc` only while the
  card has focus. After a single accept the card's place shows "Applied, Undo" for 8 s.
* Floating button: bottom-right of the field (outside it when the field is under 40 px tall), states `setup` (gray
  with a dot, "Finish setting up Jammarly") / idle / checking / count / clean / collapsed / off / unsupported /
  error (sub-kinds `auth`, `rate-limit`, `spend-cap`, `budget`, `network`, each with a tooltip), plus a tone chip
  (`TONE_EMOJI`). Hover reveals a power button ("Turn off in this field until next visit" / "forever"); click opens
  the menu: Accept all grammar (n) / Accept all style and tone (n) / Accept everything (n, "k rewrites need your
  choice"), Undo last, Open review panel, Check now (deep pass), Check here anyway (opt-out hosts), Turn off on
  `<host>`, Turn off this field.
* Colors as tokens on `:host` with dark variants under `prefers-color-scheme: dark`: correctness `#E0372C` / `#FF6B61`,
  clarity `#2A7DE1` / `#5B9CF6`, engagement `#1D9F7A` / `#34D3AC`, delivery `#8B5CF6` / `#B07CF0`, interactive
  `#2551DA` / `#7A9BFF`, brand `#0E9A74`. Underline states: default 2 px; active 3 px plus an 18 % tint behind the
  text while the card is open; pending fades. Colorblind mode = Wong palette plus a per-category pattern (solid /
  dashed / dotted / double); `forced-colors: active` falls back to borders.
* Commands: `toggle-on-site`, `accept-all` (= Accept all grammar, the safe tier, routed to the active field) and
  `open-panel`; `_execute_action` opens the popup. Alt+Shift chords avoid Chrome's built-ins (Ctrl+Shift+J is
  DevTools) but can collide with Windows input-language switching on two-language profiles; they are user-editable at
  `chrome://extensions/shortcuts`.

### 3.6 Settings, storage, sync

* One source of truth: the profile document, cached in `chrome.storage.local` next to the device settings, written
  only by the service worker. Content scripts never read storage; they receive `EffectiveConfig` over the port and
  `config` broadcasts on change. `chrome.storage.sync` is unused. Secrets are stored with
  `setAccessLevel('TRUSTED_CONTEXTS')` when the API exists (Chrome 140+). Budget: profile ≤ 1 MB, event buffer
  ≤ 5,000 events with oldest-first eviction, dismissal fingerprints keyed by `docKey` with a 30-day TTL [R09 §1.8].
* `docKey = sha256(userSalt ‖ origin ‖ fieldPath ‖ docHint)[0:16]` where `docHint` is a stable per-document token
  when one exists (Gmail draft id, Docs document id, thread id in the URL) and `userSalt` is a random value stored in
  the profile document. It keys dismissal memory and the `docId` of feedback events [R09 §1.12].
* `profile` is the shared **profile document** (`ProfileDocument` in `@jammarly/shared/profile`): settings that
  make sense across devices (goals, categories, dialect, custom instructions, models and engine mode, privacy consent,
  dictionary, muted rules, site overrides, voice profiles, learned state). Scalars are last-writer-wins registers
  keyed by fixed-width hybrid logical clocks; sets are add-wins observed-remove sets [R07 §9.2]. Device ops are
  typed (`LwwPath`, `SetPath`); `voice` and `learning` ops are accepted only from a dashboard session or the cron, and
  the **learning section is server-authoritative when paired**: the worker folds events into a device-local shadow
  for immediate effect and replaces it with `profile.learning` on every successful poll (unpaired devices fold into
  the profile copy directly). The same merge code runs on the device and the server.
* **The Anthropic API key is per device**, entered in the options page and never synced or distributed by the web
  app. The learning job uses a server-side key (`ANTHROPIC_API_KEY` env var, or a key entered on the dashboard and
  stored encrypted at rest with a key derived from `SESSION_SECRET`), which never reaches devices. When paired, the
  profile's `mode`, `model` and `fastModel` are authoritative and the options page writes them as ops.
* Pages other than the worker (side panel, popup, options) receive `PublicDeviceSettings`, never the key or token.
* When paired, the worker polls `GET /api/profile/version` (a tiny cached document) every 5 minutes while active and
  every 15 minutes when idle (`chrome.alarms`), fetches the body only when the version changed, and pushes local ops
  with `POST /api/profile/ops` two seconds after a change (at most 12 profile writes per day); `412` triggers a merge
  and retry. Feedback events upload hourly while active plus an idle flush, at most 6 batches per device per day, to
  stay inside the Vercel Hobby Blob operation budget [R09 §1.11]. When sync is paused (budget or offline) everything
  keeps working from the local copy and the popup shows "sync paused".
* Unpaired, everything still works locally with the API key entered in the options page.

### 3.7 Learning

* The content script emits the ten `FeedbackKind`s of `learning.ts` (`shown` once per suggestion id per field
  session; `ignore` on blur/send/close after ≥ 2 s dwell; `accepted_by_typing` / `self_corrected` from the span's
  `inputType`-tagged edits; `edit_after_accept` carries `final`) with ≤ 200-char redacted snippets when snippet
  storage is on. Voice samples take only sentences whose characters were typed (`insertText` /
  `insertCompositionText`), never pasted, dropped or Jammarly-applied [R08 §8.1].
* The worker folds events into per-(scope, rule) counters immediately (scopes host → context → global) and runs the
  deterministic learner. Constants: `N_MIN_SCOPE = 8` (the most specific scope with n ≥ 8 decides), `UB_SUPPRESS =
  0.35`, `N_MIN_DEMOTE = 6`, `UB_DEMOTE = 0.50`, `CONFIDENCE_FLOOR = 0.90`; no time decay in v1 (counters are folded
  daily). Promotion is the orthogonal `eligibleForBulk` flag (correctness only, global scope, n ≥ 10 ∧ Wilson LB ≥
  0.80): a promoted rule's correctness suggestions qualify for Tier A at confidence ≥ 0.70 instead of 0.85 (severity
  `error`, `autoApplySafe` and exact anchor still required). Manual overrides live only in `rules.muted`. Core
  correctness errors with confidence ≥ 0.9 are never learned away [R08 §8.2, reviewer 32].
* Learned state (`mutedRules`, `demotedRules`, `dictionary`) is part of the profile document and syncs.
* The **voice profile** is synthesized by Claude from the user's final text samples and decision history, rendered
  as a byte-stable `<user_voice_profile>` system block (400–800 tokens) placed before any volatile content
  [R08 §8.3–8.4]. Synthesis runs in the web app nightly and on demand, and can also run on the device
  ("Learn my voice now") so an unpaired install still improves.

### 3.8 Google Docs (layered, [R09 §1.1])

1. **Default for every install:** an explicit "Google Docs isn't supported inline" state on the floating button, and
   the side panel's **paste → check → Accept all → copy back** flow, which also covers Slides, Sheets, Figma and
   Canva.
2. **Inline adapter, auto-enabled only when it works:** a MAIN-world `document_start` script on
   `https://docs.google.com/document/*` sets `window._docs_annotate_canvas_by_ext` to Jammarly's own id (never
   overwriting a pre-set flag). If Docs then exposes `_docs_annotate_getAnnotatedText(id)` as a function (which it
   does for allow-listed ids and, reportedly, for the publisher's own account), the bridge activates: it polls
   `getText()` every 125 ms, positions underlines from the SVG `rect[aria-label]` annotation layer, and applies edits
   by `setSelection(start, end)` plus a synthetic `paste` (text/plain) into the `docs-texteventtarget-iframe`
   editable, verified by re-reading. Otherwise the adapter stays off and layer 1 applies.
3. **No borrowed ids.** The "compatibility id" that other extensions ship belongs to a retired Microsoft product;
   it is available only as a dev-build environment flag for comparison testing, never as a product setting.
4. Submit Google's allow-list form on day one; plan for no answer. Post-v1: "send accepted edits as Suggestions"
   through the Docs REST API with the non-sensitive `drive.file` scope and the Google Picker [R09 §1.2].

A stable extension id is pinned with the manifest `key` (`apps/extension/EXTENSION_ID`). MAIN-world scripts are
subject to the page CSP (Trusted Types on Google hosts), so they never use HTML-string sinks; isolated-world
content scripts carry their own CSP in Chrome [R09 §1.18].

### 3.9 Minimum Chrome

120 (`chrome.alarms` 30 s floor, side panel `open()`, popover, `caretPositionFromPoint` fallback to
`caretRangeFromPoint`). `chrome.storage.local.setAccessLevel` is feature-detected (Chrome 140+).

## 4. Web app (apps/web)

* Next.js 16.4 App Router, Node 24, Fluid Compute, region `iad1`, `maxDuration` 60 for API routes and 300 for the
  learning routes [R07 §9.1].
* **Auth:** many users through JSlice (Google single sign-on, `JSLICE_URL`). JSlice hands back a 60 s ES256 JWT
  (`aud` = `jammarly`) at `/api/auth/jslice`; the route verifies it against JSlice's JWKS, accepts each `jti` once and
  starts an iron-session v9 sealed cookie whose `uid` is the token's `sub` (the stable Google id). `/login` first tries
  a silent sign-in (`/launch/jammarly?silent=1`) and shows **Continue with JSlice** when JSlice answers
  `jslice=none`; sign-out lands on `/login?jslice=none`. Device bearer tokens (`jm1.<deviceId>.<secret>`, stored
  hashed) resolve to their user through `auth/devices/<deviceId>.json`.
* **Storage:** one private Vercel Blob store (OIDC). Every user's documents live under `users/<sub>/`:
  `profile.json` (ETag CAS), `version.json` (tiny, served cached for polling), `snapshots/`,
  `events/<date>/<device>.jsonl`, `events/index.json` (never `list()` in the hot path), `devices.json`,
  `pairings/<id>.json`, `runs/`, `server-key.json`, `account.json`. Lookups needed before the user is known hold only
  pointers: `auth/users/<sub>.json` (the cron's user list), `auth/devices/<id>.json` and `auth/pairings/<id>.json`
  (`{ uid }`), `auth/jti/` (used tokens); `system/quota.json` keeps the store-wide operation counters. The daily
  fold compacts event batches into counters and deletes the raw blobs. Budget target: ≈ 1,200 advanced and ≈ 5,000
  simple operations per month for three devices, inside the Hobby caps [R09 §1.11]. The budget is per store, so every
  user shares it.
* **Pairing:** the dashboard calls `chrome.runtime.sendMessage(EXTENSION_ID, {type:'jammarly.pair', pairingId, code})`
  (`externally_connectable` pinned to the production origin); the worker accepts the message only when
  `sender.origin === APP_ORIGIN` (compiled into the build) and redeems against that origin, ignoring any origin in the
  message. Fallback: the user types the code into the options page [R07 §9.4]. `APP_ORIGIN` is the production
  **domain alias** (`https://<project>.vercel.app` or a custom domain), never `VERCEL_URL`; Deployment Protection stays
  at Standard. The build fails unless `externally_connectable.matches` equals exactly `[APP_ORIGIN + '/*']`.
* **Clocks and ops:** HLCs are `<13-digit ms>-<4-digit counter>-<deviceId>`; the server rejects ops more than 5
  minutes ahead of its clock (`hlc_skew`), rejects paths outside the allowlist (`op_not_allowed`), validates values with
  the shared zod schemas (`schema_invalid`), and caps profile writes at 10 per hour per device (`quota_exceeded`).
* **API:** `/api/auth/jslice|logout`, `/api/devices` (list, revoke, `pair/start`, `pair/redeem`, `rotate`),
  `/api/profile` (GET with ETag, PUT with If-Match, `ops` merge, `version` tiny cached document), `/api/events`,
  `/api/learning/summary|run|status`, `/api/learning/data` (DELETE: every server artifact), `/api/export`,
  `/api/server-key` (status; set from the dashboard), `/api/cron/synthesize?ctx=messages|documents` (`CRON_SECRET`),
  `/api/health` (with the month's Blob operation counters so the dashboard warns at 80 %). Errors use `ApiErrorCode`.
  CORS: echo `Access-Control-Allow-Origin` only for `Origin ∈ EXTENSION_IDS`, `Vary: Origin`, never credentials;
  cookie-authenticated routes reject requests with an extension `Origin`. The server answers `304` for an
  `If-None-Match` matching an ETag it wrote or read within 60 s without touching Blob.
* **Privacy:** consent (`settings.privacy`) is synced and enforced server-side: when `storeSnippets` is off the
  upload route strips `original`/`replacement`/`final`/`sentence` and samples regardless of what a device sent; the
  daily fold purges events past `retentionDays`; "Delete all learning data" enumerates events, samples, snapshots,
  runs, learned dictionary entries and voice profiles; export returns the same set as JSON.
* **Pages:** Overview (sync status, devices with revoke and pairing, usage, Blob budget warning at 80 %), Tuning
  (goals with per-site overrides, categories, custom instructions, dictionary, muted rules, models and engine mode,
  server key for the learning job), Voice (profile per context: view, edit, lock traits, remove items, regenerate,
  history, strength), Learning (acceptance by category, rule table with state / `eligibleForBulk` / overrides, "what
  Jammarly learned"), Privacy and data (consent, snippet storage, retention, private sites, export, delete). The
  paste → check → Accept all → copy flow lives in the extension's side panel, not in the web app.
* **Contexts:** events and scopes use `email | chat | doc | social | code | other`; voice profiles use
  `messages` (email, chat, social) and `documents` (doc, other); `code` gets no voice profile [R09 §1.13].
* **Learning job:** two cron entries (`?ctx=messages` at 03:00 UTC, `?ctx=documents` at 04:00 UTC); each visits every
  user with batches newer than their last run for that context (in an order rotated daily, until under 20 s remain)
  and runs the job for them; the first also folds events into counters and runs the deterministic learner. Each run is
  idempotent and resumable: it writes `users/<sub>/runs/<date>-<ctx>.json` with stage checkpoints (the persistent
  log, since Hobby keeps runtime logs for an hour), sets the SDK `timeout` from `getDeadline()` with `maxRetries: 0`, records `partial` and stops cleanly when
  under 20 s remain, uses `max_tokens ≥ 8000` (thinking is billed as output), and on `refusal` or `max_tokens` keeps the
  previous profile version and appends the reason to `learning.history`. Synthesis uses `claude-opus-5-5` with
  structured output and effort medium; the result is linted (regex plus a Haiku classifier) so it can never relax
  correctness, inject instructions, URLs, addresses or tool talk, and `renderVoiceBlock` is the only renderer on
  device and server (sanitizes and caps every field). Runs are skipped when fewer than 20 new events or 1,500 new
  sampled words arrived. "Run now" on the dashboard (`POST /api/learning/run`, ≤ 3/day) is the manual retry.
* **Deployment (provisioning order, team-scoped API):** create project `jammarly-web` linked to
  `Julian88Tex/jammarly` with root directory `apps/web` and Fluid Compute; create the private Blob store bound to it;
  set env vars `SESSION_SECRET`, `CRON_SECRET` (sensitive, production + preview), `JSLICE_URL`,
  `APP_ORIGIN` (the production alias), `EXTENSION_IDS` (plain) and optionally `ANTHROPIC_API_KEY` (sensitive,
  server-only; the dashboard can set it instead); add one WAF rate-limit rule on `/api/auth/jslice` and
  `/api/devices/pair/*`; create a production deployment from the PR branch until it merges; then build the extension
  with `JAMMARLY_APP_ORIGIN` set to the alias and record the extension id in `EXTENSION_IDS`.

## 5. v1 scope and staging

**v1 ships:** textarea/input and generic contenteditable through the verified ladder, with named profiles for Gmail,
Superhuman (Squire), Slashy, Slack, ProseMirror hosts (ChatGPT, Claude.ai, Atlassian) and Notion; best-effort
profiles for Draft.js (X), Slate (Discord), Lexical (Facebook, Threads), LinkedIn, Gutenberg, Reddit and GitHub that
degrade to the generic ladder when a rung fails verification; local rules; hybrid engine with budget and the mock
provider; hover card, underlines, floating button, side panel (grouped list, Accept-all preview, undo, revert, scratch
check); dismissal memory; first-run, options and popup; pairing, profile sync and event upload; nightly fold with
Wilson suppression / demotion, manual mute and dictionary; web-app voice synthesis with lint and injection at strength
0–2; Google Docs layer 1 (side panel) plus the layer 2 bridge behind its runtime activation check.

**Staged to v1.1:** on-device "Learn my voice now", dialect inference (needs `'auto'` in `Dialect`), style-decision
mining, dictionary auto-growth beyond candidates, reprobing and the 30 % suppression cap as user-visible features,
strength 3, a `document.consistency` UI, and Docs "send as Suggestions" through the REST API.

## 6. Testing

* Unit: vitest in each workspace (shared: node; extension: jsdom; web: node with an in-memory blob store).
* e2e: Playwright loads `apps/extension/dist` into headless Chromium with the mock engine and fixture pages
  (textarea, contenteditable editors, framework fixtures, Gmail-like compose, iframe, Google Docs mock).
* CI: typecheck, unit, build, e2e on every push and PR.
