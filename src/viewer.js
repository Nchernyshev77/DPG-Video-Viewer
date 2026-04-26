import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const MIN_FOV = 25;
const MAX_FOV = 95;
const VR_ASPECT_TARGET = 2;
const VR_ASPECT_TOLERANCE = 0.08;

export function createViewer(canvas, container) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1100);
  camera.position.set(0, 0, 0.01);

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = -0.35;
  controls.enabled = false;

  const sphereGeometry = new THREE.SphereGeometry(500, 96, 96);
  sphereGeometry.scale(-1, 1, 1);
  const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
  sphere.visible = false;
  sphere.rotation.y = -Math.PI / 2;
  scene.add(sphere);

  const planeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMaterial);
  plane.visible = false;
  scene.add(plane);

  let mode = 'flat';
  let videoTexture = null;
  let panX = 0;
  let panY = 0;
  let dragPointerId = null;
  let lastPoint = { x: 0, y: 0 };

  function resize() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    fitPlane();
  }

  function fitPlane(videoWidth = 16, videoHeight = 9) {
    if (!plane.visible) {
      return;
    }

    const distance = 1;
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const visibleWidth = visibleHeight * camera.aspect;
    const videoRatio = videoWidth / videoHeight;
    const viewportRatio = visibleWidth / visibleHeight;

    let planeWidth = visibleWidth;
    let planeHeight = visibleHeight;

    if (videoRatio > viewportRatio) {
      planeHeight = visibleWidth / videoRatio;
    } else {
      planeWidth = visibleHeight * videoRatio;
    }

    const zoomFactor = 75 / camera.fov;
    plane.position.set(panX, panY, -distance);
    plane.scale.set(planeWidth * zoomFactor, planeHeight * zoomFactor, 1);
  }

  function attachVideo(videoElement) {
    if (videoTexture) {
      videoTexture.dispose();
    }

    videoTexture = new THREE.VideoTexture(videoElement);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.generateMipmaps = false;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.wrapS = THREE.ClampToEdgeWrapping;
    videoTexture.wrapT = THREE.ClampToEdgeWrapping;

    sphereMaterial.map = videoTexture;
    sphereMaterial.needsUpdate = true;
    planeMaterial.map = videoTexture;
    planeMaterial.needsUpdate = true;

    const aspect = videoElement.videoHeight > 0 ? videoElement.videoWidth / videoElement.videoHeight : 16 / 9;
    const isVrLike = Math.abs(aspect - VR_ASPECT_TARGET) <= VR_ASPECT_TOLERANCE;
    setMode(isVrLike ? 'vr' : 'flat', videoElement.videoWidth || 16, videoElement.videoHeight || 9);
  }

  function setMode(nextMode, videoWidth = 16, videoHeight = 9) {
    mode = nextMode;
    controls.enabled = nextMode === 'vr';
    sphere.visible = nextMode === 'vr';
    plane.visible = nextMode !== 'vr';
    fitPlane(videoWidth, videoHeight);
  }

  function setFovFromWheel(deltaY, videoWidth, videoHeight) {
    camera.fov = clamp(camera.fov + deltaY * 0.02, MIN_FOV, MAX_FOV);
    camera.updateProjectionMatrix();
    fitPlane(videoWidth, videoHeight);
  }

  function resetView(videoWidth = 16, videoHeight = 9) {
    panX = 0;
    panY = 0;
    camera.fov = 75;
    camera.updateProjectionMatrix();
    controls.reset();
    controls.target.set(0, 0, -1);
    controls.update();
    fitPlane(videoWidth, videoHeight);
  }

  function animate() {
    controls.update();
    if (videoTexture) {
      videoTexture.needsUpdate = true;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  function onPointerDown(event) {
    if (mode !== 'flat' || event.button !== 0) {
      return;
    }

    dragPointerId = event.pointerId;
    lastPoint = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (mode !== 'flat' || dragPointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - lastPoint.x;
    const dy = event.clientY - lastPoint.y;
    lastPoint = { x: event.clientX, y: event.clientY };

    panX += dx * 0.0025;
    panY -= dy * 0.0025;
    fitPlane();
  }

  function onPointerUp(event) {
    if (dragPointerId !== event.pointerId) {
      return;
    }

    canvas.releasePointerCapture(event.pointerId);
    dragPointerId = null;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', resize);
  resize();
  animate();

  return {
    attachVideo,
    getMode: () => mode,
    resize,
    resetView,
    setFovFromWheel,
  };
}
