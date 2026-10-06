import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createStaticServer } from "../../tools/serve.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = `${root}/tests/.fixtures`;
let browser;
let server;
let subpathServer;
let origin;
let subpathOrigin;
const appHandles = new WeakMap();
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const current = (page) =>
  page.evaluate(
    async () =>
      (await import(document.querySelector("script[type=module][src]").src)).app
        .player.currentTime,
  );

before(async () => {
  await mkdir(`${root}/test-results/tmp`, { recursive: true });
  process.env.TMPDIR = `${root}/test-results/tmp`;
  await readFile(`${fixtures}/flat.mp4`); // Generate fixtures first with npm run test:fixtures.
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.DPG_BROWSER_EXECUTABLE || undefined,
    args: [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
    ],
  });
  server = createStaticServer({ root: `${root}/dist` });
  subpathServer = createStaticServer({
    root: `${root}/dist`,
    basePath: "/DPG-Video-Viewer/",
  });
  await listen(server);
  await listen(subpathServer);
  origin = `http://127.0.0.1:${server.address().port}`;
  subpathOrigin = `http://127.0.0.1:${subpathServer.address().port}/DPG-Video-Viewer`;
});
after(async () => {
  await browser?.close();
  server?.close();
  subpathServer?.close();
});

async function pageFor(t, url = origin, options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    ...options,
  });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  t.after(async () => {
    await appHandles.get(page)?.dispose();
    await page.close();
    assert.deepEqual(failures, [], "Unexpected browser errors");
  });
  await page.goto(`${url}/`);
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#viewer canvas")),
  );
  const handle = await page.evaluateHandle(
    async () =>
      (await import(document.querySelector("script[type=module][src]").src))
        .app,
  );
  assert.equal(await page.evaluate((app) => Boolean(app), handle), true);
  appHandles.set(page, handle);
  return page;
}
async function waitReady(page) {
  // waitForFunction polls a synchronous predicate; a Promise is already truthy.
  await page.waitForFunction((app) => app.player.ready, appHandles.get(page));
}
async function ready(page, file) {
  await page.locator("#file").setInputFiles(`${fixtures}/${file}`);
  await page.waitForFunction(
    ({ app, name }) => app.player.item?.name === name && app.player.ready,
    { app: appHandles.get(page), name: file },
  );
}
async function waitSeek(page, time) {
  await page.waitForFunction(
    ({ app, value }) =>
      !app.player.seeking && Math.abs(app.player.currentTime - value) < 0.005,
    { app: appHandles.get(page), value: time },
  );
}

test("local dependencies, actual MP4 decoding and zero idle redraws", async (t) => {
  const page = await pageFor(t);
  const external = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("blob:"))
      external.push(request.url());
  });
  await ready(page, "flat.mp4");
  await page.waitForFunction(
    () => document.getElementById("hudFps").textContent === "FPS: 30",
  );
  assert.equal(await page.locator("#status").isVisible(), false);
  assert.equal(
    await page.evaluate(() => document.getElementById("mediaVideo").paused),
    true,
  );
  await page.waitForTimeout(350);
  const before = await page.evaluate(async () =>
    (
      await import(document.querySelector("script[type=module][src]").src)
    ).app.view.diagnostics(),
  );
  await page.waitForTimeout(500);
  const after = await page.evaluate(async () =>
    (
      await import(document.querySelector("script[type=module][src]").src)
    ).app.view.diagnostics(),
  );
  assert.equal(after.drawCount, before.drawCount);
  assert.equal(after.textures, 1);
  assert.equal(after.mode, "flat");
  assert.deepEqual(external, []);
  const revision = await page.locator("html").getAttribute("data-version");
  assert.match(revision, /^[a-f0-9]{16}$/);
  const staleAssets = await page.evaluate(
    (revision) =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter(
          (url) =>
            /\.(js|css)$/.test(url) && !url.includes(`/assets/${revision}/`),
        ),
    revision,
  );
  assert.deepEqual(
    staleAssets,
    [],
    "Every module and stylesheet belongs to the same release",
  );
  await page.screenshot({ path: `${root}/test-results/flat.png` });
  t.diagnostic(
    `Paused draws in 500 ms: ${after.drawCount - before.drawCount}; GPU textures: ${after.textures}`,
  );
});

test("missing loadeddata and metadata-only preload still present a paused first frame", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if (this instanceof HTMLVideoElement && type === "loadeddata") return;
      return add.call(this, type, listener, options);
    };
    const state = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "readyState",
    );
    const play = HTMLMediaElement.prototype.play;
    const primed = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      ...state,
      get() {
        return primed.has(this)
          ? state.get.call(this)
          : Math.min(1, state.get.call(this));
      },
    });
    HTMLMediaElement.prototype.play = function () {
      primed.add(this);
      return play.call(this);
    };
  });
  await ready(page, "flat.mp4");
  await waitSeek(page, 0);
  await page.evaluate((app) => app.view.drawFrame(), appHandles.get(page));
  const result = await page.evaluate(
    (app) => ({
      diagnostics: app.player.diagnostics(),
      paused: app.player.video.paused,
      textures: app.view.diagnostics().textures,
    }),
    appHandles.get(page),
  );
  assert.equal(result.paused, true);
  assert.equal(result.textures, 1);
  assert.equal(result.diagnostics.width, 320);
  assert.equal(
    result.diagnostics.events.some((event) => event.event === "loadeddata"),
    false,
  );
  assert.equal(
    result.diagnostics.events.some(
      (event) => event.event === "request-first-frame",
    ),
    true,
  );
  assert.equal(await page.locator("#status").isVisible(), false);
  await page.screenshot({
    path: `${root}/test-results/first-frame-recovery.png`,
  });
});

test("a stalled preload can open the original without disabling caching or opening a file picker", async (t) => {
  const page = await pageFor(t);
  let pickers = 0;
  page.on("filechooser", () => pickers++);
  await page.evaluate(() => {
    window.originalReader = FileReader;
    window.FileReader = class extends FileReader {
      readAsArrayBuffer() {}
    };
  });
  await page.locator("#file").setInputFiles(`${fixtures}/flat.mp4`);
  await page.waitForFunction(
    (app) => app.player.cacheState.mode === "reading",
    appHandles.get(page),
  );
  assert.equal(await page.locator("#loadDirect").isVisible(), true);
  await page.screenshot({ path: `${root}/test-results/loading-actions.png` });
  await page.locator("#loadDirect").focus();
  await page.keyboard.press("Enter");
  await waitReady(page);
  assert.equal(pickers, 0);
  assert.equal(await page.locator("#cacheLimit").inputValue(), "2147483648");
  assert.equal(
    await page.evaluate(
      (app) => app.player.cacheState.mode,
      appHandles.get(page),
    ),
    "bypassed",
  );
  await page.evaluate(() => {
    window.FileReader = window.originalReader;
  });
  await ready(page, "vr.mp4");
  assert.equal(
    await page.evaluate(
      (app) => app.player.cacheState.mode,
      appHandles.get(page),
    ),
    "cached",
  );
});

test("an unreadable cached media URL automatically retries the original file", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    let calls = 0;
    URL.createObjectURL = (file) => {
      calls++;
      return create(
        calls === 2
          ? new Blob(["damaged cached media"], { type: "video/mp4" })
          : file,
      );
    };
  });
  await ready(page, "flat.mp4");
  const result = await page.evaluate(
    (app) => ({
      mode: app.player.cacheState.mode,
      original: app.player.video.src === app.player.item.url,
      bytes: app.cache.bytes,
      limit: app.cache.limit,
      diagnostics: app.player.diagnostics(),
    }),
    appHandles.get(page),
  );
  assert.equal(result.mode, "fallback");
  assert.equal(result.original, true);
  assert.equal(result.bytes, 0);
  assert.equal(result.limit, 2147483648);
  assert.ok(
    result.diagnostics.events.some((event) => event.event === "retry-original"),
  );
  assert.equal(await page.locator("#status").isVisible(), false);
});

test("held steps present decoded pixels under CPU load; pointer release stops repeating", async (t) => {
  const page = await pageFor(t);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await ready(page, "flat.mp4");
  for (const cacheLimit of [2147483648, 0]) {
    if (!cacheLimit) {
      await page.locator("#infoBtn").click();
      const position = await current(page);
      await page.locator("#cacheLimit").selectOption("0");
      await waitReady(page);
      await waitSeek(page, position);
      await page.locator("#infoBtn").click();
    }
    const samples = await page.evaluate(async (app) => {
      const canvas = app.view.canvas;
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const pixels = new Uint8Array(64 * 64 * 4);
      const samples = [];
      for (let i = 0; i < 18; i++) {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: "ArrowRight",
            key: "ArrowRight",
            repeat: i > 0,
            bubbles: true,
          }),
        );
        await app.view.drawFrame();
        gl.readPixels(
          Math.floor(canvas.width / 2 - 32),
          Math.floor(canvas.height / 2 - 32),
          64,
          64,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let colored = 0;
        for (let j = 0; j < pixels.length; j += 4)
          if (Math.max(pixels[j], pixels[j + 1], pixels[j + 2]) > 50) colored++;
        samples.push(colored);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { code: "ArrowRight", bubbles: true }),
      );
      return samples;
    }, appHandles.get(page));
    assert.ok(
      samples.every((count) => count > 100),
      `Black frame with cache=${cacheLimit}: ${samples}`,
    );
    t.diagnostic(
      `Cache ${cacheLimit ? "on" : "off"}: ${samples.length} non-black decoded frames at 4× CPU slowdown`,
    );
  }
  await page.evaluate((app) => app.player.seekTo(0.5), appHandles.get(page));
  await waitSeek(page, 0.5);
  await page.locator("#stepFwd").hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.waitForFunction(
    (app) => !app.player.seeking,
    appHandles.get(page),
  );
  const stopped = await current(page);
  assert.ok(
    stopped > 0.6,
    "Holding the pointer advances several displayed frames",
  );
  await page.waitForTimeout(250);
  assert.equal(
    await current(page),
    stopped,
    "Pointer release leaves no repeating backlog",
  );
  assert.equal(
    await page.evaluate((app) => app.player.playing, appHandles.get(page)),
    false,
  );
  await page.screenshot({ path: `${root}/test-results/held-step.png` });
});

test("cached selection avoids rereading files; direct mode preserves position; clear releases the cache", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    let reads = 0;
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (...args) {
      reads++;
      return read.apply(this, args);
    };
    // Test-only counter is held by a getter on the browser's FileReader constructor.
    Object.defineProperty(FileReader, "testReads", { get: () => reads });
  });
  await page
    .locator("#file")
    .setInputFiles([`${fixtures}/flat.mp4`, `${fixtures}/vr.mp4`]);
  await waitReady(page);
  await page.evaluate((app) => app.playlist.select(0), appHandles.get(page));
  await waitReady(page);
  const before = await page.evaluate(() => FileReader.testReads);
  for (const index of [1, 0, 1, 0]) {
    await page.evaluate(({ app, index }) => app.playlist.select(index), {
      app: appHandles.get(page),
      index,
    });
    await waitReady(page);
  }
  assert.equal(await page.evaluate(() => FileReader.testReads), before);
  const cached = await page.evaluate(
    (app) => ({
      bytes: app.cache.bytes,
      size: app.cache.size,
      cached: app.player.cacheState.mode,
      independent: app.player.video.src !== app.player.item.url,
    }),
    appHandles.get(page),
  );
  assert.equal(cached.size, 2);
  assert.ok(cached.bytes > 0);
  assert.equal(cached.cached, "cached");
  assert.equal(cached.independent, true);
  await page.evaluate((app) => app.player.seekTo(1), appHandles.get(page));
  await waitSeek(page, 1);
  await page.locator("#infoBtn").click();
  await page.screenshot({ path: `${root}/test-results/cache-info.png` });
  await page.locator("#cacheLimit").selectOption("0");
  await waitReady(page);
  await waitSeek(page, 1);
  assert.equal(
    await page.evaluate(
      (app) => app.player.video.src === app.player.item.url,
      appHandles.get(page),
    ),
    true,
  );
  await page.evaluate((app) => app.playlist.clear(), appHandles.get(page));
  assert.deepEqual(
    await page.evaluate(
      (app) => ({ bytes: app.cache.bytes, size: app.cache.size }),
      appHandles.get(page),
    ),
    { bytes: 0, size: 0 },
  );
});

test("fractional FPS, frame stepping, editing shortcuts and seek coalescing", async (t) => {
  const page = await pageFor(t);
  await ready(page, "fractional.mp4");
  await page.waitForFunction(
    () => document.getElementById("hudFps").textContent === "FPS: 29.97",
  );
  await page.keyboard.press("ArrowRight");
  await waitSeek(page, 1001 / 30000);
  await page.locator("#hudFrame").click();
  await page.locator("#frameJumpInput").fill("15");
  const before = await current(page);
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    await current(page),
    before,
    "Typing must not trigger viewer hotkeys",
  );
  await page.keyboard.press("Enter");
  await waitSeek(page, (15 * 1001) / 30000);
  await page.evaluate(() => {
    const slider = document.getElementById("fsTimeRange");
    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    for (const value of ["0.7", "1", "1.25"]) {
      slider.value = value;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await waitSeek(page, 1.25);
  assert.equal(
    await page.evaluate(() => document.getElementById("mediaVideo").paused),
    true,
  );
});

test("playlist duplicates, literal filenames, rapid switching and GPU resource cleanup", async (t) => {
  const page = await pageFor(t);
  const buffer = await readFile(`${fixtures}/flat.mp4`);
  const name = "<img src=x onerror=alert(1)>.mp4";
  await page.locator("#file").setInputFiles([
    { name, mimeType: "video/mp4", buffer },
    {
      name: "vr.mp4",
      mimeType: "video/mp4",
      buffer: await readFile(`${fixtures}/vr.mp4`),
    },
    { name, mimeType: "video/mp4", buffer },
  ]);
  await waitReady(page);
  await page.locator("#plistBtn").click();
  assert.equal(await page.locator("#plistPanel img").count(), 0);
  assert.equal(
    await page.locator("#plistPanel .name").first().textContent(),
    name,
  );
  for (let i = 0; i < 12; i++) {
    await page.evaluate(async (index) => {
      (
        await import(document.querySelector("script[type=module][src]").src)
      ).app.playlist.select(index);
    }, i % 2);
    await waitReady(page);
    await page.waitForTimeout(35);
  }
  await page.waitForFunction(
    (app) => app.view.diagnostics().mode === "vr",
    appHandles.get(page),
  );
  await page.screenshot({ path: `${root}/test-results/vr.png` });
  const memory = await page.evaluate(async () =>
    (
      await import(document.querySelector("script[type=module][src]").src)
    ).app.view.diagnostics(),
  );
  assert.equal(memory.textures, 1);
  assert.ok(memory.geometries <= 2);
  await page.locator('.plItem[data-idx="0"] .x').click();
  await page.evaluate(async () => {
    (
      await import(document.querySelector("script[type=module][src]").src)
    ).app.playlist.select(1);
  });
  await waitReady(page);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("video").length),
    1,
  );
  await page.locator("#closeAll").click();
  await page.waitForTimeout(80);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("video").length),
    0,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await import(document.querySelector("script[type=module][src]").src)
        ).app.view.diagnostics().textures,
    ),
    0,
  );
});

test("drop after clearing, decoding error and recovery with WebM", async (t) => {
  const page = await pageFor(t);
  await ready(page, "flat.mp4");
  await page.evaluate(async () =>
    (
      await import(document.querySelector("script[type=module][src]").src)
    ).app.playlist.clear(),
  );
  const bytes = [...(await readFile(`${fixtures}/flat.mp4`))];
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], "dropped.mp4", { type: "video/mp4" }),
    );
    document
      .getElementById("status")
      .dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
      );
  }, bytes);
  await waitReady(page);
  assert.equal(await page.locator("#dropmask").isVisible(), false);
  await page.locator("#file").setInputFiles({
    name: "broken.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("invalid video"),
  });
  await page.waitForFunction(
    (app) => Boolean(app.player.error),
    appHandles.get(page),
  );
  assert.equal(await page.locator("#play").isDisabled(), true);
  assert.equal(await page.locator("#status").isVisible(), true);
  await ready(page, "flat.webm");
  await page.waitForFunction(
    () => document.getElementById("hudFps").textContent === "FPS: 24",
  );
  assert.equal(await page.locator("#status").isVisible(), false);
});

test("play/pause, auto-hide hold and fullscreen panels", async (t) => {
  const page = await pageFor(t);
  await ready(page, "flat.mp4");
  await page.locator("#infoBtn").click();
  await page.locator("#play").click();
  await page.waitForTimeout(2200);
  assert.ok(
    !((await page.locator("#viewer").getAttribute("class")) || "").includes(
      "ui-autoHide",
    ),
  );
  await page.locator("#infoBtn").click();
  await page.waitForFunction(() =>
    document.getElementById("viewer").classList.contains("ui-autoHide"),
  );
  await page.mouse.click(640, 360);
  await page.waitForFunction(
    () => document.getElementById("mediaVideo").paused,
  );
  assert.ok(
    !((await page.locator("#viewer").getAttribute("class")) || "").includes(
      "ui-autoHide",
    ),
  );
  await page.locator("#fsBtn").click();
  await page.waitForFunction(() => document.fullscreenElement?.id === "viewer");
  await page.locator("#infoBtn").click();
  assert.equal(await page.locator("#infoPanel").isVisible(), true);
  assert.equal(
    await page.evaluate(() =>
      document.fullscreenElement.contains(document.getElementById("infoPanel")),
    ),
    true,
  );
  await page.locator("#plistBtn").click();
  assert.equal(
    await page.evaluate(() =>
      document.fullscreenElement.contains(
        document.getElementById("plistPanel"),
      ),
    ),
    true,
  );
  await page.evaluate(() => document.exitFullscreen());
});

test("GitHub Pages subdirectory paths and compact mobile layout", async (t) => {
  const page = await pageFor(t, subpathOrigin, {
    viewport: { width: 375, height: 667 },
  });
  await ready(page, "flat.mp4");
  await page.locator("#plistBtn").click();
  const bounds = await page.locator("#plistPanel").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375);
  const bar = await page.locator("#fsBar").boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 375);
  assert.ok((await page.locator("#fsTimeRange").boundingBox()).width > 0);
  await page.screenshot({ path: `${root}/test-results/mobile.png` });
  await page.locator("#infoBtn").click();
  await page.locator("#loadDetailsPanel summary").click();
  const info = await page.locator("#infoPanel").boundingBox();
  assert.ok(
    info.y + info.height < bar.y,
    "Expanded loading details must leave playback controls accessible",
  );
  await page.screenshot({ path: `${root}/test-results/mobile-info.png` });
});
