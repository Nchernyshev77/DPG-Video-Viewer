import { CONFIG } from "../config.js";
import { clamp, projectionFor } from "../core/format.js";
import { createLifecycle } from "../core/lifecycle.js";
import { readVideoMetadata } from "./metadata.js";

export class VideoPlayer extends EventTarget {
  #readMetadata;
  #sourceLife = null;
  #generation = 0;
  #frameHandle = null;
  #fallbackHandle = null;
  #pendingSeek = null;
  #scrubWasPlaying = false;
  #sample = null;
  #autoplay = false;
  #cache;
  #presentFrame;
  #seek = null;
  #pendingSteps = 0;
  #repeatStep = 0;
  #loadTimeoutMs;
  #primeDelayMs;
  #loadEvents = [];
  #loadStarted = 0;
  #startTime = 0;
  #sourceMode = "empty";
  #lastPlaybackUpdate = -Infinity;

  video = null;
  item = null;
  ready = false;
  loading = false;
  loadStage = "empty";
  fps = null;
  fpsSource = null;
  variableFrameRate = false;
  scrubbing = false;
  error = "";
  cacheState = { mode: "empty", read: 0, total: 0 };

  constructor(
    container,
    {
      readMetadata = readVideoMetadata,
      cache = null,
      presentFrame = () => {},
      loadTimeoutMs = CONFIG.mediaLoadTimeoutMs,
      primeDelayMs = CONFIG.mediaPrimeDelayMs,
    } = {},
  ) {
    super();
    this.#readMetadata = readMetadata;
    this.#cache = cache;
    this.#presentFrame = presentFrame;
    this.#loadTimeoutMs = loadTimeoutMs;
    this.#primeDelayMs = primeDelayMs;
  }

  get seeking() {
    return Boolean(this.#seek || this.video?.seeking);
  }

  get playing() {
    return Boolean(
      this.ready && this.video && !this.video.paused && !this.video.ended,
    );
  }
  get duration() {
    return Number.isFinite(this.video?.duration) ? this.video.duration : 0;
  }
  get currentTime() {
    return this.video?.currentTime || 0;
  }
  get effectiveFPS() {
    return this.fps || CONFIG.fallbackFps;
  }
  get totalFrames() {
    return this.fps && this.duration
      ? Math.round(this.duration * this.fps)
      : null;
  }
  get mode() {
    return projectionFor(
      this.video?.videoWidth || 0,
      this.video?.videoHeight || 0,
    );
  }

  #emit(event = "update", detail) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  #drawFrame() {
    this.#emit("frame");
    return this.#presentFrame();
  }

  load(
    item,
    {
      autoplay = false,
      startTime = 0,
      cacheLimit,
      direct = false,
      recovery = false,
    } = {},
  ) {
    this.#generation++;
    this.#stopFrames();
    this.#sourceLife?.dispose();
    // Consumers detach and dispose the old texture before its media is reset.
    this.#emit("unload");
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video.remove();
    }
    this.video = null;
    this.item = item;
    this.ready = false;
    this.loading = Boolean(item);
    this.loadStage = item ? "preloading" : "empty";
    this.#sourceMode = "empty";
    this.#startTime = startTime;
    if (!recovery) {
      this.#loadEvents = [];
      this.#loadStarted = performance.now();
    }
    this.fps = this.fpsSource = null;
    this.variableFrameRate = false;
    this.scrubbing = this.#scrubWasPlaying = false;
    this.#pendingSeek = this.#sample = null;
    this.#seek = null;
    this.#pendingSteps = this.#repeatStep = 0;
    this.cacheState = { mode: "empty", read: 0, total: 0 };
    this.error = "";
    this.#autoplay = autoplay;
    // Detach the old media before evicting its cached URL.
    if (cacheLimit !== undefined) this.#cache?.setLimit(cacheLimit);
    if (!item) {
      this.#emit();
      return;
    }

    const generation = this.#generation;
    const life = (this.#sourceLife = createLifecycle());
    const open = (source) => {
      if (life.signal.aborted || generation !== this.#generation) return;
      this.#openSource(item, source, life, generation, startTime);
    };
    if (direct) {
      this.cacheState = {
        mode: recovery ? "fallback" : "bypassed",
        read: 0,
        total: item.file.size,
      };
      open({ url: item.url, file: item.file, mode: this.cacheState.mode });
    } else if (this.#cache) {
      this.#emit();
      void this.#cache
        .prepare(item, life.signal, (state) => {
          if (life.signal.aborted) return;
          this.cacheState = state;
          this.#emit();
        })
        .then(open)
        .catch(() => {
          if (!life.signal.aborted) {
            this.cacheState = {
              mode: "failed",
              read: 0,
              total: item.file.size,
            };
            open({ url: item.url, file: item.file, mode: "failed" });
          }
        });
    } else open({ url: item.url, file: item.file });
  }

  #openSource(item, source, life, generation, startTime) {
    // One media element per source makes late events from old sources harmless.
    const video = (this.video = document.createElement("video"));
    video.id = "mediaVideo";
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.loop = true;
    // The legacy viewer uses a detached media element, consumed only by WebGL.
    // A transparent 1px DOM video can trigger browser visibility optimizations.
    this.#sourceMode = source.mode || "direct";
    this.loadStage = "metadata";
    let restoreTime = startTime;
    let priming = false;
    let primed = false;
    let finished = false;
    let primeTimer;
    let deadline;
    let poll;
    const stopLoadingTimers = () => {
      clearTimeout(primeTimer);
      clearTimeout(deadline);
      clearInterval(poll);
    };
    life.cleanup(stopLoadingTimers);
    const record = (event) => {
      this.#loadEvents.push({
        event,
        ms: Math.round(performance.now() - this.#loadStarted),
        readyState: video.readyState,
        networkState: video.networkState,
      });
      if (this.#loadEvents.length > 24) this.#loadEvents.shift();
    };
    const fail = (message) => {
      if (finished || life.signal.aborted) return;
      finished = true;
      stopLoadingTimers();
      if (!this.ready && source.mode === "cached") {
        record("retry-original");
        this.load(item, {
          autoplay: this.#autoplay,
          startTime,
          direct: true,
          recovery: true,
        });
        // Detach the cached URL before discarding an unusable copy.
        this.#cache?.discard?.(item.file);
        return;
      }
      this.#stopFrames();
      this.#seek = null;
      this.#pendingSeek = null;
      this.#pendingSteps = this.#repeatStep = 0;
      this.ready = this.loading = false;
      this.loadStage = "error";
      this.error = message;
      video.pause();
      this.#emit();
    };
    const checkReady = () => {
      if (
        finished ||
        life.signal.aborted ||
        this.ready ||
        video.readyState < 2 ||
        video.seeking ||
        !video.videoWidth ||
        !video.videoHeight
      )
        return;
      if (priming && !this.#autoplay) {
        priming = false;
        video.pause();
        const target = clamp(startTime, 0, Math.max(0, this.duration - 0.001));
        if (Math.abs(video.currentTime - target) > 0.00001) {
          video.currentTime = target;
          return;
        }
      }
      stopLoadingTimers();
      this.ready = true;
      this.loading = false;
      this.loadStage = "ready";
      record("first-frame");
      this.#emit("ready");
      void this.#drawFrame();
      this.#emit();
      if (this.#autoplay) {
        this.#autoplay = false;
        void this.play();
      }
    };
    const prime = () => {
      if (finished || life.signal.aborted || this.ready || primed) return;
      primed = priming = true;
      this.loadStage = "frame";
      record("request-first-frame");
      this.#emit();
      // preload=auto is a hint. A muted play request can make the decoder start.
      void video
        .play()
        .then(checkReady)
        .catch((error) => {
          if (
            finished ||
            life.signal.aborted ||
            this.ready ||
            error.name === "AbortError"
          )
            return;
          priming = false;
          if (error.name === "NotAllowedError") {
            this.loadStage = "gesture";
            record("play-needs-gesture");
            this.#emit();
          }
        });
    };
    life.on(
      video,
      "loadstart loadedmetadata loadeddata canplay canplaythrough stalled suspend error",
      (event) => record(event.type),
    );
    life.on(video, "loadedmetadata durationchange", () => {
      if (restoreTime > 0 && Number.isFinite(video.duration)) {
        video.currentTime = clamp(
          restoreTime,
          0,
          Math.max(0, video.duration - 0.001),
        );
        restoreTime = 0;
      }
      if (!this.ready && !finished && this.loadStage !== "gesture")
        this.loadStage = "frame";
      checkReady();
      if (!this.ready && !finished && !primed && !primeTimer)
        primeTimer = setTimeout(prime, this.#primeDelayMs);
      this.#emit();
    });
    life.on(
      video,
      "loadeddata canplay canplaythrough progress timeupdate seeked",
      checkReady,
    );
    life.on(video, "play", () => {
      this.error = "";
      this.#sample = null;
      this.#lastPlaybackUpdate = -Infinity;
      if (this.ready) this.#startFrames();
      this.#emit();
    });
    life.on(video, "pause ended", () => {
      this.#stopFrames();
      void this.#drawFrame();
      this.#emit();
    });
    life.on(video, "timeupdate", () => this.#emit());
    life.on(video, "seeking", () => {
      this.#sample = null;
    });
    life.on(video, "seeked", () => {
      if (!this.ready) return;
      this.#seek ||= { generation, presenting: false };
      this.#seek.seeked = true;
      this.#presentSeek();
    });
    life.on(video, "loadeddata canplay", () => this.#presentSeek());
    life.on(video, "error", () => {
      fail(
        video.error?.code === 2
          ? "The file could not be read. Check the disk or network connection and retry."
          : "The video could not be decoded. This browser may not support its codec, or the file may be damaged.",
      );
    });
    deadline = setTimeout(() => {
      checkReady();
      if (this.ready) return;
      record("first-frame-timeout");
      fail(
        video.readyState >= 1
          ? "The first frame did not load. Retry, or check whether this video plays in the original viewer."
          : "The video did not load. Check access to the file and retry.",
      );
    }, this.#loadTimeoutMs);
    poll = setInterval(checkReady, CONFIG.mediaPollMs);
    video.src = source.url;
    video.load();
    this.#emit();
    this.#readMetadata(source.file, life.signal)
      .then((metadata) => {
        if (generation !== this.#generation || life.signal.aborted || !metadata)
          return;
        this.fps = metadata.fps;
        this.fpsSource = metadata.source;
        this.variableFrameRate = metadata.variableFrameRate;
        this.#emit();
      })
      .catch((error) => {
        if (!life.signal.aborted)
          console.warn("Could not read video metadata", error);
      });
  }

  async play() {
    if (!this.video || (!this.ready && !this.loading)) return;
    if (!this.ready) this.#autoplay = true;
    const video = this.video;
    try {
      await video.play();
      if (video === this.video && this.playing) this.#startFrames();
    } catch (error) {
      if (video !== this.video || error.name === "AbortError") return;
      this.error = this.loading
        ? "Playback could not start. Press Start video to try again."
        : "Playback could not start. Press Play to try again.";
      this.#emit();
    }
  }

  pause() {
    this.video?.pause();
  }
  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seekTo(time) {
    if (!this.ready || !this.video) return;
    const target = clamp(time, 0, this.duration);
    if (this.seeking) {
      this.#pendingSeek = target;
      this.#pendingSteps = this.#repeatStep = 0;
      return;
    }
    if (Math.abs(this.currentTime - target) < 0.00001) {
      this.#emit();
      return;
    }
    this.#seek = {
      generation: this.#generation,
      seeked: false,
      presenting: false,
    };
    this.video.currentTime = target;
    this.#emit();
  }

  #presentSeek() {
    const seek = this.#seek;
    if (
      !seek ||
      !seek.seeked ||
      seek.presenting ||
      this.video.seeking ||
      this.video.readyState < 2
    )
      return;
    seek.presenting = true;
    // seeked is not a rendered frame. Keep this seek locked until WebGL uploads it.
    Promise.resolve(this.#drawFrame()).then(() => {
      if (this.#seek !== seek || seek.generation !== this.#generation) return;
      this.#seek = null;
      const pending = this.#pendingSeek;
      const steps = this.#pendingSteps || this.#repeatStep;
      this.#pendingSeek = null;
      this.#pendingSteps = this.#repeatStep = 0;
      this.#emit();
      if (pending !== null) this.seekTo(pending);
      else if (steps) this.stepFrames(steps);
    });
  }

  stopStepping() {
    this.#repeatStep = 0;
  }

  retry({ direct = false } = {}) {
    if (!this.item) return;
    this.load(this.item, {
      autoplay: this.playing || this.#autoplay,
      startTime: this.ready ? this.currentTime : this.#startTime,
      direct,
    });
  }

  diagnostics() {
    return {
      file: this.item?.name,
      bytes: this.item?.file.size,
      type: this.item?.file.type || "unknown",
      stage: this.loadStage,
      source: this.#sourceMode,
      cache: this.cacheState,
      readyState: this.video?.readyState,
      networkState: this.video?.networkState,
      width: this.video?.videoWidth,
      height: this.video?.videoHeight,
      mediaError: this.video?.error && {
        code: this.video.error.code,
        message: this.video.error.message,
      },
      error: this.error,
      events: this.#loadEvents.slice(),
    };
  }

  reloadCache(limit = this.#cache?.limit) {
    if (!this.item) {
      this.#cache?.setLimit(limit);
      return;
    }
    this.load(this.item, {
      autoplay: this.playing,
      startTime: this.currentTime,
      cacheLimit: limit,
    });
  }

  stepFrames(count, { repeat = false } = {}) {
    if (!this.ready) return;
    this.pause();
    if (this.seeking) {
      // Key auto-repeat may outrun the decoder. Retain one direction, not a backlog.
      if (repeat) this.#repeatStep = Math.sign(count);
      else this.#pendingSteps += count;
      return;
    }
    if (!this.fps) {
      this.fps = CONFIG.fallbackFps;
      this.fpsSource = "fallback";
    }
    const fps = this.effectiveFPS;
    const start = this.currentTime;
    const target = (Math.round(start * fps) + count) / fps;
    const insideFrame = Math.min(0.0001, 0.01 / fps);
    this.seekTo(
      clamp(target + insideFrame, 0, Math.max(0, this.duration - 0.25 / fps)),
    );
  }

  jumpToFrame(frame) {
    if (!Number.isFinite(frame) || !this.ready) return;
    this.pause();
    if (!this.fps) {
      this.fps = CONFIG.fallbackFps;
      this.fpsSource = "fallback";
    }
    this.seekTo(
      clamp(Math.round(frame), 0, Math.max(0, (this.totalFrames || 1) - 1)) /
        this.effectiveFPS,
    );
  }

  beginScrub() {
    if (!this.ready || this.scrubbing) return;
    this.#scrubWasPlaying = this.playing;
    this.scrubbing = true;
    this.pause();
    this.#emit();
  }

  endScrub() {
    if (!this.scrubbing) return;
    const resume = this.#scrubWasPlaying;
    this.scrubbing = this.#scrubWasPlaying = false;
    if (resume) void this.play();
    this.#emit();
  }

  #observeFPS(metadata) {
    if (this.fpsSource === "metadata" || !Number.isFinite(metadata?.mediaTime))
      return;
    const current = {
      time: metadata.mediaTime,
      frames: metadata.presentedFrames,
    };
    const first = this.#sample;
    if (!first || current.time < first.time) {
      this.#sample = current;
      return;
    }
    const elapsed = current.time - first.time;
    if (elapsed < 0.5) return;
    const fps = (current.frames - first.frames) / elapsed;
    if (Number.isFinite(fps) && fps > 0 && fps < 1000) {
      this.fps = Math.round(fps * 1000) / 1000;
      this.fpsSource = "estimated";
    }
    this.#sample = current;
  }

  #startFrames() {
    if (
      this.#frameHandle !== null ||
      this.#fallbackHandle !== null ||
      !this.video
    )
      return;
    const video = this.video;
    const generation = this.#generation;
    const tick = (now, metadata) => {
      this.#frameHandle = this.#fallbackHandle = null;
      if (generation !== this.#generation) return;
      this.#observeFPS(metadata);
      // Playback is painted by the renderer's RAF loop. Frame callbacks only
      // measure FPS and update the HUD; they must not gate display refresh.
      if (now - this.#lastPlaybackUpdate >= CONFIG.uiIntervalMs) {
        this.#lastPlaybackUpdate = now;
        this.#emit();
      }
      if (this.playing) this.#startFrames();
    };
    if (video.requestVideoFrameCallback)
      this.#frameHandle = video.requestVideoFrameCallback(tick);
    else this.#fallbackHandle = requestAnimationFrame(tick);
  }

  #stopFrames() {
    if (this.#frameHandle !== null)
      this.video?.cancelVideoFrameCallback?.(this.#frameHandle);
    if (this.#fallbackHandle !== null)
      cancelAnimationFrame(this.#fallbackHandle);
    this.#frameHandle = this.#fallbackHandle = null;
  }

  dispose() {
    this.load(null);
    this.#sourceLife?.dispose();
  }
}
