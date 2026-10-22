# Jammarly extension build

This branch holds the ready-to-load Chrome extension, rebuilt automatically after every passing change.

Install once:

1. `git clone -b extension-build https://github.com/Julian88Tex/jammarly.git ~/Jammarly`
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `~/Jammarly` folder.

Update: run `git -C ~/Jammarly pull`. Jammarly notices the new files within a minute and reloads itself.
