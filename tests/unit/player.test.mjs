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
) {
  globalThis.document = { createElement: () => new FakeVideo() };
  return new VideoPlayer({ append() {} }, { readMetadata });
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
  assert.equal(player.currentTime, 2);
  player.video.completeSeek();
  assert.equal(player.video.requests, 2);
  player.stepFrames(1);
  player.stepFrames(1);
  player.video.completeSeek();
  player.video.completeSeek();
  assert.ok(Math.abs(player.currentTime - 62 / 30) < 0.00001);
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
