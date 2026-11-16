# Local AI in production – plan (docs only)

Status: plan, nothing deployed. Written 2026-11-16. Prices checked on the web the same day (sources at the end); they
change often, so re-check before ordering. Architecture and contracts: `.claude/skills/drinkme-ai-service/SKILL.md`.

## 1. What has to run
| Part | Needs | Notes |
|---|---|---|
| Express server (`server/`) | CPU host (already planned, see DEPLOY.md) | Unchanged; talks to the ai-service over a private network |
| ai-service (`ai-service/`) | Python 3.12, ~300 MB RAM, CPU for OCR (~0.5 s/scan) | Stateless, no disk writes |
| Ollama + `qwen3-vl:4b-instruct` | NVIDIA GPU, ≥ 8 GB VRAM (model uses ~4.5 GB at 4k context) | One model for scans and recipes, so no model swapping |

Measured on the dev laptop (RTX 4060 Laptop, 8 GB): scan p50 4.7 s, recipe batch (4 recipes) ~28 s. Data-centre cards
in the same class (L4, RTX 4000 SFF Ada) have similar or higher memory bandwidth, so expect the same or better.

## 2. Providers compared (EU first: user photos are personal data)
| Provider | GPU | Location | Price (checked 2026-11-16) | Monthly if always on | Fit |
|---|---|---|---|---|---|
| **Hetzner GEX44** (dedicated) | RTX 4000 SFF Ada, 20 GB | DE / FI (EU) | €232.30/mo excl. IPv4 + €114 setup (official price table after the 15 June 2026 adjustment; older €184 still quoted elsewhere) | **~€235** | Best value for steady load; EU; flat price; manual scaling (order days ahead); "limited offering" |
| **Scaleway** L4-1-24G (cloud) | L4, 24 GB | Paris (EU) | ~$0.88–0.92 per GPU-hour (aggregators, Aug–Oct 2026) | ~€600 | EU, hourly, API-created, easy to add a 2nd GPU for peaks |
| **OVHcloud** L4-90 (cloud) | L4, 24 GB | FR / EU | ~$1.00 per GPU-hour (aggregators, Oct 2026); monthly billing cheaper | ~€680 (hourly) | EU, private network (vRack) included |
| **RunPod** (pods / serverless) | L4 / RTX 4000 Ada | EU + US data centres, US company | L4 ~$0.39–0.49/h on demand; serverless flex workers from ~$0.58/h only while working | $0–285 | Cheapest at very low volume (serverless), but cold starts (model load 10–60 s), US provider → SCCs/DPA needed |

Not chosen: hyperscalers (AWS g6 / GCP L4) cost more for one small GPU and add egress; Vast.ai-style marketplaces
cannot give a data-processing agreement for personal photos.

## 3. Cost estimates (GPU only; the Express host and storage are in DEPLOY.md)
Assumptions: 40 % of monthly active users use AI; each AI user does 6 scans and 4 recipe batches a month
→ 6 × 4 s + 4 × 25 s ≈ **2 GPU-minutes per AI user per month**. Evening peaks ≈ 10× the average load.

| Monthly active users | AI users | GPU time / month | Peak concurrent AI requests | Setup | GPU cost / month |
|---|---|---|---|---|---|
| 100 | 40 | ~1.4 h | < 1 | RunPod serverless (EU region), 0 idle workers — or the laptop for a closed beta | **~€5–20** (cold start on the first request after idle) |
| 1,000 | 400 | ~14 h | 1–2 | 1 × Hetzner GEX44, `OLLAMA_NUM_PARALLEL=2` | **~€235** (+€114 once) |
| 10,000 | 4,000 | ~140 h | 5–10 | 2 × Hetzner GEX44 behind the server's round-robin, or 1 × GEX44 + Scaleway L4 on demand for peaks | **~€470** (2× GEX44) / ~€235 + €100–300 burst |

Per AI user that is ~€0.05–0.60/month, far below OpenAI-Vision-per-photo pricing at scale and with no photo leaving
our infrastructure. Re-measure after launch with real usage before buying the second GPU.

## 4. Setup with Docker (on the GPU host)
```yaml
# docker-compose.yml on the GPU host (needs the NVIDIA Container Toolkit)
services:
  ollama:
    image: ollama/ollama:0.40.16          # pin the version tested locally
    restart: unless-stopped
    environment:
      OLLAMA_KEEP_ALIVE: "24h"            # keep the model in VRAM
      OLLAMA_NUM_PARALLEL: "2"
      OLLAMA_HOST: "0.0.0.0:11434"
    volumes: [ "ollama-models:/root/.ollama" ]
    deploy: { resources: { reservations: { devices: [ { capabilities: [gpu] } ] } } }
    networks: [ internal ]                # no published port
  ai-service:
    build: ./ai-service                   # python:3.12-slim, non-root user, `python -m app.main`
    restart: unless-stopped
    environment:
      OLLAMA_HOST: "ollama:11434"
      AI_SERVICE_HOST: "0.0.0.0"          # refuses to start without a token on a non-loopback host
      AI_SERVICE_TOKEN: ${AI_SERVICE_TOKEN}   # from a secret file, never in git
      DRINKME_VISION_MODEL: "qwen3-vl:4b-instruct"
      DRINKME_MAX_IMAGE_SIDE: "768"
    ports: [ "10.0.0.2:8088:8088" ]       # bound to the private-network address only
    networks: [ internal ]
    read_only: true
    tmpfs: [ /tmp ]
networks: { internal: { internal: false } }
volumes: { ollama-models: {} }
```
`ai-service/Dockerfile` (to add when deploying): `FROM python:3.12-slim`, `pip install -r requirements.txt`
(pinned), copy `app/` only, `USER 10001`, `CMD ["python", "-m", "app.main"]`. Pull the model once
(`docker compose exec ollama ollama pull qwen3-vl:4b-instruct`) and check its digest against the one tested locally.

Express server env: `AI_PROVIDER=local`, `AI_SERVICE_URL=http://10.0.0.2:8088`, `AI_SERVICE_TOKEN=<same secret>`,
`AI_SERVICE_TIMEOUT_MS=60000`, `AI_RATE_LIMIT_PER_HOUR=30`.

## 5. Security
- **Private network only:** Hetzner vSwitch / Scaleway Private Network / OVH vRack, or WireGuard between the two
  hosts when they are with different providers. The ai-service port is bound to the private address; the host
  firewall allows 8088 only from the Express server's private IP. Ollama has no published port at all.
- **Auth token:** `AI_SERVICE_TOKEN` (32+ random bytes) on both sides, compared in constant time; the ai-service
  refuses to listen on a non-loopback host without it. Rotate it like the JWT secret (docs/SECURITY_ROTATION.md).
- **Encryption in transit:** WireGuard (or the provider's private network + TLS terminated by a Caddy sidecar
  if the link ever leaves a private network).
- **No data at rest:** photos and prompts are never written or logged (only method, path, status and timings).
  The opt-in photo store lives on the Express host, not the GPU host.
- **Hardening:** non-root containers, read-only filesystem, automatic security updates, SSH keys only, pinned
  image versions, `nvidia-smi` + disk alerts.
- **Abuse:** per-user limits stay on the Express server (30 AI requests/hour, one at a time per user); add a
  global daily cap there before a public launch.
- **Processor agreement:** the GPU host becomes a processor (photos in memory) → DPA with the provider, entry in
  `docs/legal/internal/subprocessors.md` (legal-compliance).

## 6. Scaling
1. Vertical first: `OLLAMA_NUM_PARALLEL=2–4` on one GPU (decode is memory-bound; parallel batches raise throughput
   with a modest latency cost). Watch p95 scan latency; target < 5 s.
2. Horizontal: several `AI_SERVICE_URL`s with round-robin + health check in `server/ai/localProvider.js` (small
   change: a list instead of one URL). Stateless service, so no sticky sessions.
3. Queue limit: when all GPUs are busy, answer 503 `ai_unavailable` quickly instead of letting requests pile up
   (Ollama's `OLLAMA_MAX_QUEUE`, plus a per-instance in-flight cap in the provider).
4. Bigger model later only if the eval says so (`docs/ai/EVAL_REPORT.md`): an 8B model needs ≥ 12 GB VRAM at
   comfortable context → GEX44 (20 GB) or L4 (24 GB) already fit it.

## 7. When the GPU server is down
- `GET /api/ai/status` asks the ai-service health (cached 10 s). When it fails, `available: false` → the app shows
  the "AI is taking a break" note on the Scanner and Recipes previews instead of erroring. Barcode lookup and saved
  recipes keep working (they need no model).
- In-flight requests fail fast with clear codes (`ai_unavailable` 503 after one retry, `ai_timeout` 504); the app
  shows a retry button.
- Optional fallback (not built yet, decision for John): a second provider, e.g. `AI_FALLBACK_PROVIDER=openai`, used
  only when the local one is unhealthy. Every recipe would still pass the same server-side safety validation, but
  photos would then go to OpenAI, which needs its own privacy notice update and DPA. Default: no fallback.
- Monitoring: uptime check on the ai-service health from the Express host, alert on 3 consecutive failures; log
  the rate of `ai_unavailable` / `ai_timeout` answers.

## Sources (checked 2026-11-16)
- Hetzner price adjustment (GEX44 €232.30 excl. IPv4, from 15 June 2026): https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Hetzner GEX44 launch (€184/mo, 2024): https://www.hetzner.com/press-release/new-gpu-server
- Scaleway L4 (aggregator): https://computeprices.com/providers/scaleway/gpus/l4
- OVHcloud L4 (aggregator): https://computeprices.com/providers/ovhcloud/gpus/l4 · official table: https://www.ovhcloud.com/en-gb/public-cloud/prices/
- RunPod pricing: https://www.runpod.io/pricing-page · L4 (aggregator): https://computeprices.com/providers/runpod/gpus/l4
