# Local AI track – run log

## 2026-11-16
- Worktree `D:\DrinkMeApp\DrinkMeFinal-ai` created on `auto/ai-2026-11-16` from `origin/main` (442321b).
- Hardware check: RTX 4060 Laptop 8 GB, driver 595.79, CUDA 13.2; ~7.2 GB VRAM free with the desktop running.
- Ollama 0.40.16 installed to `D:\AI\Ollama` (signed installer, `/DIR`). The installer's tray app started before the
  new user env vars were visible to it, so it was stopped; the server is run with `ollama serve` and
  `OLLAMA_MODELS=D:\AI\ollama-models` (nothing was written to `C:\Users\Aron\.ollama\models`, checked: 0 MB).
- Model candidates (web check, Nov 2026): Qwen3-VL is the usual pick for label OCR on 8 GB; 8B Q4 = 6.2 GB, 4B Q4 = 3.3 GB.
  Pulled `qwen3-vl:4b-instruct` and `qwen3-vl:8b-instruct`.
- Python 3.12 venv at `D:\AI\venvs\drinkme-ai` (fastapi, uvicorn, httpx, pydantic, pillow, rapidocr-onnxruntime, pytest).
- Phase 0 written (agents + skills). The server test harness port is made overridable (`DRINKME_TEST_PORT`) so this
  worktree can run the suite on 5056 while the to-do run uses 5055.
