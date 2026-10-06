# DPG Video Viewer — GitHub Pages

This publishing branch contains two static versions:

- `/`: the existing main viewer, copied unchanged from `b26d5c8be5068f4b9950274e6e0d122b8df39b60`. Its index.html blob SHA is unchanged.
- `/preview/`: the modular viewer from `refactor/modular-viewer`, commit `e95f0b0fb8d29445b66571a0444406c43e537885`.

The preview restores selected-file preloading with a 2 GiB aggregate LRU budget (configurable in Info). Held frame steps wait for decoded data and an actual WebGL render; repeated keys cannot outrun the display. Source code passed 18 unit and 8 Chromium tests, including 4x CPU throttling with caching on and off: https://github.com/Nchernyshev77/DPG-Video-Viewer/actions/runs/37450721382

Neither this publication nor the refactor has been merged into main. GitHub Pages publishes from gh-pages, /(root). The existing viewer remains at the root URL and the test version opens at /preview/. Reload the preview without browser cache after updates (Ctrl+F5).

The preview is a tested source snapshot. Its source branch contains architecture and audit documentation. The .nojekyll file serves JavaScript and vendor assets directly.
