/** Copy already-preloaded bytes into the browser's private local filesystem. */
export async function createFileCache(
  blob,
  signal,
  { storage = globalThis.navigator?.storage } = {},
) {
  signal?.throwIfAborted();
  if (!storage?.getDirectory)
    throw new DOMException(
      "Local file caching is unavailable",
      "NotSupportedError",
    );
  const root = await storage.getDirectory();
  signal?.throwIfAborted();
  const directory = await root.getDirectoryHandle("dpg-video-cache", {
    create: true,
  });
  signal?.throwIfAborted();
  const extension =
    /\.(mp4|m4v|mov|webm|mkv)$/i.exec(blob.name || "")?.[0] ||
    (blob.type === "video/webm" ? ".webm" : ".mp4");
  const name = `${crypto.randomUUID()}${extension.toLowerCase()}`;
  const remove = async () => {
    try {
      await directory.removeEntry(name);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  };
  let writable;
  const abortWrite = () => {
    void writable?.abort(signal.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abortWrite, { once: true });
  try {
    signal?.throwIfAborted();
    const handle = await directory.getFileHandle(name, { create: true });
    signal?.throwIfAborted();
    writable = await handle.createWritable();
    signal?.throwIfAborted();
    await writable.write(blob);
    signal?.throwIfAborted();
    await writable.close();
    writable = null;
    signal?.throwIfAborted();
    const file = await handle.getFile();
    signal?.throwIfAborted();
    if (file.size !== blob.size) throw new Error("Incomplete local cache copy");
    return { file, remove };
  } catch (error) {
    await writable?.abort(error).catch(() => {});
    await remove().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortWrite);
  }
}
