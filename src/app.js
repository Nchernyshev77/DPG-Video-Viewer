  import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
  import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';

  // === UI ===
  
function esc(s){ try{ return String(s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]); }); }catch(_){ return ''; } }
const I=id=>document.getElementById(id);
  const [fileInput,playBtn,stepBackBtn,stepFwdBtn,timeSlider,tc,zoomSlider,resetViewBtn,status,statusText,progress,dropmask,fsBtn,closeAllBtn,playlistSel,introBackdrop,fsBar,fsTime,fsTimeRange,playIcon,playLabel,infoBtn,infoPanel,plistBtn,plistBtnLabel,plistPanel,hudFps,hudFrame,viewer,toolbar,meas] = ['file','play','stepBack','stepFwd','time','tc','zoom','resetView','status','statusText','progress','dropmask','fsBtn','closeAll','playlist','introBackdrop','fsBar','fsTime','fsTimeRange','playIcon','playLabel','infoBtn','infoPanel','plistBtn','plistBtnLabel','plistPanel','hudFps','hudFrame','viewer','toolbar','meas'].map(I);
  

// ===== SECTION: UI ELEMENT BINDINGS =====
// ====== CONFIG / STATE / BUS (non-breaking scaffolding) ======
const CONFIG = Object.freeze({
  zoom: { min: parseFloat(zoomSlider.min)||20, max: parseFloat(zoomSlider.max)||100, uiInitial: parseFloat(zoomSlider.value)||80 },
});

const state = {
  mode: 'flat',      // 'flat' | 'vr' (future: 'image' | 'sequence' | 'audio')
  fps: null,
  framesTotal: null,
  isScrubbing: false,
  fov: 75,
  meta: { type: null, name: '', duration: null },
};

const Bus = (()=>{
  const m = new Map();
  return {
    on(ev, fn){ if(!m.has(ev)) m.set(ev, new Set()); m.get(ev).add(fn); return ()=>m.get(ev)?.delete(fn); },
    emit(ev, payload){ const s=m.get(ev); if(s) for(const fn of s) try{ fn(payload); }catch(e){ console.error(e); } },
    off(ev, fn){ m.get(ev)?.delete(fn); }
  };
})();

// ---- Bus listeners (non-breaking mirrors) ----
try{
  Bus.on && Bus.on('fps:set', (val)=>{
    try{
      state.fps = (typeof val==='number' && isFinite(val)) ? val : null;
      if(state.fps && isFinite((video&&video.duration)||NaN)){
        state.framesTotal = Math.round((video.duration||0)*state.fps);
      } else {
        state.framesTotal = null;
      }
    }catch(_){}
  });
  Bus.on && Bus.on('seek', (t)=>{
    try{
      // mirror only; core seek logic unchanged
      // could be used by external panels later
    }catch(_){}
  });
}catch(_){/* no-op if Bus absent */}
// ---- /Bus listeners ----
// ===== SECTION: STATUS DISPLAY =====
function reportError(err, where){
  try{
    const msg = (err && err.message) ? err.message : String(err);
    showError(where ? (where+': '+msg) : msg);
    if (console && console.error) console.error('[viewer]', where||'error', err);
  }catch(_){/* noop */}
}

function setStatus(kind, text){
  try{
    if(text!=null){
      if(kind==='error'){ status.classList.add('show'); statusText.textContent = String(text); }
      else if(kind==='info'){ status.classList.add('show'); statusText.textContent = String(text); }
      else { status.classList.remove('show'); }
    }
  }catch(_){/* non-critical */}
}
function showInfo(text){
  try{ setStatus('info', text); status.classList.add('show'); statusText.textContent = String(text); }catch(_){}
}
function showError(text){
  try{ setStatus('error', text); status.classList.add('show'); statusText.textContent = String(text); }catch(_){}
}
function clearStatus(){
  try{ setStatus('', ''); status.classList.remove('show'); }catch(_){}
}

// ====== /CONFIG / STATE / BUS ======
const ZMIN = parseFloat(zoomSlider.min)||20;
  const ZMAX = parseFloat(zoomSlider.max)||100;
  const ZSUM = ZMIN + ZMAX;

  const on=(t,evs,fn,opt)=>evs.split(' ').forEach(e=>t.addEventListener(e,fn,opt));

  // === THREE ===
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, powerPreference:'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const defaultDPR = Math.min(window.devicePixelRatio, 2); let currentDPR = defaultDPR; renderer.setPixelRatio(defaultDPR); const applyDPR=(d)=>{ if(d!==currentDPR){ currentDPR=d; renderer.setPixelRatio(d); onResize();
  try{ __relocatePlistForFS(!!isFullscreen()); }catch(_){ } } };
  renderer.setSize(viewer.clientWidth, viewer.clientHeight, true);
  renderer.setClearColor(0x000000, 1);
  viewer.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(80, viewer.clientWidth/viewer.clientHeight, 0.1, 1100);
  camera.position.set(0,0,0.01);

  try{ const fInit = (ZSUM - parseFloat((zoomSlider&&zoomSlider.value)||80)); camera.fov=fInit; camera.updateProjectionMatrix(); fitPlane(); }catch(e){}
const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.enablePan = false; controls.rotateSpeed = -0.35; // inverted axes
  controls.enableZoom = false; // wheel -> FOV zoom
  let interacting=false;
  controls.addEventListener('start',()=>{
    interacting=true;
    startRenderLoop();
  });
  controls.addEventListener('end',()=>{
    interacting=false;
    if (video.paused) stopRenderLoop();
  });
  const isFirefox = /firefox/i.test(navigator.userAgent);
  // projection + shader materials must be defined BEFORE first use
  let uvMesh = null;
  // runtime mode + flat panning
  let renderMode = 'vr';
  let panX = 0, panY = 0;

  // Sphere for equirectangular; inside-out w/o mirroring

  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });// keep sphere hidden; VR uses cube only// UV sphere (high tessellation) to compare with cube projection
  // Lighter tessellation to reduce startup cost on weak/old GPUs.
  const uvGeo = new THREE.SphereGeometry(500,64,64);
  uvGeo.scale(-1,1,1);
  uvMesh = new THREE.Mesh(uvGeo, material);
  uvMesh.visible = false;
  uvMesh.rotation.y = -Math.PI/2; // align initial view to image center (−90°)
  scene.add(uvMesh);

  // (Cube projection removed) — using UV sphere for VR

  // ==== Core media & playback state (restored) ====
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;            // allow autoplay when requested
  video.loop = true;             // auto-repeat per earlier request
  video.controls = false;

  // Freeze camera while playing to avoid micro-drift/"waves"; restore damping on pause
  video.addEventListener('play', ()=>{
    controls.enableDamping = false;
    startRenderLoop();
  });
  video.addEventListener('pause', ()=>{
    controls.enableDamping = true;
    if (!interacting) stopRenderLoop();
  });

  let playlist = [];
  let currentIndex = -1;
  let revokers = [];
  let currentFile = null;

  let haveMetadata = false;
  let pendingAutoplay = false;
  let allowPlay = false;
  let isScrubbing = false;

  let sourceFPS = null, displayFPS = null, estimatedFPS = null;
  let activeLoadId = 0;

  let videoTex = null;

  // Flat plane for non-2:1 videos
  const planeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: null, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1,1), planeMat);
  plane.visible = false;
  scene.add(plane);

  function attachVideoTexture(){
    if(videoTex) return;
    videoTex = new THREE.VideoTexture(video);
    videoTex.colorSpace = THREE.SRGBColorSpace;
    const w = video.videoWidth||0, h = video.videoHeight||0;
    const pot = (w>0 && h>0 && (w & (w-1))===0 && (h & (h-1))===0);
    const useMips = pot && w<=4096 && h<=4096; // mips only for POT textures
    videoTex.generateMipmaps = useMips;
    videoTex.minFilter = useMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    videoTex.magFilter = THREE.LinearFilter;
    // NPOT textures cannot use REPEAT; enforce CLAMP to avoid incomplete texture -> black
    videoTex.wrapS = THREE.ClampToEdgeWrapping;
    videoTex.wrapT = THREE.ClampToEdgeWrapping;
    videoTex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    material.map = videoTex; material.needsUpdate = true;
    planeMat.map = videoTex; planeMat.needsUpdate = true;
    
    if(video.readyState>=2){ videoTex.needsUpdate = true; }
  }
  function refreshTex(){ if(videoTex){ videoTex.needsUpdate = true; } }

  function applyLetterbox(){ /* no-op for compatibility */ }

  function applyVR(){
    renderMode='vr'; controls.enabled=true; plane.visible=false;if(uvMesh) uvMesh.visible=true;
  }
  function applyFLAT(){
    renderMode='flat'; controls.enabled=false;if(uvMesh) uvMesh.visible=false; plane.visible=true; fitPlane();
  }
  function decideAndApplyMode(){
    const w = video.videoWidth || 0, h = video.videoHeight || 0;
    if (h>0 && Math.abs(w/h - 2) < 0.05) applyVR(); else applyFLAT();
  }

  function fitPlane(){
    const d=1;
    const vh = 2*d*Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
    const vw = vh*camera.aspect;
    const W = video.videoWidth || 16, H = video.videoHeight || 9;
    const r = W/H, rView = vw/(vh||1);
    let pw, ph;
    if (r >= rView) { pw = vw; ph = vw / r; } else { ph = vh; pw = vh * r; }
    plane.position.set(panX, panY, -d);
    const z = 75 / (camera.fov || 75); plane.scale.set(pw * z, ph * z, 1); }

  function fmtTime(t){ if(!isFinite(t)) return '00:00'; t=Math.max(0, Math.floor(t)); const s=t%60; const m=Math.floor(t/60)%60; const h=Math.floor(t/3600); return h>0? (h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')) : (String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')); }
  function updateTimeUI(){
    const cur=video.currentTime||0, dur=video.duration||0;
    tc.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    fsTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    if(Number.isFinite(dur) && dur>0 && !isScrubbing){
      const max=dur.toFixed(3); const val=(video.currentTime||0).toFixed(3);
      timeSlider.max=max; fsTimeRange.max=max; timeSlider.value=val; fsTimeRange.value=val;
      timeSlider.disabled=false; fsTimeRange.disabled=false;
    }
  }
  function formatFPS(val){
  if(!(typeof val==='number') || !isFinite(val)) return '—';
  const r = Math.round(val*1000)/1000;
  if (Math.abs(r - Math.round(r)) < 1e-3) return String(Math.round(r));
  return String(r).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

// ===== Media Adapters (skeleton, unused yet) =====
/**
 * Basic interface (documentation):
 *  kind: 'video'|'image'|'sequence'|'audio'
 *  load(fileOrUrl): Promise<Meta>
 *  play(), pause(), seek(t), currentTime(), duration(), dispose()
 */
function createVideoAdapter(videoEl){
  const v = videoEl;
  return {
    kind: 'video',
    async load(){ return { duration: v.duration||null }; },
    play(){ try{ v.play(); }catch(_){/*noop*/} },
    pause(){ try{ v.pause(); }catch(_){/*noop*/} },
    seek(t){ try{ v.currentTime = Math.max(0, Math.min(v.duration||0, +t||0)); }catch(_){/*noop*/} },
    currentTime(){ return v.currentTime||0; },
    duration(){ return v.duration||0; },
    dispose(){ /* nothing yet */ }
  };
}
// ===== /Media Adapters =====

// ===== SECTION: HUD UPDATE LOOP =====

function updateHUD(){
  /* state mirrors */ try{ state.fps = displayFPS || null; state.framesTotal = (displayFPS && isFinite(video.duration||NaN))? Math.round((video.duration||0)*displayFPS): null; state.fov = (camera&&camera.fov)||state.fov; }catch(_){/*noop*/}

    const fps = displayFPS;
    hudFps.textContent = 'FPS: ' + (fps? formatFPS(fps) : '—');
    hudFps.style.color = (fps && Math.round(fps)!==30) ? '#ff4a4a' : '';
    const f = fps ? Math.max(0, Math.round((video.currentTime||0)*fps)) : '—';
    const total = (displayFPS && isFinite(video.duration||NaN)) ? Math.round((video.duration||0)*displayFPS) : null;
if (document.getElementById('frameJumpInput')) {  const wrap = document.getElementById('frameTotalWrap');  if (wrap) { wrap.textContent = total ? (' / ' + String(total)) : ''; }} else {  hudFrame.textContent = 'Frame: ' + (total? (String(f)+' / '+String(total)) : String(f));}}
  let lastUI=0; const UI_INTERVAL=80;
  function updateUI(force=false){ const now=performance.now(); if(force || now-lastUI>UI_INTERVAL){ updateTimeUI(); updateHUD(); lastUI=now; } }

  function rebuildPlaylistUI(){
    playlistSel.innerHTML = playlist.map((it,i)=>`<option value="${i}">${i+1}. ${it.name}</option>`).join('');
    playlistSel.disabled = playlist.length===0;
    plistBtnLabel.textContent = playlist.length ? String(playlist.length) : '';
    rebuildPlaylistPanel();
  
    if(playlist.length===0){ try{ displayFPS=null; }catch(_){ } try{ updateHUD(true); }catch(_){ } }
  }

  async function addFiles(fileList){
    const wasPlaying = !video.paused && haveMetadata;
    const arr = Array.from(fileList||[]);
    for(const f of arr){
      if(!f) continue; const _t=(f.type||'').toLowerCase(); const _n=(f.name||'').toLowerCase(); const _looksVideo = _t.startsWith('video/') || /\.(mp4|webm|mkv|mov)$/i.test(_n); if(!_looksVideo) continue;
      let _pf; try{ _pf = await prefetchToBlobUrl(f); }catch(_){ _pf = { blobUrl: URL.createObjectURL(f), fromCache:false }; }
      const url = _pf.blobUrl;
      revokers.push(()=>{ try{ URL.revokeObjectURL(url); }catch(_){}});
      playlist.push({ url, name:f.name, file:f });
    }
    rebuildPlaylistUI();
    if(playlist.length){ loadIndex(playlist.length-1, {autoplay:wasPlaying}); }
  }

  // Render loop
  function loop(){
    if(!video.paused && video.readyState>=2 && videoTex){ videoTex.needsUpdate = true; }
    if(controls.enableDamping || interacting) controls.update();
    renderer.render(scene, camera);
    updateUI();
  }
  

// Render once helper to force a frame when stepping on pause
function __renderOnce(){
  try{
    if(videoTex) videoTex.needsUpdate = true;
    if(typeof renderer!=='undefined' && renderer && typeof scene!=='undefined' && scene && typeof camera!=='undefined' && camera){
      renderer.render(scene, camera);
    }
  }catch(_){}
}
let renderLoopRunning = false;
function startRenderLoop(){
  if (renderLoopRunning) return;
  renderLoopRunning = true;
  renderer.setAnimationLoop(loop);
}
function stopRenderLoop(){
  if (!renderLoopRunning) return;
  renderLoopRunning = false;
  renderer.setAnimationLoop(null);
  __renderOnce();
}
// Do not run 60fps loop while idle: start only on demand.
__renderOnce();

  function loadIndex(i, opts={autoplay:false}){
    if(i<0 || i>=playlist.length) return;
    const wasPlaying = opts.autoplay;
    currentIndex = i; playlistSel.value = String(i);
    try{ updatePlaylistActive(); }catch(_){ }
    
    try{ if(plistPanel && plistPanel.classList.contains('show')) plistBtn.blur(); }catch(_){ }
currentFile = playlist[i].file || null;
    loadURL(playlist[i].url, playlist[i].name, {autoplay: wasPlaying});
  }
  const nav=(d)=>{ if(!playlist.length) return; const p=!video.paused&&haveMetadata; loadIndex((currentIndex+d+playlist.length)%playlist.length,{autoplay:p}); };
  
  
  playlistSel.addEventListener('change', ()=>{ const wasPlaying = !video.paused && haveMetadata; const i = parseInt(playlistSel.value,10); loadIndex(i, {autoplay:wasPlaying}); });

  // === Custom playlist panel ===
  
// Keep active row highlighted in the opened playlist panel
function updatePlaylistActive(){
  try{
    if(!plistPanel) return;
    const prev = plistPanel.querySelector('.plItem.active');
    if(prev) prev.classList.remove('active');
    const cur = plistPanel.querySelector(`.plItem[data-idx="${currentIndex}"]`);
    if(cur){ cur.classList.add('active'); try{ cur.scrollIntoView({block:'nearest'}); }catch(_){ } }
  }catch(_){}
}

function rebuildPlaylistPanel(){
    if(!plistPanel) return;
    if(!playlist.length){ plistPanel.innerHTML = '<div style="padding:.6rem .8rem; color:#9aa3ad">Empty</div>'; return; }
    const rows = playlist.map((item,i)=>{
      const active = (i===currentIndex) ? ' active' : '';
      return `<div class="plItem${active}" data-idx="${i}">
        <span class="idx">${i+1}.</span>
        <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        <button class="x" title="Remove" aria-label="Remove">×</button>
      </div>`;
    }).join('');
    plistPanel.innerHTML = rows;
    // Append playlist footer with Close all at end of list
    try{
      var footer = document.getElementById('plistFooter');
      if(!footer){
        footer = document.createElement('div');
        footer.id = 'plistFooter';
      }
      // Move the actual Close all button node to keep listeners
      if (typeof closeAllBtn !== 'undefined' && closeAllBtn) {
        // Ensure it has a visible text label in playlist context
        (function(btn){
          var hasText=false, spans=btn.querySelectorAll('span');
          for(var i=0;i<spans.length;i++){ if(!spans[i].classList.contains('i') && (spans[i].textContent||'').trim()){ hasText=true; break; } }
          if(!hasText){ var lab=document.createElement('span'); lab.textContent='Close all'; btn.appendChild(lab); }
          footer.innerHTML=''; footer.appendChild(btn);
        })(closeAllBtn);
      }
      // Place footer strictly after generated rows
      if(footer !== plistPanel.lastElementChild) plistPanel.appendChild(footer);
    }catch(_){}

  
    try{ if (typeof infoPanel!=='undefined' && infoPanel && infoPanel.classList && infoPanel.classList.contains('show')) positionInfoPanel(); }catch(_){}
}
  function overlayTopPx(){ const r=infoBtn.getBoundingClientRect(); return Math.round(r.top); }
  function openPlistPanel(){
    rebuildPlaylistPanel();
    { const items = plistPanel.querySelectorAll('.plItem'); if(items && items.length >= 5){ plistPanel.scrollTop = Math.max(0, items[4].offsetTop - 8); } }
    const r = plistBtn.getBoundingClientRect();
    const margin = 12; // keep some space to see rounded corners on the right

    let longest=''; for(const it of playlist){const n=it.name||''; if(n.length>longest.length) longest=n;}
    meas.textContent = longest;
    let desired = Math.ceil(meas.getBoundingClientRect().width) + 56;

    const maxW = Math.floor(window.innerWidth * 0.8);
    const minW = 260;
    desired = Math.max(minW, Math.min(maxW, desired));

    // Set explicit width so content fits; expand leftwards if needed
    plistPanel.style.width = desired + 'px';

    let left = Math.round(plistDock.getBoundingClientRect().right) + 8;
    // Shift left if we would overflow on the right or get too close to the right edge
    const rightEdge = left + desired;
    let overflow = rightEdge + margin - window.innerWidth;
    if(overflow > 0){ left = left - overflow; }
    const remainingRight = window.innerWidth - (left + desired);
    if(remainingRight < margin){ left -= (margin - remainingRight); }
    // Clamp to screen with a small left margin
    if(left < margin) left = margin;

    plistPanel.style.left = Math.round(left) + 'px';
    plistPanel.style.top = Math.round(r.top) + 'px';
    plistPanel.classList.add('show');
      try{ window.__panelState = window.__panelState || {}; window.__panelState.plist = true; }catch(_){}
if (typeof infoPanel!=='undefined' && infoPanel && infoPanel.classList && infoPanel.classList.contains('show')) { positionInfoPanel(); }
    }
  function closePlistPanel() { plistPanel.classList.remove('show');
    try{ window.__panelState = window.__panelState || {}; window.__panelState.plist = false; }catch(_){}
try{ window.__panelState = window.__panelState || {}; window.__panelState.plist = false; window.__plistLastClosedTS = Date.now(); }catch(_){ }
try{ if (typeof infoPanel!=='undefined' && infoPanel && infoPanel.classList && infoPanel.classList.contains('show')) positionInfoPanel(); }catch(_){ }
   }
  const togglePlistPanel=()=> plistPanel.classList.contains('show') ? closePlistPanel() : openPlistPanel();
  on(plistBtn,'click', e=>{ e.stopPropagation(); togglePlistPanel(); });
  on(plistBtn,'contextmenu', e=>{ e.preventDefault(); e.stopPropagation(); try{ clearAll(); }catch(_){ } });
  on(document,'click', e=>{
  const onViewer  = (e.target===viewer) || (e.target.closest && e.target.closest('#viewer'));
  const inPlBtn   = (e.target===plistBtn) || (e.target.closest && e.target.closest('#plistBtn'));
  const inPl      = !!(plistPanel && plistPanel.contains && plistPanel.contains(e.target));
  const inInfoBtn = (e.target===infoBtn) || (e.target.closest && e.target.closest('#infoBtn'));
  const inInfo    = !!(infoPanel && infoPanel.contains && infoPanel.contains(e.target));
  if (onViewer) return;
  if (plistPanel && !inPl && !inPlBtn && !inInfoBtn && !inInfo) closePlistPanel();
  if (infoPanel && !inInfo && !inInfoBtn && !inPlBtn && !inPl) closeInfoPanel();
});
plistPanel.addEventListener('click', (e)=>{
    // Keep panel open while interacting inside it
    e.stopPropagation();
    const row = e.target.closest('.plItem');
    if(!row) return;
    const idx = parseInt(row.getAttribute('data-idx'),10);
    if(e.target.closest('.x')){ removeIndex(idx); return; }
    const wasPlaying = !video.paused && haveMetadata;
    loadIndex(idx, {autoplay:wasPlaying});
    // refresh to update active highlight without closing
    rebuildPlaylistUI();
  });

  function removeIndex(i){
    if(i<0 || i>=playlist.length) return;
    const wasPlaying = !video.paused && haveMetadata;
    const removingCurrent = (i===currentIndex);
    // Revoke URL
    const rev = revokers.splice(i,1)[0]; try{ if(rev) rev(); }catch(e){}
    // Remove from playlist
    playlist.splice(i,1);
    if(!playlist.length){ clearAll(); openPlistPanel(); return; }
    if(removingCurrent){
      const target = Math.min(i, playlist.length-1);
      loadIndex(target, {autoplay:wasPlaying});
      rebuildPlaylistUI();
    } else {
      if(i < currentIndex) currentIndex -= 1; // shift left
      rebuildPlaylistUI();
    }
    rebuildPlaylistPanel();
  }

  function clearAll(){
    try{ video.pause(); }catch(e){}
    video.removeAttribute('src'); video.load(); haveMetadata=false; estimatedFPS=null; pendingAutoplay=false; videoTex=null; material.map=null; material.needsUpdate=true;
    while(revokers.length){ try{ revokers.pop()(); }catch(e){} }
    playlist.length=0; currentIndex=-1; rebuildPlaylistUI();
    
    
    try{ releasePrefetchCache(); }catch(_){ }
try{ displayFPS = null; }catch(_){ }
    try{ updateHUD(true); }catch(_){ }
timeSlider.disabled=true; stepBackBtn.disabled=true; stepFwdBtn.disabled=true; playBtn.disabled=true;
    progress.hidden=true; status.classList.add('show');
    try{ if(window.__uiShowMenus) window.__uiShowMenus(); }catch(_){ }
    try{ document.getElementById('viewer')?.classList.remove('ui-autoHide'); }catch(_){ } introBackdrop.classList.add('show'); statusText.innerHTML = 'Drag & Drop a video here or <b>click here</b>.';
    tc.textContent = '00:00 / 00:00'; timeSlider.value='0'; timeSlider.max='0'; fsTimeRange.value='0'; fsTimeRange.max='0'; fsTime.textContent='00:00 / 00:00';
    closePlistPanel(); if(plistPanel){ plistPanel.innerHTML = '<div style="padding:.6rem .8rem; color:#9aa3ad">Empty</div>'; }
  
    try{ closeInfoPanel(); }catch(_){ }}
  closeAllBtn.addEventListener('click', clearAll);

  
// ===== SECTION: PREFETCH (RAM cache for small/medium files) =====
const MAX_PREFETCH_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const ramCache = new Map(); // key -> { blobUrl, size, ts }

function makeCacheKey(file){
  try{ return [file.name, file.size, file.lastModified].join('|'); }catch(_){ return String(Math.random()); }
    try{ closeInfoPanel(); }catch(_){ }
}

/**
 * Prefetch entire file into RAM and create a Blob URL (safe fallback to original File on error).
 * Returns: { blobUrl, fromCache: boolean }
 */
async function prefetchToBlobUrl(file){
  const key = makeCacheKey(file);
  if (ramCache.has(key)) return { blobUrl: ramCache.get(key).blobUrl, fromCache: true };
  if (typeof file.size==='number' && file.size > MAX_PREFETCH_BYTES) {
    // too big for prefetch — use original file directly
    return { blobUrl: URL.createObjectURL(file), fromCache: false };
  }
  showInfo(`Preloading: ${(file.size/1048576).toFixed(1)} MB…`);
  try{
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: file.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    ramCache.set(key, { blobUrl: url, size: file.size, ts: Date.now() });
    clearStatus();
    return { blobUrl: url, fromCache: false };
  }catch(e){
    try{ reportError(e, 'prefetchToBlobUrl'); }catch(_){}
    // fallback to direct file
    clearStatus();
    return { blobUrl: URL.createObjectURL(file), fromCache: false };
  }
}

function releasePrefetchCache(){
  try{
    for(const {blobUrl} of ramCache.values()){
      try{ URL.revokeObjectURL(blobUrl); }catch(_){}
    }
    ramCache.clear();
  }catch(_){}
}
// ===== /PREFETCH =====

// === Loading ===
  function loadURL(url, name, {autoplay=false}={}){
    const loadId = ++activeLoadId;
    pendingAutoplay = !!autoplay;
    // reset camera / zoom for new video
    try{ controls.reset(); }catch(e){}
    try{ applyFOV(80); }catch(e){} if(uvMesh) uvMesh.rotation.set(0,-Math.PI/2,0);
    // reset fps state for new source
    sourceFPS = null; displayFPS = null; estimatedFPS = null; updateHUD();
    allowPlay = false; // block any unsolicited plays until we explicitly start

    // reset timeline to 0 immediately (no tiny preview)
    timeSlider.value='0'; timeSlider.max='0'; fsTimeRange.value='0'; fsTimeRange.max='0'; tc.textContent='00:00 / 00:00'; fsTime.textContent='00:00 / 00:00';

    status.classList.add('show'); introBackdrop.classList.add('show'); progress.hidden=false; progress.value=0; haveMetadata=false; playBtn.disabled=true; stepBackBtn.disabled=true; stepFwdBtn.disabled=true; timeSlider.disabled=true;
    showInfo(`Loading: ${name||''}`);

    videoTex=null; material.map=null; material.needsUpdate=true;
    planeMat.map=null; planeMat.needsUpdate=true;
    try{ renderer.clear(); }catch(_){}
    __renderOnce();

    // Guard any automatic plays from the element    // Remove previous playGuard if any to avoid duplicate listeners
    try{ if(video.__playGuard){ video.removeEventListener('play', video.__playGuard); video.removeEventListener('playing', video.__playGuard); } }catch(_){ }

    const playGuard = ()=>{ if(!allowPlay) { try{ video.pause(); }catch(e){} } };
    video.addEventListener('play', playGuard, {once:false});
    video.addEventListener('playing', playGuard, {once:false});
    try{ video.__playGuard = playGuard; }catch(_){ }

    video.src = url; try{ video.pause(); }catch(e){}; video.load();

    video.addEventListener('loadedmetadata', ()=>onLoadedMetadataOnce(loadId), { once:true });
    video.addEventListener('loadeddata', ()=>onLoadedDataOnce(loadId), { once:true });
    video.addEventListener('canplay', ()=>onCanPlayOnce(loadId, autoplay), { once:true });
    video.addEventListener('progress', ()=>onProgress(loadId));
    video.addEventListener('error', ()=>onVideoError(loadId), { once:true });
  }

  function onLoadedMetadataOnce(loadId){
    if(loadId !== activeLoadId) return;
    initFPSFromMetadata(currentFile).catch(e=>{ try{ reportError(e,'initFPSFromMetadata'); }catch(_){} });
    haveMetadata = true; try{ video.currentTime = 0; }catch(e){}
    attachVideoTexture(); decideAndApplyMode(); refreshTex();
    timeSlider.disabled=false; playBtn.disabled=false; stepBackBtn.disabled=false; stepFwdBtn.disabled=false;
    __renderOnce();
  }

  function onLoadedDataOnce(loadId){
    if(loadId !== activeLoadId) return;
    // Ensure texture is attached and first frame is uploaded
    attachVideoTexture();
    decideAndApplyMode();
    refreshTex();
    fitPlane();
    applyFOV(defaultFOV());
    // Hide overlays as soon as we have the first decodable frame
    progress.hidden = true;
    clearStatus();
    introBackdrop.classList.remove('show');
    updateUI(true);
    __renderOnce();
  }

  function onCanPlayOnce(loadId, autoplay){
    if(loadId !== activeLoadId) return;
    progress.hidden=true; clearStatus(); introBackdrop.classList.remove('show'); updateUI(true);
    if(autoplay){ video.currentTime = 0; allowPlay = true; video.play().catch(()=>{}); } else { allowPlay=false; video.pause(); }
    updatePlayBtn();
    __renderOnce();
    // Measure FPS only if playing; never start playback for it
    setTimeout(()=>{ if(!video.paused) autoEstimateFPS(); }, 600);
  }

  async function autoEstimateFPS(){
    if(video.paused) return; // never start playback for measurement
    let frames=0; let startMedia=null; let endMedia=null; const durationSec=0.5; const startWall=performance.now();
    const cb=(now,meta)=>{ frames++; if(startMedia===null) startMedia = meta.mediaTime; endMedia = meta.mediaTime; if(performance.now()-startWall < durationSec*1000){ video.requestVideoFrameCallback(cb);} };
    if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(cb);
    await new Promise(r=> setTimeout(r, durationSec*1000 + 20));
    const delta = (endMedia!==null && startMedia!==null) ? (endMedia - startMedia) : 0;
    const fps = delta>0 ? Math.round(frames/delta) : frames/durationSec;
    estimatedFPS = (Number.isFinite(fps) && fps>0) ? Math.min(240, Math.max(1, Math.round(fps))) : 30;
    if(!displayFPS && estimatedFPS) displayFPS = Math.round(estimatedFPS);
  }

  function onProgress(loadId){
    if(loadId !== activeLoadId) return;
    try{ if(video.buffered.length){ const end = video.buffered.end(video.buffered.length-1); const ratio = Math.min(1, (video.duration? end/video.duration : 0)); progress.value = ratio; } }catch(e){}
  }
  function onVideoError(loadId){
    if(loadId !== activeLoadId) return;
    alert('Playback error. The codec may not be supported by this browser.');
    status.classList.remove('show'); introBackdrop.classList.remove('show'); progress.hidden=true;
  }

  // === Playback ===
  function setPlayUI(isPlaying){
    const svgPlay = '<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M8 5l10 7l-10 7z\"/></svg>';
    const svgPause = '<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M7 5h4v14H7z\"/><path d=\"M13 5h4v14h-4z\"/></svg>';
    playLabel.textContent = isPlaying ? 'Pause' : 'Play';
    playIcon.innerHTML = isPlaying ? svgPause : svgPlay;
  }
  function updatePlayBtn(){ setPlayUI(!video.paused && !video.ended); }
  function togglePlay(){ if(!haveMetadata) return; if(video.paused){ allowPlay=true; try{ video.play(); }catch(e){} } else { allowPlay=true; video.pause(); } updatePlayBtn(); }
  playBtn.addEventListener('click', togglePlay);

  // === Smooth scrubbing (seek queue + Firefox rAF fallback) ===
  let scrubWasPlaying = false;
  let seeking = false;           // true while a seek is in-flight (non-FF path)
  let pendingSeek = null;        // last requested time, if any (non-FF path)
  let scrubRAF = null;           // firefox fallback loop handle
  let desiredTime = null;        // firefox target time during scrubbing

  
// helper: clamp time into [0, duration]
function clampTime(t){
  try{
    const d = isFinite(video.duration||NaN) ? video.duration : 0;
    return Math.max(0, Math.min(d, +t||0));
  }catch(_){ return Math.max(0, +t||0); }
}
// ===== SECTION: PLAYER SEEK/STEP =====

function seekTo(t){
try{
    const t2 = clampTime(t);
    if (!isFinite(t2)) return;
    video.currentTime = t2;
    updateUI(true);
  }catch(_){}
}
  function queueSeek(t){
    pendingSeek = t;
    if(!seeking){
      seeking = true;
      seekTo(t);
    }
  }
  function startScrubRAF(){
    if(scrubRAF) return;
    const tick = () => {
      if(!isScrubbing){ scrubRAF=null; return; }
      if(desiredTime!=null){ seekTo(desiredTime); if(videoTex) videoTex.needsUpdate = true; }
      scrubRAF = requestAnimationFrame(tick);
    };
    scrubRAF = requestAnimationFrame(tick);
  }

  function beginScrub(){ try{ state.isScrubbing = true; }catch(_){} 
    if(!haveMetadata) return;
    scrubWasPlaying = !video.paused;
    if(scrubWasPlaying){ allowPlay = false; video.pause(); }
    isScrubbing = true;
    if(isFirefox) startScrubRAF();
  }
  function endScrub(){ try{ state.isScrubbing = false; }catch(_){} 
    isScrubbing = false;
    if(isFirefox && scrubRAF){ cancelAnimationFrame(scrubRAF); scrubRAF=null; desiredTime=null; }
    if(scrubWasPlaying){ allowPlay = true; video.play().catch(()=>{}); }
    updateUI(true);
  }

  function bindRange(el){
    el.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); beginScrub(); }, {passive:false});
    el.addEventListener('mousedown', (e)=>{ e.stopPropagation(); }, {passive:true});
    el.addEventListener('touchstart', (e)=>{ e.stopPropagation(); beginScrub(); }, {passive:true});
    el.addEventListener('input', ()=>{
      if(!haveMetadata) return;
      const t = parseFloat(el.value)||0;
      // mirror to the other slider
      if(el===timeSlider){ fsTimeRange.value = String(t); } else { timeSlider.value = String(t); }
      if(isFirefox){ desiredTime = t; } else { queueSeek(t); }
    });
    el.addEventListener('pointermove', (e)=>{ if(isScrubbing) e.stopPropagation(); }, {passive:true});
    el.addEventListener('change', endScrub);
  }
  bindRange(timeSlider); bindRange(fsTimeRange);

  video.addEventListener('seeked', ()=>{
    if(videoTex) videoTex.needsUpdate = true;
    updateUI(true);
    if(pendingSeek !== null){
      const t = pendingSeek; pendingSeek = null;
      seekTo(t);
    } else {
      seeking = false;
    }
  });

  // === Frame stepping (auto FPS) ===
  function getFPS(){ return (displayFPS && isFinite(displayFPS) && displayFPS>0) ? displayFPS : (estimatedFPS || 30); }
  
async function stepFrames(n){
  try{
    if(!haveMetadata) return;
    const dir = (n|0) >= 0 ? 1 : -1;
    if (window.__stepLock) { window.__stepQueued = dir; return; }
    window.__stepLock = true;
    try{
      await __stepOnce(dir);
    } finally {
      window.__stepLock = false;
      if (window.__stepQueued) {
        const q = window.__stepQueued; window.__stepQueued = 0;
        setTimeout(()=>{ stepFrames(q); }, 0);
      }
    }
  }catch(_){}
}

async function __stepOnce(dir){
  try{
    if(!haveMetadata) return;
    const hasRVFC = !!(video && video.requestVideoFrameCallback);
    try{ allowPlay=false; video.pause(); }catch(_){}

    if(hasRVFC){
      const start = video.currentTime || 0;
      const fps = Math.max(1, getFPS() || 30);
      const dt = 1 / fps;
      const nudge = dir>0 ? +1e-4 : -1e-4;
      let target = clampTime(start + dir*dt);
      for(let i=0;i<6;i++){
        const pts = await new Promise((resolve)=>{
          let handle = 0; let to = 0;
          const cb = (now, meta)=>{
            if(to) clearTimeout(to);
            try{ if(handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); }catch(_){}
            const p = (meta && typeof meta.mediaTime==='number') ? meta.mediaTime : (video.currentTime||0);
            resolve(p);
          };
          try{ handle = video.requestVideoFrameCallback(cb); }catch(_){ resolve(video.currentTime||start); }
          try{ video.currentTime = clampTime(target + nudge); }catch(_){}
          to = setTimeout(()=>{ resolve(video.currentTime||start); }, 220);
        });
        if(Number.isFinite(pts) && ((dir>0 && pts > start+1e-6) || (dir<0 && pts < start-1e-6))){
          if(videoTex) videoTex.needsUpdate = true;
          updateUI(true); __renderOnce();
          return;
        }
        // not advanced yet — push target a bit further
        target = clampTime(target + dir * Math.max(dt*0.25, 0.002));
      }
      // fallback: grid step
      const snapped = Math.round(start*fps)/fps;
      const next = clampTime(snapped + dir*dt);
      video.currentTime = next;
      if(videoTex) videoTex.needsUpdate = true;
      updateUI(true); __renderOnce();
      return;
    }

    // Fallback for browsers without rVFC: previous grid-based approach
    const fps = getFPS();
    if(!fps || !isFinite(fps) || fps<=0) return;
    const dur = video.duration || 0;
    const t0 = video.currentTime || 0;
    const dt = 1 / fps;
    const snapped = Math.round(t0 * fps) / fps;
    let next = snapped + (dir*dt);
    if (next < 0) next = 0;
    if (dur) {
      const tail = dur - dt * 0.25;
      if (next > tail) next = Math.min(dur, tail);
    }
    if (typeof queueSeek === 'function') queueSeek(next);
    else video.currentTime = next;
    updateUI(true); __renderOnce();
  }catch(_){}
}

stepBackBtn.addEventListener('click', ()=> stepFrames(-1));
  stepFwdBtn.addEventListener('click', ()=> stepFrames(+1));

  // === Wheel zoom (FOV) + slider ===
const WHEEL_STEP = 3;
// Default FOV depends on mode (flat uses two wheel ticks closer)
function defaultFOV(){ try{ return (renderMode==='flat') ? (80 - 2*WHEEL_STEP) : 80; }catch(_){ return 80; } }

  const applyFOV=f=>{ f=Math.min(100,Math.max(20,f)); camera.fov=f; camera.updateProjectionMatrix(); zoomSlider.value = String(Math.round(ZSUM - f)); fitPlane(); }
  on(zoomSlider,'input',()=>applyFOV(ZSUM - parseFloat(zoomSlider.value)));
  on(viewer,'wheel',e=>{ e.preventDefault(); const step=3; applyFOV(camera.fov + (e.deltaY>0?step:-step)); }, {passive:false});
  on(resetViewBtn,'click',()=>{
    controls.reset();
    applyFOV(defaultFOV());
    panX=0; panY=0;
    if(uvMesh) uvMesh.rotation.set(0,-Math.PI/2,0);
    fitPlane();
    updateUI(true);
    __renderOnce();
  });

  // === Drag & Drop and file dialog ===

// Ensure overlays accept drops (prevents files=0 when overlay on top)
try{
  if (typeof introBackdrop!=='undefined' && introBackdrop) {
    on(introBackdrop,'dragover', e=>{ e.preventDefault(); e.stopPropagation(); if(e.dataTransfer) e.dataTransfer.dropEffect='copy'; }, {passive:false});
    on(introBackdrop,'drop', e=>{ e.preventDefault(); e.stopPropagation(); const fl=e.dataTransfer?.files; if(fl?.length) addFiles(fl); }, {passive:false});
  }
  if (typeof dropmask!=='undefined' && dropmask && !dropmask.__dndRebind){
    on(dropmask,'dragover', e=>{ e.preventDefault(); e.stopPropagation(); if(e.dataTransfer) e.dataTransfer.dropEffect='copy'; }, {passive:false});
    on(dropmask,'drop', e=>{ e.preventDefault(); e.stopPropagation(); const fl=e.dataTransfer?.files; if(fl?.length) addFiles(fl); }, {passive:false});
    dropmask.__dndRebind = true;
  }
}catch(_){}
  on(status,'dragover', e=>{ e.preventDefault(); });

  // Accept drops on overlays to avoid misses when they cover the viewer
  try{
    if (typeof status!=='undefined' && status) {
      on(status,'drop', e=>{ e.preventDefault(); e.stopPropagation(); const fl=e.dataTransfer?.files; if(fl?.length) addFiles(fl); });
    }
    if (typeof dropmask!=='undefined' && dropmask) {
    }
  }catch(_){}

  // Global drag highlight: keep dropmask working even after clearAll / overlays
  (function(){
    let dragDepth = 0;
    function showMask(){ try{ dropmask && dropmask.classList.add('show'); }catch(_){ } }
    function hideMask(){ try{ dropmask && dropmask.classList.remove('show'); }catch(_){ } }
    ['dragenter','dragover','dragleave','drop'].forEach(type=>{
      document.addEventListener(type, e=>{
        try{
          const dt = e.dataTransfer;
          // React only when real files are being dragged
          if(dt && dt.types && !Array.from(dt.types).includes('Files')) return;
          if(type==='dragenter'){
            e.preventDefault();
            dragDepth++;
            showMask();
          }else if(type==='dragover'){
            e.preventDefault();
            if(dt) dt.dropEffect = 'copy';
          }else if(type==='dragleave'){
            e.preventDefault();
            dragDepth = Math.max(0, dragDepth-1);
            if(dragDepth===0) hideMask();
          }else{ // drop
            e.preventDefault();
            dragDepth = 0;
            hideMask();
          }
        }catch(_){}
      }, {capture:true, passive:false});
    });
  })();

  // Accept drops on the viewer background (when overlays don't already handle it)
  on(viewer,'drop', e=>{
    e.preventDefault();
    const fl = e.dataTransfer?.files;
    if (fl?.length) addFiles(fl);
  });

on(fileInput,'change',()=>{ if(fileInput.files?.length) addFiles(fileInput.files); 
  try{ fileInput.value=''; }catch(_){ }});

  // === Keyboard ===
  window.addEventListener('keydown', (e)=>{
    const k = e.code;
    if(k==='Space'){ e.preventDefault(); playBtn.click(); }
    else if(k==='ArrowRight' || k==='KeyD'){ e.preventDefault(); stepFrames(+1); }
    else if(k==='ArrowLeft' || k==='KeyA'){ e.preventDefault(); stepFrames(-1); }
    else if(k==='ArrowUp' || k==='KeyW'){ e.preventDefault(); nav(-1); }
    else if(k==='ArrowDown' || k==='KeyS'){ e.preventDefault(); nav(1); }
    else if(k==='KeyR'){ e.preventDefault(); resetViewBtn.click(); }
    else if(k==='KeyE'){ e.preventDefault(); try{ togglePlistPanel(); }catch(_){ } }
    else if(k==='KeyI'){ e.preventDefault(); try{ infoBtn.click(); }catch(_){ } }
    else if(k==='KeyO'){ e.preventDefault(); try{ fileInput.click(); }catch(_){ } }

    else if(k==='KeyE'){ e.preventDefault(); try{ togglePlistPanel(); }catch(_){ } }
    else if(k==='KeyI'){ e.preventDefault(); try{ infoBtn.click(); }catch(_){ } }
    else if(k==='KeyQ'){ e.preventDefault(); try{ clearAll(); }catch(_){ } }
    else if(k==='Escape'){ e.preventDefault(); try{ closePlistPanel(); }catch(_){ } try{ closeInfoPanel(); }catch(_){ } }
  });

  // Left-click toggles play/pause (click, not drag)
  let clickSingleTimer = null;
  let tapX=0,tapY=0,tapT=0,tapMoved=false;

  function inLeftUiCluster(e){
    try{
      const v = viewer;
      if(!v) return false;
      if (v.classList && v.classList.contains('ui-autoHide')) return false;

      const hudEl  = document.getElementById('hud')       || window.hud;
      const dockEl = document.getElementById('plistDock') || window.plistDock;
      const rects = [];
      if (hudEl)  rects.push(hudEl.getBoundingClientRect());
      if (dockEl) rects.push(dockEl.getBoundingClientRect());
      if (!rects.length) return false;

      let left=rects[0].left, top=rects[0].top,
          right=rects[0].right, bottom=rects[0].bottom;
      for (let i=1;i<rects.length;i++){
        const r = rects[i]; if(!r) continue;
        if (r.left   < left)   left   = r.left;
        if (r.top    < top)    top    = r.top;
        if (r.right  > right)  right  = r.right;
        if (r.bottom > bottom) bottom = r.bottom;
      }

      const x = e.clientX, y = e.clientY;
      return x >= left && x <= right && y >= top && y <= bottom;
    }catch(_){
      return false;
    }
  }

  on(viewer,'pointerdown', e=>{
    if (inLeftUiCluster(e)) return;
    if (e.target && e.target.closest &&
        (e.target.closest('#toolbar') ||
         e.target.closest('#fsBar') ||
         e.target.closest('#plistDock') ||
         e.target.closest('#infoBtn') ||
         e.target.closest('#plistBtn'))) return;
    if(e.button!==0) return;
    tapX=e.clientX; tapY=e.clientY; tapT=performance.now(); tapMoved=false;
  });

  on(viewer,'pointermove', e=>{
    if((e.buttons&1)===1 && (Math.abs(e.clientX-tapX)>5 || Math.abs(e.clientY-tapY)>5))
      tapMoved=true;
  });

  on(viewer,'pointerup', e=>{
    if (inLeftUiCluster(e)) return;
    if (e.target && e.target.closest &&
        (e.target.closest('#toolbar') ||
         e.target.closest('#fsBar') ||
         e.target.closest('#plistDock') ||
         e.target.closest('#infoBtn') ||
         e.target.closest('#plistBtn'))) return;
    if (status && status.classList && status.classList.contains('show')) return;
    if(e.button!==0) return;
    const dt=performance.now()-tapT;
    if(!tapMoved && dt<250){
      if(clickSingleTimer) clearTimeout(clickSingleTimer);
      clickSingleTimer = setTimeout(()=>{ try{ togglePlay(); }catch(_){ } }, 200);
    }
  });

  // === Fullscreen (cross‑browser) ===
  function isFullscreen(){ return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || document.mozFullScreenElement; }
  async function enterFullscreen(){ const el = viewer; const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen || el.mozRequestFullScreen; if(req) { try{ await req.call(el); }catch(e){} } }
  async function exitFullscreen(){ const ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen || document.mozCancelFullScreen; if(ex){ try{ await ex.call(document); }catch(e){} } }
  async function toggleFullscreen(){ if(!isFullscreen()){ await enterFullscreen(); } else { await exitFullscreen(); } }
  on(fsBtn,'click',toggleFullscreen); on(viewer,'dblclick', (e)=>{
    if (e.target && e.target.closest && (e.target.closest('#toolbar') || e.target.closest('#fsBar') || e.target.closest('#plistDock') || e.target.closest('#infoBtn') || e.target.closest('#plistBtn'))) { return; } if(clickSingleTimer){ clearTimeout(clickSingleTimer); clickSingleTimer=null; } toggleFullscreen(); });
  on(document,'fullscreenchange webkitfullscreenchange msfullscreenchange mozfullscreenchange', ()=>{
  fsBar.classList.add('show');
  const fs = !!isFullscreen();
  try{ relocatePanelsForFS(fs); }catch(_){}
  try{
    if (window.__panelState){
      if (window.__panelState.plist && !plistPanel.classList.contains('show')) openPlistPanel();
      if (window.__panelState.info  && !infoPanel.classList.contains('show')) infoPanel.classList.add('show');
      positionInfoPanel();
    }
  }catch(_){}
  onResize();
});

function openInfoPanel(){ try{ infoPanel.classList.add('show'); positionInfoPanel(); }catch(_){}}
function closeInfoPanel(){ try{ infoPanel.classList.remove('show'); }catch(_){}}
// === Info panel toggle ===
  on(infoBtn,'click',()=>{ try{ if (typeof isFullscreen==='function' && isFullscreen()) __relocateInfoForFS(true); }catch(_){ } positionInfoPanel(); infoPanel.classList.toggle('show'); try{ window.__panelState = window.__panelState || {}; window.__panelState.info = infoPanel.classList.contains('show'); }catch(_){ } });

  // === Resize ===
  function onResize(){ const fs=!!isFullscreen(); const w=fs?window.innerWidth:viewer.clientWidth; const h=fs?window.innerHeight:viewer.clientHeight; renderer.setSize(w,h,true); camera.aspect=w/h; camera.updateProjectionMatrix(); fitPlane(); }
  on(window,'resize',()=>{ onResize(); positionInfoPanel(); if(plistPanel.classList.contains('show')) { const r = plistBtn.getBoundingClientRect(); plistPanel.style.top = Math.round(r.top) + 'px'; } });
  onResize();
  infoPanel.style.top = overlayTopPx() + 'px';

  // === Init ===
  updateUI(true);

  // === FPS from metadata (mp4/webm) ===
  function setDisplayFPSOnce(val){
    if(displayFPS) return;
    if(typeof val==='number' && isFinite(val) && val>0 && val<1000){
      sourceFPS = val;
      displayFPS = val;
      updateHUD();
    }
  
  try{ Bus.emit && Bus.emit('fps:set', val); }catch(_){}
}
  function loadScriptOnce(src){
    return new Promise((resolve,reject)=>{ const s=document.createElement('script'); s.src=src; s.async=true; s.onload=()=>resolve(); s.onerror=()=>reject(new Error('load '+src)); document.head.appendChild(s); });
  }
  async function ensureMP4Box(){ if(window.MP4Box) return; await loadScriptOnce('https://unpkg.com/mp4box@0.5.4/dist/mp4box.all.min.js'); }
  async function extractMP4FPS(file){ try{ await ensureMP4Box(); const buf = await file.arrayBuffer(); const mp4 = window.MP4Box.createFile(); return await new Promise((resolve)=>{ mp4.onReady = (info)=>{ let v = (info.videoTracks && info.videoTracks[0]) || (info.tracks||[]).find(t=>t.type==='video'); if(v && v.nb_samples && v.duration && v.timescale){ const fps = (v.nb_samples * v.timescale) / v.duration; resolve(fps); } else resolve(null); }; mp4.onError = ()=>resolve(null); buf.fileStart = 0; mp4.appendBuffer(buf); mp4.flush(); }); }catch(e){ return null; } }
  function readVint(u, pos){ const b=u[pos]; if(b===undefined) return {length:0,value:0}; let mask=0x80, len=1; while(len<=8 && (b & mask)===0){ mask>>=1; len++; } if(len>8) return {length:1,value:0}; let value = BigInt(b & (~mask)); for(let k=1;k<len;k++){ value = (value<<8n) | BigInt(u[pos+k]||0); } return {length:len, value:Number(value)}; }

  async function extractWEBMFPS(file){ try{ const buf = await file.slice(0, 1024*1024).arrayBuffer(); const u=new Uint8Array(buf); for(let i=0;i<u.length-3;i++){ // DefaultDuration ID 0x23E383
      if(u[i]===0x23 && u[i+1]===0xE3 && u[i+2]===0x83){ let idx=i+3; const r=readVint(u, idx); const sizeLen=r.length, dataLen=r.value; if(!sizeLen||!dataLen) continue; idx+=sizeLen; if(idx+dataLen<=u.length){ let ns=0; for(let j=0;j<dataLen;j++){ ns = (ns<<8) | u[idx+j]; } if(ns>0){ const fps = 1e9 / ns; return fps; } } } } return null; }catch(e){ return null; } }

  async function initFPSFromMetadata(file){ try{ if(!file) return; const type=(file.type||'').toLowerCase(); let fps=null; if(type.includes('mp4')){ fps = await extractMP4FPS(file); } else if(type.includes('webm')){ fps = await extractWEBMFPS(file); } setDisplayFPSOnce(fps); } catch(e){} }
  // Flat-mode panning with mouse (LMB drag)
  let panActive=false, panLX=0, panLY=0;
  on(viewer,'pointerdown', e=>{ if(renderMode!=='flat' || e.button!==0) return; panActive=true; panLX=e.clientX; panLY=e.clientY; viewer.setPointerCapture?.(e.pointerId); e.preventDefault(); });
  on(viewer,'pointermove', e=>{ if(!panActive || renderMode!=='flat') return; const w=renderer.domElement.clientWidth||1, h=renderer.domElement.clientHeight||1; const d=1; const vh=2*d*Math.tan(camera.fov*Math.PI/360); const vw=vh*camera.aspect; const dx=(e.clientX-panLX)/w*vw; const dy=(e.clientY-panLY)/h*vh; panX+=dx; panY-=dy; panLX=e.clientX; panLY=e.clientY; plane.position.set(panX,panY,-d); });
  on(viewer,'pointerup pointercancel', e=>{ if(e.button===0) panActive=false; });

// ===== SECTION: MEDIA ADAPTERS (scaffold only; not used at runtime) =====

/**
 * @typedef {Object} MediaAdapter
 * @property {() => Promise<void>} load
 * @property {() => void} play
 * @property {() => void} pause
 * @property {() => void} dispose
 * @property {() => number} duration
 * @property {(t:number) => void} seek
 */

/** Image adapter scaffold */
function createImageAdapter(file){
  /** @type {MediaAdapter} */
  const api = {
    async load(){ /* TODO: decode image; noop scaffold */ },
    play(){ /* no-op for image */ },
    pause(){ /* no-op for image */ },
    dispose(){ /* no-op */ },
    duration(){ return 0 },
    seek(t){ /* no-op for image */ }
  };
  return api;
}

/** Sequence adapter scaffold (folder or numbered frames) */
function createSequenceAdapter(files){
  /** @type {MediaAdapter} */
  const api = {
    async load(){ /* TODO: preload/stream frames; noop scaffold */ },
    play(){ /* TODO */ },
    pause(){ /* TODO */ },
    dispose(){ /* TODO */ },
    duration(){ return 0 },
    seek(t){ /* TODO */ }
  };
  return api;
}

/** Audio adapter scaffold */
function createAudioAdapter(file){
  /** @type {MediaAdapter} */
  const api = {
    async load(){ /* TODO: setup <audio> or WebAudio; noop scaffold */ },
    play(){ /* TODO */ },
    pause(){ /* TODO */ },
    dispose(){ /* TODO */ },
    duration(){ return 0 },
    seek(t){ /* TODO */ }
  };
  return api;
}

// ===== SECTION: RENDER MODES (interface + placeholders; not used at runtime) =====

/**
 * @typedef {Object} RenderMode
 * @property {() => void} enter
 * @property {() => void} exit
 * @property {(fov:number) => void} applyZoom
 * @property {() => void} render
 * @property {(w:number,h:number) => void} resize
 */

/** Flat render mode placeholder */
function FlatMode(){
  /** @type {RenderMode} */
  const api = {
    enter(){ /* TODO: attach flat pipeline */ },
    exit(){ /* TODO: detach */ },
    applyZoom(fov){ /* TODO: adjust camera for flat */ },
    render(){ /* TODO: draw frame */ },
    resize(w,h){ /* TODO: handle size */ }
  };
  return api;
}

/** VR render mode placeholder */
function VRMode(){
  /** @type {RenderMode} */
  const api = {
    enter(){ /* TODO: setup VR pipeline */ },
    exit(){ /* TODO */ },
    applyZoom(fov){ /* TODO: adjust camera for VR */ },
    render(){ /* TODO */ },
    resize(w,h){ /* TODO */ }
  };
  return api;
}

// ===== SECTION: OPTIMIZED RESIZE (rAF-throttled) =====
(function(){
  let scheduled = false;
  function dispatchOptimizedResize(){
    scheduled = false;
    try{ document.dispatchEvent(new Event('optimizedResize')); }catch(_){}
  }
  try{
    window.addEventListener('resize', function(){
      if (scheduled) return;
      scheduled = true;
      try{ requestAnimationFrame(dispatchOptimizedResize); }catch(_){ scheduled = false; }
    }, {passive: true});
  }catch(_){ /* older browsers fallback */ 
    window.addEventListener('resize', function(){
      if (scheduled) return;
      scheduled = true;
      setTimeout(dispatchOptimizedResize, 16);
    });
  }
  // Safe unified handler: adapt layout on resize without touching existing listeners
  document.addEventListener('optimizedResize', function(){
    try{ if (typeof fitPlane==='function') fitPlane(); }catch(_){}
    try{ if (typeof updateUI==='function') updateUI(true); }catch(_){}
  });
})();
// ===== /OPTIMIZED RESIZE =====

// === Central click-to-open (safe, idempotent) ===
(function(){
  try{
    if (typeof status!=='undefined' && status) {
      if (!status.__hasClickToOpen) {
        status.addEventListener('click', function(e){
          if (!status.classList.contains('show')) return;
          e.preventDefault(); e.stopPropagation();
          try{ fileInput.value=''; }catch(_){ }
          if (fileInput && typeof fileInput.click==='function') fileInput.click();
        });
        status.addEventListener('keydown', function(e){
          if (!status.classList.contains('show')) return;
          if (e.key==='Enter' || e.key===' ') {
            e.preventDefault();
            try{ fileInput.value=''; }catch(_){ }
          if (fileInput && typeof fileInput.click==='function') fileInput.click();
          }
        });
        status.__hasClickToOpen = true;
      }
    }
  }catch(_){}
})();



// Keep playlist panel visible in Fullscreen by relocating it inside #viewer while FS is active.
(function(){
  try{
    // Original placement to restore on exit
    if (!window.__plistOrigParent) window.__plistOrigParent = null;
    if (!window.__plistOrigNext) window.__plistOrigNext = null;

    window.__relocatePlistForFS = function(fs){
      try{
        if (typeof viewer === 'undefined' || typeof plistPanel === 'undefined') return;
        if (!viewer || !plistPanel) return;
        if (fs){
          // Save original position once
          if (!window.__plistOrigParent){
            window.__plistOrigParent = plistPanel.parentNode;
            window.__plistOrigNext = plistPanel.nextSibling;
          }
          // Move into fullscreen subtree if needed
          if (plistPanel.parentNode !== viewer){
            viewer.appendChild(plistPanel);
          }
        }else{
          // Restore to original parent/place if we saved it
          if (window.__plistOrigParent){
            try{
              if (window.__plistOrigNext && window.__plistOrigNext.parentNode === window.__plistOrigParent){
                window.__plistOrigParent.insertBefore(plistPanel, window.__plistOrigNext);
              }else{
                window.__plistOrigParent.appendChild(plistPanel);
              }
            }catch(_){
              // Fallback: append
              try{ window.__plistOrigParent.appendChild(plistPanel); }catch(__){}
            }
          }
        }
      }catch(_){}
    };
  }catch(_){}
})();

// --- Conditional shielding for left dock ---
(function(){
  try{
    function inButtons(t){
      if(!t) return false;
      return !!(t.closest && (t.closest('#plistBtn') || t.closest('#infoBtn')));
    }
    function shieldDock(el){
      if(!el || el.__dockGuard) return;
      // Only block when clicking *not* on buttons
      const guard = function(e){
        if(inButtons(e.target)) return;
        if(e.type==='dblclick' || (e.type==='pointerdown' && e.button===0)){
          e.preventDefault();
        }
        e.stopPropagation();
      };
      ['pointerdown','pointerup','click','dblclick'].forEach(type=>{
        el.addEventListener(type, guard, true);
      });
      el.__dockGuard = true;
    }
    function shieldBtn(btn){
      if(!btn || btn.__btnGuard) return;
      btn.addEventListener('pointerdown', function(e){ if(e.button===0){ e.stopPropagation(); } }, true);
      btn.addEventListener('pointerup',   function(e){ e.stopPropagation(); }, true);
      btn.addEventListener('dblclick',    function(e){ e.preventDefault(); e.stopPropagation(); }, true);
      // do NOT block 'click' here
      btn.__btnGuard = true;
    }
    shieldDock(typeof plistDock!=='undefined'?plistDock:null);
    shieldBtn(typeof plistBtn!=='undefined'?plistBtn:null);
    shieldBtn(typeof infoBtn!=='undefined'?infoBtn:null);
  }catch(_){}
})();

// --- Info panel positioning: align to the right of the info button; stack below playlist when both open ---
function positionInfoPanel(){
  try{
    if (!infoBtn || !infoPanel) return;
    const rDock = plistDock.getBoundingClientRect();
    infoPanel.style.right = 'auto';
    infoPanel.style.left  = Math.round(rDock.right) + 8 + 'px';
    // Base top on overlayTopPx (already tied to infoBtn top)
    infoPanel.style.top   = overlayTopPx() + 'px';
    // If playlist panel is open, place info panel *below* it
    if (plistPanel && plistPanel.classList && plistPanel.classList.contains('show')){
      const rPl = plistPanel.getBoundingClientRect();
      const topNow = parseInt(infoPanel.style.top, 10) || overlayTopPx();
      const desiredTop = Math.max(topNow, Math.round(rPl.bottom) + 8);
      infoPanel.style.top = desiredTop + 'px';
    }
  }catch(e){}
}

// Keep info panel visible in Fullscreen by relocating it inside #viewer while FS is active.
(function(){
  try{
    if (!window.__infoOrigParent) window.__infoOrigParent = null;
    if (!window.__infoOrigNext) window.__infoOrigNext = null;
    window.__relocateInfoForFS = function(fs){
      try{
        if (typeof viewer==='undefined') return;
        // If panel hasn't been created yet, nothing to do now
        if (typeof infoPanel==='undefined' || !infoPanel) return;
        if (fs){
          if (!window.__infoOrigParent){
            window.__infoOrigParent = infoPanel.parentNode;
            window.__infoOrigNext = infoPanel.nextSibling;
          }
          if (infoPanel.parentNode !== viewer){
            viewer.appendChild(infoPanel);
          }
        }else{
          if (window.__infoOrigParent){
            try{
              if (window.__infoOrigNext && window.__infoOrigNext.parentNode === window.__infoOrigParent){
                window.__infoOrigParent.insertBefore(infoPanel, window.__infoOrigNext);
              }else{
                window.__infoOrigParent.appendChild(infoPanel);
              }
            }catch(_){
              try{ window.__infoOrigParent.appendChild(infoPanel); }catch(__){}
            }
          }
        }
      }catch(_){}
    };
  }catch(_){}
})();

// --- Unified fullscreen relocation for both panels ---
function relocatePanelsForFS(fs){
  try{ if (typeof __relocatePlistForFS === 'function') __relocatePlistForFS(!!fs); }catch(_){}
  try{ if (typeof __relocateInfoForFS === 'function') __relocateInfoForFS(!!fs); }catch(_){}
}


// === Additional open fallbacks when 'status' (empty state) is visible ===
(function(){
  try{
    // Dropmask click opens file dialog (only in empty state)
    if (typeof dropmask!=='undefined' && dropmask && !dropmask.__hasClickToOpen) {
      dropmask.addEventListener('click', function(e){
        if (!status || !status.classList || !status.classList.contains('show')) return;
        e.preventDefault(); e.stopPropagation();
        try{ fileInput.value=''; }catch(_){ }
        if (fileInput && typeof fileInput.click==='function') fileInput.click();
      });
      dropmask.__hasClickToOpen = true;
    }
    // Viewer click fallback (only when empty state is shown)
    if (typeof viewer!=='undefined' && viewer && !viewer.__openOnStatus) {
      viewer.addEventListener('click', function(e){
        if (!status || !status.classList || !status.classList.contains('show')) return;
        // ignore clicks on toolbar/fsBar and left-dock controls (info/playlist)
        if (e.target && e.target.closest && (e.target.closest('#toolbar') || e.target.closest('#fsBar') || e.target.closest('#plistDock') || e.target.closest('#infoBtn') || e.target.closest('#plistBtn'))) return;
        e.preventDefault(); e.stopPropagation();
        try{ fileInput.value=''; }catch(_){ }
        if (fileInput && typeof fileInput.click==='function') fileInput.click();
      });
      viewer.__openOnStatus = true;
    }
  }catch(_){}
})();

/* ===== AUTO-HIDE MENUS (minimal intrusive) ===== */
(function(){
  try{
    const viewer    = document.getElementById('viewer');
    const hzBottom  = document.getElementById('hzBottom');
    const hzCorner  = document.getElementById('hzCorner');
    const infoPanel = document.getElementById('infoPanel');
    const plistPanel= document.getElementById('plistPanel');
    if (!viewer || !hzBottom || !hzCorner || (typeof video === 'undefined')) return;

    // Добавлен флаг hold: когда открыт плейлист/инфо — авто‑скрытие отключается.
    const UIHide = { delay: 2000, timer: null, hidden: false, hold: false };
    // --- Temporary cursor reveal on any movement while UI is hidden ---
    let __cursorRevealTO = null;
    function revealCursorTemp(){
      try{
        viewer.classList.add('cursorReveal');
        if(__cursorRevealTO) clearTimeout(__cursorRevealTO);
        __cursorRevealTO = setTimeout(()=>{
          viewer.classList.remove('cursorReveal');
        }, 800);
      }catch(_){}
    }


    function panelsOpen(){
      try{
        return !!((infoPanel && infoPanel.classList.contains('show')) ||
          (plistPanel && plistPanel.classList.contains('show')) ||
          document.getElementById('frameJumpInput'));

      }catch(_){ return false; }
    }
    function setHold(on){
      UIHide.hold = !!on;
      if(UIHide.hold){
        showMenus();            // всегда показать меню
      }else{
        if(isPlaying()) scheduleHide();
      }
    }

    function isPlaying(){ try{ return !video.paused; }catch(_){ return false; } }
    function clearHideTimer(){ if(UIHide.timer){ clearTimeout(UIHide.timer); UIHide.timer=null; } }
    function activateHotZones(active){
      try{
        if(active){
          hzBottom.classList.add('active');
          hzCorner.classList.add('active');
        }else{
          hzBottom.classList.remove('active');
          hzCorner.classList.remove('active');
        }
      }catch(_){}
    }
    function hideMenus(){
      if(UIHide.hold) return;       // НЕ скрываем, если открыт один из панелей
      if(UIHide.hidden) return;
      viewer.classList.add('ui-autoHide');
      UIHide.hidden = true;
      activateHotZones(true);
    }
    function showMenus(){
      if(!UIHide.hidden && !viewer.classList.contains('ui-autoHide')){
        // уже видно
      }else{
        viewer.classList.remove('ui-autoHide');
        UIHide.hidden = false;
      }
      activateHotZones(false);
      clearHideTimer();
    }
    function scheduleHide(){
      clearHideTimer();
      if(UIHide.hold) return;       // с открытыми панелями таймер не запускаем
      if(!isPlaying()) return;
      UIHide.timer = setTimeout(()=>{ if(isPlaying() && !UIHide.hold) hideMenus(); }, UIHide.delay);
    }
    function bumpAutoHide(){
      if(UIHide.hold){ showMenus(); return; }  // панели открыты — только показываем
      if(!isPlaying()) return;
      showMenus();
      scheduleHide();
    }

    // Наведение на горячие зоны — показать/продлить, но учитывать hold
    ['mouseenter','pointerenter'].forEach(ev=>{
      hzBottom.addEventListener(ev, ()=>{ if(isPlaying()) bumpAutoHide(); }, {passive:true});
      hzCorner.addEventListener(ev, ()=>{ if(isPlaying()) bumpAutoHide(); }, {passive:true});
    });
    // Клики в горячих зонах, когда UI скрыт — не должны кликать по видео
    ['pointerdown','click','dblclick'].forEach(ev=>{
      hzBottom.addEventListener(ev, e=>{ if(isPlaying() && !UIHide.hold && UIHide.hidden){ e.preventDefault(); e.stopPropagation(); } }, true);
      hzCorner.addEventListener(ev, e=>{ if(isPlaying() && !UIHide.hold && UIHide.hidden){ e.preventDefault(); e.stopPropagation(); } }, true);
    });
    // Продление таймера при действиях по видимому UI (если нет hold)
    ['mousemove','pointermove','pointerdown','wheel'].forEach(ev=>{
      viewer.addEventListener(ev, ()=>{  if(UIHide.hidden) { revealCursorTemp(); }  if(isPlaying() && !UIHide.hold && !UIHide.hidden) scheduleHide();}, {passive:true});
    });
    // При уходе курсора — скрываем только если нет hold
    viewer.addEventListener('mouseleave', ()=>{ if(isPlaying() && !UIHide.hold) hideMenus(); }, {passive:true});
    // Пауза/Плей
    video.addEventListener('pause', ()=>{ showMenus(); });  // пауза всегда показывает
    video.addEventListener('play',  ()=>{
      if(panelsOpen()){ setHold(true); } else { showMenus(); scheduleHide(); }
    });

    // Следим за открытием/закрытием панелей через MutationObserver
    const refreshHold = ()=> setHold(panelsOpen());
    if(infoPanel){ new MutationObserver(refreshHold).observe(infoPanel,  {attributes:true, attributeFilter:['class']}); }
    if(plistPanel){ new MutationObserver(refreshHold).observe(plistPanel,{attributes:true, attributeFilter:['class']}); }
    // Начальная синхронизация
    refreshHold();
  }catch(_){}

    try{
      window.__uiShowMenus = showMenus;
      window.__uiScheduleHide = scheduleHide;
      window.__uiBumpAutoHide = bumpAutoHide;
      window.__uiRefreshHold = refreshHold;
    }catch(_){}
})();

// === Frame Jump (edit current frame) ===
(function(){
  try{
    if (!hudFrame) return;
    hudFrame.style.cursor = 'text';
    hudFrame.title = 'Click to enter frame number';

    function currentFrame(){
      try{
        const fps = getFPS();
        if(!fps) return null;
        return Math.max(0, Math.round((video.currentTime||0)*fps));
      }catch(_){ return null; }
    }
    function totalFrames(){
      try{
        const fps = getFPS();
        const dur = video.duration || 0;
        if(!fps || !isFinite(dur) || dur<=0) return null;
        return Math.round(dur * fps);
      }catch(_){ return null; }
    }
    function restoreHUD(){
      try{
        const input = document.getElementById('frameJumpInput');
        if(input && input.parentNode) input.parentNode.removeChild(input);
        const wrap = document.getElementById('frameTotalWrap');
        if(wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
        updateHUD(true);
        try{ if(window.__uiRefreshHold) window.__uiRefreshHold(); }catch(_){ }
      }catch(_){}
    }
    function commitFrameEdit(input){
      try{
        const val = (input && input.value!=null) ? String(input.value).trim() : '';
        const num = parseInt(val, 10);
        const fps = getFPS();
        const total = totalFrames();
        if(!fps || !isFinite(fps) || fps<=0){
          try{ showInfo('FPS unknown — cannot jump to frame'); setTimeout(()=>{ try{ clearStatus(); }catch(_){ } }, 1200); }catch(_){}
          restoreHUD();
          try{ if(window.__uiShowMenus) window.__uiShowMenus(); if(window.__uiScheduleHide) window.__uiScheduleHide(); }catch(_){}
          return;
        }
        if(!isFinite(num)){
          restoreHUD();
          try{ if(window.__uiShowMenus) window.__uiShowMenus(); if(window.__uiScheduleHide) window.__uiScheduleHide(); }catch(_){}
          return;
        }
        let target = num;
        if(isFinite(total) && total!=null){
          if(target < 0) target = 0;
          if(target > total) target = total;
        }else{
          if(target < 0) target = 0;
        }
        const t = target / fps;
        try{ seekTo(t); }catch(_){ try{ video.currentTime = t; }catch(__){} }
      }catch(_){}
      restoreHUD();
      try{ if(window.__uiShowMenus) window.__uiShowMenus(); if(window.__uiScheduleHide) window.__uiScheduleHide(); }catch(_){}
    }
    function beginFrameEdit(){
      try{ try{ allowPlay=false; video.pause(); }catch(_){ } try{ if(typeof updatePlayBtn==='function') updatePlayBtn(); }catch(_){ }
        const fps = getFPS();
        if(!fps){
          try{ showInfo('FPS unknown — cannot jump to frame'); setTimeout(()=>{ try{ clearStatus(); }catch(_){ } }, 1200); }catch(_){}
          return;
        }
        const cur = currentFrame();
        const total = totalFrames();
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'frameJumpInput';
        input.step = '1';
        input.min = '0';
        if (isFinite(total)) input.max = String(total);
        input.value = (cur!=null) ? String(cur) : '';
        hudFrame.innerHTML = 'Frame: ';
        hudFrame.appendChild(input);
        const totalSpan = document.createElement('span');
        totalSpan.id = 'frameTotalWrap';
        totalSpan.textContent = (isFinite(total) && total!=null) ? (' / ' + String(total)) : '';
        hudFrame.appendChild(totalSpan);
        try{ if(window.__uiRefreshHold) window.__uiRefreshHold(); }catch(_){ }
        input.addEventListener('keydown', (e)=>{
          if(e.key==='Enter'){ e.preventDefault(); commitFrameEdit(input); }
          else if(e.key==='Escape'){ e.preventDefault(); restoreHUD(); try{ if(window.__uiShowMenus) window.__uiShowMenus(); if(window.__uiScheduleHide) window.__uiScheduleHide(); }catch(_){ } }
        });
        input.addEventListener('blur', ()=> commitFrameEdit(input));
        setTimeout(()=>{ try{ input.focus(); input.select(); }catch(_){} }, 0);
      }catch(_){}
    }
    hudFrame.addEventListener('click', (e)=>{
      if(e.target && e.target.id==='frameJumpInput') return;
      beginFrameEdit();
      e.stopPropagation();
    });
  }catch(_){}
})();

// --- Shield HUD from toggling play/pause on clicks (like playlist/info) ---
(function(){
  try{
    const hud = document.getElementById('hud');
    if(!hud) return;
    if(hud.__hudGuardBubble) return;
    const guardBubble = function(e){
      e.stopPropagation();
    };
    ['pointerdown','pointerup','click','dblclick'].forEach(type=>{
      hud.addEventListener(type, guardBubble, false);
    });
    hud.__hudGuardBubble = true;
  }catch(_){}
})();
