import { CONFIG } from "../config.js";
import { createFileCache } from "./file-cache.js";

/** Read the selected file into one buffer, as in the original viewer. */
function readFile(blob, signal, timeoutMs, progress) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const reader = new FileReader();
    let timer;
    let finished = false;
    let loaded = 0;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(
        signal?.reason || new DOMException("Read cancelled", "AbortError"),
      );
      reader.abort();
    };
    const watch = () => {
      if (finished) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        reject(new DOMException("File read made no progress", "TimeoutError"));
        reader.abort();
      }, timeoutMs);
    };
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
    reader.onprogress = (event) => {
      if (finished || event.loaded <= loaded) return;
      loaded = event.loaded;
      watch();
      progress?.(loaded);
    };
    signal?.addEventListener("abort", abort, { once: true });
    watch();
    try {
      reader.readAsArrayBuffer(blob);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Encoded-file preloading, with an aggregate LRU budget and independent URLs. */
export class VideoCache {
  #entries = new Map();
  #bytes = 0;
  #urls;
  #read;
  #readTimeoutMs;
  #createFile;
  #writeTimeoutMs;
  limit;

  constructor({
    limit = CONFIG.cacheBytes,
    urls = URL,
    read = readFile,
    readTimeoutMs = CONFIG.cacheReadTimeoutMs,
    createFile = createFileCache,
    writeTimeoutMs = CONFIG.cacheWriteTimeoutMs,
  } = {}) {
    this.limit = limit;
    this.#urls = urls;
    this.#read = read;
    this.#readTimeoutMs = readTimeoutMs;
    this.#createFile = createFile;
    this.#writeTimeoutMs = writeTimeoutMs;
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
    entry.copyController?.abort();
    this.#bytes -= file.size;
    this.#urls.revokeObjectURL(entry.url);
    for (const url of entry.retired || []) this.#urls.revokeObjectURL(url);
    void entry.remove?.().catch(() => {});
  }

  setLimit(bytes) {
    this.limit = Math.max(0, Number(bytes) || 0);
    while (this.#bytes > this.limit)
      this.#remove(this.#entries.keys().next().value);
  }

  async prepare(item, signal, progress = () => {}) {
    const original = item.file;
    signal?.throwIfAborted();
    const report = (mode, read = 0, backing) =>
      progress({
        mode,
        read,
        total: original.size,
        limit: this.limit,
        ...(backing ? { backing } : {}),
      });
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
      report("cached", original.size, existing.backing);
      return existing;
    }
    // Evict before reading: old caches must not coexist with a full new file.
    while (this.#bytes + original.size > this.limit)
      this.#remove(this.#entries.keys().next().value);
    report("reading");
    try {
      const buffer = await this.#read(
        original,
        signal,
        this.#readTimeoutMs,
        (read) => {
          if (!signal?.aborted) report("reading", read);
        },
      );
      signal?.throwIfAborted();
      if (buffer.byteLength !== original.size)
        throw new Error("Incomplete file read");
      // Preserve the source shape and MIME fallback of the working legacy path.
      const file = new Blob([buffer], {
        type: original.type || "application/octet-stream",
      });
      Object.assign(file, {
        name: original.name,
        lastModified: original.lastModified,
      });
      const entry = {
        file,
        url: this.#urls.createObjectURL(file),
        mode: "cached",
        backing: "blob",
      };
      this.#entries.set(original, entry);
      this.#bytes += original.size;
      report("cached", original.size, entry.backing);
      return entry;
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      // Read or allocation failures retain the original disk-backed source.
      return direct("failed");
    }
  }

  async materialize(item, signal) {
    signal?.throwIfAborted();
    const entry = this.#entries.get(item.file);
    if (!entry) throw new Error("The preloaded copy is no longer cached");
    if (entry.backing === "file") return entry;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    entry.copyController = controller;
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => {
      rejectCancelled = reject;
    });
    const onAbort = () => rejectCancelled(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("Local cache copy timed out", "TimeoutError"),
        ),
      this.#writeTimeoutMs,
    );
    let copy;
    let accepted = false;
    try {
      const operation = Promise.resolve()
        .then(() => this.#createFile(entry.file, controller.signal))
        .then(async (result) => {
          if (
            controller.signal.aborted ||
            this.#entries.get(item.file) !== entry
          ) {
            await result.remove().catch(() => {});
            throw (
              controller.signal.reason ||
              new DOMException("Cache entry removed", "AbortError")
            );
          }
          return result;
        });
      copy = await Promise.race([operation, cancelled]);
      const url = this.#urls.createObjectURL(copy.file);
      entry.retired ||= [];
      entry.retired.push(entry.url);
      entry.file = copy.file;
      entry.url = url;
      entry.backing = "file";
      entry.remove = copy.remove;
      accepted = true;
      return entry;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      if (entry.copyController === controller) delete entry.copyController;
      if (copy && !accepted) await copy.remove().catch(() => {});
    }
  }

  // The player calls this only after detaching the previous video source.
  releaseRetired(file) {
    const entry = this.#entries.get(file);
    for (const url of entry?.retired?.splice(0) || [])
      this.#urls.revokeObjectURL(url);
  }

  prune(files) {
    const retained = new Set(files);
    for (const file of this.#entries.keys())
      if (!retained.has(file)) this.#remove(file);
  }

  discard(file) {
    this.#remove(file);
  }

  dispose() {
    for (const file of this.#entries.keys()) this.#remove(file);
  }
}
