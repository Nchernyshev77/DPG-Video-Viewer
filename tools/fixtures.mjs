import { mkdir, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../tests/.fixtures/", import.meta.url));
await mkdir(root, { recursive: true });
const fixtures = [
  [
    "flat.mp4",
    "320x180",
    "30",
    ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
  ],
  ["vr.mp4", "360x180", "30", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
  [
    "fractional.mp4",
    "320x180",
    "30000/1001",
    ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
  ],
  ["flat.webm", "320x180", "24", ["-c:v", "libvpx-vp9", "-b:v", "200k"]],
  [
    "vr-4k.mp4",
    "3840x1920",
    "30",
    [
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ],
  ],
];
for (const [name, size, fps, codec] of fixtures) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=${fps}`,
      "-t",
      name === "vr-4k.mp4" ? "8" : "3",
      ...codec,
      `${root}/${name}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status)
    throw new Error(
      `Install ffmpeg to generate fixtures: ${result.stderr || result.error}`,
    );
}
console.log("Generated deterministic MP4 and WebM fixtures");

// Keep the original renderer for reproducible A/B measurements, outside the app.
const legacy = spawnSync(
  "git",
  ["show", "b26d5c8be5068f4b9950274e6e0d122b8df39b60:index.html"],
  { encoding: "utf8" },
);
if (legacy.status)
  throw new Error(
    "Fetch the original commit before generating comparison fixtures",
  );
const assetsRoot = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const [revision] = (await readdir(assetsRoot)).filter((name) =>
  /^[a-f0-9]{16}$/.test(name),
);
if (!revision) throw new Error("Run npm run build before generating fixtures");
let html = legacy.stdout
  .replace(
    "https://unpkg.com/three@0.160.0/build/three.module.js",
    `../${revision}/vendor/three/three.module.min.js`,
  )
  .replace(
    "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module",
    `../${revision}/vendor/three/addons/controls/OrbitControls.js`,
  );
html = html.replace(
  '<script type="module">',
  `<script type="importmap">{"imports":{"three":"../${revision}/vendor/three/three.module.min.js"}}</script><script>window.MP4Box={createFile(){return{appendBuffer(){},flush(){this.onReady({videoTracks:[{nb_samples:240,duration:8,timescale:1}]})}}}}</script><script type="module">`,
);
// Expose existing objects only for tests; playback/rendering code stays unchanged.
html = html.replace(
  "renderer.setAnimationLoop(loop);",
  "renderer.setAnimationLoop(loop); window.legacyViewer = { video, renderer, scene, camera };",
);
await mkdir(`${assetsRoot}/legacy`, { recursive: true });
await writeFile(`${assetsRoot}/legacy/index.html`, html);
