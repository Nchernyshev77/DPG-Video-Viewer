import { CONFIG } from "../config.js";

/** Read one bounded chunk; source replacement can stop a slow network read. */
function readChunk(blob, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    reader.onload = () => {
      cleanup();
      resolve(reader.result);
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error);
    };
    reader.onabort = () => {
      cleanup();
      reject(
        signal?.reason || new DOMException("Read cancelled", "AbortError"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

/** Encoded-file preloading, with an aggregate LRU budget and independent URLs. */
export class VideoCache {
  #entries = new Map();
  #bytes = 0;
  #urls;
  #read;
  #chunkBytes;
  limit;

  constructor({
    limit = CONFIG.cacheBytes,
    urls = URL,
    read = readChunk,
    chunkBytes = CONFIG.cacheChunkBytes,
  } = {}) {
    this.limit = limit;
    this.#urls = urls;
    this.#read = read;
    this.#chunkBytes = chunkBytes;
  }

  get bytes() {
    return this.#bytes;
  }
  get size() {
    return this.#entries.size;
  }

  #remove(file) {
    const entry = this.#entries.get(file);
    if (!entry) return;
    this.#entries.delete(file);
    this.#bytes -= file.size;
    this.#urls.revokeObjectURL(entry.url);
  }

  setLimit(bytes) {
    this.limit = Math.max(0, Number(bytes) || 0);
    while (this.#bytes > this.limit)
      this.#remove(this.#entries.keys().next().value);
  }

  async prepare(item, signal, progress = () => {}) {
    const original = item.file;
    signal?.throwIfAborted();
    const report = (mode, read = 0) =>
      progress({ mode, read, total: original.size, limit: this.limit });
    const direct = (mode) => {
      report(mode);
      return { url: item.url, file: original, mode };
    };
    if (!this.limit) return direct("disabled");
    if (original.size > this.limit) return direct("oversized");
    const existing = this.#entries.get(original);
    if (existing) {
      this.#entries.delete(original);
      this.#entries.set(original, existing);
      report("cached", original.size);
      return existing;
    }
    // Evict before reading: old caches must not coexist with a full new file.
    while (this.#bytes + original.size > this.limit)
      this.#remove(this.#entries.keys().next().value);
    report("reading");
    try {
      const parts = [];
      for (let offset = 0; offset < original.size; offset += this.#chunkBytes) {
        signal?.throwIfAborted();
        const end = Math.min(original.size, offset + this.#chunkBytes);
        const buffer = await this.#read(original.slice(offset, end), signal);
        signal?.throwIfAborted();
        // Blob parts avoid staging a second file-sized ArrayBuffer at completion.
        parts.push(new Blob([buffer]));
        report("reading", end);
      }
      signal?.throwIfAborted();
      const file = new File(parts, original.name, {
        type: original.type,
        lastModified: original.lastModified,
      });
      const entry = {
        file,
        url: this.#urls.createObjectURL(file),
        mode: "cached",
      };
      this.#entries.set(original, entry);
      this.#bytes += original.size;
      report("cached", original.size);
      return entry;
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      // Read or allocation failures retain the original disk-backed source.
      return direct("failed");
    }
  }

  prune(files) {
    const retained = new Set(files);
    for (const file of this.#entries.keys())
      if (!retained.has(file)) this.#remove(file);
  }

  dispose() {
    for (const file of this.#entries.keys()) this.#remove(file);
  }
}
