import { createLifecycle } from "./core/lifecycle.js";
import { Playlist } from "./media/playlist.js";
import { VideoPlayer } from "./media/player.js";
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
  const player = new VideoPlayer(elements.viewer);
  let notice = "";
  let lastStatus = "";

  function updateStatus() {
    const message =
      notice ||
      player.error ||
      (player.loading
        ? `Loading: ${player.item.name}`
        : !player.item
          ? "Drag & Drop a video here or click here."
          : "");
    if (message === lastStatus) return;
    lastStatus = message;
    elements.statusText.textContent = message;
    elements.status.classList.toggle("show", Boolean(message));
    elements.introBackdrop.classList.toggle("show", !player.ready);
    elements.progress.hidden = true;
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

  life.on(playlist, "change", (event) => {
    if (event.detail.selectionChanged) {
      const autoplay = player.playing;
      hud.cancelEdit();
      notice = "";
      player.load(playlist.current, { autoplay });
    }
    if (event.detail.structureChanged) panels.render();
    else panels.updateActive();
  });
  life.on(player, "unload", view.clear);
  life.on(player, "ready", () => {
    view.setVideo(player.video);
    hud.update(true);
  });
  life.on(player, "frame", view.drawFrame);
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
    view.dispose();
  }
  // A page stored in the back-forward cache remains usable when restored.
  life.on(window, "pagehide", (event) => {
    if (!event.persisted) dispose();
    else player.pause();
  });
  return { playlist, player, view, dispose };
}
