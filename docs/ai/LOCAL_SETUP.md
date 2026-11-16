# Local AI – setup on this PC

The scanner and the recipe generator run on a local model. Everything AI is stored on **D:** (C: is low on space).
Architecture and contracts: `.claude/skills/drinkme-ai-service/SKILL.md`.

## Hardware (checked 2026-11-16)
| Part | Value |
|---|---|
| CPU | Ryzen 7 7435HS |
| RAM | 16 GB |
| GPU | RTX 4060 Laptop, 8 GB VRAM, driver 595.79, CUDA 13.2 (`nvidia-smi`) |
| VRAM free with the desktop running | ~7.2 GB |

## Quick start
```powershell
cd D:\DrinkMeApp\DrinkMeFinal-ai     # or the main checkout once merged
npm run ai:setup                    # once: folders, env vars, Ollama, venv, packages, models
npm run ai:start                    # Ollama + ai-service in the background, model warmed, health checked
npm run ai:health                   # {"status":"ok", ...}
npm run ai:test                     # ai-service unit tests (no GPU needed)
npm run ai:stop
```
Then set `AI_PROVIDER=local` in `server/.env` and start the server. `npm run test:android` / `test:ios` start the
ai-service automatically when `AI_PROVIDER=local` (in the shell or in `server/.env`).

## Paths
| What | Path | Set by |
|---|---|---|
| Root | `D:\AI\` (`DRINKME_AI_ROOT` to change) | `scripts/ai-service.mjs` |
| Ollama program | `D:\AI\Ollama\` (`ollama.exe`, `ollama app.exe`) | installer `/DIR=D:\AI\Ollama` |
| Ollama installer download | `D:\AI\cache\downloads\OllamaSetup.exe` | `ai:setup` |
| Models | `D:\AI\ollama-models\` | `OLLAMA_MODELS` |
| Python venv (3.12) | `D:\AI\venvs\drinkme-ai\` | `ai:setup` (`py -3.12 -m venv`) |
| pip cache | `D:\AI\cache\pip\` | `PIP_CACHE_DIR` |
| Hugging Face cache (not used yet) | `D:\AI\cache\huggingface\` | `HF_HOME` |
| Torch cache (not used yet) | `D:\AI\cache\torch\` | `TORCH_HOME` |
| Temp files of AI processes | `D:\AI\cache\tmp\` | `TMP`/`TEMP` set for AI child processes only |
| OCR models (RapidOCR ONNX) | inside the venv: `D:\AI\venvs\drinkme-ai\Lib\site-packages\rapidocr_onnxruntime\models\` | pip |
| Datasets | `D:\AI\datasets\` (scan set: `scan-v1\images` + `manifest.jsonl`) | `ai-service/eval/build_dataset.py` |
| Reports, logs, PID files | `D:\AI\reports\` (`ollama-serve.log`, `ai-service.log`, `bench-*.json`, `eval-*`) | scripts |

Checked: nothing was written to `C:\Users\Aron\.ollama\models` (0 MB). The Ollama installer puts a Start-menu entry and
an auto-start shortcut for the tray app on C: (a few KB); the tray app reads `OLLAMA_MODELS` from the user env vars,
so models still go to D:.

## Windows user environment variables (set by `ai:setup`)
| Variable | Value |
|---|---|
| `OLLAMA_MODELS` | `D:\AI\ollama-models` |
| `OLLAMA_HOST` | `127.0.0.1:11434` (loopback only) |
| `PIP_CACHE_DIR` | `D:\AI\cache\pip` |
| `HF_HOME` | `D:\AI\cache\huggingface` |
| `TORCH_HOME` | `D:\AI\cache\torch` |
`TMP`/`TEMP` are **not** changed for the whole user (that would affect every program); the scripts set them to
`D:\AI\cache\tmp` for the AI processes they start.

## ai-service settings (environment of the ai-service process)
| Variable | Default | Meaning |
|---|---|---|
| `AI_SERVICE_HOST` | `127.0.0.1` | Bind address. A non-loopback host refuses to start without `AI_SERVICE_TOKEN` |
| `AI_SERVICE_PORT` | `8088` | |
| `AI_SERVICE_TOKEN` | none | Shared secret with the Express server (header `X-AI-Service-Token`). Optional on loopback |
| `DRINKME_VISION_MODEL` | `qwen3-vl:4b-instruct` | Scan model |
| `DRINKME_TEXT_MODEL` | same as vision | Recipe model (one model for both: no swapping in 8 GB) |
| `DRINKME_OCR` | `on` | RapidOCR text as a hint to the vision model (+~0.5 s) |
| `DRINKME_MAX_IMAGE_SIDE` | `1024` (`768` recommended, see below) | Downscale before the model |
| `SCAN_MIN_CONFIDENCE` | `0.6` | Below → `low_confidence` → the app offers the barcode |
| `OLLAMA_TIMEOUT_S` | `90` | Per model call |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long the model stays in VRAM after the last request |

## Server settings (`server/.env`)
`AI_PROVIDER`, `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `AI_SERVICE_TIMEOUT_MS`, `AI_RATE_LIMIT_PER_HOUR`, `AI_PHOTO_DIR`,
`AI_PHOTO_RETENTION_DAYS` – see `server/README.md`.

## Model choice
Web check (Nov 2026): Qwen3-VL is the usual recommendation for label OCR on 8 GB cards; 8B Q4 = 6.2 GB, 4B Q4 = 3.3 GB.
Measured on this PC (`ai-service/eval/bench.py`, warm, OCR on, 12 photos; reports in `D:\AI\reports\bench-*.json`):

| Model | Image side | Scan p50 | Scan p95 | Cold start | Recipe batch (4) | VRAM used by model |
|---|---|---|---|---|---|---|
| qwen3-vl:8b-instruct | 768 | 8.8 s | 10.2 s | 21.8 s | 60.5 s | 6.6 GB (only ~0.4 GB left) |
| **qwen3-vl:4b-instruct** | 768 | **4.7 s** | **5.6 s** | 12.0 s | 28.5 s | **4.5 GB** |
| qwen3-vl:4b-instruct | 640 | 5.0 s | 5.6 s | 13.1 s | – | 4.5 GB |
| qwen3-vl:4b-instruct, OCR off | 640 | 4.3 s | 4.5 s | 10.2 s | – | 4.4 GB |

The 8B is over the 5 s budget, so the **4B instruct** is used for both scanning and recipes. The time is mostly
token generation, not image size. The first-ever load from disk took ~59 s; `ai:start` warms the model so users do
not pay it. Accuracy per model: `docs/ai/EVAL_REPORT.md`.

## Troubleshooting
- `ai:health` says `degraded` / `ollama: false`: run `npm run ai:start` (it starts `ollama serve` with the D: paths).
- `modelsPresent: false`: `D:\AI\Ollama\ollama.exe pull qwen3-vl:4b-instruct` (with `OLLAMA_MODELS` set).
- First scan very slow: the model was unloaded after `OLLAMA_KEEP_ALIVE`; the next ones are fast again.
- Free VRAM: `nvidia-smi`; another GPU app (games, Docker with GPU) can push the model partly to the CPU (3-5× slower).
