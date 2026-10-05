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
    async () => (await import("./src/main.js")).app.player.currentTime,
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
  server = createStaticServer({ root });
  subpathServer = createStaticServer({ root, basePath: "/DPG-Video-Viewer/" });
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
    async () => (await import("./src/main.js")).app,
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
      !app.player.video.seeking &&
      Math.abs(app.player.currentTime - value) < 0.005,
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
    (await import("./src/main.js")).app.view.diagnostics(),
  );
  await page.waitForTimeout(500);
  const after = await page.evaluate(async () =>
    (await import("./src/main.js")).app.view.diagnostics(),
  );
  assert.equal(after.drawCount, before.drawCount);
  assert.equal(after.textures, 1);
  assert.equal(after.mode, "flat");
  assert.deepEqual(external, []);
  await page.screenshot({ path: `${root}/test-results/flat.png` });
  t.diagnostic(
    `Paused draws in 500 ms: ${after.drawCount - before.drawCount}; GPU textures: ${after.textures}`,
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
      (await import("./src/main.js")).app.playlist.select(index);
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
    (await import("./src/main.js")).app.view.diagnostics(),
  );
  assert.equal(memory.textures, 1);
  assert.ok(memory.geometries <= 2);
  await page.locator('.plItem[data-idx="0"] .x').click();
  await page.evaluate(async () => {
    (await import("./src/main.js")).app.playlist.select(1);
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
        (await import("./src/main.js")).app.view.diagnostics().textures,
    ),
    0,
  );
});

test("drop after clearing, decoding error and recovery with WebM", async (t) => {
  const page = await pageFor(t);
  await ready(page, "flat.mp4");
  await page.evaluate(async () =>
    (await import("./src/main.js")).app.playlist.clear(),
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
});
