# DPG Video Viewer — GitHub Pages

This branch contains two static versions of the viewer:

- `/`: the existing `main` viewer, copied unchanged from commit `b26d5c8be5068f4b9950274e6e0d122b8df39b60`.
- `/preview/`: the modular viewer from `refactor/modular-viewer`, commit `04a789e6285677c5c59d1fb64036458e6015a25c`.

The root `index.html` has the same Git blob SHA as `main`. Neither the `main` branch nor the refactor branch is changed by preparing this publishing branch.

To publish both versions, select **Settings → Pages → Deploy from a branch → gh-pages → /(root) → Save**. Keep the existing domain and HTTPS settings. The existing viewer stays at the root URL and the preview opens at the same URL followed by `/preview/`.

The preview is a snapshot of the tested refactor. Update it from that source branch when publishing a newer preview. The `.nojekyll` file ensures JavaScript modules and vendor files are served as static assets.
