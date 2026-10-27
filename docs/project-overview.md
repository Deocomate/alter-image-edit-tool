# Image Edit AI Tool

A local web app for editing photos with OpenRouter image models while keeping full
resolution. ChatGPT re-compresses uploads and returns small images. This tool sends
the original file and exports the exact pixel size you choose.

## Setup

1. Node.js 20.6 or newer.
2. Put a regular OpenRouter API key in `.env`:
   `OPENROUTER_API_KEY=sk-or-v1-...`.
   Management or provisioning keys can't call models. They return `401 User not found`.
3. `npm install`, then `npm start`, then open http://localhost:3210 (set `PORT` to change the port).
4. `npm test` runs the image-pipeline tests.

## Deploy (Docker / Coolify)

`Dockerfile` builds a production image (Node 22, runs `node server/index.js` as the `node` user).
`docker-compose.yml` only `expose`s port 3210 on the internal Docker network and publishes no
host port, so it cannot clash with other projects on the server.

1. In Coolify, create a resource from the GitHub repo and pick the **Docker Compose** build pack.
2. Set the `OPENROUTER_API_KEY` environment variable.
3. Assign a domain to the `app` service with port 3210 (for example `https://edit.example.com:3210`,
   where `:3210` tells Coolify's proxy which container port to route to).
4. Sessions and images are kept in the `app-data` volume (`/app/data`), so they survive redeploys.

The app has no login. Anyone with the URL can spend the OpenRouter credit, so protect the domain
(for example with Coolify's basic-auth middleware) or keep it private.

## How quality is preserved

| Step | Behavior | Code |
|------|----------|------|
| Upload | Original bytes are stored as-is. Only EXIF-rotated or unusual formats are re-encoded, losslessly to PNG. | `normalizeUpload` in `server/image-pipeline.js` |
| Send to model | The original is sent untouched if it is ≤ 7 MB and ≤ 4096 px. Otherwise it is downsized once with Lanczos. | `prepareInputImage` |
| Model request | The ratio menu lists only ratios the selected model supports. Uses the closest supported `aspect_ratio` and the smallest native `resolution` that covers the target (up to 4K). Asks for `quality: high` and PNG output when the model supports them. | `POST /api/sessions/:id/edit` in `server/index.js` |
| Output | Center-cropped and resized with Lanczos to the exact target size, with light sharpening when upscaling. Exported as PNG, JPG q95 4:4:4, or WEBP q95. | `finalizeImage` |
| Transparent PNG cutout | If the first image has transparent pixels (a product with the background removed), the model gets it on plain grey and only builds the surface, background depth, and shadows. If the frame ratio is not one the model produces, transparent margins widen it to the closest supported ratio first, so the model output scales onto it uniformly. The server then finds where the model redrew the products (scale 0.7–1.3, shift ±15%, coarse-to-fine correlation) and pastes the original product pixels there, on the model's own surface and shadows. A pure shift keeps every product pixel; a size change resamples them once with Lanczos. The match score and scale show in the result meta ("khớp 92%, sản phẩm ×0.85"). The brush is disabled. | `isCutout`, `padToRatio`, `estimateAlignment`, `compositeCutout` |
| Cutout layout | On upload, the main cutout is trimmed to its products and centred in a new frame: the chosen ratio, or the model-supported ratio closest to the upload, with products spanning 80% of the limiting side. Picking a ratio in the ratio menu re-frames the cutout; the layout editor (frame-icon button on the attachment) also changes size and position. Both list only ratios the selected model supports. Products keep their native pixels; only the frame grows or shrinks, and re-layouts always start from the original upload. | `layoutCutout`, `POST /api/images/:id/layout`, `public/layout-editor.js` |
| Brush mask | Generated pixels are pasted only inside the painted area, with a feathered edge. Every other pixel is the untouched original, and the frame stays the original aspect ratio. | `compositeWithMask` |

Quality tiers set the long edge: HD 1280, Full HD 1920, 2K 2560, 4K 3840. "Gốc"
keeps the source size. If the target is larger than what the model can produce natively,
the extra size comes from interpolation and adds no new detail. The UI marks this as
"Phóng to" (upscaled). Pick a 4K-native model to avoid it.

## Structure

- `server/index.js`: Express routes and the edit flow.
- `server/openrouter-client.js`: model list (`GET /api/v1/images/models`, cached for 10 min) and generation (`POST /api/v1/images`).
- `server/image-pipeline.js`: sizing, input preparation, compositing, and encoding (sharp).
- `server/session-store.js`: sessions saved as JSON in `data/sessions/`, images in `data/images/`.
- `public/`: the ChatGPT-style UI in vanilla JS (`app.js`), the brush mask editor (`mask-editor.js`), and the cutout layout editor (`layout-editor.js`). Altar scene presets for cutouts are in `SCENE_PRESETS` in `app.js`.
