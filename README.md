# DPG Video Viewer — GitHub Pages

[Original viewer](https://nchernyshev77.github.io/DPG-Video-Viewer/) · [Modular preview](https://nchernyshev77.github.io/DPG-Video-Viewer/preview/?check=6ac4485)

[Source branch](https://github.com/Nchernyshev77/DPG-Video-Viewer/tree/refactor/modular-viewer) · [Draft PR #1](https://github.com/Nchernyshev77/DPG-Video-Viewer/pull/1)

Preview source commit: `6ac4485030df49e30a8c4db71ed3c3d330b9c26c`; asset revision: `40343446279d17e6`.

The preview preserves full-buffer Blob preloading, bounded LRU caching and rendered-frame stepping. During playback the camera remains stationary until pointer interaction. The VR sphere, filtering and anisotropy match the original viewer. Decoder priming also covers loading before metadata. All modules, styles and vendor files share one asset revision; previous published assets remain available for open tabs.

Validation: 28 unit tests and 15 scenarios each in Chromium and Firefox, including a stationary-camera regression and pre-metadata recovery on the real MP4 decoder. Synthetic 4K A/B measurements run under software WebGL. See preview/version.json and CI artifacts.

The root index.html remains exactly the original viewer from main commit b26d5c8be5068f4b9950274e6e0d122b8df39b60. Preview publication does not change or merge main.
