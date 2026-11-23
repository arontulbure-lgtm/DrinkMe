// AI provider layer. AI runs only with AI_PROVIDER=local set explicitly (decision D-24, 2026-11-22: never an outside
// AI company for AI flows). Every other value - unset, off, the removed "openai", or the old AI_ENABLED switch -
// means off. The provider returns raw candidates; the server validates them (schemas.js, recipeSafety.js).
//   name: 'local'
//   health(): Promise<{ ok: boolean, detail?: object }>
//   scan({ imageBase64, mimeType, language, signal }): Promise<ScanResult-like object>
//   recipes(RecipeRequest, { signal }): Promise<{ recipes: object[] }>
// Errors are AiProviderError with code ai_unavailable | ai_timeout | ai_invalid_output | ai_bad_request.

export const AI_PROVIDERS = ['local', 'off'];

export class AiProviderError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export const resolveAiProviderName = (env) => {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw === 'openai' || env.AI_ENABLED === 'true') {
    console.warn('[ai] The OpenAI provider was removed (D-24). AI stays off; set AI_PROVIDER=local to use the local model.');
  } else if (raw !== '' && raw !== 'off') {
    console.warn('[ai] AI_PROVIDER must be local or off - AI stays off.');
  }
  return 'off';
};
