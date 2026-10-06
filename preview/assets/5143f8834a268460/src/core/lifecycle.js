/** Every component owns its listeners and releases them together. */
export function createLifecycle() {
  const controller = new AbortController();
  const cleanups = [];
  return {
    signal: controller.signal,
    on(target, events, listener, options = {}) {
      for (const event of events.split(" ")) {
        target.addEventListener(event, listener, {
          ...options,
          signal: controller.signal,
        });
        // Three.js EventDispatcher accepts DOM-style listeners but ignores signals.
        cleanups.push(() =>
          target.removeEventListener(event, listener, options),
        );
      }
    },
    cleanup(fn) {
      cleanups.push(fn);
    },
    dispose() {
      controller.abort();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
}
