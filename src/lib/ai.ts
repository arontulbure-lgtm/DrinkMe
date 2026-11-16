// AI scanner, barcode fallback and recipes (server routes /api/ai/* and /api/recipes/saved).
// The client shows the real AI screens only while the kill switch in the screen is on AND the server says
// GET /api/ai/status → available. Contracts: .claude/skills/drinkme-ai-service/SKILL.md.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, ApiError } from './api';
import { useAuth } from '../context/AuthContext';
import { AI_CATEGORIES, type AiRecipe, type AiRecipeBatch, type AiScanItem, type AiScanResult, type AiSettings, type AiStatus } from '../types/api';

// The server answers a scan in ~5 s and a recipe batch in up to ~90 s (generation + one regeneration).
const SCAN_TIMEOUT_MS = 45_000;
const BARCODE_TIMEOUT_MS = 20_000;
const RECIPES_TIMEOUT_MS = 150_000;
const SCAN_STATUSES: AiScanResult['status'][] = ['recognized', 'low_confidence', 'water', 'not_ingredient', 'unclear'];
const RECIPE_WARNINGS: AiRecipe['warnings'] = ['raw_egg', 'energy_alcohol'];

// A newer server may add enum values (an additive change, same schemaVersion). Unknown ones must never reach
// the UI as raw i18n keys: an unknown status or category reads as "unclear", unknown warnings are dropped.
export function normalizeScanResult(result: AiScanResult): AiScanResult {
  const knownStatus = SCAN_STATUSES.includes(result.status);
  const knownCategory = !result.item || AI_CATEGORIES.includes(result.item.category);
  if (knownStatus && knownCategory) return result;
  return { ...result, status: 'unclear', item: null, suggestBarcode: true };
}
export function normalizeRecipe(recipe: AiRecipe): AiRecipe {
  return { ...recipe, warnings: (recipe.warnings ?? []).filter((w) => RECIPE_WARNINGS.includes(w)), youWillAlsoNeed: recipe.youWillAlsoNeed ?? [] };
}

export const aiStatusKey = (language: string) => ['ai.status', language] as const;
export const SAVED_RECIPES_KEY = ['ai.savedRecipes'] as const;

const withTimeout = async <T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError('timeout', 504, 'ai_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const appLanguage = (language: string): 'en' | 'ro' => (language === 'ro' ? 'ro' : 'en');

export function useAiStatus(language: string, enabled = true) {
  const { serverUserId } = useAuth();
  return useQuery<AiStatus>({
    queryKey: aiStatusKey(appLanguage(language)),
    enabled: enabled && !!serverUserId,
    staleTime: 30_000,
    queryFn: () => apiFetch<AiStatus>('/api/ai/status', { query: { language: appLanguage(language) } }),
  });
}

/** Accepts the notice version the server asked for (it depends on where photos are processed). */
export function useAcceptAiNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => apiFetch('/api/ai/notice', { method: 'POST', body: JSON.stringify({ version }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai.status'] }),
  });
}

export function useUpdateAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { basics?: string[] | null; photoOptIn?: boolean; language: string }) =>
      apiFetch<AiSettings>('/api/ai/settings', { method: 'PUT', body: JSON.stringify({ ...body, language: appLanguage(body.language) }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai.status'] }),
  });
}

export const scanPhoto = (imageBase64: string, language: string) => withTimeout(SCAN_TIMEOUT_MS, (signal) =>
  apiFetch<AiScanResult>('/api/ai/scan', {
    method: 'POST', body: JSON.stringify({ imageBase64, language: appLanguage(language) }), signal,
  })).then(normalizeScanResult);

export const lookupBarcode = (ean: string, language: string) => withTimeout(BARCODE_TIMEOUT_MS, (signal) =>
  apiFetch<AiScanResult>('/api/ai/barcode', {
    method: 'POST', body: JSON.stringify({ ean, language: appLanguage(language) }), signal,
  })).then(normalizeScanResult);

export type AiReport =
  | { kind: 'recipe'; reason: AiReportReason; recipeId: string; recipeName: string }
  | { kind: 'scan'; reason: AiReportReason; category?: string; status?: string };
export type AiReportReason = 'offensive' | 'unsafe' | 'wrong' | 'other';
export const AI_REPORT_REASONS: AiReportReason[] = ['offensive', 'unsafe', 'wrong', 'other'];

/** Reports an AI answer (Google Play AI-generated content policy). Reviewed by the DrinkMe team. */
export const reportAiOutput = (report: AiReport) =>
  apiFetch('/api/ai/report', { method: 'POST', body: JSON.stringify(report) });

export type RecipeRequest = { mode: 'scan'; item: AiScanItem } | { mode: 'smart_bar' };

export const generateRecipes = (request: RecipeRequest, language: string, newSession: boolean) =>
  withTimeout(RECIPES_TIMEOUT_MS, (signal) => apiFetch<AiRecipeBatch>('/api/ai/recipes', {
    method: 'POST', body: JSON.stringify({ ...request, language: appLanguage(language), newSession }), signal,
  })).then((batch) => ({ ...batch, recipes: batch.recipes.map(normalizeRecipe) }));

export function useSavedRecipes(enabled = true) {
  const { serverUserId } = useAuth();
  return useQuery<AiRecipe[]>({
    queryKey: SAVED_RECIPES_KEY,
    enabled: enabled && !!serverUserId,
    queryFn: async () => {
      try {
        return (await apiFetch<{ items: AiRecipe[] }>('/api/recipes/saved')).items.map(normalizeRecipe);
      } catch (error) {
        // A server without AI v1 (older deploy or rollback): nothing saved, not an error.
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
    },
  });
}

/** Save / unsave with an optimistic update of the saved list. */
export function useToggleSavedRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ recipe, save }: { recipe: AiRecipe; save: boolean }) => {
      if (save) return apiFetch<AiRecipe>('/api/recipes/saved', { method: 'POST', body: JSON.stringify({ recipe }) });
      await apiFetch(`/api/recipes/saved/${encodeURIComponent(recipe.id)}`, { method: 'DELETE' });
      return null;
    },
    onMutate: async ({ recipe, save }) => {
      await queryClient.cancelQueries({ queryKey: SAVED_RECIPES_KEY });
      const previous = queryClient.getQueryData<AiRecipe[]>(SAVED_RECIPES_KEY);
      queryClient.setQueryData<AiRecipe[]>(SAVED_RECIPES_KEY, (list = []) => (
        save ? [recipe, ...list.filter((r) => r.id !== recipe.id)] : list.filter((r) => r.id !== recipe.id)
      ));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(SAVED_RECIPES_KEY, context?.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SAVED_RECIPES_KEY }),
  });
}

const KNOWN_AI_ERRORS = new Set([
  'ai_bad_request', 'ai_disabled', 'ai_unavailable', 'ai_timeout', 'ai_invalid_output', 'ai_rate_limit', 'ai_busy', 'ai_notice_required',
  'barcode_unavailable', 'barcode_not_found', 'barcode_invalid', 'smart_bar_empty', 'water_no_recipes', 'recipe_limit',
  'recipe_invalid',
]);

/**
 * i18n key for an AI error: offline, a known server code, too large, rate limited, or generic. A 400 without a
 * code means an unreadable photo only on the scan route ('scan'); elsewhere it is a generic error.
 */
export function getAiErrorKey(error: unknown, context: 'scan' | 'other' = 'other'): string {
  if (error instanceof ApiError) {
    if (error.code && KNOWN_AI_ERRORS.has(error.code)) return `ai.errors.${error.code}`;
    if (error.status === 413) return 'ai.errors.image_too_large';
    if (error.status === 429) return 'ai.errors.ai_rate_limit';
    if (error.status === 400) return context === 'scan' ? 'ai.errors.image_invalid' : 'ai.errors.generic';
    if (error.status === 507) return 'common.serviceUnavailable';
    return 'ai.errors.generic';
  }
  // fetch rejects with a TypeError when there is no connection.
  if (error instanceof TypeError) return 'ai.errors.offline';
  return 'ai.errors.generic';
}

/** Name shown for a scanned item: brand + product, else style, else the category label. */
export function itemDisplayName(item: AiScanItem, categoryLabel: string): string {
  const name = [item.brand, item.product].filter(Boolean).join(' ').trim();
  if (item.brand && item.product && item.product.toLowerCase().includes(item.brand.toLowerCase())) return item.product;
  return name || item.style || categoryLabel;
}

/** Formats an amount: 40 ml, 2 pcs, 10 g. */
export function formatAmount(amount: number, unit: AiRecipe['ingredients'][number]['unit'], pieceLabel: string): string {
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return unit === 'piece' ? `${value} ${pieceLabel}` : `${value} ${unit}`;
}
