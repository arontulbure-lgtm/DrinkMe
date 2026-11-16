// AI provider layer. AI_PROVIDER = local | openai | off (default off).
// Every provider has the same interface and returns raw candidates; the server validates them
// (schemas.js, recipeSafety.js) whichever provider answered.
//   name: 'local' | 'openai'
//   health(): Promise<{ ok: boolean, detail?: object }>
//   scan({ imageBase64, mimeType, language }): Promise<ScanResult-like object>
//   recipes(RecipeRequest): Promise<{ recipes: object[] }>
// Errors are AiProviderError with code ai_unavailable | ai_timeout | ai_invalid_output | ai_bad_request.

export const AI_PROVIDERS = ['local', 'openai', 'off'];

export class AiProviderError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/**
 * Picks the provider from the environment. Legacy: with AI_PROVIDER unset, AI_ENABLED=true keeps meaning
 * "OpenAI", so existing deployments behave as before.
 */
export const resolveAiProviderName = (env) => {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '') return env.AI_ENABLED === 'true' ? 'openai' : 'off';
  if (AI_PROVIDERS.includes(raw)) return raw;
  console.warn('[ai] AI_PROVIDER must be local, openai or off - AI stays off.');
  return 'off';
};
