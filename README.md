# Jammarly

Jammarly is a Grammarly-class writing assistant built as a Chrome extension, with Claude as the engine and a small
companion web app on Vercel for syncing settings and learning your voice across devices.

It underlines problems in any web text field, shows a Grammarly-style hover card with a one-click fix, and adds the
one thing Grammarly never shipped: **Accept all** for grammar, for style and tone, or for everything at once, as one
undoable transaction with per-item revert.

## Install (ready-made build)

You need Chrome 120 or newer.

1. Get the build:
   ```bash
   git clone -b extension-build https://github.com/Julian88Tex/jammarly.git ~/Jammarly
   ```
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the
   `~/Jammarly` folder.
3. The first-run page opens. Read the disclosure, click **I agree and continue**, paste your Anthropic API key and press
   **Test key**. Your key stays on this device.
4. Click into any text field. Local checks appear right away; Claude suggestions follow when you pause typing.

To update, run `git -C ~/Jammarly pull`. Jammarly notices the new files within a minute and reloads itself.

## Releases

Every change merges into `main`. Each push to `main` that passes typecheck and tests publishes the extension to the
`extension-build` branch (`.github/workflows/publish-build.yml`), which is what the install above loads.

## What it does

- **Four suggestion categories** with Grammarly's colors: correctness (red), clarity (blue), engagement (green),
  delivery (purple). Suggestions are minimal, meaning-preserving, anchored to exact spans, and silent on acceptable text.
- **Two engines working together.** Deterministic local rules run on every keystroke (spacing, repeated words,
  capitalization, a/an, high-precision confusables, doubled punctuation). Claude runs in two passes: a fast pass with
  `claude-haiku-5-5` while you pause, and a deep pass with `claude-opus-5-5` when you stop, blur or paste.
- **Hover UI** that matches Grammarly's: 2 px underlines, a hover card (category, title, struck-through original, bold
  replacement you can click, explanation, Accept / Dismiss / Add to dictionary / More), a floating button with a count
  badge and tone chip, and a side panel that lists everything by category.
- **Accept all grammar / Accept all style and tone / Accept everything**, with a preview, a toast with Undo, a
  "Recently applied" list with per-item revert, and the native undo stack preserved where the host editor allows it.
- **Works across editors**: textareas and inputs, Gmail, Superhuman, Slashy, Slack, Notion, ChatGPT and Claude.ai
  (ProseMirror), LinkedIn, X, Discord, Facebook, WordPress, Reddit, GitHub, plus a side-panel paste, check, accept all
  and copy flow for canvas apps. Google Docs gets inline underlines when Docs exposes its annotation API for the
  extension, and the side-panel flow otherwise.
- **Learns from you.** Every accept, dismiss and ignore is a feedback event. A deterministic learner (Wilson bounds)
  suppresses or demotes rules you keep rejecting per site, per context and globally, grows your dictionary, and never
  learns away a high-confidence correctness error. A nightly job synthesizes an editable **voice profile** that is
  injected into the prompt so suggestions match how you actually write.
- **Syncs across devices** through the web app: goals, categories, dialect, custom instructions, dictionary, muted
  rules, site overrides, voice profiles and learned state live in one profile document merged with CRDT semantics.
  Your Anthropic API key stays on each device and is never synced.
- **Bring your own key.** Text is sent to Anthropic with your own API key only after you agree on the first-run page.
  A daily budget caps spend; the mock engine lets you try everything without a key.

## Repository layout

```
apps/extension   Chrome MV3 extension (TypeScript, esbuild, vitest + jsdom, Playwright e2e in headless Chromium)
apps/web         Next.js 16 companion app on Vercel (JSlice sign-in, device pairing, profile sync, learning, dashboard)
packages/shared  @jammarly/shared: contracts, text utilities, local rules, prompts and anchoring, learner, CRDT merge
docs             ARCHITECTURE.md is the design source of truth
```

## Install the extension (developer build)

Prerequisites: Node 24 and npm 10 (`.nvmrc` is set), Chrome 120 or newer.

```bash
npm ci
npm run build                      # builds packages, the extension (apps/extension/dist) and the web app
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `apps/extension/dist`.
   The manifest pins a stable extension id (`apps/extension/EXTENSION_ID`), so reloads keep the same id.
2. The first-run page opens. Read the disclosure, click **I agree and continue**, paste an Anthropic API key and press
   **Test key** (or choose **Use the mock engine** in a dev build to try the UI without a key).
3. Focus any text field. Local checks appear immediately; Claude suggestions follow when you pause.

Shortcuts (editable at `chrome://extensions/shortcuts`): `Alt+Shift+J` opens the popup, `Alt+Shift+G` toggles
Jammarly on the current site, `Alt+Shift+A` accepts everything in the focused field (grammar, style and tone). Change the keys on the settings page under Keyboard shortcuts.

To rebuild on change: `npm run extension -- watch`, then reload the extension.

## Deploy the companion web app (optional)

The extension works fully offline from the web app. Deploy it when you want settings and learning to sync across
devices and a nightly voice-profile job. Full instructions, the environment variable table and the API are in
`apps/web/README.md`; the short version:

1. Create a Vercel project from this repository with **Root Directory** `apps/web` (Fluid Compute, region `iad1`).
2. Create one **private** Blob store and connect it to the project.
3. Set the environment variables: `SESSION_SECRET` (random, 32+ chars), `CRON_SECRET`, `JSLICE_URL`
   (`https://jslice.vercel.app`; sign-in is Google single sign-on through JSlice, for any number of users),
   `APP_ORIGIN` (the production alias, e.g. `https://jammarly-web.vercel.app`), `EXTENSION_IDS` (the id from `apps/extension/EXTENSION_ID`) and
   optionally `ANTHROPIC_API_KEY` for the server-side learning job (it can also be entered on the dashboard).
4. Deploy. Then rebuild the extension with `JAMMARLY_APP_ORIGIN=https://<your alias> npm run build` so the build can
   accept pairing messages from your dashboard, and reload it.
5. Sign in with **Continue with JSlice**, open **Overview** and click **Pair a device**; the extension picks up the code automatically, or
   you type it into the extension's options page under **Sync**.

## Development

```bash
npm run typecheck            # every workspace
npm test                     # vitest: shared (node), extension (jsdom), web (node)
npm run build                # esbuild bundles + next build
npm run test:e2e             # Playwright: loads apps/extension/dist into headless Chromium with the mock engine
npm run extension -- watch   # rebuild the extension on change
npm run web -- dev           # Next.js dev server for the web app (uses an in-memory blob store without a token)
```

CI runs typecheck, unit tests, build and the e2e suite on every push and pull request.

## How it works, briefly

The content script detects eligible fields, keeps a plain-text model with a version and a diff log, runs local rules
on every change, and asks the service worker for a Claude pass when you pause. The worker builds a cached prompt
from your goals, dialect, style decisions, dictionary, custom instructions and voice profile, streams a structured
JSON response, anchors every suggestion back to the real text by verbatim string match (never model offsets),
resolves overlaps, assigns tiers (A: mechanical correctness fixes, B: meaning-preserving style edits, C: rewrites and
flags) and caches results per paragraph so re-checks never flicker. Edits are applied through a per-editor ladder
(`execCommand`, `beforeinput`, synthetic paste, direct DOM splice) and verified after each step, so framework editors
that revert foreign changes are handled. Everything is specified in `docs/ARCHITECTURE.md`.

## Privacy

Nothing leaves your browser until you agree on the first-run page. Text in fields you check is sent to Anthropic with
your own API key. Feedback events carry short redacted snippets only when snippet storage is on, never from password,
payment or private-site fields, and the web app strips snippets server-side when you turn storage off. Export and
delete all learning data from the web app's **Privacy and data** page.

## License

MIT
