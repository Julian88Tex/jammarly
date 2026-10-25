# Jammarly

Jammarly is a Grammarly-style writing assistant for Chrome, powered by Claude. It underlines problems in any web text
field, offers one-click fixes in a hover card, and can accept every grammar or style suggestion at once.

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

To update later, run `git -C ~/Jammarly pull`. Jammarly notices the new files within a minute and reloads itself.

Shortcuts (change them at `chrome://extensions/shortcuts`): `Alt+Shift+J` opens the popup.

## Build from source

The source lives on the [`feat/jammarly-extension`](https://github.com/Julian88Tex/jammarly/tree/feat/jammarly-extension)
branch until it is merged. You need Node 24 and npm 10.

```bash
git clone -b feat/jammarly-extension https://github.com/Julian88Tex/jammarly.git
cd jammarly
npm ci
npm run build    # builds the shared package, the extension (apps/extension/dist) and the web app
```

Then load `apps/extension/dist` with **Load unpacked** as above. That branch's README covers the companion web app,
tests and architecture.

## Branches

- `extension-build`: the ready-to-load extension, rebuilt automatically after every passing change.
- `feat/jammarly-extension`: the source (extension, companion web app and shared package).
