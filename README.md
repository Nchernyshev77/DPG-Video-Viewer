# DPG Video Viewer — GitHub Pages

Original viewer: https://nchernyshev77.github.io/DPG-Video-Viewer/

Modular preview: https://nchernyshev77.github.io/DPG-Video-Viewer/preview/?check=8f1305c

Source: [refactor/modular-viewer](https://github.com/Nchernyshev77/DPG-Video-Viewer/tree/refactor/modular-viewer), draft [PR #1](https://github.com/Nchernyshev77/DPG-Video-Viewer/pull/1).

Preview commit: `8f1305c3898d7e164bf5b0d99a548e292ab683e4`; assets revision: `7102aace66e6ed58`.

The preview preserves legacy full-buffer Blob preloading and continuous playback rendering. It includes bounded LRU caching, frame stepping that waits for rendered frames, first-frame recovery and loading timeouts. All modules, styles and vendor files share one versioned asset directory; old published paths remain available for existing tabs. See preview/version.json for version and test details.

Validation: 27 unit tests and 13 browser scenarios each in Chromium and Firefox, including synthetic 4K A/B comparison with the original viewer. Actual Windows Floorp, the user's file and network-drive performance require validation in the user's environment.

The root index.html remains the original main viewer (commit b26d5c8be5068f4b9950274e6e0d122b8df39b60). Main is not merged or changed by preview publication.
