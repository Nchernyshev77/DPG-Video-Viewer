# DPG Video Viewer — GitHub Pages

Original viewer: https://nchernyshev77.github.io/DPG-Video-Viewer/

Modular preview: https://nchernyshev77.github.io/DPG-Video-Viewer/preview/

Source: [refactor/modular-viewer](https://github.com/Nchernyshev77/DPG-Video-Viewer/tree/refactor/modular-viewer), draft [PR #1](https://github.com/Nchernyshev77/DPG-Video-Viewer/pull/1).

Preview commit: `41807ad356b551c696f78f5475d84f0141d90b03`; assets revision: `d1d0db3e630231f0`.

The preview includes file preloading, bounded LRU caching, frame stepping that waits for rendered frames, first-frame recovery and loading timeouts. All modules, styles and vendor files share one versioned asset directory; old published paths remain available for existing tabs. See preview/version.json for version and test details.

The root index.html remains the original main viewer (commit b26d5c8be5068f4b9950274e6e0d122b8df39b60). Main is not merged or changed by preview publication.
