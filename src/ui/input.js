import { CONFIG } from "../config.js";
import { createLifecycle } from "../core/lifecycle.js";

export function bindInput({
  elements,
  player,
  playlist,
  view,
  panels,
  onError,
}) {
  const life = createLifecycle();
  let dragDepth = 0;
  let tap = null;
  let clickTimer = null;
  let stepTimer = null;
  const steppedOnPress = new WeakSet();
  const stopStepHold = () => {
    clearTimeout(stepTimer);
    stepTimer = null;
    player.stopStepping();
  };
  const open = () => {
    elements.fileInput.value = "";
    elements.fileInput.click();
  };
  const clearClick = () => {
    clearTimeout(clickTimer);
    clickTimer = null;
  };
  const addFiles = (files) => {
    try {
      if (!playlist.add(files))
        onError("No video files found. Choose MP4, WebM, MOV or MKV.");
    } catch (error) {
      onError(`Could not open files: ${error.message}`);
    }
  };

  life.on(elements.fileInput, "change", () => {
    if (elements.fileInput.files?.length) addFiles(elements.fileInput.files);
    elements.fileInput.value = "";
  });
  life.on(elements.status, "click", (event) => {
    event.stopPropagation();
    if (event.target.closest("button")) return;
    open();
  });
  life.on(elements.status, "keydown", (event) => {
    if (event.target !== elements.status) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });
  life.on(elements.introBackdrop, "click", open);
  life.on(
    document,
    "dragenter dragover dragleave drop",
    (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes("Files"))
        return;
      event.preventDefault();
      if (event.type === "dragenter") {
        dragDepth++;
        elements.dropmask.classList.add("show");
      } else if (event.type === "dragover")
        event.dataTransfer.dropEffect = "copy";
      else if (event.type === "dragleave") {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) elements.dropmask.classList.remove("show");
      } else {
        dragDepth = 0;
        elements.dropmask.classList.remove("show");
        if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
      }
    },
    { capture: true },
  );
  life.on(window, "blur", () => {
    stopStepHold();
    dragDepth = 0;
    elements.dropmask.classList.remove("show");
  });

  life.on(elements.playBtn, "click", () => player.toggle());
  for (const [button, direction] of [
    [elements.stepBackBtn, -1],
    [elements.stepFwdBtn, 1],
  ]) {
    life.on(button, "pointerdown", (event) => {
      if (event.button !== 0 || button.disabled) return;
      stopStepHold();
      steppedOnPress.add(button);
      player.stepFrames(direction);
      const repeat = () => {
        player.stepFrames(direction, { repeat: true });
        stepTimer = setTimeout(repeat, 60);
      };
      stepTimer = setTimeout(repeat, 350);
    });
    life.on(button, "click", (event) => {
      if (event.detail && steppedOnPress.delete(button)) return;
      player.stepFrames(direction);
    });
  }
  life.on(document, "pointerup pointercancel", stopStepHold);
  life.on(elements.resetViewBtn, "click", view.reset);
  life.on(elements.zoomSlider, "input", () =>
    view.setFov(
      CONFIG.minFov + CONFIG.maxFov - Number(elements.zoomSlider.value),
    ),
  );
  life.on(
    elements.viewer,
    "wheel",
    (event) => {
      if (
        event.target.closest(
          "#fsBar, #plistDock, #hud, #plistPanel, #infoPanel",
        )
      )
        return;
      event.preventDefault();
      view.zoom(event.deltaY > 0 ? CONFIG.wheelStep : -CONFIG.wheelStep);
      elements.zoomSlider.value = String(
        CONFIG.minFov + CONFIG.maxFov - view.fov,
      );
    },
    { passive: false },
  );

  for (const slider of [elements.timeSlider, elements.fsTimeRange]) {
    life.on(slider, "pointerdown", () => player.beginScrub());
    life.on(slider, "input", () => {
      const value = Number(slider.value);
      elements.timeSlider.value = elements.fsTimeRange.value = String(value);
      player.seekTo(value);
    });
    life.on(slider, "change", () => player.endScrub());
  }
  life.on(document, "pointerup pointercancel", () => player.endScrub());

  async function toggleFullscreen() {
    try {
      const current =
        document.fullscreenElement || document.webkitFullscreenElement;
      if (current) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else {
        const enter =
          elements.viewer.requestFullscreen ||
          elements.viewer.webkitRequestFullscreen;
        if (enter) await enter.call(elements.viewer);
        else onError("Fullscreen is not available in this browser.");
      }
    } catch (error) {
      onError(`Could not enter fullscreen: ${error.message}`);
    }
  }
  life.on(elements.fsBtn, "click", toggleFullscreen);
  life.on(document, "fullscreenchange webkitfullscreenchange", () => {
    const active = Boolean(
      document.fullscreenElement || document.webkitFullscreenElement,
    );
    elements.fsBtn.setAttribute(
      "aria-label",
      active ? "Exit fullscreen" : "Fullscreen",
    );
  });
  life.on(view.canvas, "pointerdown", (event) => {
    if (event.button !== 0) return;
    tap = {
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      time: performance.now(),
      moved: false,
    };
    if (view.mode === "flat") view.canvas.setPointerCapture(event.pointerId);
  });
  life.on(view.canvas, "pointermove", (event) => {
    if (!tap || !(event.buttons & 1)) return;
    tap.moved ||=
      Math.abs(event.clientX - tap.x) > 5 ||
      Math.abs(event.clientY - tap.y) > 5;
    if (tap.moved)
      view.pan(event.clientX - tap.lastX, event.clientY - tap.lastY);
    tap.lastX = event.clientX;
    tap.lastY = event.clientY;
  });
  life.on(view.canvas, "pointerup", (event) => {
    if (event.button !== 0 || !tap) return;
    if (
      !tap.moved &&
      performance.now() - tap.time < 250 &&
      !elements.status.classList.contains("show")
    ) {
      clearClick();
      clickTimer = setTimeout(() => player.toggle(), 200);
    }
    tap = null;
  });
  life.on(view.canvas, "pointercancel lostpointercapture", () => {
    tap = null;
  });
  life.on(view.canvas, "dblclick", () => {
    clearClick();
    void toggleFullscreen();
  });
  life.on(player, "unload", () => {
    stopStepHold();
    clearClick();
    tap = null;
  });

  const actions = {
    Space: () => player.toggle(),
    ArrowRight: (event) => player.stepFrames(1, { repeat: event.repeat }),
    KeyD: (event) => player.stepFrames(1, { repeat: event.repeat }),
    ArrowLeft: (event) => player.stepFrames(-1, { repeat: event.repeat }),
    KeyA: (event) => player.stepFrames(-1, { repeat: event.repeat }),
    ArrowUp: () => playlist.navigate(-1),
    KeyW: () => playlist.navigate(-1),
    ArrowDown: () => playlist.navigate(1),
    KeyS: () => playlist.navigate(1),
    KeyR: view.reset,
    KeyE: panels.togglePlaylist,
    KeyI: panels.toggleInfo,
    KeyO: open,
    KeyQ: () => {
      playlist.clear();
      panels.close();
    },
    Escape: panels.close,
  };
  life.on(window, "keydown", (event) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented
    )
      return;
    if (
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    )
      return;
    if (
      event.code === "Space" &&
      event.target.closest('button, [role="button"]')
    )
      return;
    const action = actions[event.code];
    if (!action) return;
    event.preventDefault();
    action(event);
  });
  life.on(window, "keyup", (event) => {
    if (["ArrowRight", "ArrowLeft", "KeyA", "KeyD"].includes(event.code))
      player.stopStepping();
  });
  return {
    dispose() {
      life.dispose();
      clearClick();
      stopStepHold();
    },
  };
}
