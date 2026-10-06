import { createLifecycle } from "./core/lifecycle.js";
import { Playlist } from "./media/playlist.js";
import { VideoPlayer } from "./media/player.js";
import { VideoCache } from "./media/cache.js";
import { createViewer } from "./rendering/viewer.js";
import { getElements } from "./ui/elements.js";
import { createHUD } from "./ui/hud.js";
import { createPanels } from "./ui/panels.js";
import { createAutoHide } from "./ui/auto-hide.js";
import { bindInput } from "./ui/input.js";

export function createApp() {
  const elements = getElements();
  const life = createLifecycle();
  const playlist = new Playlist();
  const cache = new VideoCache();
  const player = new VideoPlayer(elements.viewer, {
    cache,
    presentFrame: () => view.drawFrame(),
  });
  let notice = "";
  let lastStatus = "";
  let lastCacheStatus = "";

  function updateStatus() {
    const message =
      notice ||
      player.error ||
      (player.loading
        ? player.cacheState.mode === "reading"
          ? `Preloading: ${player.item.name} — ${Math.round((100 * player.cacheState.read) / Math.max(1, player.cacheState.total))}%`
          : `Loading: ${player.item.name}`
        : !player.item
          ? "Drag & Drop a video here or click here."
          : "");
    elements.progress.hidden = player.cacheState.mode !== "reading";
    if (player.cacheState.mode === "reading")
      elements.progress.value =
        player.cacheState.read / Math.max(1, player.cacheState.total);
    const cacheMode = player.cacheState.mode;
    if (elements.cacheLimit.value !== String(cache.limit))
      elements.cacheLimit.value = String(cache.limit);
    elements.cacheSkip.hidden = cacheMode !== "reading";
    const cacheStatus =
      cacheMode === "cached"
        ? `Preloaded: ${(player.cacheState.total / 1024 ** 2).toFixed(1)} MB. Cache: ${(cache.bytes / 1024 ** 2).toFixed(1)} MB.`
        : cacheMode === "reading"
          ? "Preloading the selected file. You can open it directly below."
          : cacheMode === "oversized"
            ? "File exceeds the cache limit; playing directly from disk."
            : cacheMode === "failed"
              ? "Preloading failed; playing directly from disk."
              : cacheMode === "disabled"
                ? "Preloading off; playing directly from disk."
                : "Files are preloaded when selected. Least recently used files are released at the limit.";
    if (cacheStatus !== lastCacheStatus) {
      elements.cacheStatus.textContent = cacheStatus;
      lastCacheStatus = cacheStatus;
    }
    if (message === lastStatus) return;
    lastStatus = message;
    elements.statusText.textContent = message;
    elements.status.classList.toggle("show", Boolean(message));
    elements.introBackdrop.classList.toggle("show", !player.ready);
    elements.status.setAttribute("aria-label", message || "Choose a video");
    if (!message && document.activeElement === elements.status)
      elements.status.blur();
  }

  const onError = (message) => {
    notice = message;
    updateStatus();
  };
  const view = createViewer(elements.viewer, {
    onError,
    onRestore() {
      notice = "";
      updateStatus();
    },
  });
  const hud = createHUD(elements, player);
  const panels = createPanels(elements, playlist);
  const autoHide = createAutoHide(elements, player);
  const input = bindInput({
    elements,
    player,
    playlist,
    view,
    panels,
    onError,
  });
  life.on(elements.cacheLimit, "change", () =>
    player.reloadCache(Number(elements.cacheLimit.value)),
  );
  life.on(elements.cacheSkip, "click", () => player.reloadCache(0));

  life.on(playlist, "change", (event) => {
    if (event.detail.selectionChanged) {
      const autoplay = player.playing;
      hud.cancelEdit();
      notice = "";
      player.load(playlist.current, { autoplay });
    }
    cache.prune(playlist.items.map((item) => item.file));
    if (event.detail.structureChanged) panels.render();
    else panels.updateActive();
  });
  life.on(player, "unload", view.clear);
  life.on(player, "ready", () => {
    view.setVideo(player.video);
    hud.update(true);
  });
  life.on(player, "update", () => {
    updateStatus();
    view.setPlaying(player.playing);
    hud.update(!player.playing);
  });
  // Pause on background tabs; recovery does not unexpectedly resume playback.
  life.on(document, "visibilitychange", () => {
    if (document.hidden) player.pause();
  });
  updateStatus();

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    input.dispose();
    autoHide.dispose();
    panels.dispose();
    hud.dispose();
    player.dispose();
    life.dispose();
    playlist.dispose();
    cache.dispose();
    view.dispose();
  }
  // A page stored in the back-forward cache remains usable when restored.
  life.on(window, "pagehide", (event) => {
    if (!event.persisted) dispose();
    else player.pause();
  });
  return { playlist, player, view, cache, dispose };
}
