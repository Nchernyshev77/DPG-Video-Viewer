import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoCache } from "../../src/media/cache.js";

const item = (name, text = "abcdef") => ({
  file: new File([text], name, { type: "video/mp4", lastModified: 10 }),
  url: `blob:original-${name}`,
});
function setup(options = {}) {
  const revoked = [];
  const reads = [];
  let id = 0;
  const cache = new VideoCache({
    limit: 12,
    urls: {
      createObjectURL: () => `blob:cache-${++id}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    read: async (blob) => {
      reads.push(blob.size);
      return blob.arrayBuffer();
    },
    ...options,
  });
  return { cache, reads, revoked };
}

test("preload preserves bytes in one flat Blob and reuses a selected File", async () => {
  const { cache, reads, revoked } = setup();
  const source = item("remote.mp4");
  const states = [];
  const first = await cache.prepare(source, undefined, (state) =>
    states.push(state),
  );
  assert.equal(await first.file.text(), "abcdef");
  assert.equal(first.file.name, source.file.name);
  assert.equal(first.file.type, source.file.type);
  assert.deepEqual(reads, [6]);
  assert.equal(first.file instanceof Blob, true);
  assert.equal(first.file instanceof File, false);
  assert.equal(states.at(-1).read, 6);
  assert.equal(await cache.prepare(source), first);
  assert.equal(
    reads.length,
    1,
    "Switching back does not reread the network file",
  );
  cache.dispose();
  assert.deepEqual(revoked, [first.url]);
});

test("LRU bounds the aggregate cache; same-name files remain independent; removal releases bytes", async () => {
  const { cache, revoked } = setup();
  const a = item("same.mp4"),
    b = item("same.mp4", "123456"),
    c = item("c.mp4");
  const first = await cache.prepare(a),
    second = await cache.prepare(b);
  assert.equal(cache.bytes, 12);
  assert.notEqual(first.url, second.url);
  await cache.prepare(a); // a is most recently used.
  await cache.prepare(c);
  assert.deepEqual(revoked, [second.url]);
  assert.equal(cache.bytes, 12);
  cache.prune([a.file]);
  assert.equal(cache.bytes, 6);
  cache.setLimit(0);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});

test("oversized and disabled caching skip reads; failed preload falls back to original source", async () => {
  const source = item("big.mp4");
  const { cache, reads } = setup({ limit: 4 });
  assert.equal((await cache.prepare(source)).url, source.url);
  assert.equal((await cache.prepare(source)).mode, "oversized");
  cache.setLimit(0);
  assert.equal((await cache.prepare(source)).mode, "disabled");
  assert.deepEqual(reads, []);
  const failed = setup({
    read: async () => {
      throw new Error("Disconnected network drive");
    },
  }).cache;
  const result = await failed.prepare(source);
  assert.equal(result.mode, "failed");
  assert.equal(result.url, source.url);
  assert.equal(failed.bytes, 0);
});

test("cancelled preloading never publishes a partial cached file or URL", async () => {
  const controller = new AbortController();
  const { cache } = setup({
    read: async (blob) => {
      controller.abort();
      return blob.arrayBuffer();
    },
  });
  await assert.rejects(cache.prepare(item("cancel.mp4"), controller.signal), {
    name: "AbortError",
  });
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

function fakeReader(t) {
  const readers = [];
  const original = globalThis.FileReader;
  globalThis.FileReader = class {
    aborted = false;
    constructor() {
      readers.push(this);
    }
    readAsArrayBuffer() {}
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  };
  t.after(() => {
    if (original) globalThis.FileReader = original;
    else delete globalThis.FileReader;
  });
  return readers;
}

test("an unresponsive FileReader is aborted and falls back without publishing partial data", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const readers = fakeReader(t);
  const { cache } = setup({ read: undefined, readTimeoutMs: 20 });
  const source = item("unresponsive.mp4");
  const pending = cache.prepare(source);
  t.mock.timers.tick(20);
  assert.equal((await pending).mode, "failed");
  assert.equal(readers[0].aborted, true);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});

test("real read progress renews the timeout; cancellation immediately rejects even if abort emits nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const readers = fakeReader(t);
  const { cache } = setup({ read: undefined, readTimeoutMs: 20 });
  const source = item("slow.mp4");
  const data = await source.file.arrayBuffer();
  const pending = cache.prepare(source);
  t.mock.timers.tick(15);
  readers[0].onprogress({ loaded: 1 });
  t.mock.timers.tick(15);
  assert.equal(readers[0].aborted, false);
  readers[0].result = data;
  readers[0].onload();
  assert.equal((await pending).mode, "cached");
  const controller = new AbortController();
  const cancelled = cache.prepare(item("cancelled.mp4"), controller.signal);
  readers[1].abort = () => {
    readers[1].aborted = true;
  };
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(readers[1].aborted, true);
  t.mock.timers.tick(1000);
  assert.equal(cache.size, 1);
  cache.dispose();
});
