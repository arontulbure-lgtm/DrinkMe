// AI_PROVIDER=local: calls the ai-service (ai-service/, FastAPI + Ollama). Never logs bodies.
import { AiProviderError } from './provider.js';
import { AI_SCHEMA_VERSION } from './taxonomy.js';

const SCAN_TIMEOUT_CAP_MS = 20_000;
const HEALTH_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ai-service error code → server error code.
const ERROR_MAP = {
  model_unavailable: 'ai_unavailable',
  model_timeout: 'ai_timeout',
  model_invalid_output: 'ai_invalid_output',
  image_invalid: 'ai_bad_request',
  invalid_request: 'ai_bad_request',
  unauthorized: 'ai_unavailable', // a wrong token is a server misconfiguration, not the user's fault
};

export const createLocalProvider = ({ url, token, timeoutMs = 60_000, fetchImpl = fetch } = {}) => {
  const base = (url || 'http://127.0.0.1:8088').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', ...(token && { 'X-AI-Service-Token': token }) };

  // One retry, only when the service could not be reached or answered 503 (e.g. model still loading).
  // Timeouts are not retried: the user would wait twice as long for the same failure.
  const call = async (path, body, callTimeoutMs) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(callTimeoutMs),
        });
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new AiProviderError('ai_timeout');
        if (attempt === 0) { await sleep(RETRY_DELAY_MS); continue; }
        throw new AiProviderError('ai_unavailable');
      }
      if (response.status === 503 && attempt === 0) { await sleep(RETRY_DELAY_MS); continue; }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new AiProviderError('ai_invalid_output');
      }
      if (!response.ok) {
        const code = ERROR_MAP[data?.error?.code] ?? (response.status >= 500 ? 'ai_unavailable' : 'ai_bad_request');
        console.warn(`[ai] ai-service ${path} answered ${response.status} (${typeof data?.error?.code === 'string' ? data.error.code.slice(0, 40) : 'no code'})`);
        throw new AiProviderError(code);
      }
      if (data?.schemaVersion !== AI_SCHEMA_VERSION) throw new AiProviderError('ai_invalid_output', 'schema version mismatch');
      return data;
    }
    throw new AiProviderError('ai_unavailable');
  };

  return {
    name: 'local',
    async health() {
      try {
        const response = await fetchImpl(`${base}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        const data = await response.json();
        return { ok: response.ok && data?.status === 'ok' && data?.schemaVersion === AI_SCHEMA_VERSION, detail: data };
      } catch {
        return { ok: false };
      }
    },
    scan: ({ imageBase64, mimeType, language }) => call(
      '/v1/scan',
      { schemaVersion: AI_SCHEMA_VERSION, imageBase64, mimeType, language },
      Math.min(SCAN_TIMEOUT_CAP_MS, timeoutMs),
    ),
    recipes: (request) => call('/v1/recipes', { schemaVersion: AI_SCHEMA_VERSION, ...request }, timeoutMs),
  };
};
