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
  readyState = 0;
  networkState = 2;
  callbacks = new Map();
  requests = 0;
  time = 0;
  dispatchEvent(event) {
    if (event.type === "loadeddata") this.readyState = 4;
    return super.dispatchEvent(event);
  }
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
  setAttribute() {}
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

test("playback callbacks measure FPS and throttle UI without scheduling frame acknowledgements", async () => {
  let paints = 0;
  let updates = 0;
  const player = setup(undefined, {
    presentFrame: () => {
      paints++;
      return Promise.resolve(true);
    },
  });
  player.load(item("play.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  await settle();
  await player.play();
  paints = 0;
  player.addEventListener("update", () => updates++);
  for (let now = 0; now < 320; now += 16) {
    const [id, callback] = player.video.callbacks.entries().next().value;
    player.video.callbacks.delete(id);
    callback(now, { mediaTime: now / 1000, presentedFrames: now / 16 });
  }
  assert.equal(
    paints,
    0,
    "Continuous playback does not wait for seek-style render acknowledgements",
  );
  assert.equal(updates, 4, "20 frame callbacks produce four UI updates");
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

test("canplay and readiness polling recover a missing loadeddata event without duplicate ready events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const player = setup();
  t.after(() => player.dispose());
  let readyEvents = 0;
  player.addEventListener("ready", () => readyEvents++);
  player.load(item("canplay.mp4"));
  player.video.readyState = 1;
  player.video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(player.ready, false, "Metadata alone is not a decoded frame");
  player.video.readyState = 4;
  player.video.dispatchEvent(new Event("canplay"));
  player.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(readyEvents, 1);
  player.load(item("no-events.mp4"));
  player.video.readyState = 2;
  t.mock.timers.tick(200);
  assert.equal(player.ready, true);
  assert.equal(player.loading, false);
  assert.equal(readyEvents, 2);
});

test("loading primes a decoder stalled before metadata and leaves the first frame paused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const player = setup(undefined, { primeDelayMs: 20 });
  t.after(() => player.dispose());
  player.load(item("waiting-for-headers.mp4"));
  const video = player.video;
  assert.equal(video.crossOrigin, "anonymous");
  let starts = 0;
  video.play = async () => {
    starts++;
    video.paused = false;
    video.dispatchEvent(new Event("loadeddata"));
  };
  video.dispatchEvent(new Event("stalled"));
  assert.equal(video.readyState, 0);
  t.mock.timers.tick(20);
  await settle();
  assert.equal(starts, 1);
  assert.equal(player.ready, true);
  assert.equal(player.loading, false);
  assert.equal(video.paused, true);
  assert.equal(player.currentTime, 0);
  assert.ok(
    player
      .diagnostics()
      .events.some((event) => event.event === "request-first-frame"),
  );
});

test("metadata-only loading primes the decoder and restores a paused first frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const player = setup(undefined, { primeDelayMs: 20 });
  t.after(() => player.dispose());
  player.load(item("metadata-only.mp4"));
  const video = player.video;
  let starts = 0;
  video.play = async () => {
    starts++;
    video.paused = false;
    video.time = 0.1;
    video.dispatchEvent(new Event("loadeddata"));
  };
  video.readyState = 1;
  video.dispatchEvent(new Event("loadedmetadata"));
  t.mock.timers.tick(20);
  await settle();
  assert.equal(starts, 1);
  assert.equal(video.paused, true);
  assert.equal(player.currentTime, 0);
  assert.equal(player.ready, false, "Wait for the restored position to decode");
  video.completeSeek();
  await settle();
  assert.equal(player.ready, true);
  assert.equal(player.playing, false);
  assert.equal(player.error, "");
});

test("a browser that requires a user gesture can start without waiting for ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const player = setup(undefined, { primeDelayMs: 20 });
  t.after(() => player.dispose());
  player.load(item("gesture.mp4"));
  const video = player.video;
  video.play = async () => {
    throw new DOMException("Gesture required", "NotAllowedError");
  };
  video.readyState = 1;
  video.dispatchEvent(new Event("loadedmetadata"));
  t.mock.timers.tick(20);
  await settle();
  assert.equal(player.loadStage, "gesture");
  assert.equal(player.loading, true);
  video.play = async () => {
    video.paused = false;
    video.readyState = 4;
    video.dispatchEvent(new Event("canplay"));
  };
  await player.play();
  await settle();
  assert.equal(player.ready, true);
  assert.equal(player.playing, true);
});

test("a suspended Blob with no metadata switches to a cached local file without waiting for the frame deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let backing = "blob",
    copies = 0,
    releases = 0,
    discarded = 0;
  const cache = {
    async prepare(source) {
      return {
        file: source.file,
        url: `blob:${backing}`,
        mode: "cached",
        backing,
      };
    },
    async materialize() {
      copies++;
      backing = "file";
    },
    releaseRetired() {
      releases++;
    },
    discard() {
      discarded++;
    },
  };
  const player = setup(undefined, {
    cache,
    cacheMetadataIdleMs: 20,
    loadTimeoutMs: 1000,
  });
  t.after(() => player.dispose());
  player.load(item("suspended.mp4"));
  await settle();
  player.video.networkState = 1;
  player.video.dispatchEvent(new Event("suspend"));
  t.mock.timers.tick(20);
  await settle();
  assert.equal(copies, 1);
  assert.equal(releases, 1);
  assert.equal(discarded, 0);
  assert.equal(player.video.src, "blob:file");
  player.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(player.ready, true);
  assert.equal(player.video.paused, true);
  assert.equal(player.diagnostics().source, "cached-file");
  t.mock.timers.tick(2000);
  assert.equal(player.ready, true);
  assert.equal(copies, 1, "There is no retry loop");
});

test("unavailable local storage falls back promptly and source replacement cancels late recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let finish,
    discarded = 0,
    calls = 0;
  const cache = {
    async prepare(source) {
      return {
        file: source.file,
        url: `blob:cache-${source.name}`,
        mode: "cached",
        backing: "blob",
      };
    },
    materialize() {
      calls++;
      if (calls === 1)
        return Promise.reject(
          new DOMException("Storage denied", "SecurityError"),
        );
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    discard() {
      discarded++;
    },
  };
  const player = setup(undefined, {
    cache,
    cacheMetadataIdleMs: 20,
    loadTimeoutMs: 1000,
  });
  t.after(() => player.dispose());
  player.load(item("fallback.mp4"));
  await settle();
  player.video.dispatchEvent(new Event("suspend"));
  t.mock.timers.tick(20);
  await settle();
  assert.equal(player.video.src, "blob:fallback.mp4");
  assert.equal(discarded, 1);
  player.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(player.ready, true);
  assert.equal(player.cacheState.mode, "fallback");
  player.load(item("old.mp4"));
  await settle();
  player.video.dispatchEvent(new Event("suspend"));
  t.mock.timers.tick(20);
  await settle();
  player.load(item("new.mp4"));
  await settle();
  const currentVideo = player.video;
  currentVideo.dispatchEvent(new Event("loadeddata"));
  finish();
  await settle();
  t.mock.timers.tick(2000);
  assert.equal(player.video, currentVideo);
  assert.equal(player.item.name, "new.mp4");
  assert.equal(player.ready, true);
});

test("stalled cached media retries the original once, then stops loading with an actionable error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let reads = 0,
    discarded = 0;
  const cache = {
    limit: 1234,
    async prepare(source) {
      reads++;
      return { file: source.file, url: "blob:cached", mode: "cached" };
    },
    discard() {
      discarded++;
    },
    setLimit() {
      throw new Error("Recovery must preserve the cache limit");
    },
  };
  const player = setup(undefined, { cache, loadTimeoutMs: 30 });
  t.after(() => player.dispose());
  player.load(item("stalled.mp4"));
  await settle();
  const old = player.video;
  t.mock.timers.tick(30);
  assert.equal(player.video.src, "blob:stalled.mp4");
  assert.equal(player.cacheState.mode, "fallback");
  assert.equal(discarded, 1);
  old.dispatchEvent(new Event("loadeddata"));
  assert.equal(player.ready, false);
  t.mock.timers.tick(30);
  assert.equal(player.loading, false);
  assert.match(player.error, /did not load/);
  assert.equal(player.loadStage, "error");
  t.mock.timers.tick(100_000);
  assert.equal(reads, 1, "No infinite retry or repeated file reads");
  assert.equal(cache.limit, 1234);
  assert.ok(
    player
      .diagnostics()
      .events.some((event) => event.event === "retry-original"),
  );
});

test("cached decoding errors recover through the original URL and explicit direct retry preserves caching", async () => {
  let reads = 0,
    discarded = 0;
  const cache = {
    limit: 1234,
    async prepare(source) {
      reads++;
      return { file: source.file, url: "blob:cached", mode: "cached" };
    },
    discard() {
      discarded++;
    },
    setLimit() {
      throw new Error("Direct retry must not disable preloading");
    },
  };
  const player = setup(undefined, { cache });
  player.load(item("error.mp4"));
  await settle();
  player.video.error = { code: 3, message: "Decode failed" };
  player.video.dispatchEvent(new Event("error"));
  assert.equal(player.video.src, "blob:error.mp4");
  assert.equal(discarded, 1);
  player.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(player.ready, true);
  player.retry({ direct: true });
  assert.equal(player.cacheState.mode, "bypassed");
  assert.equal(reads, 1);
  assert.equal(cache.limit, 1234);
  player.dispose();
});

test("source replacement cancels load timers and ignores a late rejected decoder request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const player = setup(undefined, { primeDelayMs: 10, loadTimeoutMs: 30 });
  t.after(() => player.dispose());
  player.load(item("old.mp4"));
  let rejectPlay;
  player.video.play = () =>
    new Promise((resolve, reject) => {
      rejectPlay = reject;
    });
  player.video.readyState = 1;
  player.video.dispatchEvent(new Event("loadedmetadata"));
  t.mock.timers.tick(10);
  player.load(item("new.mp4"));
  player.video.dispatchEvent(new Event("loadeddata"));
  rejectPlay(new DOMException("Old request denied", "NotAllowedError"));
  await settle();
  t.mock.timers.tick(1000);
  assert.equal(player.ready, true);
  assert.equal(player.error, "");
  assert.equal(player.loadStage, "ready");
  assert.equal(
    player
      .diagnostics()
      .events.some((event) => event.event === "first-frame-timeout"),
    false,
  );
});
