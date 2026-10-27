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
  pickResolution,
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

test('cutout edit keeps every product pixel identical and replaces only the background', async () => {
  const { raw, png } = await productCutout();
  const generated = await sharp(await shiftedScene(png, 10, 6)).resize(768, 512).png().toBuffer();
  const out = await finalizeImage({ generated, source: png, cutout: true, target: { width: W, height: H }, format: 'png' });
  assert.deepEqual([out.width, out.height], [W, H]);
  const px = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    if (raw[p * 4 + 3] !== 255) continue;
    if (px[p * 3] !== raw[p * 4] || px[p * 3 + 1] !== raw[p * 4 + 1] || px[p * 3 + 2] !== raw[p * 4 + 2]) changed++;
  }
  assert.equal(changed, 0);
  const corner = (20 * W + 20) * 3;
  assert.deepEqual([px[corner], px[corner + 1], px[corner + 2]], [0x5a, 0x3a, 0x22]);
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
