import type { Drink } from '../types/api';

// State shared by every useDrinkToggles caller. Kept apart from the hook so AuthContext and App can
// reset it without importing the hook (which imports AuthContext).

export type DrinkToggleKind = 'cheer' | 'save';

// The fields each toggle owns. A rollback puts back only these, so a cheer never undoes a save.
export type ToggleState = Pick<Drink, 'isLiked' | 'cheersCount'> | Pick<Drink, 'isSaved'>;

// Per user, kind and post: the state the server last confirmed, how many requests are still out,
// whether any of them changed the server, and the queries cancelled for them (fetched again once the
// chain settles). Only the last request to settle writes to the cache.
export interface ToggleChain {
  generation: number;
  confirmed: ToggleState;
  pending: number;
  changed: boolean;
  cancelledKeys: (readonly unknown[])[];
}

export const chains = new Map<string, ToggleChain>();
export const chainKey = (userId: string, kind: DrinkToggleKind, drinkId: number) => `${userId}|${kind}|${drinkId}`;

let generation = 0;
export const getToggleGeneration = () => generation;

// Call next to every queryClient.clear(). Clearing drops queued mutations without settling them, so
// their chains would never reach zero; a callback from an older generation is ignored.
export function resetDrinkToggles(): void {
  generation += 1;
  chains.clear();
}
