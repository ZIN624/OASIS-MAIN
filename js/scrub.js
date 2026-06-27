// OASIS 3Dスクラブ デモ
// Three.js でオブジェクトを表示し、ドラッグ回転・スライダーでのスクラブ操作を行う。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const wrap = document.getElementById("canvasWrap");
const shapeSelect = document.getElementById("shapeSelect");
const scrubRange = document.getElementById("scrubRange");
const scrubValue = document.getElementById("scrubValue");
const autoRotateBtn = document.getElementById("autoRotateBtn");
const resetBtn = document.getElementById("resetBtn");

// --- シーン・カメラ・レンダラー ---------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 0, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

// --- ライト ----------------------------------------------------------------
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8fd6aa, 0.5);
fillLight.position.set(-4, -2, -3);
scene.add(fillLight);

// --- マテリアル（OASISのグリーン） ------------------------------------------
const material = new THREE.MeshStandardMaterial({
  color: 0x2f8f57,
  metalness: 0.3,
  roughness: 0.35,
});

// --- 形状の生成 ------------------------------------------------------------
function createGeometry(type) {
  switch (type) {
    case "cube":
      return new THREE.BoxGeometry(2, 2, 2);
    case "sphere":
      return new THREE.SphereGeometry(1.4, 48, 48);
    case "torus":
      return new THREE.TorusGeometry(1.2, 0.45, 32, 64);
    case "torusKnot":
    default:
      return new THREE.TorusKnotGeometry(1, 0.32, 160, 24);
  }
}

const mesh = new THREE.Mesh(createGeometry("torusKnot"), material);
scene.add(mesh);

function setShape(type) {
  mesh.geometry.dispose();
  mesh.geometry = createGeometry(type);
}

// --- コントロール（ドラッグでカメラ視点を回す・ズーム） ----------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// --- 回転の状態管理 --------------------------------------------------------
// autoSpin … メッシュ自体を自動でくるくる回す
// scrubbing … スライダーで手動操作している間は自動回転を止める
let autoSpin = true;
let scrubbing = false;
const SPIN_SPEED = 0.6; // ラジアン/秒

function setSlider(deg) {
  scrubRange.value = String(deg);
  scrubValue.textContent = `${deg}°`;
}

// スライダー操作＝スクラブ：角度をメッシュへ直接反映する
scrubRange.addEventListener("input", () => {
  const deg = Number(scrubRange.value);
  scrubValue.textContent = `${deg}°`;
  mesh.rotation.y = THREE.MathUtils.degToRad(deg);
});
scrubRange.addEventListener("pointerdown", () => {
  scrubbing = true;
  autoSpin = false;
  updateAutoRotateLabel();
});
scrubRange.addEventListener("pointerup", () => {
  scrubbing = false;
});

// --- UI操作 ----------------------------------------------------------------
shapeSelect.addEventListener("change", () => setShape(shapeSelect.value));

function updateAutoRotateLabel() {
  autoRotateBtn.textContent = `自動回転：${autoSpin ? "ON" : "OFF"}`;
}

autoRotateBtn.addEventListener("click", () => {
  autoSpin = !autoSpin;
  updateAutoRotateLabel();
});

resetBtn.addEventListener("click", () => {
  controls.reset();
  camera.position.set(0, 0, 5);
});

// --- リサイズ対応 ----------------------------------------------------------
function resize() {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
if ("ResizeObserver" in window) {
  new ResizeObserver(resize).observe(wrap);
}
resize();

// --- 描画ループ ------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  if (autoSpin && !scrubbing) {
    mesh.rotation.y += SPIN_SPEED * delta;
    // 自動回転に合わせてスライダー表示も追従させる
    const deg = ((Math.round(THREE.MathUtils.radToDeg(mesh.rotation.y)) % 360) + 360) % 360;
    setSlider(deg);
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();
