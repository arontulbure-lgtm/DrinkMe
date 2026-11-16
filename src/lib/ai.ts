// AI scanner, barcode fallback and recipes (server routes /api/ai/* and /api/recipes/saved).
// The client shows the real AI screens only while the kill switch in the screen is on AND the server says
// GET /api/ai/status → available. Contracts: .claude/skills/drinkme-ai-service/SKILL.md.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, ApiError } from './api';
import { useAuth } from '../context/AuthContext';
import type { AiRecipe, AiRecipeBatch, AiScanItem, AiScanResult, AiSettings, AiStatus } from '../types/api';

// The server answers a scan in ~5 s and a recipe batch in up to ~90 s (generation + one regeneration).
const SCAN_TIMEOUT_MS = 45_000;
const BARCODE_TIMEOUT_MS = 20_000;
const RECIPES_TIMEOUT_MS = 150_000;
export const AI_NOTICE_VERSION = 1;

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

export function useAcceptAiNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/api/ai/notice', { method: 'POST', body: JSON.stringify({ version: AI_NOTICE_VERSION }) }),
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
  }));

export const lookupBarcode = (ean: string, language: string) => withTimeout(BARCODE_TIMEOUT_MS, (signal) =>
  apiFetch<AiScanResult>('/api/ai/barcode', {
    method: 'POST', body: JSON.stringify({ ean, language: appLanguage(language) }), signal,
  }));

export type RecipeRequest = { mode: 'scan'; item: AiScanItem } | { mode: 'smart_bar' };

export const generateRecipes = (request: RecipeRequest, language: string, newSession: boolean) =>
  withTimeout(RECIPES_TIMEOUT_MS, (signal) => apiFetch<AiRecipeBatch>('/api/ai/recipes', {
    method: 'POST', body: JSON.stringify({ ...request, language: appLanguage(language), newSession }), signal,
  }));

export function useSavedRecipes(enabled = true) {
  const { serverUserId } = useAuth();
  return useQuery<AiRecipe[]>({
    queryKey: SAVED_RECIPES_KEY,
    enabled: enabled && !!serverUserId,
    queryFn: async () => (await apiFetch<{ items: AiRecipe[] }>('/api/recipes/saved')).items,
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
  'ai_disabled', 'ai_unavailable', 'ai_timeout', 'ai_invalid_output', 'ai_rate_limit', 'ai_busy', 'ai_notice_required',
  'barcode_unavailable', 'barcode_not_found', 'barcode_invalid', 'smart_bar_empty', 'water_no_recipes', 'recipe_limit',
  'recipe_invalid',
]);

/** i18n key for an AI error: offline, a known server code, too large, rate limited, or generic. */
export function getAiErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code && KNOWN_AI_ERRORS.has(error.code)) return `ai.errors.${error.code}`;
    if (error.status === 413) return 'ai.errors.image_too_large';
    if (error.status === 429) return 'ai.errors.ai_rate_limit';
    if (error.status === 400) return 'ai.errors.image_invalid';
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
