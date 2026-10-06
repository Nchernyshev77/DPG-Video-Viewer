import { CONFIG } from "../config.js";
import { formatFPS, formatTime } from "../core/format.js";
import { createLifecycle } from "../core/lifecycle.js";

const PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l10 7l-10 7z"/></svg>';
const PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7z"/><path d="M13 5h4v14h-4z"/></svg>';

export function createHUD(elements, player) {
  const life = createLifecycle();
  let lastUpdate = -Infinity;
  let lastPlaying = null;
  let edit = null;

  function update(force = false) {
    const playing = player.playing;
    if (playing !== lastPlaying) {
      elements.playIcon.innerHTML = playing ? PAUSE : PLAY; // Static, trusted SVG only.
      elements.playLabel.textContent = playing ? "Pause" : "Play";
      elements.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
      lastPlaying = playing;
    }
    for (const button of [
      elements.playBtn,
      elements.stepBackBtn,
      elements.stepFwdBtn,
    ])
      button.disabled = !player.ready;
    elements.timeSlider.disabled = elements.fsTimeRange.disabled =
      !player.ready;
    const now = performance.now();
    if (!force && now - lastUpdate < CONFIG.uiIntervalMs) return;
    lastUpdate = now;
    const time = `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
    elements.tc.textContent = elements.fsTime.textContent = time;
    for (const slider of [elements.timeSlider, elements.fsTimeRange]) {
      slider.max = player.duration.toFixed(3);
      if (!player.scrubbing) slider.value = player.currentTime.toFixed(3);
    }
    const approximate =
      player.fpsSource !== "metadata" || player.variableFrameRate;
    elements.hudFps.textContent = `FPS: ${player.fps && approximate ? "~" : ""}${formatFPS(player.fps)}`;
    elements.hudFps.classList.toggle(
      "fps-warning",
      Boolean(player.fps && Math.round(player.fps) !== 30),
    );
    elements.hudFps.title = player.variableFrameRate
      ? "Variable frame rate: average FPS; frame positions are approximate"
      : player.fpsSource === "metadata"
        ? "FPS from container metadata"
        : "Estimated FPS; frame positions are approximate";
    if (!edit) {
      const frame = player.fps
        ? Math.max(0, Math.round(player.currentTime * player.fps))
        : "—";
      elements.hudFrame.textContent = `Frame: ${frame}${player.totalFrames ? ` / ${player.totalFrames}` : ""}`;
    }
  }

  function finishEdit(commit = false) {
    if (!edit) return;
    const input = edit;
    edit = null; // Removing a focused input can emit blur; make completion idempotent.
    if (commit && input.value.trim() && Number.isFinite(Number(input.value)))
      player.jumpToFrame(Number(input.value));
    input.remove();
    update(true);
    elements.viewer.dispatchEvent(new Event("panelschange"));
  }

  function beginEdit() {
    if (!player.ready || edit) return;
    player.pause();
    edit = document.createElement("input");
    edit.id = "frameJumpInput";
    edit.type = "number";
    edit.step = "1";
    edit.min = "0";
    edit.max = String(
      Math.max(0, Math.round(player.duration * player.effectiveFPS) - 1),
    );
    edit.value = String(Math.round(player.currentTime * player.effectiveFPS));
    edit.setAttribute("aria-label", "Frame number");
    elements.hudFrame.replaceChildren(document.createTextNode("Frame: "), edit);
    edit.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finishEdit(event.key === "Enter");
      }
    });
    edit.addEventListener("blur", () => finishEdit(true), { once: true });
    edit.focus();
    edit.select();
    elements.viewer.dispatchEvent(new Event("panelschange"));
  }

  life.on(elements.hudFrame, "click", beginEdit);
  life.on(elements.hudFrame, "keydown", (event) => {
    if (!edit && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      beginEdit();
    }
  });
  update(true);
  return {
    update,
    cancelEdit: () => finishEdit(false),
    dispose() {
      life.dispose();
      finishEdit(false);
    },
  };
}
