// Layout editor for product cutouts: pick the frame ratio, how much of the frame the products fill, and their position.
// The preview mirrors `layoutCutout` on the server, which applies the result on the full-resolution original.
// With a scene photo (an existing altar) the photo is the frame and the products are scaled onto it, mirroring
// `placeOnScene` on the server.
const PREVIEW_EDGE = 1400;
const SCAN_EDGE = 1024;

export const DEFAULT_LAYOUT = { fill: 0.8, centerX: 0.5, centerY: 0.5 };
export const DEFAULT_PLACEMENT = { fill: 0.6, centerX: 0.5, centerY: 0.6 };
const NOTES = {
  frame: 'Kéo để dời bộ đồ thờ, chỉnh "Độ lớn" để thêm hoặc bớt khoảng trống quanh nó. Sản phẩm giữ nguyên kích thước pixel gốc, chỉ khung hình thay đổi, nên không mất chi tiết.',
  scene: 'Kéo để đặt chân bộ đồ thờ lên mặt bàn thờ, chỉnh "Độ lớn" hoặc cuộn chuột trên ảnh để thu nhỏ, phóng to. Bấm "Áp dụng" rồi mới tạo ảnh: ảnh bàn thờ giữ nguyên, AI chỉ thêm bóng đổ và chiều sâu quanh chân đồ thờ.',
};

const $ = (id) => document.getElementById(id);
const modal = $('layout-modal');
const canvas = $('layout-canvas');
const ctx = canvas.getContext('2d');
const fillInput = $('layout-fill');
const ratioBox = $('layout-ratios');

let resolveOpen = null;
let image = null;
let scene = null;
let bounds = null;
let layout = null;
let drag = null;

const parseRatio = (value) => {
  const [w, h] = String(value).split(':').map(Number);
  return w / h;
};
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Bounding box of the visible pixels, scanned on a downscaled copy and mapped back to original pixels.
function scanBounds(img) {
  const k = Math.min(1, SCAN_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k);
  const h = Math.round(img.naturalHeight * k);
  const scan = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true });
  scan.drawImage(img, 0, 0, w, h);
  const { data } = scan.getImageData(0, 0, w, h);
  let [minX, minY, maxX, maxY] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= 8) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { left: 0, top: 0, width: img.naturalWidth, height: img.naturalHeight };
  return { left: minX / k, top: minY / k, width: (maxX - minX + 1) / k, height: (maxY - minY + 1) / k };
}

function place(frameWidth, frameHeight, width, height) {
  const left = clamp(layout.centerX * frameWidth - width / 2, 0, frameWidth - width);
  const top = clamp(layout.centerY * frameHeight - height / 2, 0, frameHeight - height);
  return { frameWidth, frameHeight, left, top, width, height };
}

// Frame size and product placement, in frame pixels, for the current layout.
function geometry() {
  if (scene) {
    const { naturalWidth: frameWidth, naturalHeight: frameHeight } = scene;
    const k = Math.min((layout.fill * frameWidth) / bounds.width, (layout.fill * frameHeight) / bounds.height);
    return place(frameWidth, frameHeight, bounds.width * k, bounds.height * k);
  }
  const ratio = parseRatio(layout.aspectRatio);
  const frameWidth = Math.max(bounds.width / layout.fill, (bounds.height / layout.fill) * ratio);
  return place(frameWidth, frameWidth / ratio, bounds.width, bounds.height);
}

function render() {
  const { frameWidth, frameHeight, left, top, width, height } = geometry();
  const s = PREVIEW_EDGE / Math.max(frameWidth, frameHeight);
  canvas.width = Math.round(frameWidth * s);
  canvas.height = Math.round(frameHeight * s);
  if (scene) {
    ctx.drawImage(scene, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#b4b4b4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height, left * s, top * s, width * s, height * s);

  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ratioBox.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.ratio === layout.aspectRatio));
  fillInput.value = Math.round(layout.fill * 100);
  $('layout-fill-value').textContent = `${Math.round(layout.fill * 100)}%`;
  $('layout-size').textContent = scene
    ? `Đồ thờ ${Math.round(width)}×${Math.round(height)} px trên ảnh ${frameWidth}×${frameHeight}`
    : `${Math.round(frameWidth)}×${Math.round(frameHeight)} px`;
}

// Stores the position the products actually end up at, so dragging past an edge does not "stick".
function commitClampedCenter() {
  const { frameWidth, frameHeight, left, top, width, height } = geometry();
  layout.centerX = (left + width / 2) / frameWidth;
  layout.centerY = (top + height / 2) / frameHeight;
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, centerX: layout.centerX, centerY: layout.centerY };
});
canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const rect = canvas.getBoundingClientRect();
  layout.centerX = drag.centerX + (event.clientX - drag.x) / rect.width;
  layout.centerY = drag.centerY + (event.clientY - drag.y) / rect.height;
  render();
});
['pointerup', 'pointercancel'].forEach((type) =>
  canvas.addEventListener(type, () => {
    if (!drag) return;
    drag = null;
    commitClampedCenter();
  }),
);

// Scrolling over the preview resizes the products around their current centre.
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const step = event.deltaY < 0 ? 1.04 : 1 / 1.04;
    layout.fill = clamp(layout.fill * step, Number(fillInput.min) / 100, 1);
    render();
  },
  { passive: false },
);

fillInput.addEventListener('input', () => {
  layout.fill = Number(fillInput.value) / 100;
  render();
});
ratioBox.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ratio]');
  if (!button) return;
  layout.aspectRatio = button.dataset.ratio;
  render();
});
$('layout-center').addEventListener('click', () => {
  // On a scene only the horizontal position is centred, so the products stay on the altar surface.
  Object.assign(layout, { centerX: 0.5, centerY: scene ? layout.centerY : 0.5 });
  render();
});

function close(result) {
  modal.hidden = true;
  resolveOpen?.(result);
  resolveOpen = null;
}
modal.querySelector('[data-close]').addEventListener('click', () => close(undefined));
$('layout-apply').addEventListener('click', () => {
  commitClampedCenter();
  close({ ...layout });
});

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không tải được ảnh để căn bố cục'));
    img.src = url;
  });

// Opens the editor for an original cutout with the frame ratios the model supports, or on a scene photo when given.
// Resolves to {aspectRatio, fill, centerX, centerY} ({fill, centerX, centerY} on a scene) or undefined (cancelled).
export async function openLayoutEditor({ original, layout: current, ratios: supported = [], scene: sceneImage }) {
  [image, scene] = await Promise.all([loadImage(original.url), sceneImage ? loadImage(sceneImage.url) : null]);
  bounds = scanBounds(image);
  const ratios = supported.includes(current.aspectRatio) ? supported : [current.aspectRatio, ...supported];
  ratioBox.hidden = Boolean(scene);
  ratioBox.innerHTML = scene ? '' : ratios.map((r) => `<button type="button" data-ratio="${r}">${r}</button>`).join('');
  fillInput.min = scene ? 10 : 40;
  $('layout-note').textContent = scene ? NOTES.scene : NOTES.frame;
  layout = { ...current };
  render();
  modal.hidden = false;
  return new Promise((resolve) => (resolveOpen = resolve));
}
