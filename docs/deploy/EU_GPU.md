# Local AI on an EU GPU host

Status: updated 2026-11-23 after the AI merge (PR #4). The plan itself (providers, prices, Docker setup on the GPU host, security) is `docs/ai/PRODUCTION_PLAN.md`; the rollout steps are `docs/ai/ROLLOUT.md`. Until the GPU host runs, production uses `AI_PROVIDER=off`.

## What the API server will need
| Variable | Value | Notes |
|---|---|---|
| `AI_PROVIDER` | `local` | Production needs it set explicitly (`off` or `local`). |
| `AI_SERVICE_URL` | `https://<private name>` or a private-network address, for example `http://10.0.0.2:8088` | Production accepts a loopback or `https` URL, or plain `http` to a host listed exactly in `AI_SERVICE_PRIVATE_HOSTS` (a private network you control: Hetzner vSwitch, Scaleway Private Network, OVH vRack, WireGuard, or the compose network). |
| `AI_SERVICE_TOKEN` | 32+ random characters | Same value on the ai-service. Never in git. |
| `AI_SERVICE_TIMEOUT_MS` | `60000` | |
| `AI_RATE_LIMIT_PER_HOUR` | `30` | Per user. Daily caps: `AI_DAILY_SCAN_LIMIT` (20), `AI_DAILY_RECIPE_LIMIT` (10). |
| `AI_SERVICE_PRIVATE_HOSTS` | e.g. `ai-service` or the private host name | Only for plain `http` on a private network. |
| `AI_RECIPE_CONCURRENCY` | `2` | Must match `OLLAMA_NUM_PARALLEL` (2 in docker-compose.yml). |
| `AI_PHOTO_OPT_IN_ENABLED` | unset | Off at launch (D-21/D-22): no scan photo is kept. |

The ai-service answers its health check on `GET /v1/health` (also `/health`), on port 8088 by default.

## Readiness
`/readyz` on the API server deliberately does not depend on the ai-service: an AI outage turns the AI routes into 503 `ai_disabled`/`ai_unavailable` answers but keeps the API in rotation.

## Docker Compose (single host with a GPU)
`docker-compose.yml` in the repo root has two services under the `ai` profile: `ollama` (NVIDIA GPU reservation, model volume, no published port) and `ai-service` (CPU, read-only, no published port, reachable from the server as `http://ai-service:8088`). It builds from `./ai-service`; `docker compose --profile ai up -d` starts it next to the server, with `AI_SERVICE_PRIVATE_HOSTS=ai-service` in the server's env file. Pull the model once with `docker compose --profile ai exec ollama ollama pull qwen3-vl:4b-instruct` and check its digest (`docs/ai/PRODUCTION_PLAN.md` §4). The ai-service container healthcheck is liveness only; the server checks `status: "ok"` itself.

## Still to fill (with the provider choice, LC-45)
- Chosen provider and region, order date, private-network setup.
- Model pull and digest check, warm-up, `OLLAMA_KEEP_ALIVE`.
- Firewall rules (8088 only from the API server's private address).
- Monitoring of `/v1/health` and GPU memory, and the rollout steps from `docs/ai/ROLLOUT.md`.
- Privacy and transparency texts (`docs/legal/ai-transparency.md`) before any real user reaches AI.
