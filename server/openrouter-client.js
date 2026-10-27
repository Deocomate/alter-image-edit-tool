import { RESOLUTION_PX } from './image-pipeline.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

let modelsCache = null;

function headers() {
  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'Image Edit AI Tool',
  };
}

async function readJson(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON error bodies are reported as text below.
  }
  if (!response.ok) {
    const message = json?.error?.message || text.slice(0, 300) || response.statusText;
    const hint = response.status === 401
      ? ' — API key không dùng được để gọi model. Hãy tạo key thường (không phải management/provisioning key) tại https://openrouter.ai/settings/keys rồi cập nhật .env.'
      : '';
    throw new Error(`OpenRouter ${response.status}: ${message}${hint}`);
  }
  return json;
}

function toEditModel(model) {
  const params = model.supported_parameters || {};
  const resolutions = params.resolution?.values || [];
  const nativePx = resolutions.map((r) => RESOLUTION_PX[r]).filter(Boolean);
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    resolutions,
    maxNativeEdge: nativePx.length ? Math.max(...nativePx) : null,
    aspectRatios: (params.aspect_ratio?.values || []).filter((v) => v !== 'auto'),
    maxReferences: params.input_references.max,
    qualities: params.quality?.values || [],
    outputFormats: params.output_format?.values || [],
  };
}

// Image models that accept at least one input image, i.e. can edit.
export async function listEditModels() {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  const json = await readJson(await fetch(`${BASE_URL}/images/models`, { headers: headers() }));
  const models = (json.data || []).filter((m) => m.supported_parameters?.input_references?.max >= 1).map(toEditModel);
  modelsCache = { at: Date.now(), models };
  return models;
}

export async function generateImage(body) {
  const response = await fetch(`${BASE_URL}/images`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await readJson(response);
  const item = json?.data?.[0];
  let buffer;
  if (item?.b64_json) buffer = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) buffer = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error('Model không trả về ảnh. Hãy thử lại hoặc đổi model.');
  return { buffer, cost: json.usage?.cost ?? null };
}
