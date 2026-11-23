# DrinkMe ai-service (FastAPI + OCR). The model runs in Ollama (its own container with the GPU); this image
# only needs the CPU. See docs/ai/PRODUCTION_PLAN.md §4 and docs/deploy/EU_GPU.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    AI_SERVICE_HOST=0.0.0.0 \
    AI_SERVICE_PORT=8088

# OpenCV (pulled in by rapidocr-onnxruntime) needs these shared libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt ./
# Pinned runtime dependencies; pytest is for development only.
RUN grep -v '^pytest' requirements.txt > requirements.runtime.txt \
 && pip install -r requirements.runtime.txt \
 && rm requirements.runtime.txt

COPY app ./app

# Non-root. main.py refuses to listen on a non-loopback host without AI_SERVICE_TOKEN.
USER 10001
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8088/v1/health', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "app.main"]
