import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { apiFetch, isAgeRequiredError, isStorageFullError } from './api';
import {
  cancelDrinkFetches,
  findCachedDrink,
  removeDrinkIfNotFound,
  syncSavedList,
  trimAndInvalidate,
  updateDrinkInCaches,
} from './drinkCache';
import { chainKey, chains, DrinkToggleKind, getToggleGeneration, ToggleChain, ToggleState } from './drinkToggleChains';
import { CheerRequest, CheerResult, Drink, SaveRequest, SaveResult } from '../types/api';

export type { DrinkToggleKind } from './drinkToggleChains';
export { resetDrinkToggles } from './drinkToggleChains';

const pickState = (kind: DrinkToggleKind, drink: Drink | undefined): ToggleState => (
  kind === 'cheer'
    ? { isLiked: drink?.isLiked ?? false, cheersCount: drink?.cheersCount ?? 0 }
    : { isSaved: drink?.isSaved ?? false }
);

const isOn = (kind: DrinkToggleKind, drink: Drink | undefined) => (kind === 'cheer' ? drink?.isLiked : drink?.isSaved) === true;

// The tapped state, with the count moved by one. A copy already in that state is left as it is.
const applyTarget = (kind: DrinkToggleKind, target: boolean) => (drink: Drink): Drink => {
  if (isOn(kind, drink) === target) return drink;
  if (kind === 'save') return { ...drink, isSaved: target };
  return { ...drink, isLiked: target, cheersCount: Math.max(0, (drink.cheersCount ?? 0) + (target ? 1 : -1)) };
};

// The last request of a chain has settled, whether it worked or not: the cache takes the state the
// server last confirmed. If any request changed the server, the saved list follows it. Queries cancelled
// for this chain are fetched again, trimmed first.
const settleChain = (queryClient: QueryClient, kind: DrinkToggleKind, drinkId: number, userId: string, chain: ToggleChain) => {
  const { confirmed } = chain;
  updateDrinkInCaches(queryClient, drinkId, (drink) => ({ ...drink, ...confirmed }));
  if (kind === 'save' && chain.changed && 'isSaved' in confirmed) {
    syncSavedList(queryClient, userId, drinkId, confirmed.isSaved === true);
  }
  const seen = new Set<string>();
  chain.cancelledKeys.forEach((queryKey) => {
    const id = JSON.stringify(queryKey);
    if (seen.has(id)) return;
    seen.add(id);
    trimAndInvalidate(queryClient, { queryKey, exact: true });
  });
};

export interface DrinkTogglesOptions {
  // Replaces the default alert. Called once the last request for that post has failed and the cache
  // is back to the confirmed state; a 404 is the caller's to handle (see removeDrinkIfNotFound).
  onError?: (error: unknown, drinkId: number, kind: DrinkToggleKind) => void;
  // Title for the default alert.
  alertTitleKey?: string;
}

// Optimistic cheer and save, shared by every screen that shows posts.
// - The button changes at once and the request names the state wanted ({ cheered } / { saved }), so a
//   repeat changes nothing on the server.
// - Requests for one post run one after another (React Query mutation scope 'drink-<id>'), so answers
//   cannot arrive out of order. The mutation is built per tap because the scope depends on the post.
// - A failure puts back the state the server last confirmed. Every callback first checks that the user
//   who tapped is still signed in and that the chain is from the current generation (resetDrinkToggles
//   runs with every queryClient.clear()), so an answer never writes into the next user's cache.
export function useDrinkToggles({ onError, alertTitleKey }: DrinkTogglesOptions = {}) {
  const queryClient = useQueryClient();
  const { serverUserId } = useAuth();
  const { t } = useLocalization();
  // The latest handler, so a screen can pass an inline function without rebuilding the toggles.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const showDefaultError = useCallback(
    (error: unknown, drinkId: number, kind: DrinkToggleKind, userId: string) => {
      let key = kind === 'cheer' ? 'errors.cheerFailed' : 'errors.saveFailed';
      if (removeDrinkIfNotFound(queryClient, error, drinkId, userId)) key = 'post.notFound';
      else if (isAgeRequiredError(error)) key = 'ageGate.required';
      else if (isStorageFullError(error)) key = 'common.serviceUnavailable';
      if (alertTitleKey) Alert.alert(t(alertTitleKey), t(key));
      else Alert.alert(t(key));
    },
    [alertTitleKey, queryClient, t]
  );

  const run = useCallback(
    (kind: DrinkToggleKind, drink: Drink) => {
      const userId = serverUserId;
      if (!userId || !isCurrentAuthUser(userId)) return;
      const generation = getToggleGeneration();
      const drinkId = drink.id;
      const key = chainKey(userId, kind, drinkId);
      // The cache is newer than the drink a screen rendered with.
      const target = !isOn(kind, findCachedDrink(queryClient, drinkId) ?? drink);
      const path = `/api/drinks/${drinkId}/${kind === 'cheer' ? 'like' : 'save'}`;
      const body: CheerRequest | SaveRequest = kind === 'cheer' ? { cheered: target } : { saved: target };
      const isCurrent = () => generation === getToggleGeneration() && isCurrentAuthUser(userId);
      // The chain this request joined, while it is still the live one for its key.
      const liveChain = (joined: ToggleChain | null | undefined) => (
        joined && joined.generation === getToggleGeneration() && chains.get(key) === joined ? joined : undefined
      );

      const mutation = queryClient.getMutationCache().build<CheerResult | SaveResult, unknown, boolean, ToggleChain | null>(queryClient, {
        mutationKey: ['drinks.toggle', kind, drinkId],
        scope: { id: `drink-${drinkId}` },
        // A request queued behind others for this post must not go out with the next user's token.
        mutationFn: async () => {
          if (!isCurrent()) throw new Error('The user who tapped is no longer signed in.');
          return apiFetch<CheerResult | SaveResult>(path, { method: 'POST', body: JSON.stringify(body) });
        },
        // The context is the chain this request joined; without one the callbacks write nothing.
        onMutate: async () => {
          if (!isCurrent()) return null;
          let cancelledKeys: (readonly unknown[])[] = [];
          try {
            cancelledKeys = await cancelDrinkFetches(queryClient, drinkId);
          } catch {
            // Nothing was cancelled; the optimistic state still applies.
          }
          if (!isCurrent()) return null;
          const chain = chains.get(key) ?? {
            generation,
            confirmed: pickState(kind, findCachedDrink(queryClient, drinkId) ?? drink),
            pending: 0,
            changed: false,
            cancelledKeys: [],
          };
          chain.pending += 1;
          chain.cancelledKeys.push(...cancelledKeys);
          chains.set(key, chain);
          updateDrinkInCaches(queryClient, drinkId, applyTarget(kind, target));
          return chain;
        },
        onSuccess: (result, _variables, joined) => {
          const chain = liveChain(joined);
          if (!chain) return;
          chain.pending -= 1;
          chain.changed = true;
          chain.confirmed = 'cheered' in result
            ? { isLiked: result.cheered, cheersCount: result.cheersCount }
            : { isSaved: result.saved };
          if (chain.pending > 0) return;
          chains.delete(key);
          if (!isCurrentAuthUser(userId)) return;
          settleChain(queryClient, kind, drinkId, userId, chain);
        },
        onError: (error, _variables, joined) => {
          const chain = liveChain(joined);
          if (!chain) return;
          chain.pending -= 1;
          // A later request for this post is still on its way and decides the final state.
          if (chain.pending > 0) return;
          chains.delete(key);
          if (!isCurrentAuthUser(userId)) return;
          settleChain(queryClient, kind, drinkId, userId, chain);
          const handleError = onErrorRef.current;
          if (handleError) handleError(error, drinkId, kind);
          else showDefaultError(error, drinkId, kind, userId);
        },
      });
      // Failures are handled in onError.
      mutation.execute(target).catch(() => undefined);
    },
    [queryClient, serverUserId, showDefaultError]
  );

  const toggleCheer = useCallback((drink: Drink) => run('cheer', drink), [run]);
  const toggleSave = useCallback((drink: Drink) => run('save', drink), [run]);

  return { toggleCheer, toggleSave };
}
