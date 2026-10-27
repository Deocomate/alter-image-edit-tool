import express from 'express';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { listEditModels, generateImage } from './openrouter-client.js';
import {
  closestAspectRatio,
  computeTargetSize,
  finalizeImage,
  flattenCutout,
  isCutout,
  layoutCutout,
  normalizeUpload,
  pickResolution,
  prepareInputImage,
} from './image-pipeline.js';
import {
  HttpError,
  IMAGES_DIR,
  createSession,
  deleteSession,
  getSession,
  imageUrl,
  initStore,
  listSessions,
  readImage,
  saveImage,
  saveSession,
} from './session-store.js';

const PORT = Number(process.env.PORT) || 3210;
const OUTPUT_FORMATS = { png: 'png', jpeg: 'jpg', webp: 'webp' };

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Thiếu OPENROUTER_API_KEY trong file .env');
  process.exit(1);
}

// For a transparent product cutout the model only builds the scene; the products are pasted back afterwards.
function buildCutoutPrompt(userPrompt, imageCount) {
  const lines = [
    'You are a professional product photographer and retoucher. The FIRST input image shows product cutouts on a plain grey backdrop.',
    `Requested scene: "${userPrompt}"`,
    'Strict rules:',
    '- Replace ONLY the plain grey backdrop with a photorealistic scene: a surface the products stand on and a background with natural depth (soft depth of field, realistic perspective and lighting).',
    '- Every product must stay at exactly the same position, size, and angle in the frame. Do not move, resize, re-arrange, crop, add, or remove any product.',
    '- Do not redraw or restyle the products. Keep their shapes, patterns, colors, and outlines exactly as they are.',
    '- Ground each product on the surface with soft, realistic contact shadows and cast shadows that match the scene lighting.',
    '- Keep the same framing and camera angle so the result aligns pixel-for-pixel with the first image.',
    '- Output a sharp, high-resolution, photorealistic result with no blur, noise, or compression artifacts.',
  ];
  if (imageCount > 1) lines.push('- The other input images are references for the scene (for example a background or style); use them only as the request asks.');
  return lines.join('\n');
}

function buildPrompt(userPrompt, imageCount, hasMask) {
  const lines = [
    'You are a precise professional photo retoucher. Edit the FIRST input image.',
    `Requested edit: "${userPrompt}"`,
    'Strict rules:',
    '- Change ONLY what the requested edit asks for.',
    '- Keep everything else identical to the original: composition, framing, camera angle, perspective, subject pose, faces and identity, hands, hair, clothing, textures, text and logos, colors and lighting (unless the edit requires changing them).',
    '- Do not crop, zoom, shift, re-frame, stylize, or add/remove anything that was not requested.',
    '- Output a sharp, high-resolution, photorealistic result with fine detail, no blur, no noise, no compression artifacts.',
  ];
  if (imageCount > 1) lines.push('- The other input images are references for the edit (for example a new background, object, or style); use them only as the edit asks.');
  if (hasMask) lines.push('- Keep the exact same framing and scale as the first image so the result aligns pixel-for-pixel with it.');
  return lines.join('\n');
}

const describeImage = async (id) => {
  const { width, height } = await sharp(await readImage(id)).metadata();
  return { id, url: imageUrl(id), width, height };
};

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.resolve('public')));
app.use('/images', express.static(IMAGES_DIR, { maxAge: '1y', immutable: true }));

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

app.get('/api/models', route(async (_req, res) => res.json({ models: await listEditModels() })));

app.post('/api/images', route(async (req, res) => {
  const match = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(req.body?.dataUrl || '');
  if (!match) throw new HttpError(400, 'Dữ liệu ảnh không hợp lệ');
  const upload = await normalizeUpload(Buffer.from(match[1], 'base64')).catch(() => {
    throw new HttpError(400, 'Không đọc được ảnh. Hãy dùng JPG, PNG hoặc WEBP.');
  });
  const id = await saveImage(upload.buffer, upload.ext);
  res.json({ id, url: imageUrl(id), width: upload.width, height: upload.height, cutout: await isCutout(upload.buffer) });
}));

// Re-frames a product cutout (always from the original upload, so layouts never compound).
app.post('/api/images/:id/layout', route(async (req, res) => {
  const source = await readImage(req.params.id);
  if (!(await isCutout(source))) throw new HttpError(400, 'Chỉ căn bố cục được cho ảnh PNG tách nền');
  const { aspectRatio, fill, centerX, centerY } = req.body || {};
  const laid = await layoutCutout(source, { aspectRatio, fill, centerX, centerY }).catch((error) => {
    throw new HttpError(400, error.message);
  });
  const id = await saveImage(laid.buffer, 'png');
  res.json({ id, url: imageUrl(id), width: laid.width, height: laid.height, cutout: true });
}));

app.get('/api/sessions', route(async (_req, res) => res.json({ sessions: await listSessions() })));
app.post('/api/sessions', route(async (_req, res) => res.json(await createSession())));
app.get('/api/sessions/:id', route(async (req, res) => res.json(await getSession(req.params.id))));
app.delete('/api/sessions/:id', route(async (req, res) => {
  await deleteSession(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/sessions/:id/edit', route(async (req, res) => {
  const session = await getSession(req.params.id);
  const { prompt, model: modelId, imageIds = [], aspectRatio = 'original', quality = '2k', outputFormat = 'png', mask, maskMode = 'edit' } = req.body || {};

  if (!prompt?.trim()) throw new HttpError(400, 'Hãy nhập yêu cầu chỉnh sửa');
  if (!imageIds.length) throw new HttpError(400, 'Hãy đính kèm ít nhất một ảnh cần chỉnh sửa');
  if (!OUTPUT_FORMATS[outputFormat]) throw new HttpError(400, 'Định dạng xuất không hợp lệ');
  const model = (await listEditModels()).find((m) => m.id === modelId);
  if (!model) throw new HttpError(400, 'Model không hỗ trợ chỉnh sửa ảnh');
  if (imageIds.length > model.maxReferences) throw new HttpError(400, `Model này nhận tối đa ${model.maxReferences} ảnh`);

  const buffers = await Promise.all(imageIds.map(readImage));
  const source = buffers[0];
  const { width: srcWidth, height: srcHeight } = await sharp(source).metadata();

  // A transparent cutout keeps its own product pixels, so the brush mask does not apply to it.
  const cutout = await isCutout(source);
  let maskBuffer = null;
  let maskId = null;
  if (mask && !cutout) {
    const match = /^data:image\/png;base64,(.+)$/s.exec(mask);
    if (!match) throw new HttpError(400, 'Mask không hợp lệ');
    maskBuffer = Buffer.from(match[1], 'base64');
    maskId = await saveImage(maskBuffer, 'png');
  }

  // Masked edits and cutouts are pasted back onto the original, so they must keep the original frame.
  const pasteBack = Boolean(maskBuffer) || cutout;
  const effectiveAspect = pasteBack ? 'original' : aspectRatio;
  const target = computeTargetSize({ srcWidth, srcHeight, aspectRatio: effectiveAspect, quality });

  const inputs = cutout ? [await flattenCutout(source), ...buffers.slice(1)] : buffers;
  const request = {
    model: model.id,
    prompt: cutout ? buildCutoutPrompt(prompt.trim(), imageIds.length) : buildPrompt(prompt.trim(), imageIds.length, Boolean(maskBuffer)),
    n: 1,
    input_references: (await Promise.all(inputs.map(prepareInputImage))).map((url) => ({ type: 'image_url', image_url: { url } })),
  };
  const requestRatio = pasteBack ? srcWidth / srcHeight : target.width / target.height;
  if (model.aspectRatios.length) request.aspect_ratio = closestAspectRatio(model.aspectRatios, requestRatio);
  if (model.resolutions.length) request.resolution = pickResolution(model.resolutions, Math.max(target.width, target.height));
  if (model.qualities.includes('high')) request.quality = 'high';
  if (model.outputFormats.includes('png')) request.output_format = 'png';

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    text: prompt.trim(),
    images: await Promise.all(imageIds.map(describeImage)),
    maskId,
    maskMode: maskBuffer ? maskMode : null,
    cutout,
    params: { model: model.id, aspectRatio: effectiveAspect, quality, outputFormat },
    createdAt: new Date().toISOString(),
  };
  session.messages.push(userMessage);
  if (session.messages.length === 1) session.title = prompt.trim().slice(0, 60);
  await saveSession(session);

  const startedAt = Date.now();
  let assistantMessage;
  try {
    const generated = await generateImage(request);
    const modelOutput = await sharp(generated.buffer).metadata();
    const result = await finalizeImage({ generated: generated.buffer, source, mask: maskBuffer, maskMode, cutout, target, format: outputFormat });
    const id = await saveImage(result.buffer, OUTPUT_FORMATS[outputFormat]);
    assistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      images: [{ id, url: imageUrl(id), width: result.width, height: result.height }],
      sourceImageId: imageIds[0],
      info: {
        model: model.id,
        requestedResolution: request.resolution ?? null,
        requestedAspectRatio: request.aspect_ratio ?? null,
        modelOutputWidth: modelOutput.width,
        modelOutputHeight: modelOutput.height,
        masked: Boolean(maskBuffer),
        cutout,
        cost: generated.cost,
        durationMs: Date.now() - startedAt,
      },
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Edit failed:', error.message);
    assistantMessage = { id: randomUUID(), role: 'assistant', error: error.message, createdAt: new Date().toISOString() };
  }
  session.messages.push(assistantMessage);
  await saveSession(session);
  res.json(session);
}));

app.use((error, _req, res, _next) => {
  const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
  if (status === 500) console.error(error);
  res.status(status).json({ error: error.message || 'Lỗi máy chủ' });
});

await initStore();
app.listen(PORT, () => console.log(`Image Edit AI Tool: http://localhost:${PORT}`));
