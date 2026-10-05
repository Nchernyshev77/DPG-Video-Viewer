import { mkdir } from "node:fs/promises";
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
      "3",
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
