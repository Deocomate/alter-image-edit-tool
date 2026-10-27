// Brush mask editor: paints on a canvas at (capped) image resolution and exports a white-on-black PNG.
const MAX_MASK_EDGE = 2048;
const MAX_UNDO = 25;

const $ = (id) => document.getElementById(id);
const modal = $('mask-modal');
const image = $('mask-image');
const canvas = $('mask-canvas');
const ctx = canvas.getContext('2d');
const brushInput = $('brush-size');
const eraserBtn = $('mask-eraser');

let resolveOpen = null;
let mode = 'edit';
let erasing = false;
let undoStack = [];
let drawing = false;
let last = null;

function setMode(next) {
  mode = next;
  modal.querySelectorAll('#mask-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

const brushRadius = () => (Number(brushInput.value) / 1000) * Math.max(canvas.width, canvas.height) * 0.5;

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
}

function stroke(from, to) {
  ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--mask').trim() || '#ff4646';
  ctx.lineWidth = brushRadius() * 2;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function pushUndo() {
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  pushUndo();
  drawing = true;
  last = pointFromEvent(event);
  stroke(last, last);
});
canvas.addEventListener('pointermove', (event) => {
  if (!drawing) return;
  const point = pointFromEvent(event);
  stroke(last, point);
  last = point;
});
['pointerup', 'pointercancel'].forEach((type) => canvas.addEventListener(type, () => (drawing = false)));

modal.querySelectorAll('#mask-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
eraserBtn.addEventListener('click', () => {
  erasing = !erasing;
  eraserBtn.classList.toggle('active', erasing);
});
$('mask-undo').addEventListener('click', () => {
  const previous = undoStack.pop();
  if (previous) ctx.putImageData(previous, 0, 0);
});
$('mask-clear').addEventListener('click', () => {
  pushUndo();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

function close(result) {
  modal.hidden = true;
  resolveOpen?.(result);
  resolveOpen = null;
}
modal.querySelector('[data-close]').addEventListener('click', () => close(undefined));
$('mask-apply').addEventListener('click', () => close(exportMask()));

function exportMask() {
  const { width, height } = canvas;
  const painted = ctx.getImageData(0, 0, width, height);
  const out = new ImageData(width, height);
  let any = false;
  for (let i = 0; i < painted.data.length; i += 4) {
    const a = painted.data[i + 3];
    if (a) any = true;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = a;
    out.data[i + 3] = 255;
  }
  if (!any) return null;
  const exportCanvas = Object.assign(document.createElement('canvas'), { width, height });
  exportCanvas.getContext('2d').putImageData(out, 0, 0);
  return { dataUrl: exportCanvas.toDataURL('image/png'), mode, strokes: painted };
}

// Opens the editor for an image. Resolves to {dataUrl, mode, strokes}, null (mask cleared) or undefined (cancelled).
export function openMaskEditor({ url, width, height, previous }) {
  const scale = Math.min(1, MAX_MASK_EDGE / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (previous?.strokes) ctx.putImageData(previous.strokes, 0, 0);
  setMode(previous?.mode || 'edit');
  erasing = false;
  eraserBtn.classList.remove('active');
  undoStack = [];
  image.src = url;
  modal.hidden = false;
  return new Promise((resolve) => (resolveOpen = resolve));
}
