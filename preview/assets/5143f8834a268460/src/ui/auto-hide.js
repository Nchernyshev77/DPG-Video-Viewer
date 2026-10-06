import { CONFIG } from "../config.js";
import { createLifecycle } from "../core/lifecycle.js";

export function createAutoHide(elements, player) {
  const life = createLifecycle();
  const { viewer, hzBottom, hzCorner } = elements;
  let timer = null;
  let cursorTimer = null;
  let wasPlaying = false;

  const held = () =>
    player.scrubbing ||
    elements.plistPanel.classList.contains("show") ||
    elements.infoPanel.classList.contains("show") ||
    Boolean(document.getElementById("frameJumpInput")) ||
    Boolean(
      viewer.querySelector(
        'button:focus-visible, input:focus-visible, [role="button"]:focus-visible',
      ),
    );
  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  function show() {
    clearTimer();
    viewer.classList.remove("ui-autoHide", "cursorReveal");
    hzBottom.classList.remove("active");
    hzCorner.classList.remove("active");
  }
  function hide() {
    if (!player.playing || held()) return;
    viewer.classList.add("ui-autoHide");
    hzBottom.classList.add("active");
    hzCorner.classList.add("active");
  }
  function schedule() {
    clearTimer();
    if (player.playing && !held()) timer = setTimeout(hide, CONFIG.autoHideMs);
  }
  function refresh() {
    show();
    schedule();
  }
  life.on(player, "update", () => {
    if (player.playing !== wasPlaying) {
      wasPlaying = player.playing;
      refresh();
    } else if (held()) show();
  });
  life.on(viewer, "panelschange focusin focusout", refresh);
  life.on(
    viewer,
    "pointermove pointerdown wheel",
    () => {
      if (viewer.classList.contains("ui-autoHide")) {
        viewer.classList.add("cursorReveal");
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(
          () => viewer.classList.remove("cursorReveal"),
          800,
        );
      } else schedule();
    },
    { passive: true },
  );
  life.on(viewer, "mouseleave", hide, { passive: true });
  for (const zone of [hzBottom, hzCorner]) {
    life.on(zone, "pointerenter", refresh);
    life.on(zone, "pointerdown click dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  return {
    refresh,
    show,
    dispose() {
      life.dispose();
      clearTimer();
      clearTimeout(cursorTimer);
      show();
    },
  };
}
