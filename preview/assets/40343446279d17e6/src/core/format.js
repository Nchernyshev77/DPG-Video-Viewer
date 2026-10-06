export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function formatTime(value) {
  const time = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const seconds = String(time % 60).padStart(2, "0");
  const minutes = String(Math.floor(time / 60) % 60).padStart(2, "0");
  const hours = Math.floor(time / 3600);
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatFPS(value) {
  return Number.isFinite(value) && value > 0
    ? String(Math.round(value * 1000) / 1000)
    : "—";
}

export function isVideoFile(file) {
  return Boolean(
    file &&
      (file.type?.startsWith("video/") ||
        /\.(mp4|webm|mkv|mov|m4v)$/i.test(file.name || "")),
  );
}

export function projectionFor(width, height) {
  return height > 0 && Math.abs(width / height - 2) < 0.05 ? "vr" : "flat";
}
