import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  closestAspectRatio,
  computeTargetSize,
  estimateAlignment,
  finalizeImage,
  flattenCutout,
  isCutout,
  layoutCutout,
  padToRatio,
  pickResolution,
  placeOnScene,
  prepareInputImage,
} from '../server/image-pipeline.js';

const W = 1200;
const H = 800;

async function gradientSource() {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      raw[i] = x % 256;
      raw[i + 1] = y % 256;
      raw[i + 2] = (x + y) % 256;
    }
  }
  return { raw, png: await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() };
}

const solid = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

async function leftHalfMask() {
  return sharp(await solid(600, 400, '#000000'))
    .composite([{ input: await solid(300, 400, '#ffffff'), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

test('computeTargetSize maps quality tiers to the long edge of the chosen ratio', () => {
  assert.deepEqual(computeTargetSize({ srcWidth: 3000, srcHeight: 2000, aspectRatio: '16:9', quality: '4k' }), { width: 3840, height: 2160 });
  assert.deepEqual(computeTargetSize({ srcWidth: 3000, srcHeight: 2000, aspectRatio: '9:16', quality: 'fhd' }), { width: 1080, height: 1920 });
  assert.deepEqual(computeTargetSize({ srcWidth: 3000, srcHeight: 2000, aspectRatio: 'original', quality: 'hd' }), { width: 1280, height: 854 });
  assert.deepEqual(computeTargetSize({ srcWidth: 3001, srcHeight: 2001, aspectRatio: 'original', quality: 'original' }), { width: 3001, height: 2001 });
});

test('model parameters pick the closest ratio and the smallest covering resolution', () => {
  assert.equal(closestAspectRatio(['1:1', '4:3', '16:9'], 3 / 2), '4:3');
  assert.equal(pickResolution(['1K', '2K', '4K'], 2560), '4K');
  assert.equal(pickResolution(['1K', '2K', '4K'], 1280), '2K');
  assert.equal(pickResolution(['1K', '2K'], 3840), '2K');
});

test('masked edit keeps every pixel outside the mask identical to the original', async () => {
  const { raw, png } = await gradientSource();
  const out = await finalizeImage({
    generated: await solid(1024, 683, '#ff0000'),
    source: png,
    mask: await leftHalfMask(),
    maskMode: 'edit',
    target: { width: W, height: H },
    format: 'png',
  });
  const px = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 640; x < W; x++) {
      const i = (y * W + x) * 3;
      if (px[i] !== raw[i] || px[i + 1] !== raw[i + 1] || px[i + 2] !== raw[i + 2]) changed++;
    }
  }
  assert.equal(changed, 0);
  const inside = (400 * W + 100) * 3;
  assert.deepEqual([px[inside], px[inside + 1], px[inside + 2]], [255, 0, 0]);
});

test('keep mode inverts the mask and output is resized to the requested size', async () => {
  const { png } = await gradientSource();
  const out = await finalizeImage({
    generated: await solid(1024, 683, '#ff0000'),
    source: png,
    mask: await leftHalfMask(),
    maskMode: 'keep',
    target: { width: 2400, height: 1600 },
    format: 'jpeg',
  });
  assert.deepEqual([out.width, out.height], [2400, 1600]);
  const px = await sharp(out.buffer).raw().toBuffer();
  const right = (800 * 2400 + 2200) * 3;
  assert.ok(px[right] > 240 && px[right + 1] < 15, 'right side should be the generated red');
});

test('unmasked result is cropped and upscaled to the exact target', async () => {
  const out = await finalizeImage({ generated: await solid(1024, 683, '#00ff00'), target: { width: 3840, height: 2160 }, format: 'webp' });
  assert.deepEqual([out.width, out.height], [3840, 2160]);
});

test('small originals are sent to the model byte-for-byte', async () => {
  const { png } = await gradientSource();
  const url = await prepareInputImage(png);
  assert.equal(url, `data:image/png;base64,${png.toString('base64')}`);
});

// Two textured "products" on a transparent canvas, like a product PNG with the background removed.
async function productCutout() {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = (x > 200 && x < 500 && y > 250 && y < 700) || (Math.hypot(x - 850, y - 500) < 170);
      if (!inside) continue;
      const i = (y * W + x) * 4;
      raw[i] = 30 + ((x * 7) % 200);
      raw[i + 1] = 40 + ((y * 5) % 180);
      raw[i + 2] = 220 - ((x + y) % 120);
      raw[i + 3] = 255;
    }
  }
  return { raw, png: await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() };
}

// What a model returns: the products redrawn on a new background, shifted by a few pixels.
async function shiftedScene(cutout, dx, dy) {
  const scene = await sharp(cutout).flatten({ background: '#5a3a22' }).png().toBuffer();
  const padded = await sharp(scene)
    .extend({ left: Math.max(0, dx), top: Math.max(0, dy), right: Math.max(0, -dx), bottom: Math.max(0, -dy), background: '#5a3a22' })
    .png()
    .toBuffer();
  return sharp(padded).extract({ left: Math.max(0, -dx), top: Math.max(0, -dy), width: W, height: H }).png().toBuffer();
}

test('cutouts are detected only when the alpha channel has transparent pixels', async () => {
  const { png } = await productCutout();
  assert.equal(await isCutout(png), true);
  assert.equal(await isCutout((await gradientSource()).png), false);
  assert.equal(await isCutout(await sharp(await solid(64, 64, '#ffffff')).ensureAlpha().png().toBuffer()), false);
  const flat = await sharp(await flattenCutout(png)).metadata();
  assert.equal(flat.hasAlpha, false);
});

test('alignment recovers a small drift of the redrawn products', async () => {
  const { png } = await productCutout();
  const { scale, dx, dy } = await estimateAlignment(await shiftedScene(png, 18, -12), png);
  assert.ok(Math.abs(scale - 1) < 0.011, `scale ${scale}`);
  assert.ok(Math.abs(dx - 18) <= 3, `dx ${dx}`);
  assert.ok(Math.abs(dy + 12) <= 3, `dy ${dy}`);
});

test('cutout edit pastes every product pixel unchanged where the model drew the products', async () => {
  const { raw, png } = await productCutout();
  const generated = await sharp(await shiftedScene(png, 10, 6)).resize(768, 512).png().toBuffer();
  const out = await finalizeImage({ generated, source: png, cutout: true, target: { width: W, height: H }, format: 'png' });
  assert.deepEqual([out.width, out.height], [W, H]);
  const { scale, dx, dy } = out.alignment;
  assert.equal(scale, 1);
  const [sx, sy] = [Math.round(dx), Math.round(dy)];
  assert.ok(Math.abs(sx - 10) <= 2 && Math.abs(sy - 6) <= 2, `shift ${sx},${sy}`);
  const px = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const o = ((y + sy) * W + x + sx) * 3;
      if (raw[p * 4 + 3] !== 255) continue;
      if (px[o] !== raw[p * 4] || px[o + 1] !== raw[p * 4 + 1] || px[o + 2] !== raw[p * 4 + 2]) changed++;
    }
  }
  assert.equal(changed, 0);
  const corner = (20 * W + 20) * 3;
  assert.deepEqual([px[corner], px[corner + 1], px[corner + 2]], [0x5a, 0x3a, 0x22]);
});

// Products with an irregular, non-repeating surface, like real photographed items.
async function noisyCutout(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  const noise = (x, y) => {
    const n = Math.sin((x >> 3) * 12.9898 + (y >> 3) * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = (x > 250 && x < 520 && y > 300 && y < 720) || Math.hypot(x - 780, y - 560) < 150;
      if (!inside) continue;
      const i = (y * width + x) * 4;
      raw[i] = 40 + noise(x, y) * 200;
      raw[i + 1] = 30 + noise(x + 999, y) * 180;
      raw[i + 2] = 20 + noise(x, y + 999) * 120;
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// What a model returns when it re-composes the scene: the products redrawn smaller or larger and moved.
async function rescaledScene(cutout, width, height, scale, dx, dy) {
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const pad = 400;
  const products = await sharp(cutout).resize(sw, sh).modulate({ brightness: 1.1 }).png().toBuffer();
  const scene = await sharp({ create: { width: width + 2 * pad, height: height + 2 * pad, channels: 3, background: '#5a3a22' } })
    .composite([{ input: products, left: pad + Math.round((width - sw) / 2) + dx, top: pad + Math.round((height - sh) / 2) + dy }])
    .png()
    .toBuffer();
  return sharp(scene).extract({ left: pad, top: pad, width, height }).png().toBuffer();
}

test('alignment finds products the model shrank or enlarged well beyond a small drift', async () => {
  const cutout = await noisyCutout(1000, 1000);
  for (const [scale, dx, dy] of [[0.78, -25, 60], [1.18, 20, -30]]) {
    const generated = await sharp(await rescaledScene(cutout, 1000, 1000, scale, dx, dy)).resize(1024, 1024).png().toBuffer();
    const found = await estimateAlignment(generated, cutout);
    assert.ok(Math.abs(found.scale - scale) <= 0.01, `scale ${found.scale} vs ${scale}`);
    assert.ok(Math.abs(found.dx - dx) <= 4 && Math.abs(found.dy - dy) <= 4, `shift ${found.dx},${found.dy} vs ${dx},${dy}`);
    assert.ok(found.score > 0.8, `score ${found.score}`);
  }
});

test('cutout edit follows the model when it shrinks the products, leaving no original-size ghost', async () => {
  const cutout = await noisyCutout(1000, 1000);
  const generated = await rescaledScene(cutout, 1000, 1000, 0.8, 0, 40);
  const out = await finalizeImage({ generated, source: cutout, cutout: true, target: { width: 1000, height: 1000 }, format: 'png' });
  const px = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  // The top-left corner of the large product at its original size is now open background.
  const o = (305 * 1000 + 255) * 3;
  assert.deepEqual([px[o], px[o + 1], px[o + 2]], [0x5a, 0x3a, 0x22]);
});

test('padding a cutout to a model ratio keeps the products and makes the ratio exact', async () => {
  const cutout = await noisyCutout(1000, 800);
  const padded = await padToRatio(cutout, 4 / 3);
  const meta = await sharp(padded).metadata();
  assert.deepEqual([meta.width, meta.height], [1067, 800]);
  assert.equal(await padToRatio(cutout, 5 / 4), cutout);
  const original = await sharp(cutout).raw().toBuffer();
  const out = await sharp(padded).raw().toBuffer();
  let changed = 0;
  for (let y = 0; y < 800; y++) {
    for (let x = 0; x < 1000; x++) {
      const i = (y * 1000 + x) * 4;
      const j = (y * 1067 + x + 33) * 4;
      if (original[i + 3] && original.readUInt32LE(i) !== out.readUInt32LE(j)) changed++;
    }
  }
  assert.equal(changed, 0);
});

test('layout centres the products in the chosen frame without resampling them', async () => {
  const { raw, png } = await productCutout();
  const out = await layoutCutout(png, { aspectRatio: '16:9', fill: 0.8, centerX: 0.5, centerY: 0.5 });
  // Products span x 201..1019 and y 251..699 (before trimming); the frame is sized so the width fills 80%.
  const bounds = { left: 201, top: 251, width: 1020 - 201, height: 700 - 251 };
  assert.equal(out.width, Math.ceil(bounds.width / 0.8 / 2) * 2);
  assert.ok(Math.abs(out.width / out.height - 16 / 9) < 0.01);

  const px = await sharp(out.buffer).raw().toBuffer();
  const left = Math.round(out.width / 2 - bounds.width / 2);
  const top = Math.round(out.height / 2 - bounds.height / 2);
  let changed = 0;
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const i = ((bounds.top + y) * W + bounds.left + x) * 4;
      const o = ((top + y) * out.width + left + x) * 4;
      if (raw[i + 3] && (px[o] !== raw[i] || px[o + 1] !== raw[i + 1] || px[o + 2] !== raw[i + 2] || px[o + 3] !== raw[i + 3])) changed++;
    }
  }
  assert.equal(changed, 0);
  assert.equal(await isCutout(out.buffer), true);
});

test('layout keeps the products inside the frame when the position is pushed past an edge', async () => {
  const { png } = await productCutout();
  const out = await layoutCutout(png, { aspectRatio: '1:1', fill: 0.6, centerX: 5, centerY: -5 });
  const { data, info } = await sharp(out.buffer).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const opaqueAt = (x, y) => data[y * info.width + x] > 0;
  let rightEdge = false;
  let topEdge = false;
  for (let i = 0; i < info.height; i++) rightEdge ||= opaqueAt(info.width - 1, i);
  for (let i = 0; i < info.width; i++) topEdge ||= opaqueAt(i, 0);
  assert.ok(rightEdge && topEdge, 'products should sit against the top-right corner');
});

test('products placed on an altar photo keep both photos and take only the shadows from the model', async () => {
  const S = 1000;
  // An irregular wood-like texture; a repeating pattern would make any shift look like a match.
  const grain = (x, y) => {
    const v = Math.sin((x >> 4) * 12.9898 + (y >> 4) * 78.233 + 7) * 43758.5453;
    return v - Math.floor(v);
  };
  const altarRaw = Buffer.alloc(S * S * 3);
  for (let p = 0; p < S * S; p++) {
    const [x, y] = [p % S, Math.floor(p / S)];
    altarRaw[p * 3] = 90 + grain(x, y) * 120;
    altarRaw[p * 3 + 1] = 60 + grain(x + 500, y) * 80;
    altarRaw[p * 3 + 2] = 30 + grain(x, y + 500) * 60;
  }
  const altar = await sharp(altarRaw, { raw: { width: S, height: S, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const placed = await placeOnScene(await noisyCutout(1000, 1000), altar, { fill: 0.5, centerX: 0.5, centerY: 0.6 });

  // The products span half the frame on their limiting side, centred at (0.5, 0.6), so the bottom edge is near y = 751.
  // (Measured from the layer below; the assertion only guards the placement formula.)
  const { data: alpha, info } = await sharp(placed.layer).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [S, S]);
  let bottom = 0;
  for (let p = 0; p < S * S; p++) if (alpha[p]) bottom = Math.max(bottom, Math.floor(p / S));
  assert.ok(Math.abs(bottom - 751) <= 5, `bottom ${bottom}`);

  // A model output: the same picture with a shadow under the products, a slightly darker overall tone, and a small shift.
  const shadow = await sharp({ create: { width: 500, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const withShadow = await sharp(placed.composite).composite([{ input: shadow, left: 250, top: bottom + 1 }]).linear(0.9, 0).png().toBuffer();
  // sharp applies extract before extend, so the shifted image must be materialized first.
  const shifted = await sharp(withShadow).extend({ left: 6, top: 4, extendWith: 'copy' }).png().toBuffer();
  const generated = await sharp(shifted).extract({ left: 0, top: 0, width: S, height: S }).resize(1024, 1024).png().toBuffer();

  const out = await finalizeImage({ generated, scene: placed, target: { width: S, height: S }, format: 'png' });
  const px = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  const scene = await sharp(placed.scene).removeAlpha().raw().toBuffer();
  const layer = await sharp(placed.layer).raw().toBuffer();

  const at = (buf, x, y, channels = 3) => [...buf.subarray((y * S + x) * channels, (y * S + x) * channels + 3)];
  assert.deepEqual(at(px, 20, 20), at(scene, 20, 20), 'the altar away from the products is untouched');
  let changed = 0;
  for (let p = 0; p < S * S; p++) {
    if (layer[p * 4 + 3] === 255 && (px[p * 3] !== layer[p * 4] || px[p * 3 + 1] !== layer[p * 4 + 1] || px[p * 3 + 2] !== layer[p * 4 + 2])) changed++;
  }
  assert.equal(changed, 0, 'product pixels are pasted unchanged');
  const lum = ([r, g, b]) => r + g + b;
  assert.ok(lum(at(px, 400, bottom + 12)) < lum(at(scene, 400, bottom + 12)) * 0.8, 'the model shadow under the products is kept');
});
