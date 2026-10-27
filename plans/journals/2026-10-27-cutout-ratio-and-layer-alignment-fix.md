---
title: Cutout ratio and layer alignment fix
date: 2026-10-27
summary: "Ratio menu ignored for cutouts, stretched model output, and too-narrow alignment caused misfit altar composites"
---

# Cutout ratio and layer alignment fix

## What happened
- Ratio dropdown was visually "locked" for PNG cutouts but still clickable; server forced `original`, so the chosen ratio was silently ignored.
- Default cutout frame used the raw upload ratio; model returned the closest supported ratio and `fit: 'fill'` stretched it non-uniformly onto the frame.
- `estimateAlignment` searched only scale ±6% / shift ±4%. Repro: model shrinking products to 0.75 was estimated as 0.93, leaving ghost products.

## Decision
- Ratio menu and layout editor list only model-supported ratios; picking a ratio re-frames the cutout. Server `padToRatio` pads the cutout transparently as a safety net.
- Coarse-to-fine NCC alignment, scale 0.7–1.3, shift ±15% (~0.7s; ±2px on the real sample).
- Products now follow the model's placement (cutout moved/resampled), background untouched — no more cropping/edge smearing.
- Result meta shows match score and product scale.

## Next steps
- Optional per-item alignment, best-of-N by match score, seed passthrough.
- Paid benchmark of Gemini 3 Pro / Seedream 4.5 / FLUX.2 by match score (needs user OK).
- Report: plans/reports/fix-261027-1131-cutout-ratio-alignment.md

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
