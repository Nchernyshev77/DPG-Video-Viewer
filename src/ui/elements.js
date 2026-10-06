const ids = {
  fileInput: "file",
  playBtn: "play",
  stepBackBtn: "stepBack",
  stepFwdBtn: "stepFwd",
  timeSlider: "time",
  tc: "tc",
  zoomSlider: "zoom",
  resetViewBtn: "resetView",
  status: "status",
  statusText: "statusText",
  progress: "progress",
  loadActions: "loadActions",
  loadStart: "loadStart",
  loadDirect: "loadDirect",
  loadRetry: "loadRetry",
  loadDetailsPanel: "loadDetailsPanel",
  loadDetails: "loadDetails",
  dropmask: "dropmask",
  fsBtn: "fsBtn",
  closeAllBtn: "closeAll",
  playlistSel: "playlist",
  introBackdrop: "introBackdrop",
  fsBar: "fsBar",
  fsTime: "fsTime",
  fsTimeRange: "fsTimeRange",
  playIcon: "playIcon",
  playLabel: "playLabel",
  infoBtn: "infoBtn",
  infoPanel: "infoPanel",
  cacheLimit: "cacheLimit",
  cacheStatus: "cacheStatus",
  cacheSkip: "cacheSkip",
  plistBtn: "plistBtn",
  plistBtnLabel: "plistBtnLabel",
  plistPanel: "plistPanel",
  plistFooter: "plistFooter",
  plistDock: "plistDock",
  hudFps: "hudFps",
  hudFrame: "hudFrame",
  hud: "hud",
  viewer: "viewer",
  meas: "meas",
  hzBottom: "hzBottom",
  hzCorner: "hzCorner",
};

export function getElements() {
  return Object.fromEntries(
    Object.entries(ids).map(([name, id]) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing UI element: #${id}`);
      return [name, element];
    }),
  );
}
