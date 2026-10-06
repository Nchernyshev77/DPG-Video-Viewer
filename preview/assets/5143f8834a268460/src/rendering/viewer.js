import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CONFIG } from "../config.js";
import { clamp, projectionFor } from "../core/format.js";
import { createLifecycle } from "../core/lifecycle.js";

export function createViewer(
  container,
  { onError = () => {}, onRestore = () => {} } = {},
) {
  const life = createLifecycle();
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio),
  );
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.setAttribute("aria-label", "Video viewport");
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.vrFov, 1, 0.1, 1100);
  camera.position.set(0, 0, 0.01);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = controls.enableZoom = false;
  controls.rotateSpeed = -0.35;
  controls.enabled = false;

  const flatMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial);
  plane.visible = false;
  scene.add(plane);
  let sphere = null;
  let texture = null;
  let video = null;
  let mode = "flat";
  let panX = 0;
  let panY = 0;
  let renderHandle = null;
  let resizeHandle = null;
  let frameDirty = false;
  let disposed = false;
  let contextLost = false;
  let drawCount = 0;
  let playing = false;
  let interacting = false;
  const frameWaiters = [];

  function fitPlane() {
    const height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const width = height * camera.aspect;
    const ratio = (video?.videoWidth || 16) / (video?.videoHeight || 9);
    const planeWidth = ratio >= camera.aspect ? width : height * ratio;
    const planeHeight = ratio >= camera.aspect ? width / ratio : height;
    const zoom = 75 / camera.fov; // Preserve the original flat-mode zoom behavior.
    plane.scale.set(planeWidth * zoom, planeHeight * zoom, 1);
    plane.position.set(panX, panY, -1);
  }

  function render() {
    renderHandle = null;
    if (disposed || contextLost || document.hidden) return;
    // Match the legacy playback clock: paint on every display refresh while
    // playing, even if rVFC is delayed or unavailable. Paused work is on demand.
    if (playing) requestRender(true);
    // A seek can temporarily invalidate the video image. Keep the last GPU frame.
    if (video && (video.seeking || video.readyState < 2)) return;
    // Preserve the legacy camera freeze during playback. Updating controls with
    // damping disabled can consume a residual drag and shift a stationary view.
    if (controls.enabled && (controls.enableDamping || interacting))
      controls.update();
    if (frameDirty && texture && video?.readyState >= 2)
      texture.needsUpdate = true;
    frameDirty = false;
    renderer.render(scene, camera);
    drawCount++;
    for (const resolve of frameWaiters.splice(0)) resolve(true);
  }

  function requestRender(newFrame = false) {
    frameDirty ||= newFrame;
    if (disposed || contextLost || document.hidden || renderHandle !== null)
      return;
    renderHandle = requestAnimationFrame(render);
  }

  function resize() {
    resizeHandle = null;
    if (disposed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio),
    );
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    fitPlane();
    requestRender();
  }

  function scheduleResize() {
    if (resizeHandle === null) resizeHandle = requestAnimationFrame(resize);
  }

  function clear() {
    for (const resolve of frameWaiters.splice(0)) resolve(false);
    frameDirty = false;
    flatMaterial.map = null;
    flatMaterial.needsUpdate = true;
    if (sphere) {
      sphere.material.map = null;
      sphere.material.needsUpdate = true;
      sphere.visible = false;
    }
    plane.visible = false;
    texture?.dispose();
    texture = video = null;
    playing = false;
    interacting = false;
    controls.enabled = false;
    requestRender();
  }

  function setFov(value) {
    camera.fov = clamp(value, CONFIG.minFov, CONFIG.maxFov);
    camera.updateProjectionMatrix();
    fitPlane();
    requestRender();
  }

  function reset() {
    controls.reset();
    panX = panY = 0;
    if (sphere) sphere.rotation.set(0, -Math.PI / 2, 0);
    setFov(mode === "vr" ? CONFIG.vrFov : CONFIG.flatFov);
  }

  function setVideo(element) {
    clear();
    video = element;
    mode = projectionFor(video.videoWidth, video.videoHeight);
    texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    const { videoWidth: width, videoHeight: height } = video;
    const powerOfTwo = (value) => value > 0 && (value & (value - 1)) === 0;
    const useMipmaps =
      powerOfTwo(width) &&
      powerOfTwo(height) &&
      width <= 4096 &&
      height <= 4096;
    // Keep the original sampling quality, especially near the VR sphere poles.
    texture.generateMipmaps = useMipmaps;
    texture.minFilter = useMipmaps
      ? THREE.LinearMipmapLinearFilter
      : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    flatMaterial.map = texture;
    flatMaterial.needsUpdate = true;
    if (mode === "vr") {
      if (!sphere) {
        const geometry = new THREE.SphereGeometry(500, 128, 128);
        geometry.scale(-1, 1, 1);
        sphere = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        scene.add(sphere);
      }
      sphere.material.map = texture;
      sphere.material.needsUpdate = true;
      sphere.visible = true;
      controls.enabled = true;
    } else plane.visible = true;
    reset();
    requestRender(true);
  }

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    controls.enableDamping = !playing;
    if (playing) requestRender(true);
  }

  life.on(controls, "change", () => requestRender());
  life.on(controls, "start", () => {
    interacting = true;
  });
  life.on(controls, "end", () => {
    interacting = false;
  });
  life.on(window, "resize", scheduleResize);
  life.on(document, "visibilitychange", () => {
    if (!document.hidden) requestRender(true);
  });
  life.on(renderer.domElement, "webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    onError(
      "The graphics context was lost. Wait for recovery or reload the page.",
    );
  });
  life.on(renderer.domElement, "webglcontextrestored", () => {
    contextLost = false;
    scheduleResize();
    requestRender(true);
    onRestore();
  });
  const observer = new ResizeObserver(scheduleResize);
  observer.observe(container);
  life.cleanup(() => observer.disconnect());
  resize();

  return {
    canvas: renderer.domElement,
    get mode() {
      return mode;
    },
    get fov() {
      return camera.fov;
    },
    setVideo,
    clear,
    reset,
    setFov,
    zoom(delta) {
      setFov(camera.fov + delta);
    },
    drawFrame() {
      if (disposed) return Promise.resolve(false);
      return new Promise((resolve) => {
        frameWaiters.push(resolve);
        requestRender(true);
      });
    },
    setPlaying,
    pan(dx, dy) {
      if (mode !== "flat" || !video) return;
      const height = 2 * Math.tan((camera.fov * Math.PI) / 360);
      panX +=
        (dx / Math.max(1, container.clientWidth)) * height * camera.aspect;
      panY -= (dy / Math.max(1, container.clientHeight)) * height;
      fitPlane();
      requestRender();
    },
    // Diagnostics support performance/resource regression tests without global state.
    diagnostics() {
      return {
        drawCount,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
        mode,
        cameraQuaternion: camera.quaternion.toArray(),
      };
    },
    dispose() {
      disposed = true;
      life.dispose();
      if (renderHandle !== null) cancelAnimationFrame(renderHandle);
      if (resizeHandle !== null) cancelAnimationFrame(resizeHandle);
      controls.dispose();
      clear();
      plane.geometry.dispose();
      flatMaterial.dispose();
      sphere?.geometry.dispose();
      sphere?.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
