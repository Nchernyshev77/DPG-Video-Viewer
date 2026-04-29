# Branching

Target branch model:

- `test` is the branch used for staging and GitHub Pages checks.
- `prod` is the branch used for the stable production version.

Suggested flow:

1. Work only in `test`.
2. Point GitHub Pages to `test` while checking a new build.
3. After manual verification, merge `test` into `prod`.
4. Point GitHub Pages back to `prod`.

Current cleanup note: the repository still has `main`, `preview/dpg-video-viewer_1`, and `preview/dpg-video-viewer_2`. After `test` and `prod` are created and verified, the preview branches can be removed.
