# LWL Instagram Downloader

**Save Instagram profiles into organized folders.**

Save individual posts, carousels, stories and highlights to dated folders. Use **Download All** on a profile to save its posts in a subfolder named after the account. Downloads use your browser's Downloads directory.

This repository provides the LWL patch source and local build tools. You supply a locally obtained copy of [Turbo Downloader for Instagram](https://chromewebstore.google.com/detail/turbo-downloader-for-inst/cpgaheeihidjmolbakklolchdplenjai). The build checks the upstream version it supports.

## Build and load

On Linux, install Python 3, Node.js and ImageMagick. Point the builder at the unpacked upstream extension directory, which contains its `manifest.json`.

```sh
LWL_UPSTREAM_DIR=/path/to/upstream-extension python3 build_local.py
```

Open `edge://extensions` or `chrome://extensions`, enable Developer mode, and use **Load unpacked** to select the generated `extension/` directory. Disable the original extension while using the patched copy, then refresh Instagram.

## Use the download buttons

Open a profile and choose **Download All** for a batch, or use the download button on an individual post or story. To recover a buffered highlight video, reload the Instagram page before opening the highlight so the extension can capture the video as it loads.

Automatic folders are enabled by default. You can choose RegExp Organizer mode in the extension's options if you prefer to manage Instagram routing there.

## Feedback

Report a bug or request through [GitHub Issues](https://github.com/longweekendlabs/instagram-turbo-repair/issues).

## Attribution

Turbo Downloader for Instagram is provided by igdownloader2023. The local builder preserves upstream notices. This repository distributes the LWL patch sources. Upstream extension files and generated builds are obtained or assembled locally.

© 2026 Long Weekend Labs

Made with ♥ by Long Weekend Labs
