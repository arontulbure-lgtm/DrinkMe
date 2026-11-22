# Local AI on an EU GPU host (stub)

Status: stub, written 2026-11-22. It is filled after the AI track (branch `auto/ai-2026-11-16`, PR #4) is merged. The plan itself (providers, prices, Docker setup on the GPU host, security) is `docs/ai/PRODUCTION_PLAN.md`, which arrives with that merge. Until then the server runs with `AI_PROVIDER=off`, and production refuses `AI_PROVIDER=local`.

## What the API server will need
| Variable | Value | Notes |
|---|---|---|
| `AI_PROVIDER` | `local` | Production refuses `local` on this build; the AI merge adds the provider and its guard. |
| `AI_SERVICE_URL` | `https://<private name>` or a private-network address, for example `http://10.0.0.2:8088` | The AI track's production guard accepts only a loopback or `https` URL. A private network (Hetzner vSwitch, Scaleway Private Network, OVH vRack) or WireGuard is planned; plain `http` on a private address needs that rule revisited at the merge. |
| `AI_SERVICE_TOKEN` | 32+ random characters | Same value on the ai-service. Never in git. |
| `AI_SERVICE_TIMEOUT_MS` | `60000` | |
| `AI_RATE_LIMIT_PER_HOUR` | `30` | Per user, from the AI track's plan. |

The ai-service answers its health check on `GET /v1/health` (also `/health`), on port 8088 by default.

## Readiness
`/readyz` on the API server deliberately does not depend on the ai-service: an AI outage turns the AI routes into 503 `ai_disabled`/`ai_unavailable` answers but keeps the API in rotation.

## Docker Compose (single host with a GPU)
`docker-compose.yml` in the repo root has an `ai-service` service under the `ai` profile (NVIDIA GPU reservation, no published port, reachable from the server as `http://ai-service:8088`). It builds from `./ai-service`, which exists only after the merge; then `docker compose --profile ai up -d` starts it next to the server. Ollama and the model run as described in the AI track's plan (`OLLAMA_HOST`).

## To fill after the merge
- Chosen provider and region, order date, private-network setup.
- Model pull and digest check, warm-up, `OLLAMA_KEEP_ALIVE`.
- Firewall rules (8088 only from the API server's private address).
- Monitoring of `/v1/health` and GPU memory, and the rollout steps from `docs/ai/ROLLOUT.md`.
- Privacy and transparency texts (`docs/legal/ai-transparency.md`) before any real user reaches AI.
