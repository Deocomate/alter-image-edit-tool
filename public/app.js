import { openMaskEditor } from './mask-editor.js';
import { DEFAULT_LAYOUT, DEFAULT_PLACEMENT, openLayoutEditor } from './layout-editor.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_MODEL = 'google/gemini-3-pro-image';
const QUALITY_TIERS = { hd: 1280, fhd: 1920, '2k': 2560, '4k': 3840 };

const ASPECT_OPTIONS = [
  { value: 'original', title: 'Giữ theo ảnh gốc' },
  ...['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '4:5', '5:4', '21:9'].map((v) => ({ value: v, title: v })),
];
const QUALITY_OPTIONS = [
  { value: 'original', title: 'Gốc', sub: 'Giữ độ phân giải ảnh gốc' },
  { value: 'hd', title: 'HD', sub: 'Cạnh dài 1280 px' },
  { value: 'fhd', title: 'Full HD', sub: 'Cạnh dài 1920 px' },
  { value: '2k', title: '2K', sub: 'Cạnh dài 2560 px' },
  { value: '4k', title: '4K', sub: 'Cạnh dài 3840 px' },
];
const FORMAT_OPTIONS = [
  { value: 'png', title: 'PNG', sub: 'Không nén mất dữ liệu, nét nhất' },
  { value: 'jpeg', title: 'JPG', sub: 'Chất lượng 95, file nhỏ hơn' },
  { value: 'webp', title: 'WEBP', sub: 'Chất lượng 95, file nhỏ nhất' },
];

// Ready-made altar scenes for product cutouts; each fills the prompt box and can still be edited.
const SCENE_PRESETS = [
  {
    title: 'Bàn thờ gỗ gụ cổ điển',
    prompt: 'Đặt bộ đồ thờ trên mặt bàn thờ gỗ gụ bóng màu nâu đỏ. Phía sau là phòng thờ gia tiên cổ điển với hoành phi, câu đối chạm khắc, mờ dần theo chiều sâu. Ánh sáng vàng ấm, đổ bóng mềm và phản chiếu nhẹ trên mặt gỗ.',
  },
  {
    title: 'Phòng thờ hiện đại',
    prompt: 'Đặt bộ đồ thờ trên bàn thờ gỗ óc chó tối giản. Phía sau là vách ốp gỗ sáng màu có đèn hắt dịu, hậu cảnh mờ có chiều sâu. Ánh sáng tự nhiên trong trẻo, đổ bóng mềm dưới chân từng món.',
  },
  {
    title: 'Sơn son thếp vàng',
    prompt: 'Đặt bộ đồ thờ trên bàn thờ gỗ sơn son thếp vàng. Hậu cảnh là không gian đền chùa trang nghiêm với cột gỗ và hoa văn chạm vàng, mờ dần theo chiều sâu. Ánh nến ấm áp, đổ bóng tự nhiên.',
  },
  {
    title: 'Studio catalogue',
    prompt: 'Đặt bộ đồ thờ trên mặt bàn gỗ trơn màu trầm. Nền studio màu kem chuyển sắc mờ dần, ánh sáng softbox đều và mềm, đổ bóng nhẹ dưới chân từng món, phong cách ảnh catalogue sản phẩm cao cấp.',
  },
];

// Finishes for products placed on the user's own altar photo: the photo stays, so these only steer shadows and light.
const ALTAR_PHOTO_PRESETS = [
  {
    title: 'Đổ bóng tự nhiên',
    prompt: 'Thêm bóng đổ mềm và vùng tối tiếp xúc dưới chân từng món đồ thờ, đúng hướng ánh sáng của ảnh bàn thờ. Giữ nguyên bàn thờ và đồ thờ.',
  },
  {
    title: 'Phản chiếu mặt gỗ bóng',
    prompt: 'Thêm bóng đổ mềm dưới chân từng món và phản chiếu nhẹ của đồ thờ trên mặt gỗ bóng của bàn thờ. Giữ nguyên bàn thờ và đồ thờ.',
  },
];

const ICONS = {
  altar: '<svg viewBox="0 0 24 24"><path d="M3 10h18M5 10v10M19 10v10M8 10V7h8v3M10 7V4h4v3"/></svg>',
  check: '<svg class="check" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  brush: '<svg viewBox="0 0 24 24"><path d="M18.4 2.6a2 2 0 0 1 3 3L12 15l-3-3ZM9 12a3 3 0 0 0-3 3c0 1.5-1 3-3 3 1 2 3.5 3 6 3a4 4 0 0 0 4-4 3 3 0 0 0-3-3"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  layout: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/></svg>',
  compare: '<svg viewBox="0 0 24 24"><path d="M12 3v18M5 7h4v10H5zM15 7h4v10h-4z"/></svg>',
};

const loadOptions = () => {
  try {
    return JSON.parse(localStorage.getItem('image-edit-options')) || {};
  } catch {
    return {};
  }
};

const state = {
  models: [],
  sessions: [],
  session: null,
  attachments: [], // {id, url, width, height, uploading?}
  mask: null, // {dataUrl, mode, strokes} for attachments[0]
  sceneMode: true, // a plain photo next to a product cutout is the altar to place the products on

  busy: false,
  options: { model: DEFAULT_MODEL, aspectRatio: 'original', quality: '2k', outputFormat: 'png', ...loadOptions() },
};

const saveOptions = () => {
  try {
    localStorage.setItem('image-edit-options', JSON.stringify(state.options));
  } catch {
    // Storage may be unavailable; options just won't persist.
  }
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Lỗi ${response.status}`);
  return json;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

const currentModel = () => state.models.find((m) => m.id === state.options.model);
// A transparent PNG product cutout: the AI only builds the scene and the products are pasted back untouched.
const isCutoutEdit = () => Boolean(state.attachments[0]?.cutout);
const keepsOriginalFrame = () => Boolean(state.mask) || isCutoutEdit();
// Products placed on the user's own altar photo (the second attachment); that photo is the frame and stays untouched.
const isSceneEdit = () => state.sceneMode && isCutoutEdit() && Boolean(state.attachments[1]) && !state.attachments[1].cutout && !state.attachments[1].uploading;

/* ---------- Dropdowns ---------- */

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle]');
  const dropdown = toggle?.closest('.dropdown');
  document.querySelectorAll('.dropdown.open').forEach((d) => {
    if (d !== dropdown && !d.contains(event.target)) d.classList.remove('open');
  });
  if (dropdown) {
    dropdown.classList.toggle('open');
    if (dropdown.id === 'model-dropdown' && dropdown.classList.contains('open')) $('model-search').focus();
  }
});

function menuItem({ title, sub, badge, selected, disabled }) {
  return `<button type="button" class="menu-item${selected ? ' selected' : ''}" ${disabled ? 'disabled' : ''}>
    ${ICONS.check}
    <span class="mi-main"><span class="mi-title">${escapeHtml(title)}</span>${sub ? `<span class="mi-sub">${escapeHtml(sub)}</span>` : ''}</span>
    ${badge || ''}
  </button>`;
}

function renderOptionDropdown(id, options, key, labelOf, onChange) {
  const root = $(id);
  const menu = root.querySelector('[data-options]');
  menu.innerHTML = options.map((o) => menuItem({ ...o, selected: o.value === state.options[key] })).join('');
  menu.querySelectorAll('.menu-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      state.options[key] = options[i].value;
      saveOptions();
      root.classList.remove('open');
      renderOptions();
      onChange?.();
    });
  });
  root.querySelector('[data-label]').textContent = labelOf(options.find((o) => o.value === state.options[key]) || options[0]);
}

function qualityBadge(value) {
  const max = currentModel()?.maxNativeEdge;
  if (!max || value === 'original') return '';
  return QUALITY_TIERS[value] <= max * 1.05 ? '<span class="badge ok">Gốc model</span>' : '<span class="badge">Phóng to</span>';
}

const parseRatio = (value) => {
  const [w, h] = String(value).split(':').map(Number);
  return w / h;
};

// Ratios the selected model produces natively; any other ratio would come back cropped or stretched.
function supportedAspects() {
  const all = ASPECT_OPTIONS.slice(1).map((o) => o.value);
  const listed = currentModel()?.aspectRatios || [];
  const supported = all.filter((v) => listed.includes(v));
  return supported.length ? supported : all;
}

const closestAspect = (ratio) =>
  supportedAspects().reduce((best, v) => (Math.abs(Math.log(parseRatio(v) / ratio)) < Math.abs(Math.log(parseRatio(best) / ratio)) ? v : best));

// Frame ratio for a product cutout: the chosen ratio, or the supported ratio closest to the original upload.
const cutoutAspect = (original) => (state.options.aspectRatio === 'original' ? closestAspect(original.width / original.height) : state.options.aspectRatio);

// Re-frames the original cutout on the server and swaps the attachment for the result.
async function applyLayout(attachment, layout) {
  const laid = await api(`/api/images/${attachment.original.id}/layout`, { method: 'POST', body: layout });
  Object.assign(attachment, laid, { layout });
}

async function relayout(main, layout) {
  main.uploading = true;
  renderAttachments();
  try {
    await applyLayout(main, layout);
  } catch (error) {
    toast(error.message);
  }
  main.uploading = false;
  renderAttachments();
}

// Choosing a ratio for a product cutout re-frames it, so the model receives exactly that frame.
function relayoutForAspect() {
  const main = state.attachments[0];
  if (isCutoutEdit() && !isSceneEdit() && main.original && !main.uploading) relayout(main, { ...DEFAULT_LAYOUT, ...main.layout, aspectRatio: cutoutAspect(main.original) });
}

function renderOptions() {
  const supported = supportedAspects();
  if (state.options.aspectRatio !== 'original' && !supported.includes(state.options.aspectRatio)) state.options.aspectRatio = 'original';
  const aspectOptions = ASPECT_OPTIONS.filter((o) => o.value === 'original' || supported.includes(o.value));
  const cutoutRatio = isCutoutEdit() ? state.attachments[0].layout?.aspectRatio : null;
  const aspectLabel = (o) => (state.mask ? 'Gốc (đang dùng mask)' : isSceneEdit() ? 'Theo ảnh bàn thờ' : cutoutRatio || (o.value === 'original' ? 'Tỉ lệ gốc' : o.title));
  renderOptionDropdown('aspect-dropdown', aspectOptions, 'aspectRatio', aspectLabel, relayoutForAspect);
  $('aspect-dropdown').querySelector('.pill').classList.toggle('locked', Boolean(state.mask) || isSceneEdit());
  renderOptionDropdown('quality-dropdown', QUALITY_OPTIONS.map((o) => ({ ...o, badge: qualityBadge(o.value) })), 'quality', (o) => o.title);
  renderOptionDropdown('format-dropdown', FORMAT_OPTIONS, 'outputFormat', (o) => o.title);
  renderHint();
}

function computeTargetSize(src) {
  const aspect = keepsOriginalFrame() ? 'original' : state.options.aspectRatio;
  const { quality } = state.options;
  if (aspect === 'original' && quality === 'original') return { width: src.width, height: src.height };
  const [w, h] = aspect.split(':').map(Number);
  const ratio = aspect === 'original' ? src.width / src.height : w / h;
  const longEdge = quality === 'original' ? Math.max(src.width, src.height) : QUALITY_TIERS[quality];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1 ? { width: even(longEdge), height: even(longEdge / ratio) } : { width: even(longEdge * ratio), height: even(longEdge) };
}

function renderHint() {
  const src = isSceneEdit() ? state.attachments[1] : state.attachments.find((a) => !a.uploading);
  const model = currentModel();
  const parts = [];
  if (src) {
    const t = computeTargetSize(src);
    parts.push(`${isSceneEdit() ? 'Ảnh bàn thờ' : 'Ảnh gốc'} ${src.width}×${src.height} → xuất ${t.width}×${t.height}`);
    if (model?.maxNativeEdge && Math.max(t.width, t.height) > model.maxNativeEdge * 1.05) {
      parts.push(`model tạo tối đa ~${model.maxNativeEdge}px, phần còn lại được phóng to`);
    }
    if (isSceneEdit() && !isPlaced()) parts.push('bước 1: bấm nút khung trên ảnh đồ thờ để đặt và chỉnh cỡ bộ đồ thờ trên mặt bàn thờ');
    else if (isSceneEdit()) parts.push('đã đặt bộ đồ thờ (bấm nút khung để chỉnh lại); AI sẽ thêm bóng đổ và chiều sâu quanh chân đồ thờ, ảnh bàn thờ giữ nguyên');
    else if (isCutoutEdit()) parts.push('AI chỉ tạo nền và bóng đổ, đồ vật là pixel gốc được ghép vào đúng chỗ model đặt');
    else if (state.mask) parts.push('chỉ vùng tô được thay đổi');
  } else {
    parts.push('Đính kèm, kéo thả hoặc dán (Ctrl+V) ảnh cần chỉnh sửa');
  }
  $('composer-hint').textContent = parts.join(' · ');
}

/* ---------- Models ---------- */

function modelSub(m) {
  const res = m.resolutions.length ? `Tối đa ${m.resolutions.at(-1)}` : 'Model tự chọn độ phân giải';
  return `${res} · nhận ${m.maxReferences} ảnh`;
}

function renderModels() {
  const query = $('model-search').value.trim().toLowerCase();
  const list = state.models.filter((m) => !query || m.name.toLowerCase().includes(query) || m.id.includes(query));
  $('model-list').innerHTML = list.length
    ? list.map((m) => menuItem({ title: m.name, sub: modelSub(m), selected: m.id === state.options.model, badge: m.maxNativeEdge >= 4096 ? '<span class="badge ok">4K</span>' : '' })).join('')
    : '<div class="mi-sub" style="padding:10px">Không tìm thấy model</div>';
  $('model-list').querySelectorAll('.menu-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      state.options.model = list[i].id;
      saveOptions();
      $('model-dropdown').classList.remove('open');
      renderModelLabel();
      renderOptions();
    });
  });
}

function renderModelLabel() {
  const m = currentModel();
  $('model-label').textContent = m ? m.name.replace(/^[^:]+:\s*/, '') : 'Chọn model';
  renderModels();
}

async function loadModels() {
  try {
    const { models } = await api('/api/models');
    state.models = models;
    if (!currentModel()) state.options.model = (models.find((m) => m.id === DEFAULT_MODEL) || models[0])?.id;
    renderModelLabel();
    renderOptions();
  } catch (error) {
    $('model-label').textContent = 'Không tải được model';
    toast(error.message);
  }
}
$('model-search').addEventListener('input', renderModels);

/* ---------- Sessions ---------- */

async function loadSessions() {
  state.sessions = (await api('/api/sessions')).sessions;
  renderSessions();
}

function renderSessions() {
  const list = $('session-list');
  list.innerHTML = state.sessions
    .map((s) => `<div class="session-item${s.id === state.session?.id ? ' active' : ''}" data-id="${s.id}">
      <span title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
      <button class="icon-btn" data-delete title="Xoá" aria-label="Xoá">${ICONS.trash}</button>
    </div>`)
    .join('');
  list.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', async (event) => {
      if (event.target.closest('[data-delete]')) return deleteSession(el.dataset.id);
      await openSession(el.dataset.id);
      if (window.innerWidth <= 760) setSidebar(false);
    });
  });
}

async function openSession(id) {
  if (state.busy) return toast('Đang xử lý, vui lòng đợi');
  state.session = await api(`/api/sessions/${id}`);
  const lastResult = [...state.session.messages].reverse().find((m) => m.role === 'assistant' && m.images?.length);
  setAttachments(lastResult ? [lastResult.images[0]] : []);
  renderSessions();
  renderThread();
}

async function deleteSession(id) {
  if (!confirm('Xoá phiên này cùng toàn bộ ảnh của nó?')) return;
  await api(`/api/sessions/${id}`, { method: 'DELETE' });
  if (state.session?.id === id) newSession();
  await loadSessions();
}

function newSession() {
  if (state.busy) return toast('Đang xử lý, vui lòng đợi');
  state.session = null;
  setAttachments([]);
  $('prompt').value = '';
  renderSessions();
  renderThread();
  $('prompt').focus();
}
$('new-session').addEventListener('click', newSession);

/* ---------- Thread ---------- */

const PARAM_LABELS = {
  aspect: (v) => (v === 'original' ? 'tỉ lệ gốc' : v),
  quality: (v) => QUALITY_OPTIONS.find((o) => o.value === v)?.title ?? v,
};

function userMessageHtml(m) {
  const placed = m.placementImage
    ? `<img src="${m.placementImage.url}" alt="Vị trí đã đặt" title="Vị trí đã đặt (bản gửi cho AI)" data-view="${m.placementImage.url}" loading="lazy" />`
    : '';
  const thumbs = m.images.map((img) => `<img src="${img.url}" alt="" data-view="${img.url}" loading="lazy" />`).join('') + placed;
  const p = m.params || {};
  const params = [PARAM_LABELS.quality(p.quality), PARAM_LABELS.aspect(p.aspectRatio), p.outputFormat?.toUpperCase(), m.maskId ? (m.maskMode === 'keep' ? 'mask giữ nguyên' : 'mask vùng sửa') : null, m.scene ? 'ghép lên ảnh bàn thờ' : m.cutout ? 'giữ nguyên sản phẩm' : null, m.placement ? `tâm ${Math.round(m.placement.centerX * 100)}%×${Math.round(m.placement.centerY * 100)}%, độ lớn ${Math.round(m.placement.fill * 100)}%` : null].filter(Boolean).join(' · ');
  return `<div class="msg-user">
    <div class="thumbs">${thumbs}</div>
    <div class="bubble">${escapeHtml(m.text)}</div>
    <div class="msg-params">${escapeHtml(params)}</div>
  </div>`;
}

function assistantMessageHtml(m) {
  if (m.error) return `<div class="msg-assistant"><div class="msg-error">Lỗi: ${escapeHtml(m.error)}</div></div>`;
  const img = m.images[0];
  const info = m.info || {};
  const modelName = state.models.find((x) => x.id === info.model)?.name || info.model;
  const meta = [
    `${img.width}×${img.height}`,
    info.modelOutputWidth ? `model tạo ${info.modelOutputWidth}×${info.modelOutputHeight}` : null,
    modelName,
    info.alignment?.score != null
      ? `khớp ${Math.round(info.alignment.score * 100)}%${Math.abs(info.alignment.scale - 1) >= 0.02 ? `, sản phẩm ×${info.alignment.scale.toFixed(2)}` : ''}`
      : null,
    info.cost != null ? `$${Number(info.cost).toFixed(3)}` : null,
    info.durationMs ? `${Math.round(info.durationMs / 1000)}s` : null,
  ].filter(Boolean);
  const sourceUrl = m.sourceImageId ? `/images/${m.sourceImageId}` : '';
  return `<div class="msg-assistant">
    <img class="result-img" src="${img.url}" alt="Ảnh kết quả" data-view="${img.url}" data-before="${sourceUrl}" />
    <div class="msg-meta">${meta.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</div>
    <div class="msg-actions">
      <a class="action-btn" href="${img.url}" download="edited-${img.width}x${img.height}-${img.id}">${ICONS.download}Tải xuống</a>
      <button class="action-btn" data-continue='${escapeHtml(JSON.stringify(img))}'>${ICONS.edit}Sửa tiếp ảnh này</button>
      ${sourceUrl ? `<button class="action-btn" data-compare="${img.url}" data-before="${sourceUrl}">${ICONS.compare}So sánh</button>` : ''}
    </div>
  </div>`;
}

function renderThread(pending) {
  const messages = state.session?.messages || [];
  $('empty').hidden = messages.length > 0 || Boolean(pending);
  $('messages').innerHTML = messages.map((m) => (m.role === 'user' ? userMessageHtml(m) : assistantMessageHtml(m))).join('') + (pending || '');
  const thread = $('thread');
  requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
}

$('messages').addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]');
  const compare = event.target.closest('[data-compare]');
  const cont = event.target.closest('[data-continue]');
  if (compare) openLightbox(compare.dataset.compare, compare.dataset.before, 'compare');
  else if (view) openLightbox(view.dataset.view, view.dataset.before);
  else if (cont) {
    setAttachments([JSON.parse(cont.dataset.continue)]);
    $('prompt').focus();
  }
});

/* ---------- Attachments ---------- */

function setAttachments(list) {
  state.attachments = list;
  state.mask = null;
  renderAttachments();
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = state.attachments
    .map((a, i) => `<div class="chip${a.uploading ? ' uploading' : ''}">
      <img src="${a.url}" alt="" />
      <button type="button" class="chip-x" data-remove="${i}" aria-label="Bỏ ảnh">${ICONS.close}</button>
      <span class="chip-tag">${i === 0 ? 'Ảnh sửa' : i === 1 && isSceneEdit() ? 'Bàn thờ' : 'Tham chiếu'}</span>
      ${i === 0 && !a.uploading && a.original ? `<button type="button" class="chip-brush${isSceneEdit() && !isPlaced() ? ' on' : ''}" data-layout title="${isSceneEdit() ? 'Đặt lên bàn thờ' : 'Căn bố cục'}" aria-label="Căn bố cục">${ICONS.layout}</button>` : ''}
      ${i === 1 && !a.uploading && !a.cutout && isCutoutEdit() ? `<button type="button" class="chip-brush${state.sceneMode ? ' on' : ''}" data-scene title="${state.sceneMode ? 'Đang dùng làm ảnh bàn thờ (bấm để chỉ dùng làm tham chiếu)' : 'Dùng làm ảnh bàn thờ để ghép đồ thờ lên'}" aria-label="Dùng làm ảnh bàn thờ">${ICONS.altar}</button>` : ''}
      ${i === 0 && !a.uploading && !a.cutout ? `<button type="button" class="chip-brush${state.mask ? ' on' : ''}" data-brush title="Tô vùng cần sửa" aria-label="Tô vùng cần sửa">${ICONS.brush}</button>` : ''}
    </div>`)
    .join('');
  renderPresets();
  renderOptions();
  updateSendState();
}

// Whether the user has placed and sized the products on the current altar photo.
const isPlaced = () => isSceneEdit() && state.attachments[0].placementFor === state.attachments[1].id;

// The user places and sizes the products on the altar photo before anything is generated.
async function openPlacement() {
  const [main, scene] = state.attachments;
  const placement = await openLayoutEditor({ ...main, layout: main.placement ?? DEFAULT_PLACEMENT, scene }).catch((error) => toast(error.message));
  if (placement) Object.assign(main, { placement, placementFor: scene.id });
  renderAttachments();
}

const presetList = () => (isSceneEdit() ? ALTAR_PHOTO_PRESETS : SCENE_PRESETS);

function renderPresets() {
  const box = $('presets');
  box.hidden = !isCutoutEdit();
  box.innerHTML = presetList().map((p, i) => `<button type="button" class="preset" data-preset="${i}">${escapeHtml(p.title)}</button>`).join('');
}

$('presets').addEventListener('click', (event) => {
  const preset = presetList()[event.target.closest('[data-preset]')?.dataset.preset];
  if (!preset) return;
  promptEl.value = preset.prompt;
  promptEl.dispatchEvent(new Event('input'));
  promptEl.focus();
});

$('attachments').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const index = Number(remove.dataset.remove);
    state.attachments.splice(index, 1);
    if (index === 0) state.mask = null;
    return renderAttachments();
  }
  if (event.target.closest('[data-scene]')) {
    state.sceneMode = !state.sceneMode;
    renderAttachments();
    if (isSceneEdit() && !isPlaced()) openPlacement();
    return;
  }
  if (event.target.closest('[data-layout]') && isSceneEdit()) return openPlacement();
  if (event.target.closest('[data-layout]')) {
    const main = state.attachments[0];
    const layout = await openLayoutEditor({ ...main, ratios: supportedAspects() });
    if (!layout) return;
    state.options.aspectRatio = layout.aspectRatio;
    saveOptions();
    return relayout(main, layout);
  }
  if (event.target.closest('[data-brush]')) {
    const main = state.attachments[0];
    const result = await openMaskEditor({ ...main, previous: state.mask });
    if (result !== undefined) {
      state.mask = result;
      renderAttachments();
    }
  }
});

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  const max = currentModel()?.maxReferences ?? 16;
  for (const file of images) {
    if (state.attachments.length >= max) {
      toast(`Model này nhận tối đa ${max} ảnh`);
      break;
    }
    const blobUrl = URL.createObjectURL(file);
    const placeholder = { url: blobUrl, uploading: true, width: 0, height: 0 };
    state.attachments.push(placeholder);
    renderAttachments();
    try {
      const uploaded = await api('/api/images', { method: 'POST', body: { dataUrl: await readAsDataUrl(file) } });
      // The main product cutout is centred in the frame right away; the original is kept for later re-layouts.
      if (uploaded.cutout && state.attachments[0] === placeholder) {
        Object.assign(placeholder, uploaded, { original: { ...uploaded } });
        await applyLayout(placeholder, { aspectRatio: cutoutAspect(uploaded), ...DEFAULT_LAYOUT }).catch((error) => toast(error.message));
      }
      Object.assign(placeholder, placeholder.original ? {} : uploaded, { uploading: false });
    } catch (error) {
      state.attachments = state.attachments.filter((a) => a !== placeholder);
      toast(error.message);
    }
    renderAttachments();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
  // A new altar photo opens the placement editor right away: products are placed before anything is generated.
  if (isSceneEdit() && !isPlaced()) openPlacement();
}

$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    event.preventDefault();
    addFiles(files);
  }
});

let dragDepth = 0;
const dropOverlay = $('drop-overlay');
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.add('show');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) dropOverlay.classList.remove('show'), (dragDepth = 0);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('show');
  addFiles(e.dataTransfer.files);
});

/* ---------- Submit ---------- */

const promptEl = $('prompt');

function updateSendState() {
  const ready = !state.busy && promptEl.value.trim() && state.attachments.length && state.attachments.every((a) => !a.uploading) && currentModel();
  $('send-btn').disabled = !ready;
}

promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
  updateSendState();
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  updateSendState();
  if ($('send-btn').disabled) return;
  if (isSceneEdit() && !isPlaced()) {
    toast('Hãy đặt và chỉnh cỡ bộ đồ thờ trên bàn thờ trước khi tạo ảnh');
    return openPlacement();
  }

  const prompt = promptEl.value.trim();
  const body = {
    prompt,
    model: state.options.model,
    imageIds: state.attachments.map((a) => a.id),
    aspectRatio: state.options.aspectRatio,
    quality: state.options.quality,
    outputFormat: state.options.outputFormat,
    mask: state.mask?.dataUrl,
    maskMode: state.mask?.mode,
    placement: isSceneEdit() ? state.attachments[0].placement : undefined,
  };

  state.busy = true;
  updateSendState();
  const optimisticUser = userMessageHtml({ text: prompt, images: state.attachments, params: body, maskId: body.mask, maskMode: body.maskMode, cutout: isCutoutEdit(), placement: body.placement });
  const started = Date.now();
  const pendingHtml = () => `${optimisticUser}<div class="msg-assistant"><div class="pending">Đang chỉnh sửa… ${Math.round((Date.now() - started) / 1000)}s</div></div>`;
  renderThread(pendingHtml());
  const timer = setInterval(() => {
    const el = document.querySelector('.pending');
    if (el) el.textContent = `Đang chỉnh sửa… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  promptEl.value = '';
  promptEl.style.height = 'auto';

  try {
    if (!state.session) state.session = await api('/api/sessions', { method: 'POST' });
    state.session = await api(`/api/sessions/${state.session.id}/edit`, { method: 'POST', body });
    const last = state.session.messages.at(-1);
    if (last.images?.length) setAttachments([last.images[0]]);
    else promptEl.value = prompt;
  } catch (error) {
    toast(error.message);
    promptEl.value = prompt;
  } finally {
    clearInterval(timer);
    state.busy = false;
    renderThread();
    updateSendState();
    loadSessions();
  }
});

/* ---------- Lightbox / compare ---------- */

const lightbox = $('lightbox');
const compareEl = $('compare');

function setComparePosition(percent) {
  const p = Math.min(100, Math.max(0, percent));
  $('compare-before-wrap').style.clipPath = `inset(0 ${100 - p}% 0 0)`;
  $('compare-line').style.left = `${p}%`;
}

function setLightboxMode(mode) {
  compareEl.classList.toggle('comparing', mode === 'compare');
  lightbox.querySelectorAll('#lightbox-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  setComparePosition(50);
}

function openLightbox(url, beforeUrl, mode = 'result') {
  $('compare-after').src = url;
  $('compare-before').src = beforeUrl || '';
  $('lightbox-modes').hidden = !beforeUrl;
  setLightboxMode(beforeUrl ? mode : 'result');
  lightbox.hidden = false;
}

lightbox.querySelectorAll('#lightbox-modes button').forEach((b) => b.addEventListener('click', () => setLightboxMode(b.dataset.mode)));
lightbox.querySelector('[data-close]').addEventListener('click', () => (lightbox.hidden = true));
$('lightbox-body').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) lightbox.hidden = true;
});
let dragging = false;
const moveCompare = (e) => {
  const rect = compareEl.getBoundingClientRect();
  setComparePosition(((e.clientX - rect.left) / rect.width) * 100);
};
compareEl.addEventListener('pointerdown', (e) => {
  if (!compareEl.classList.contains('comparing')) return;
  dragging = true;
  compareEl.setPointerCapture(e.pointerId);
  moveCompare(e);
});
compareEl.addEventListener('pointermove', (e) => dragging && moveCompare(e));
compareEl.addEventListener('pointerup', () => (dragging = false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lightbox.hidden = true;
});

/* ---------- Sidebar ---------- */

function setSidebar(open) {
  document.querySelector('.app').classList.toggle('sidebar-hidden', !open);
}
$('open-sidebar').addEventListener('click', () => setSidebar(true));
$('close-sidebar').addEventListener('click', () => setSidebar(false));
$('backdrop').addEventListener('click', () => setSidebar(false));
if (window.innerWidth <= 760) setSidebar(false);

/* ---------- Init ---------- */

renderOptions();
renderThread();
updateSendState();
loadModels();
loadSessions().catch((error) => toast(error.message));
