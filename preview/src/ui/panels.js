import { clamp } from "../core/format.js";
import { createLifecycle } from "../core/lifecycle.js";

export function createPanels(elements, playlist) {
  const life = createLifecycle();
  const {
    viewer,
    plistPanel,
    infoPanel,
    plistFooter,
    closeAllBtn,
    plistBtn,
    infoBtn,
  } = elements;
  let resizeHandle = null;
  // Both panels belong to the fullscreen subtree from the beginning.
  viewer.append(plistPanel, infoPanel);

  const notify = () => viewer.dispatchEvent(new Event("panelschange"));
  const isOpen = (panel) => panel.classList.contains("show");

  function position() {
    resizeHandle = null;
    const margin = 12;
    const dock = elements.plistDock.getBoundingClientRect();
    const longest = playlist.items.reduce(
      (a, item) => (item.name.length > a.length ? item.name : a),
      "",
    );
    elements.meas.textContent = longest;
    const availableWidth = Math.max(1, window.innerWidth - margin * 2);
    const width = Math.min(
      availableWidth,
      Math.max(
        260,
        Math.min(
          window.innerWidth * 0.8,
          elements.meas.getBoundingClientRect().width + 76,
        ),
      ),
    );
    plistPanel.style.width = `${width}px`;
    plistPanel.style.left = `${clamp(dock.right + 8, margin, window.innerWidth - width - margin)}px`;
    plistPanel.style.top = `${clamp(plistBtn.getBoundingClientRect().top, margin, window.innerHeight - 80)}px`;
    plistPanel.style.maxHeight = `${Math.max(50, Math.min(window.innerHeight * 0.5, window.innerHeight - parseFloat(plistPanel.style.top) - margin))}px`;

    const infoWidth = Math.min(320, availableWidth);
    infoPanel.style.width = `${infoWidth}px`;
    infoPanel.style.left = `${clamp(dock.right + 8, margin, window.innerWidth - infoWidth - margin)}px`;
    const top = isOpen(plistPanel)
      ? plistPanel.getBoundingClientRect().bottom + 8
      : infoBtn.getBoundingClientRect().top;
    infoPanel.style.top = `${clamp(top, margin, window.innerHeight - 80)}px`;
    infoPanel.style.maxHeight = `${Math.max(50, window.innerHeight - parseFloat(infoPanel.style.top) - margin)}px`;
  }

  function schedulePosition() {
    if (resizeHandle === null) resizeHandle = requestAnimationFrame(position);
  }

  function setOpen(panel, button, open) {
    panel.classList.toggle("show", open);
    button.setAttribute("aria-expanded", String(open));
    position();
    notify();
  }

  function close() {
    setOpen(plistPanel, plistBtn, false);
    setOpen(infoPanel, infoBtn, false);
  }

  function render() {
    const rows = document.createDocumentFragment();
    const options = document.createDocumentFragment();
    playlist.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `plItem${index === playlist.currentIndex ? " active" : ""}`;
      row.dataset.idx = String(index);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Play ${item.name}`);
      if (index === playlist.currentIndex)
        row.setAttribute("aria-current", "true");
      const number = document.createElement("span");
      number.className = "idx";
      number.textContent = `${index + 1}.`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = name.title = item.name;
      const remove = document.createElement("button");
      remove.className = "x";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove";
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      row.append(number, name, remove);
      rows.append(row);
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index + 1}. ${item.name}`;
      options.append(option);
    });
    if (!playlist.size) {
      const empty = document.createElement("div");
      empty.className = "playlist-empty";
      empty.textContent = "Empty";
      rows.append(empty);
    }
    plistPanel.replaceChildren(rows, plistFooter);
    elements.playlistSel.replaceChildren(options);
    elements.playlistSel.disabled = !playlist.size;
    elements.playlistSel.value = String(playlist.currentIndex);
    elements.plistBtnLabel.textContent = playlist.size
      ? String(playlist.size)
      : "";
    closeAllBtn.disabled = !playlist.size;
    if (isOpen(plistPanel) || isOpen(infoPanel)) position();
  }

  function updateActive() {
    const previous = plistPanel.querySelector(".plItem.active");
    previous?.classList.remove("active");
    previous?.removeAttribute("aria-current");
    const current = plistPanel.querySelector(
      `.plItem[data-idx="${playlist.currentIndex}"]`,
    );
    current?.classList.add("active");
    current?.setAttribute("aria-current", "true");
    elements.playlistSel.value = String(playlist.currentIndex);
    if (isOpen(plistPanel)) current?.scrollIntoView({ block: "nearest" });
  }

  function activateRow(event) {
    const row = event.target.closest(".plItem");
    if (!row) return;
    const index = Number(row.dataset.idx);
    if (event.target.closest(".x")) playlist.remove(index);
    else playlist.select(index);
  }

  life.on(plistPanel, "click", activateRow);
  life.on(plistPanel, "keydown", (event) => {
    if (
      event.target.matches(".plItem") &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      event.stopPropagation();
      activateRow(event);
    }
  });
  life.on(plistBtn, "click", () =>
    setOpen(plistPanel, plistBtn, !isOpen(plistPanel)),
  );
  life.on(plistBtn, "contextmenu", (event) => {
    event.preventDefault();
    playlist.clear();
    close();
  });
  life.on(infoBtn, "click", () =>
    setOpen(infoPanel, infoBtn, !isOpen(infoPanel)),
  );
  life.on(closeAllBtn, "click", () => {
    playlist.clear();
    close();
  });
  life.on(elements.playlistSel, "change", () =>
    playlist.select(Number(elements.playlistSel.value)),
  );
  life.on(document, "click", (event) => {
    // A remove-button click can detach its target before it bubbles to document.
    // The original event path still records that the click happened in the panel.
    if (!event.composedPath().includes(viewer)) close();
  });
  life.on(window, "resize", schedulePosition);
  life.on(
    document,
    "fullscreenchange webkitfullscreenchange",
    schedulePosition,
  );
  render();
  return {
    render,
    updateActive,
    close,
    togglePlaylist: () => setOpen(plistPanel, plistBtn, !isOpen(plistPanel)),
    toggleInfo: () => setOpen(infoPanel, infoBtn, !isOpen(infoPanel)),
    dispose() {
      life.dispose();
      if (resizeHandle !== null) cancelAnimationFrame(resizeHandle);
    },
  };
}
