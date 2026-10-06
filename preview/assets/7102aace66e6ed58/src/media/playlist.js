import { isVideoFile } from "../core/format.js";

/** Files stay on disk. Each playlist entry owns one independent object URL. */
export class Playlist extends EventTarget {
  #items = [];
  #index = -1;
  #urls;
  #nextId = 0;

  constructor(urls = URL) {
    super();
    this.#urls = urls;
  }
  get items() {
    return this.#items.slice();
  }
  get currentIndex() {
    return this.#index;
  }
  get current() {
    return this.#items[this.#index] || null;
  }
  get size() {
    return this.#items.length;
  }

  #notify(previous, structureChanged = false) {
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: {
          selectionChanged: previous !== this.current,
          structureChanged,
        },
      }),
    );
  }

  add(files) {
    const previous = this.current;
    let added = 0;
    for (const file of Array.from(files || [])) {
      if (!isVideoFile(file)) continue;
      this.#items.push(
        Object.freeze({
          id: ++this.#nextId,
          file,
          name: file.name,
          url: this.#urls.createObjectURL(file),
        }),
      );
      added++;
    }
    if (added) {
      this.#index = this.#items.length - 1;
      this.#notify(previous, true);
    }
    return added;
  }

  select(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.size ||
      index === this.#index
    )
      return;
    const previous = this.current;
    this.#index = index;
    this.#notify(previous);
  }

  navigate(offset) {
    if (this.size) this.select((this.#index + offset + this.size) % this.size);
  }

  remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) return;
    const previous = this.current;
    const [removed] = this.#items.splice(index, 1);
    if (!this.size) this.#index = -1;
    else if (index === this.#index)
      this.#index = Math.min(index, this.size - 1);
    else if (index < this.#index) this.#index--;
    // Notify first, so the player detaches a selected source before its URL is revoked.
    this.#notify(previous, true);
    this.#urls.revokeObjectURL(removed.url);
  }

  clear() {
    const previous = this.current;
    const removed = this.#items.splice(0);
    this.#index = -1;
    this.#notify(previous, true);
    for (const item of removed) this.#urls.revokeObjectURL(item.url);
  }

  dispose() {
    this.clear();
  }
}
