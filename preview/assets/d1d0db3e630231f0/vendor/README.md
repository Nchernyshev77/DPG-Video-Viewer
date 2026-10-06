# Vendored runtime

Three.js **0.160.0**, matching the original viewer, is included locally so the
application starts without CDN access. The MIT license is in `three/LICENSE`.
Files were downloaded unchanged from the published npm package:

- https://unpkg.com/three@0.160.0/build/three.module.min.js
- https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js
- https://unpkg.com/three@0.160.0/LICENSE

The import map in `index.html` resolves OrbitControls' `three` import to the
same local version. This avoids fetching a different Three.js version via CDN
module rewriting. Upgrade both files together and run the browser tests.
