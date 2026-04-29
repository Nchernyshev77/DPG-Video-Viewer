import { createViewer } from './viewer.js';

const APP_NAME = 'DPG Video Viewer';
const DEFAULT_FPS = 30;

const dom = {
  app: document.getElementById('app'),
  fileInput: document.getElementById('fileInput'),
  viewerRoot: document.getElementById('viewerRoot'),
  viewerStage: document.getElementById('viewerStage'),
  viewerCanvas: document.getElementById('viewerCanvas'),
  intro: document.getElementById('intro'),
  progressBar: document.getElementById('progressBar'),
  dropMask: document.getElementById('dropMask'),
  statusBox: document.getElementById('statusBox'),
  playBtn: document.getElementById('playBtn'),
  stepBackBtn: document.getElementById('stepBackBtn'),
  stepFwdBtn: document.getElementById('stepFwdBtn'),
  resetViewBtn: document.getElementById('resetViewBtn'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  playlistToggleBtn: document.getElementById('playlistToggleBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  timeLabel: document.getElementById('timeLabel'),
  timeRange: document.getElementById('timeRange'),
  playlistPanel: document.getElementById('playlistPanel'),
  playlistList: document.getElementById('playlistList'),
  infoBtn: document.getElementById('infoBtn'),
  infoPanel: document.getElementById('infoPanel'),
  hudMode: document.getElementById('hudMode'),
  hudFps: document.getElementById('hudFps'),
  hudFrame: document.getElementById('hudFrame'),
};

const state = {
  playlist: [],
  currentIndex: -1,
  fps: DEFAULT_FPS,
  activeUrl: null,
  activeObjectUrls: new Set(),
};

const viewer = createViewer(dom.viewerCanvas, dom.viewerStage);
const video = document.createElement('video');
video.preload = 'auto';
video.playsInline = true;
video.crossOrigin = 'anonymous';
video.muted = true;
video.loop = true;
video.controls = false;

let statusTimer = null;
let isInfoVisible = false;
let isPlaylistVisible = window.innerWidth > 1180;
let lastFrameMetadata = null;
let fpsAccumulator = { frames: 0, startMediaTime: null, lastMediaTime: null };

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function createPlaylistId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCurrentItem() {
  if (state.currentIndex < 0 || state.currentIndex >= state.playlist.length) {
    return null;
  }

  return state.playlist[state.currentIndex];
}

function setIntroVisible(isVisible) {
  dom.intro.classList.toggle('intro--visible', isVisible);
}

function setDropMaskVisible(isVisible) {
  dom.dropMask.classList.toggle('drop-mask--visible', isVisible);
}

function setInfoVisible(isVisible) {
  dom.infoPanel.hidden = !isVisible;
}

function setPlaylistVisible(isVisible) {
  dom.playlistPanel.hidden = !isVisible;
}

function setStatus(message, type = 'info', autoClear = true) {
  window.clearTimeout(statusTimer);

  if (!message) {
    dom.statusBox.hidden = true;
    dom.statusBox.textContent = '';
    dom.statusBox.classList.remove('status-box--error');
    return;
  }

  dom.statusBox.hidden = false;
  dom.statusBox.textContent = message;
  dom.statusBox.classList.toggle('status-box--error', type === 'error');

  if (autoClear) {
    statusTimer = window.setTimeout(() => setStatus(''), 2600);
  }
}

function updatePlaybackUi() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const fps = Number.isFinite(state.fps) ? state.fps : DEFAULT_FPS;
  const frame = duration > 0 ? Math.round(time * fps) : NaN;

  dom.playBtn.disabled = state.currentIndex < 0;
  dom.stepBackBtn.disabled = state.currentIndex < 0;
  dom.stepFwdBtn.disabled = state.currentIndex < 0;
  dom.resetViewBtn.disabled = state.currentIndex < 0;
  dom.playBtn.textContent = video.paused ? 'Play' : 'Pause';
  dom.timeLabel.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  dom.timeRange.disabled = state.currentIndex < 0;
  dom.timeRange.max = String(Number.isFinite(duration) ? duration : 0);
  dom.timeRange.value = String(Number.isFinite(time) ? time : 0);
  dom.hudMode.textContent = `Режим: ${viewer.getMode() === 'vr' ? 'VR / 360' : 'Flat'}`;
  dom.hudFps.textContent = `FPS: ${Number.isFinite(fps) ? fps.toFixed(2) : '—'}`;
  dom.hudFrame.textContent = `Кадр: ${Number.isFinite(frame) ? frame : '—'}`;
}

function renderPlaylist() {
  dom.playlistList.replaceChildren();

  if (!state.playlist.length) {
    const empty = document.createElement('div');
    empty.className = 'playlist-item';

    const meta = document.createElement('div');
    meta.className = 'playlist-item__meta';

    const title = document.createElement('span');
    title.className = 'playlist-item__title';
    title.textContent = 'Плейлист пуст';

    const subtitle = document.createElement('span');
    subtitle.className = 'playlist-item__subtitle';
    subtitle.textContent = 'Добавь файлы через кнопку «Открыть» или drag and drop';

    meta.append(title, subtitle);
    empty.appendChild(meta);
    dom.playlistList.appendChild(empty);
    return;
  }

  state.playlist.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `playlist-item${index === state.currentIndex ? ' playlist-item--active' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'playlist-item__meta';

    const title = document.createElement('span');
    title.className = 'playlist-item__title';
    title.textContent = item.file.name;

    const subtitle = document.createElement('span');
    subtitle.className = 'playlist-item__subtitle';
    subtitle.textContent = formatBytes(item.file.size);

    meta.append(title, subtitle);

    const openButton = document.createElement('button');
    openButton.className = 'btn btn--small playlist-item__open';
    openButton.type = 'button';
    openButton.textContent = index === state.currentIndex ? 'Открыто' : 'Открыть';
    openButton.disabled = index === state.currentIndex;
    openButton.addEventListener('click', () => openIndex(index));

    const removeButton = document.createElement('button');
    removeButton.className = 'btn btn--small playlist-item__remove';
    removeButton.type = 'button';
    removeButton.textContent = 'Удалить';
    removeButton.addEventListener('click', () => removeIndex(index));

    row.append(meta, openButton, removeButton);
    dom.playlistList.appendChild(row);
  });
}

function updateEmptyState() {
  const hasFiles = state.playlist.length > 0;
  setIntroVisible(!hasFiles);
  document.title = hasFiles ? `${APP_NAME} — ${getCurrentItem()?.file?.name || ''}` : APP_NAME;
}

function resetFpsTracking() {
  state.fps = DEFAULT_FPS;
  lastFrameMetadata = null;
  fpsAccumulator = { frames: 0, startMediaTime: null, lastMediaTime: null };
}

function revokeActiveUrl() {
  if (!state.activeUrl) {
    return;
  }

  state.activeObjectUrls.delete(state.activeUrl);
  URL.revokeObjectURL(state.activeUrl);
  state.activeUrl = null;
}

function revokePlaylistUrls() {
  state.activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.activeObjectUrls.clear();
  state.activeUrl = null;
}

async function loadCurrentVideo({ autoplay = false } = {}) {
  const item = getCurrentItem();
  if (!item) {
    video.removeAttribute('src');
    video.load();
    updatePlaybackUi();
    updateEmptyState();
    renderPlaylist();
    return;
  }

  revokeActiveUrl();
  resetFpsTracking();

  const objectUrl = URL.createObjectURL(item.file);
  state.activeUrl = objectUrl;
  state.activeObjectUrls.add(objectUrl);
  video.src = objectUrl;
  video.load();

  try {
    await video.play();
    if (!autoplay) {
      video.pause();
    }
  } catch (_) {
    if (autoplay) {
      setStatus('Автовоспроизведение заблокировано браузером. Нажми Play.', 'info', false);
    }
  }

  updatePlaybackUi();
  updateEmptyState();
  renderPlaylist();
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('video/') || /\.(mp4|webm|mkv|mov)$/i.test(file.name));
  if (!files.length) {
    setStatus('Поддерживаются только видеофайлы.', 'error');
    return;
  }

  state.playlist.push(...files.map((file) => ({ id: createPlaylistId(), file })));

  if (state.currentIndex === -1) {
    state.currentIndex = 0;
    loadCurrentVideo({ autoplay: false });
  }

  renderPlaylist();
  updateEmptyState();
  setStatus(`Добавлено файлов: ${files.length}.`);
}

function openIndex(index, { autoplay = false } = {}) {
  if (index < 0 || index >= state.playlist.length) {
    return;
  }

  state.currentIndex = index;
  loadCurrentVideo({ autoplay });
}

function removeIndex(index) {
  if (index < 0 || index >= state.playlist.length) {
    return;
  }

  state.playlist.splice(index, 1);

  if (!state.playlist.length) {
    clearPlaylist();
    return;
  }

  if (state.currentIndex > index) {
    state.currentIndex -= 1;
  } else if (state.currentIndex === index) {
    state.currentIndex = Math.min(index, state.playlist.length - 1);
    loadCurrentVideo({ autoplay: false });
  }

  renderPlaylist();
  updateEmptyState();
}

function clearPlaylist() {
  state.playlist = [];
  state.currentIndex = -1;
  video.pause();
  video.removeAttribute('src');
  video.load();
  revokePlaylistUrls();
  renderPlaylist();
  updatePlaybackUi();
  updateEmptyState();
  setStatus('Все видео удалены.');
}

function stepFrame(direction) {
  const fps = Number.isFinite(state.fps) && state.fps > 0 ? state.fps : DEFAULT_FPS;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const nextTime = Math.min(Math.max(video.currentTime + direction / fps, 0), Math.max(duration - 0.001, 0));
  video.pause();
  video.currentTime = nextTime;
  updatePlaybackUi();
}

async function togglePlayPause() {
  if (state.currentIndex < 0) {
    return;
  }

  if (video.paused) {
    try {
      await video.play();
    } catch (error) {
      setStatus(`Не удалось запустить воспроизведение: ${error.message}`, 'error', false);
      return;
    }
  } else {
    video.pause();
  }

  updatePlaybackUi();
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }

  await dom.viewerStage.requestFullscreen();
}

function toggleInfo() {
  isInfoVisible = !isInfoVisible;
  setInfoVisible(isInfoVisible);
}

function togglePlaylist(force) {
  isPlaylistVisible = typeof force === 'boolean' ? force : !isPlaylistVisible;
  setPlaylistVisible(isPlaylistVisible);
}

function goRelative(delta) {
  if (!state.playlist.length) {
    return;
  }

  const nextIndex = (state.currentIndex + delta + state.playlist.length) % state.playlist.length;
  openIndex(nextIndex, { autoplay: !video.paused });
}

function trackVideoFrames() {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return;
  }

  const onFrame = (_, metadata) => {
    const mediaTime = metadata.mediaTime;

    if (lastFrameMetadata && mediaTime > lastFrameMetadata.mediaTime) {
      if (fpsAccumulator.startMediaTime == null) {
        fpsAccumulator.startMediaTime = lastFrameMetadata.mediaTime;
      }

      fpsAccumulator.frames += 1;
      fpsAccumulator.lastMediaTime = mediaTime;

      const elapsed = fpsAccumulator.lastMediaTime - fpsAccumulator.startMediaTime;
      if (elapsed >= 0.5) {
        const estimatedFps = fpsAccumulator.frames / elapsed;
        if (Number.isFinite(estimatedFps) && estimatedFps > 1) {
          state.fps = estimatedFps;
        }
      }
    }

    lastFrameMetadata = metadata;
    updatePlaybackUi();
    video.requestVideoFrameCallback(onFrame);
  };

  video.requestVideoFrameCallback(onFrame);
}

video.addEventListener('loadedmetadata', () => {
  viewer.attachVideo(video);
  viewer.resetView(video.videoWidth || 16, video.videoHeight || 9);
  updatePlaybackUi();
  setStatus('');
});
video.addEventListener('timeupdate', updatePlaybackUi);
video.addEventListener('play', updatePlaybackUi);
video.addEventListener('pause', updatePlaybackUi);
video.addEventListener('ended', updatePlaybackUi);
video.addEventListener('error', () => setStatus('Ошибка загрузки видео.', 'error', false));

trackVideoFrames();

window.addEventListener('beforeunload', revokePlaylistUrls);
window.addEventListener('resize', () => {
  if (window.innerWidth > 1180 && !isPlaylistVisible) {
    return;
  }
  setPlaylistVisible(isPlaylistVisible);
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const isTextInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (isTextInput) {
    return;
  }

  switch (event.key.toLowerCase()) {
    case ' ':
      event.preventDefault();
      togglePlayPause();
      break;
    case 'a':
    case 'arrowleft':
      event.preventDefault();
      stepFrame(-1);
      break;
    case 'd':
    case 'arrowright':
      event.preventDefault();
      stepFrame(1);
      break;
    case 'w':
    case 'arrowup':
      event.preventDefault();
      goRelative(-1);
      break;
    case 's':
    case 'arrowdown':
      event.preventDefault();
      goRelative(1);
      break;
    case 'r':
      event.preventDefault();
      viewer.resetView(video.videoWidth || 16, video.videoHeight || 9);
      break;
    case 'f':
      event.preventDefault();
      toggleFullscreen().catch((error) => setStatus(`Fullscreen недоступен: ${error.message}`, 'error'));
      break;
    case 'i':
      event.preventDefault();
      toggleInfo();
      break;
    case 'o':
      event.preventDefault();
      dom.fileInput.click();
      break;
    default:
      break;
  }
});

dom.fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});
dom.intro.addEventListener('click', () => dom.fileInput.click());
dom.intro.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    dom.fileInput.click();
  }
});
dom.playBtn.addEventListener('click', togglePlayPause);
dom.stepBackBtn.addEventListener('click', () => stepFrame(-1));
dom.stepFwdBtn.addEventListener('click', () => stepFrame(1));
dom.resetViewBtn.addEventListener('click', () => viewer.resetView(video.videoWidth || 16, video.videoHeight || 9));
dom.fullscreenBtn.addEventListener('click', () => toggleFullscreen().catch((error) => setStatus(`Fullscreen недоступен: ${error.message}`, 'error')));
dom.infoBtn.addEventListener('click', toggleInfo);
dom.playlistToggleBtn.addEventListener('click', () => togglePlaylist());
dom.clearAllBtn.addEventListener('click', clearPlaylist);
dom.timeRange.addEventListener('input', (event) => {
  const nextTime = Number(event.target.value);
  video.currentTime = Number.isFinite(nextTime) ? nextTime : 0;
  updatePlaybackUi();
});
dom.viewerStage.addEventListener('wheel', (event) => {
  event.preventDefault();
  viewer.setFovFromWheel(event.deltaY, video.videoWidth || 16, video.videoHeight || 9);
}, { passive: false });
['dragenter', 'dragover'].forEach((eventName) => {
  dom.viewerStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    setDropMaskVisible(true);
  });
});
['dragleave', 'dragend'].forEach((eventName) => {
  dom.viewerStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    setDropMaskVisible(false);
  });
});
dom.viewerStage.addEventListener('drop', (event) => {
  event.preventDefault();
  setDropMaskVisible(false);
  if (event.dataTransfer?.files?.length) {
    addFiles(event.dataTransfer.files);
  }
});

setInfoVisible(isInfoVisible);
setPlaylistVisible(isPlaylistVisible);
setStatus(`${APP_NAME} готов к проверке. Загрузите видео для теста.`);
updateEmptyState();
renderPlaylist();
updatePlaybackUi();
