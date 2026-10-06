import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  formatTime,
  formatFPS,
  isVideoFile,
  projectionFor,
} from "../../src/core/format.js";

test("time and fractional FPS formatting handle boundaries", () => {
  assert.equal(formatTime(Infinity), "00:00");
  assert.equal(formatTime(-10), "00:00");
  assert.equal(formatTime(3661.9), "1:01:01");
  assert.equal(formatFPS(30000 / 1001), "29.97");
  assert.equal(formatFPS(null), "—");
  assert.equal(clamp(NaN, 0, 10), 0);
});
test("video detection accepts missing MIME types and projection preserves 2:1 behavior", () => {
  assert.ok(isVideoFile({ name: "clip.MP4", type: "" }));
  assert.ok(isVideoFile({ name: "clip", type: "video/webm" }));
  assert.ok(!isVideoFile({ name: "notes.txt", type: "text/plain" }));
  assert.equal(projectionFor(3840, 1920), "vr");
  assert.equal(projectionFor(1920, 1080), "flat");
  assert.equal(projectionFor(0, 0), "flat");
});
