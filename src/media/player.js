import { CONFIG } from "../config.js";
import { clamp, projectionFor } from "../core/format.js";
import { createLifecycle } from "../core/lifecycle.js";
import { readVideoMetadata } from "./metadata.js";

export class VideoPlayer extends EventTarget {
  #container;
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

  video = null;
  item = null;
  ready = false;
  loading = false;
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
    } = {},
  ) {
    super();
    this.#container = container;
    this.#readMetadata = readMetadata;
    this.#cache = cache;
    this.#presentFrame = presentFrame;
  }

  get seeking() {
    return Boolean(this.#seek || this.video?.seeking);
  }

  get playing() {
    return Boolean(this.video && !this.video.paused && !this.video.ended);
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

  load(item, { autoplay = false, startTime = 0, cacheLimit } = {}) {
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
    if (this.#cache) {
      this.#emit();
      void this.#cache
        .prepare(item, life.signal, (state) => {
          if (life.signal.aborted) return;
          this.cacheState = state;
          this.#emit();
        })
        .then(open)
        .catch((error) => {
          if (!life.signal.aborted) {
            this.error = "Could not preload the video. Choose another file.";
            this.loading = false;
            this.#emit();
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
    video.hidden = true;
    this.#container.append(video);
    let restoreTime = startTime;
    life.on(video, "loadedmetadata durationchange", () => {
      if (restoreTime > 0 && Number.isFinite(video.duration)) {
        video.currentTime = clamp(
          restoreTime,
          0,
          Math.max(0, video.duration - 0.001),
        );
        restoreTime = 0;
      }
      this.#emit();
    });
    life.on(video, "loadeddata", () => {
      this.ready = true;
      this.loading = false;
      this.#emit("ready");
      void this.#drawFrame();
      this.#emit();
    });
    life.on(video, "canplay", () => {
      if (this.#autoplay) {
        this.#autoplay = false;
        void this.play();
      }
    });
    life.on(video, "play", () => {
      this.error = "";
      this.#sample = null;
      this.#startFrames();
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
      this.#seek ||= { generation, presenting: false };
      this.#seek.seeked = true;
      this.#presentSeek();
    });
    life.on(video, "loadeddata canplay", () => this.#presentSeek());
    life.on(video, "error", () => {
      this.#stopFrames();
      this.#seek = null;
      this.#pendingSeek = null;
      this.#pendingSteps = this.#repeatStep = 0;
      this.ready = this.loading = false;
      this.error =
        "Playback error. This browser may not support the video codec. Choose another file.";
      this.#emit();
    });
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
    if (!this.ready || !this.video) return;
    const video = this.video;
    try {
      await video.play();
    } catch (error) {
      if (video !== this.video || error.name === "AbortError") return;
      this.error = "Playback could not start. Press Play to try again.";
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
    const tick = (_now, metadata) => {
      this.#frameHandle = this.#fallbackHandle = null;
      if (generation !== this.#generation) return;
      this.#observeFPS(metadata);
      void this.#drawFrame();
      this.#emit();
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
