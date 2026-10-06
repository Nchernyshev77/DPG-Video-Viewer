import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoPlayer } from "../../src/media/player.js";

class FakeVideo extends EventTarget {
  paused = true;
  seeking = false;
  duration = 3;
  videoWidth = 320;
  videoHeight = 180;
  ended = false;
  readyState = 4;
  callbacks = new Map();
  requests = 0;
  time = 0;
  set currentTime(value) {
    this.time = value;
    this.seeking = true;
    this.requests++;
  }
  get currentTime() {
    return this.time;
  }
  completeSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  load() {}
  remove() {}
  removeAttribute() {}
  requestVideoFrameCallback(fn) {
    const id = this.callbacks.size + 1;
    this.callbacks.set(id, fn);
    return id;
  }
  cancelVideoFrameCallback(id) {
    this.callbacks.delete(id);
  }
}
function setup(
  readMetadata = async () => ({
    fps: 30,
    source: "metadata",
    variableFrameRate: false,
  }),
  options = {},
) {
  globalThis.document = { createElement: () => new FakeVideo() };
  return new VideoPlayer({ append() {} }, { readMetadata, ...options });
}
const item = (name) => ({ name, file: { name }, url: `blob:${name}` });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("seek queue coalesces intermediate positions and does not repeat the same seek forever", async () => {
  const player = setup();
  player.load(item("a.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  await settle();
  player.seekTo(1);
  player.seekTo(1.5);
  player.seekTo(2);
  assert.equal(player.video.requests, 1);
  player.video.completeSeek();
  await settle();
  assert.equal(player.currentTime, 2);
  player.video.completeSeek();
  await settle();
  assert.equal(player.video.requests, 2);
  player.stepFrames(1);
  player.stepFrames(1);
  player.video.completeSeek();
  await settle();
  player.video.completeSeek();
  await settle();
  assert.ok(Math.abs(player.currentTime - 62 / 30) < 0.001);
  player.dispose();
});

test("seek waits for decoded data and renderer acknowledgement; repeats do not build a backlog", async () => {
  const paints = [];
  const player = setup(undefined, {
    presentFrame: () => new Promise((resolve) => paints.push(resolve)),
  });
  player.load(item("slow.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  paints.shift()(true);
  await settle();
  player.stepFrames(1);
  for (let i = 0; i < 100; i++) player.stepFrames(1, { repeat: true });
  player.video.readyState = 1;
  player.video.completeSeek();
  assert.equal(paints.length, 0, "No upload of an undecoded frame");
  assert.equal(player.video.requests, 1);
  player.video.readyState = 4;
  player.video.dispatchEvent(new Event("canplay"));
  assert.equal(paints.length, 1);
  await settle();
  assert.equal(
    player.video.requests,
    1,
    "seeked alone must not start the next seek",
  );
  paints.shift()(true);
  await settle();
  assert.equal(player.video.requests, 2);
  assert.ok(Math.abs(player.currentTime - 2 / 30) < 0.001);
  player.video.completeSeek();
  paints.shift()(true);
  await settle();
  assert.equal(
    player.video.requests,
    2,
    "100 repeat events retain only one extra frame",
  );
  player.dispose();
});

test("keyup cancels queued repeat and old renderer acknowledgements cannot seek a replacement", async () => {
  const paints = [];
  const player = setup(undefined, {
    presentFrame: () => new Promise((resolve) => paints.push(resolve)),
  });
  player.load(item("old.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  paints.shift()(true);
  await settle();
  player.stepFrames(1);
  player.stepFrames(1, { repeat: true });
  player.stopStepping();
  player.video.completeSeek();
  paints.shift()(true);
  await settle();
  assert.equal(player.video.requests, 1);
  player.stepFrames(1);
  player.stepFrames(1, { repeat: true });
  player.video.completeSeek();
  const oldPaint = paints.shift();
  player.load(item("new.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  paints.shift()(true);
  oldPaint(true);
  await settle();
  assert.equal(player.video.requests, 0);
  player.dispose();
});
test("late metadata and media events from a previous file cannot change the current source", async () => {
  const pending = [];
  const player = setup(() => new Promise((resolve) => pending.push(resolve)));
  player.load(item("old.mp4"));
  const oldVideo = player.video;
  oldVideo.dispatchEvent(new Event("loadeddata"));
  await player.play();
  assert.equal(oldVideo.callbacks.size, 1);
  player.load(item("new.mp4"));
  assert.equal(oldVideo.callbacks.size, 0);
  oldVideo.dispatchEvent(new Event("loadeddata"));
  assert.equal(player.ready, false);
  pending[0]({ fps: 60, source: "metadata" });
  await settle();
  assert.equal(player.fps, null);
  pending[1]({ fps: 24, source: "metadata" });
  await settle();
  assert.equal(player.fps, 24);
  player.dispose();
});
test("repeated scrub start preserves playback intent and source replacement cancels it", async () => {
  const player = setup();
  player.load(item("a.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  await player.play();
  player.beginScrub();
  player.beginScrub();
  assert.equal(player.playing, false);
  player.endScrub();
  assert.equal(player.playing, true);
  player.beginScrub();
  player.load(item("b.mp4"));
  player.endScrub();
  assert.equal(player.playing, false);
  player.dispose();
});

test("source replacement aborts a slow preload and ignores its late completion", async () => {
  const pending = [];
  const player = setup(undefined, {
    cache: {
      prepare(source, signal) {
        return new Promise((resolve) =>
          pending.push({ source, signal, resolve }),
        );
      },
      setLimit() {},
    },
  });
  player.load(item("old.mp4"));
  assert.equal(player.video, null);
  player.load(item("new.mp4"));
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ url: "blob:cache-new", file: pending[1].source.file });
  await settle();
  const current = player.video;
  assert.equal(current.src, "blob:cache-new");
  pending[0].resolve({ url: "blob:cache-old", file: pending[0].source.file });
  await settle();
  assert.equal(player.video, current);
  assert.equal(player.item.name, "new.mp4");
  player.dispose();
});
