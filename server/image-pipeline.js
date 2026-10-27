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
const COARSE_EDGE = 128;
// Search range for where the model redrew the products: scale in per-mille, shift as a share of the frame.
const SCALE_MIN = 700;
const SCALE_MAX = 1300;
const MAX_SHIFT = 0.15;
// Most sampled points per working size; the coarse level runs many more candidates, so it gets fewer.
const COARSE_POINTS = 4000;
const FINE_POINTS = 25000;

// Greyscale pixels at a small working size, used to compare the model output with the cutout.
async function smallGrey(input, width, height) {
  return sharp(input).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
}

// Scores a candidate mapping at one working size by the normalized cross-correlation between the cutout's
// opaque pixels and the model output, so products the model relit still match.
async function alignmentMatcher(generated, cutout, edge, maxPoints) {
  const meta = await sharp(cutout).metadata();
  const k = edge / Math.max(meta.width, meta.height);
  const w = Math.round(meta.width * k);
  const h = Math.round(meta.height * k);
  const ref = await smallGrey(await flattenCutout(cutout), w, h);
  const gen = await smallGrey(generated, w, h);
  const alpha = await sharp(cutout).ensureAlpha().extractChannel(3).resize(w, h, { fit: 'fill' }).raw().toBuffer();

  let opaque = 0;
  for (let p = 0; p < w * h; p++) if (alpha[p] > 230) opaque++;
  // An opaque reference (a whole scene photo) is sampled on a sparse grid to keep the search fast.
  const step = Math.max(1, Math.round(Math.sqrt(opaque / maxPoints)));
  const xs = [];
  const ys = [];
  const refs = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (alpha[y * w + x] <= 230) continue;
      xs.push(x);
      ys.push(y);
      refs.push(ref[y * w + x]);
    }
  }
  const n = xs.length;
  const mean = refs.reduce((a, b) => a + b, 0) / (n || 1);
  const centred = refs.map((r) => r - mean);
  const refVar = centred.reduce((a, r) => a + r * r, 0);
  const cx = w / 2;
  const cy = h / 2;
  // Bilinear sampling, so sub-pixel shifts change the score and the fine search can resolve them.
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = Math.min(Math.floor(x), w - 2);
    const y0 = Math.min(Math.floor(y), h - 2);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    return (gen[i] * (1 - fx) + gen[i + 1] * fx) * (1 - fy) + (gen[i + w] * (1 - fx) + gen[i + w + 1] * fx) * fy;
  };
  const score = (s, dx, dy) => {
    let sg = 0;
    let sgg = 0;
    let srg = 0;
    for (let i = 0; i < n; i++) {
      const g = sample(cx + s * (xs[i] - cx) + dx, cy + s * (ys[i] - cy) + dy);
      sg += g;
      sgg += g * g;
      srg += centred[i] * g;
    }
    const genVar = sgg - (sg * sg) / n;
    return genVar > 0 && refVar > 0 ? srg / Math.sqrt(refVar * genVar) : -1;
  };
  return { k, w, n, score };
}

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step + 1e-9) + 1 }, (_, i) => from + i * step);

// Finds where the model redrew the products: the scale and shift with generated(c + scale·(p − c) + d) ≈ cutout(p).
// Models often re-compose the scene (for example shrinking the products to fit a square altar), so the search is
// wide and runs coarse-to-fine. `score` is the correlation of the best match (1 = identical).
export async function estimateAlignment(generated, cutout) {
  const coarse = await alignmentMatcher(generated, cutout, COARSE_EDGE, COARSE_POINTS);
  const fine = await alignmentMatcher(generated, cutout, ALIGN_EDGE, FINE_POINTS);
  if (coarse.n < 50 || fine.n < 100) return { scale: 1, dx: 0, dy: 0, score: null };

  let best = { s: 1000, dx: 0, dy: 0, c: coarse.score(1, 0, 0) };
  const search = (matcher, scales, shiftsX, shiftsY) => {
    for (const s of scales) {
      for (const dy of shiftsY) {
        for (const dx of shiftsX) {
          const c = matcher.score(s / 1000, dx, dy);
          if (c > best.c) best = { s, dx, dy, c };
        }
      }
    }
  };
  const around = (centre, radius, step) => range(centre - radius, centre + radius, step);

  const maxShift = Math.round(coarse.w * MAX_SHIFT);
  search(coarse, range(SCALE_MIN, SCALE_MAX, 20), range(-maxShift, maxShift, 2), range(-maxShift, maxShift, 2));

  const up = fine.k / coarse.k;
  const start = { s: best.s, dx: Math.round(best.dx * up), dy: Math.round(best.dy * up) };
  best = { ...start, c: fine.score(start.s / 1000, start.dx, start.dy) };
  search(fine, around(start.s, 20, 5), around(start.dx, 6, 1), around(start.dy, 6, 1));
  const mid = best;
  search(fine, around(mid.s, 4, 2), around(mid.dx, 1, 0.5), around(mid.dy, 1, 0.5));
  const half = best;
  search(fine, [half.s], around(half.dx, 0.375, 0.125), around(half.dy, 0.375, 0.125));
  return { scale: best.s / 1000, dx: best.dx / fine.k, dy: best.dy / fine.k, score: best.c };
}

// Moves the cutout onto the products the model drew, so the pasted products sit on the model's own surface and
// shadows. Products are resampled only when the model changed their size; a pure shift keeps every pixel.
async function placeCutout(cutout, { width, height }, { scale, dx, dy }) {
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const left = Math.round(((1 - scale) * width) / 2 + dx);
  const top = Math.round(((1 - scale) * height) / 2 + dy);
  let layer = sharp(cutout).ensureAlpha();
  if (sw !== width || sh !== height) layer = sharp(await layer.resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer());
  const pad = Math.max(Math.abs(left), Math.abs(top)) + Math.max(Math.abs(sw - width), Math.abs(sh - height)) + 2;
  // sharp applies extract before extend, so the padded layer must be materialized first.
  const padded = await layer
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(padded).extract({ left: pad - left, top: pad - top, width, height }).png().toBuffer();
}

// Uses the model output as the whole scene (surface, background, shadows) and pastes the cutout's own product
// pixels where the model placed the products.
async function compositeCutout({ generated, cutout }) {
  const { width, height } = await sharp(cutout).metadata();
  const alignment = await estimateAlignment(generated, cutout);
  const background = await sharp(generated).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
  const products = await placeCutout(cutout, { width, height }, alignment);
  return { buffer: await sharp(background).composite([{ input: products }]).png().toBuffer(), alignment };
}

// Resamples the model output so that output(p) = generated(c + scale·(p − c) + d) at the reference size.
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

// Puts the product group on an existing scene photo (for example an empty altar). The group spans `fill` of the
// scene's limiting side with its centre at (centerX, centerY). Returns the opaque scene, the product layer at scene
// size, and the flat preview the model edits.
export async function placeOnScene(cutout, sceneBuffer, { fill = 0.6, centerX = 0.5, centerY = 0.6 } = {}) {
  const box = await alphaBounds(cutout);
  if (!box) throw new Error('Ảnh tách nền không có sản phẩm nào');
  const scene = await sharp(sceneBuffer).removeAlpha().png().toBuffer();
  const { width, height } = await sharp(scene).metadata();
  const f = clamp(Number(fill) || 0.6, 0.05, 1);
  const k = Math.min((f * width) / box.width, (f * height) / box.height);
  const pw = Math.max(1, Math.round(box.width * k));
  const ph = Math.max(1, Math.round(box.height * k));
  const left = Math.round(clamp(Number(centerX) * width - pw / 2, 0, width - pw));
  const top = Math.round(clamp(Number(centerY) * height - ph / 2, 0, height - ph));
  let product = sharp(cutout).ensureAlpha().extract(box);
  if (pw !== box.width || ph !== box.height) product = product.resize(pw, ph, { fit: 'fill', kernel: 'lanczos3' });
  const layer = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await product.png().toBuffer(), left, top }])
    .png()
    .toBuffer();
  const composite = await sharp(scene).composite([{ input: layer }]).png().toBuffer();
  return { scene, layer, composite };
}

const ZONE_EDGE = 512;
// How far around the products the model may change the scene (contact shadows, reflections), as a share of the frame.
const SHADOW_REACH = 0.05;

// Feathered mask of where the model output is used: the products dilated by SHADOW_REACH. Computed small and scaled up.
async function shadowZone(layer, width, height) {
  const k = ZONE_EDGE / Math.max(width, height);
  const sw = Math.max(1, Math.round(width * k));
  const sh = Math.max(1, Math.round(height * k));
  const sigma = (ZONE_EDGE * SHADOW_REACH) / 2;
  const raw = { raw: { width: sw, height: sh, channels: 1 } };
  // sharp runs linear before blur within one pipeline, and a single-channel raw input comes back as three channels,
  // so each step is materialized and channel 0 is taken explicitly.
  const blurred = await sharp(layer).ensureAlpha().extractChannel(3).resize(sw, sh, { fit: 'fill' }).blur(sigma).extractChannel(0).raw().toBuffer();
  const dilated = await sharp(blurred, raw).linear(6, 0).extractChannel(0).raw().toBuffer();
  const feathered = await sharp(dilated, raw).blur(sigma / 2).extractChannel(0).raw().toBuffer();
  return sharp(feathered, { raw: { width: sw, height: sh, channels: 1 } }).resize(width, height, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
}

// Scales each colour channel of the model output so that, away from the products, it matches the original scene.
// Models often shift the overall tone slightly, which would otherwise show as a halo around the shadow zone.
async function matchColours(aligned, scene, zone, width, height) {
  const k = 256 / Math.max(width, height);
  const sw = Math.max(1, Math.round(width * k));
  const sh = Math.max(1, Math.round(height * k));
  const a = await sharp(aligned).resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const s = await sharp(scene).resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const z = await sharp(zone, { raw: { width, height, channels: 1 } }).resize(sw, sh, { fit: 'fill' }).raw().toBuffer();
  const sumA = [0, 0, 0];
  const sumS = [0, 0, 0];
  let count = 0;
  for (let p = 0; p < sw * sh; p++) {
    if (z[p] > 8) continue;
    count++;
    for (let c = 0; c < 3; c++) {
      sumA[c] += a[p * 3 + c];
      sumS[c] += s[p * 3 + c];
    }
  }
  if (count < 100) return aligned;
  const gains = sumA.map((v, c) => clamp(v > 0 ? sumS[c] / v : 1, 0.7, 1.4));
  return sharp(aligned).linear(gains, [0, 0, 0]).png().toBuffer();
}

// Keeps the scene photo untouched except around the products, where the model's shadows and reflections are blended
// in, then pastes the product layer exactly where it was placed.
async function compositeScene({ generated, scene, layer, composite }) {
  const { width, height } = await sharp(scene).metadata();
  const alignment = await estimateAlignment(generated, composite);
  const aligned = await alignGenerated(generated, { width, height }, alignment);
  const zone = await shadowZone(layer, width, height);
  const matched = await matchColours(aligned, scene, zone, width, height);
  // sharp applies joinChannel before other operations, so the colour-matched image must be materialized first.
  const rgb = await sharp(matched).removeAlpha().png().toBuffer();
  const zoned = await sharp(rgb).joinChannel(zone, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const buffer = await sharp(scene).composite([{ input: zoned }, { input: layer }]).png().toBuffer();
  return { buffer, alignment };
}

// Widens a cutout frame with transparent margins to exactly `ratio`, so the output of a model that only produces
// fixed ratios scales onto the frame uniformly instead of being stretched.
export async function padToRatio(buffer, ratio) {
  const { width, height } = await sharp(buffer).metadata();
  if (Math.abs(Math.log(width / height / ratio)) < 0.005) return buffer;
  const w = width / height < ratio ? Math.round(height * ratio) : width;
  const h = width / height < ratio ? height : Math.round(width / ratio);
  const left = Math.floor((w - width) / 2);
  const top = Math.floor((h - height) / 2);
  return sharp(buffer)
    .ensureAlpha()
    .extend({ left, right: w - width - left, top, bottom: h - height - top, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
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

export async function finalizeImage({ generated, source, mask, maskMode, cutout, scene, target, format }) {
  let base = generated;
  let alignment = null;
  if (scene) ({ buffer: base, alignment } = await compositeScene({ generated, ...scene }));
  else if (cutout) ({ buffer: base, alignment } = await compositeCutout({ generated, cutout: source }));
  else if (mask) base = await compositeWithMask({ generated, source, mask, maskMode });
  const meta = await sharp(base).metadata();
  const sameSize = meta.width === target.width && meta.height === target.height;
  let pipeline = sharp(base);
  if (!sameSize) {
    pipeline = pipeline.resize(target.width, target.height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' });
    if (target.width / meta.width > 1.05) pipeline = pipeline.sharpen({ sigma: 0.6 });
  }
  const { data, info } = await encode(pipeline, format).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, alignment };
}
