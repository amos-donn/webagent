# Roboflow inference vs. the current page-reading approach

**Question:** would Roboflow inference read websites better than what webagent does today?
**Date:** 31 October 2026
**Short answer:** no — not for this job. Roboflow is a computer-vision platform (label, train, serve detectors and VLMs). It has no web-UI understanding model, no published UI benchmark, and no way to output an actionable element ("element 47, role=button, name=Search"). Roboflow's own blog says Florence-2 — its main screenshot-reading model — is *"better suited to retrieval and indexing tasks than to precise UI navigation agents."* The DOM element map this extension already sends is exact ground truth that a pixel detector can only approximate.

That said, two narrow Roboflow uses are genuinely defensible: OCR for canvas/PDF/graphics-only content, and cheap detect→crop to cut vision tokens. Both are optional add-ons, not replacements.

*(A previous report in this folder covers "RoboHost", which turned out not to be an AI product at all. This report supersedes it for the product you meant.)*

---

## 1. What Roboflow actually is

Six distinct things share the name, and they are routinely conflated:

| Component | What it does |
|---|---|
| **Serverless Cloud API** (`serverless.roboflow.com`) | Hosted inference, billed per image. Same interface as self-hosted; only `api_url` changes. |
| **Dedicated Deployments** | Roboflow runs the Inference server privately for you, billed in GPU-hours (1 credit = 1 GPU hour). |
| **Inference / Inference Server** | Open-source (Apache-2.0 core) container or Python package that serves models and Workflows over HTTP. Runs on CPU, GPU, Jetson, Raspberry Pi. |
| **Workflows** | A DAG builder chaining blocks: detector → crop → OCR → VLM → tracker → sinks (webhook, Slack, MQTT…). |
| **Universe** | 50,000+ community datasets and thousands of pre-trained models callable by `model_id`. |
| **Fine-tuning** | On-platform labelling and training (1 credit = 30 min GPU), downloadable weights. |

So Roboflow gives you **perception primitives over images**, plus a way to chain them. It is not a page reader, a crawler, or a browsing agent.

## 2. The models relevant to "reading a page"

From Roboflow's own model catalogue:

| Category | Models | Output |
|---|---|---|
| Object detection | RF-DETR (N→2XL), YOLOv5/8/9/10/11/12, YOLO26, YOLO-NAS, Grounding DINO, OWLv2, Roboflow Instant | classes + boxes + confidences |
| Segmentation | RF-DETR Seg, YOLO*-Seg, YOLACT, SAM, SAM2, SAM3 Video | masks / polygons |
| OCR & documents | DocTR, EasyOCR, TrOCR, GLM-OCR, PP-OCRv6 | text (+ boxes in det+rec pipelines) |
| VLMs | Florence-2, PaliGemma, Qwen2.5-VL, Qwen3-VL, Qwen3.5, SmolVLM, Moondream2, Gemma 4 | free-form text, captions, sometimes boxes |

Nothing here is trained for web UI. The closest fit is Florence-2, whose task list includes `ocr`, `phrase-grounded-object-detection` and `detection-grounded-ocr` — and which **requires a GPU**.

Critical caveats from Roboflow's own documentation:

- **Florence-2 and UI navigation:** their website-screenshot blog states the model "makes mistakes related to the positioning of elements… better suited to retrieval and indexing tasks than to precise UI navigation agents."
- **SmolVLM2 grounding failure:** asked for the coordinates of a dog, it returned `[19.5, 1.5, 19.5, 1.5]` — an invalid box. Small VLMs cannot reliably emit coordinates, which is exactly what a clicking agent needs.
- **OWLv2** is box-prompted (you supply an example box), is not on the Serverless API, and measured **541 ms on an NVIDIA L4** for one image.
- **SAM/SAM2** need a point or box prompt — they refine a box, they cannot find "the Search button" by name.

## 3. Pricing and the cost trap

- **Self-hosted inference is free of credits on every plan** (since 18 Sept 2026); you pay for hardware. Note licensing: YOLO11/YOLO26 are AGPL-3.0 and RF-DETR XL/2XL use PML 1.0 — commercial self-hosting needs the Enterprise add-on. Apache-2.0 RF-DETR sizes are fine.
- **Serverless per-image credits per 1,000 images:** RF-DETR Nano 0.125, Small–Large 0.1875, XL 0.25, 2XL 0.3125; PP-OCR det+rec 0.375; DocTR/EasyOCR 0.375; Grounding DINO / OWLv2 / Roboflow Instant 0.75; SAM2 0.3125.
- **VLMs are billed by execution time, not per image:** 1 credit = 500 execution seconds (7.2 credits/hour). Core is $39/mo for 10 credits (~$3.90/credit).
- **The trap:** a 2-second hosted VLM call costs on the order of $0.05 per page view, versus fractions of a cent for Gemini 3.5 Flash-Lite through OpenRouter. Roboflow's own credits page even lists OpenRouter at "$2.00 usage per credit" — i.e. reselling the same models at a markup.
- At scale, RF-DETR Nano detection works out to roughly **$0.00002–$0.0001 per image** — genuinely cheap, but it only gives you boxes.

## 4. Benchmarks that exist — and the one that doesn't

- **Real detection benchmarks:** RF-DETR-N 48.4 AP50:95 @ 2.3 ms; RF-DETR-L 56.5 @ 6.8 ms; RF-DETR-2XL 60.1 @ 17.2 ms (T4, TensorRT FP16, batch 1), re-evaluated in-house with pycocotools on COCO val2017.
- **Document/OCR evidence is qualitative only:** a SmolVLM2 review read a page screenshot's text correctly apart from italics; a Florence-2 OCR test read a container ID but missed vertical text.
- **No published accuracy or latency benchmark for web-page or UI understanding exists.** Roboflow's "Vision Evals" leaderboard (which scores ~34–98 VLMs, including Gemini) is the most useful artifact, but it returned HTTP 429 when fetched, so its numbers cannot be quoted here.
- Universe hosts community UI datasets ("Website Screenshots", "Web-UI-objects") — snippet-level evidence only; those pages returned 403, and the Roboflow Public one is described as *synthetically generated* from top sites, not real-world UI.

## 5. Why it doesn't beat what we do now

1. **Perception is not policy.** A detector returns `{class: "button", box, confidence}`. It does not know which button starts a search, what to type, or in what order. The LLM makes the decision; Roboflow would only sharpen pixels→boxes.
2. **The DOM already wins at localisation.** Our element map enumerates every visible interactive control with its accessible name, exact role and centre coordinate — ground truth. A detector guesses at the same thing from pixels, with false positives on decorative boxes and misses on unlabelled icons.
3. **Generality needs training.** The only no-training routes are open-vocabulary detectors, which Roboflow's docs describe for common objects ("cats or cars") and which need visual example boxes — not "the Search button on an unseen SaaS dashboard". Real precision on arbitrary sites would need custom labelled data per design system.
4. **It adds a network hop and a GPU dependency** for information we already hold locally, and it cannot see the user's session at all — it only ever sees a screenshot we pass it.
5. **Cost and latency move the wrong way.** Hosted VLM time costs multiples of our current model call, and every extra round trip is felt directly by the user.

## 6. Where Roboflow could genuinely help (optional, later)

1. **Canvas / PDF / graphics-only content.** Google Docs, map canvases, chart widgets, PDF viewers render text into pixels where `innerText` is empty. PP-OCR (det+rec) at 0.375 credits/1k images (~$0.0001/image) or DocTR returns text plus boxes. This is the one clear gap in the current pipeline — though Gemini also reads text from images reasonably well, so it is partly covered already.
2. **Detect→crop→reason.** RF-DETR-Nano to find candidate regions, crop them, and send only crops to the model: fewer vision tokens, sharper small text, faster. Roboflow promotes this pattern explicitly. For a Chrome extension we could equally crop locally with no vendor.
3. **Coordinate snapping.** Use a detector or OCR boxes to snap a model's approximate click to a real element box — a guardrail against off-by-20-pixels clicks. Our element map already provides better snapping targets for free.

## 7. Recommendation

- **Do not adopt Roboflow as the page reader.** It solves a different problem (vision model serving), and its own docs disclaim precise UI navigation for the model people would reach for.
- **Keep the local pipeline** — readability-scored DOM text, structured table/list/aria hints, expanded element map with on-screen/off-screen split and `disabled`/`checked` state (all shipped in this change).
- **If a pixel-only gap shows up in practice** (canvas editors, PDF viewers, image-only dashboards), add a *local* canvas/OCR fallback first; only then consider a hosted OCR call. It should be a per-page fallback, never the main path.
- **What would change this:** a published UI-grounding benchmark where a Roboflow-served model beats the current pipeline on your own task set, at comparable latency and cost. Nothing available today clears that bar.

## Sources

- https://docs.roboflow.com/deployment/self-hosted/self-hosted
- https://docs.roboflow.com/deployment/self-hosted/inference-server
- https://docs.roboflow.com/deployment/self-hosted/inference-server/install/minimum-requirements
- https://inference-models.roboflow.com/models/
- https://docs.roboflow.com/workflows/blocks/blocks/run-a-model/florence2-model
- https://docs.roboflow.com/models/supported-models/owlv2
- https://docs.roboflow.com/deployment/roboflow-cloud/serverless-api/model-pricing
- https://roboflow.com/pricing · https://roboflow.com/credits
- https://roboflow.com/blog/website-screenshot-understanding
- https://roboflow.com/blog/florence-2-workflows · https://roboflow.com/blog/smolvlm2
- https://roboflow.com/blog/agentic-computer-vision
- https://roboflow.com/blog/making-it-easier-cheaper-to-deploy-with-roboflow
- https://rfdetr.roboflow.com/latest/learn/benchmarks/

**Unverified / marketing-only:** the "160,000 inferences per credit" and "9 in 10 workspaces cheaper" claims; Vision Evals rankings (429, not quotable); Universe UI dataset accuracy (403); whether self-hosted GPU throughput would beat Gemini on end-to-end cost (no published benchmark either way).
