import sharp from 'sharp';

// Output long-edge size for each quality tier (16:9 HD = 1280x720, 4K = 3840x2160).
export const QUALITY_TIERS = { hd: 1280, fhd: 1920, '2k': 2560, '4k': 3840 };

// Approximate long-edge pixels of OpenRouter `resolution` tiers.
export const RESOLUTION_PX = { 512: 512, 768: 768, '1K': 1024, '1.5K': 1536, '2K': 2048, '4K': 4096 };

// Keep request payloads well under provider limits while sending originals untouched when possible.
const MAX_INPUT_BYTES = 7 * 1024 * 1024;
const MAX_INPUT_EDGE = 4096;

// Plain studio grey the cutout is shown on when sent to the model.
const CUTOUT_BACKDROP = '#b4b4b4';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function parseRatio(value) {
  const [w, h] = String(value).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

export function computeTargetSize({ srcWidth, srcHeight, aspectRatio, quality }) {
  if (aspectRatio === 'original' && quality === 'original') return { width: srcWidth, height: srcHeight };
  const ratio = aspectRatio === 'original' ? srcWidth / srcHeight : parseRatio(aspectRatio);
  if (!ratio) throw new Error(`Tỉ lệ khung hình không hợp lệ: ${aspectRatio}`);
  const longEdge = quality === 'original' ? Math.max(srcWidth, srcHeight) : QUALITY_TIERS[quality];
  if (!longEdge) throw new Error(`Chất lượng không hợp lệ: ${quality}`);
  return ratio >= 1
    ? { width: even(longEdge), height: even(longEdge / ratio) }
    : { width: even(longEdge * ratio), height: even(longEdge) };
}

export function closestAspectRatio(supported, ratio) {
  let best = null;
  let bestDiff = Infinity;
  for (const value of supported) {
    const r = parseRatio(value);
    if (!r) continue;
    const diff = Math.abs(Math.log(r / ratio));
    if (diff < bestDiff) [best, bestDiff] = [value, diff];
  }
  return best;
}

// Smallest native tier that covers the target, otherwise the largest available.
export function pickResolution(supported, longEdge) {
  const tiers = supported.filter((v) => RESOLUTION_PX[v]).sort((a, b) => RESOLUTION_PX[a] - RESOLUTION_PX[b]);
  return tiers.find((v) => RESOLUTION_PX[v] >= longEdge) ?? tiers.at(-1) ?? null;
}

const toDataUrl = (buffer, mime) => `data:${mime};base64,${buffer.toString('base64')}`;

// Sends the stored original as-is when it fits; otherwise downsizes once with minimal loss.
export async function prepareInputImage(buffer) {
  const meta = await sharp(buffer).metadata();
  const fits = buffer.length <= MAX_INPUT_BYTES && Math.max(meta.width, meta.height) <= MAX_INPUT_EDGE;
  if (fits && ['jpeg', 'png', 'webp'].includes(meta.format)) return toDataUrl(buffer, `image/${meta.format}`);

  const resized = sharp(buffer).resize({
    width: MAX_INPUT_EDGE,
    height: MAX_INPUT_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: 'lanczos3',
  });
  const png = await resized.clone().png().toBuffer();
  if (png.length <= MAX_INPUT_BYTES) return toDataUrl(png, 'image/png');
  for (const quality of [96, 92, 88]) {
    const jpeg = await resized.clone().flatten({ background: '#ffffff' }).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
    if (jpeg.length <= MAX_INPUT_BYTES || quality === 88) return toDataUrl(jpeg, 'image/jpeg');
  }
}

// A cutout is a PNG/WEBP whose alpha channel actually contains transparent pixels.
export async function isCutout(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.hasAlpha) return false;
  const { channels } = await sharp(buffer).stats();
  return channels.at(-1).min < 250;
}

// The model sees the cutout on a plain backdrop, never on undefined transparent pixels.
export async function flattenCutout(buffer) {
  return sharp(buffer).flatten({ background: CUTOUT_BACKDROP }).png().toBuffer();
}

const ALIGN_EDGE = 384;

// Greyscale pixels at a small working size, used to compare the model output with the cutout.
async function smallGrey(input, width, height) {
  return sharp(input).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
}

// Finds the scale and shift that best map the model's redrawn products back onto the cutout.
// Models usually keep framing, but small drifts would leave ghost edges around pasted products.
export async function estimateAlignment(generated, cutout) {
  const meta = await sharp(cutout).metadata();
  const k = ALIGN_EDGE / Math.max(meta.width, meta.height);
  const w = Math.round(meta.width * k);
  const h = Math.round(meta.height * k);
  const ref = await smallGrey(await flattenCutout(cutout), w, h);
  const gen = await smallGrey(generated, w, h);
  const alpha = await sharp(cutout).ensureAlpha().extractChannel(3).resize(w, h, { fit: 'fill' }).raw().toBuffer();

  const points = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 230) points.push(x, y);
  if (points.length < 200) return { scale: 1, dx: 0, dy: 0 };

  const cx = w / 2;
  const cy = h / 2;
  const cost = (s, dx, dy) => {
    let sum = 0;
    for (let i = 0; i < points.length; i += 2) {
      const gx = Math.round(cx + s * (points[i] - cx) + dx);
      const gy = Math.round(cy + s * (points[i + 1] - cy) + dy);
      const g = gx >= 0 && gx < w && gy >= 0 && gy < h ? gen[gy * w + gx] : 0;
      sum += Math.abs(g - ref[points[i + 1] * w + points[i]]);
    }
    return sum;
  };

  const maxShift = Math.round(w * 0.04);
  let best = { s: 1, dx: 0, dy: 0, c: cost(1, 0, 0) };
  for (let s = 0.94; s <= 1.0601; s += 0.02) {
    for (let dy = -maxShift; dy <= maxShift; dy += 2) {
      for (let dx = -maxShift; dx <= maxShift; dx += 2) {
        const c = cost(s, dx, dy);
        if (c < best.c) best = { s, dx, dy, c };
      }
    }
  }
  const coarse = best;
  for (let s = coarse.s - 0.015; s <= coarse.s + 0.0151; s += 0.005) {
    for (let dy = coarse.dy - 1.5; dy <= coarse.dy + 1.5; dy += 0.5) {
      for (let dx = coarse.dx - 1.5; dx <= coarse.dx + 1.5; dx += 0.5) {
        const c = cost(s, dx, dy);
        if (c < best.c) best = { s, dx, dy, c };
      }
    }
  }
  return { scale: best.s, dx: best.dx / k, dy: best.dy / k };
}

// Resamples the model output so that output(p) = generated(c + scale·(p − c) + d) at the cutout size.
async function alignGenerated(generated, { width, height }, { scale, dx, dy }) {
  const fitted = await sharp(generated).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
  if (scale === 1 && dx === 0 && dy === 0) return fitted;
  const sw = Math.round(width / scale);
  const sh = Math.round(height / scale);
  const scaled = await sharp(fitted).resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  const left = Math.round(((1 - scale) * (width / 2) + dx) / scale);
  const top = Math.round(((1 - scale) * (height / 2) + dy) / scale);
  const pad = Math.max(Math.abs(left), Math.abs(top)) + Math.max(Math.abs(sw - width), Math.abs(sh - height)) + 2;
  // sharp applies extract before extend, so the padded image must be materialized first.
  const padded = await sharp(scaled).extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' }).png().toBuffer();
  return sharp(padded).extract({ left: left + pad, top: top + pad, width, height }).png().toBuffer();
}

// Uses the model output only as background, floor and shadows; the products are the cutout's own pixels.
async function compositeCutout({ generated, cutout }) {
  const { width, height } = await sharp(cutout).metadata();
  const alignment = await estimateAlignment(generated, cutout);
  const background = await alignGenerated(generated, { width, height }, alignment);
  return sharp(background).composite([{ input: await sharp(cutout).ensureAlpha().png().toBuffer() }]).png().toBuffer();
}

// Bounding box of the visible (non-transparent) pixels of a cutout, or null when it is empty.
export async function alphaBounds(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const MAX_LAYOUT_EDGE = 8192;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const ceilEven = (n) => Math.max(2, Math.ceil(n / 2) * 2);

// Re-frames a cutout: the products keep their native pixel size (no resampling) and the frame is built around them.
// `fill` is the share of the frame the product group spans on its limiting side; center is its position in the frame.
export async function layoutCutout(buffer, { aspectRatio, fill = 0.8, centerX = 0.5, centerY = 0.5 }) {
  const box = await alphaBounds(buffer);
  if (!box) throw new Error('Ảnh tách nền không có sản phẩm nào');
  const ratio = parseRatio(aspectRatio);
  if (!ratio) throw new Error(`Tỉ lệ khung hình không hợp lệ: ${aspectRatio}`);
  const f = clamp(Number(fill) || 0.8, 0.2, 1);
  const frameWidth = Math.max(box.width / f, (box.height / f) * ratio);
  // Only an extreme margin can exceed the cap; then the products are shrunk, never enlarged.
  const scale = Math.min(1, MAX_LAYOUT_EDGE / Math.max(frameWidth, frameWidth / ratio));
  const productWidth = Math.round(box.width * scale);
  const productHeight = Math.round(box.height * scale);
  const width = Math.max(ceilEven(frameWidth * scale), productWidth);
  const height = Math.max(ceilEven(width / ratio), productHeight);

  let product = sharp(buffer).ensureAlpha().extract(box);
  if (scale < 1) product = product.resize(productWidth, productHeight, { kernel: 'lanczos3' });
  const left = Math.round(clamp(Number(centerX) * width - productWidth / 2, 0, width - productWidth));
  const top = Math.round(clamp(Number(centerY) * height - productHeight / 2, 0, height - productHeight));
  const data = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await product.png().toBuffer(), left, top }])
    .png()
    .toBuffer();
  return { buffer: data, width, height };
}

// Normalizes an uploaded file: applies EXIF rotation and keeps original bytes whenever possible.
export async function normalizeUpload(buffer) {
  const meta = await sharp(buffer).metadata();
  const needsRotation = meta.orientation && meta.orientation !== 1;
  const keepBytes = !needsRotation && ['jpeg', 'png', 'webp'].includes(meta.format);
  if (keepBytes) return { buffer, ext: meta.format === 'jpeg' ? 'jpg' : meta.format, width: meta.width, height: meta.height };
  const { data, info } = await sharp(buffer).rotate().png().toBuffer({ resolveWithObject: true });
  return { buffer: data, ext: 'png', width: info.width, height: info.height };
}

function encode(pipeline, format) {
  if (format === 'jpeg') return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true });
  if (format === 'webp') return pipeline.webp({ quality: 95, smartSubsample: true });
  return pipeline.png({ compressionLevel: 6 });
}

// Pastes the generated pixels only inside the mask, so everything else stays the exact original pixels.
async function compositeWithMask({ generated, source, mask, maskMode }) {
  const { width, height } = await sharp(source).metadata();
  const feather = Math.max(1.5, Math.max(width, height) / 400);
  let alphaPipeline = sharp(mask).flatten({ background: '#000000' }).extractChannel(0).resize(width, height, { fit: 'fill' });
  if (maskMode === 'keep') alphaPipeline = alphaPipeline.negate({ alpha: false });
  const alpha = await alphaPipeline.blur(feather).raw().toBuffer();

  // sharp applies joinChannel before resize, so the resize must be materialized first.
  const resized = await sharp(generated).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
  const genWithAlpha = await sharp(resized)
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return sharp(source).composite([{ input: genWithAlpha }]).png().toBuffer();
}

export async function finalizeImage({ generated, source, mask, maskMode, cutout, target, format }) {
  let base = generated;
  if (cutout) base = await compositeCutout({ generated, cutout: source });
  else if (mask) base = await compositeWithMask({ generated, source, mask, maskMode });
  const meta = await sharp(base).metadata();
  const sameSize = meta.width === target.width && meta.height === target.height;
  let pipeline = sharp(base);
  if (!sameSize) {
    pipeline = pipeline.resize(target.width, target.height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' });
    if (target.width / meta.width > 1.05) pipeline = pipeline.sharpen({ sigma: 0.6 });
  }
  const { data, info } = await encode(pipeline, format).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}
