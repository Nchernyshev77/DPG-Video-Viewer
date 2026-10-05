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
    // OrbitControls emits change only while its damping is still moving the camera.
    if (controls.enabled) controls.update();
    if (frameDirty && texture && video?.readyState >= 2)
      texture.needsUpdate = true;
    frameDirty = false;
    renderer.render(scene, camera);
    drawCount++;
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
    // Rebuilding mipmaps on every video frame was costly; use linear filtering.
    texture.generateMipmaps = false;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    flatMaterial.map = texture;
    flatMaterial.needsUpdate = true;
    if (mode === "vr") {
      if (!sphere) {
        const geometry = new THREE.SphereGeometry(500, 64, 48);
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

  life.on(controls, "change", () => requestRender());
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
      requestRender(true);
    },
    setPlaying(playing) {
      controls.enableDamping = !playing;
    },
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
