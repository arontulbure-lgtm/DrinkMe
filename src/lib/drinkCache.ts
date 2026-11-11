import { InfiniteData, QueryClient, QueryFilters } from '@tanstack/react-query';
import { isCurrentAuthUser } from '../context/AuthContext';
import { isNotFoundError } from './api';
import { BaseUser, Comment, Drink, PartnerStatus, Page } from '../types/api';

// Callers check isCurrentAuthUser first: these helpers write to the cache of whoever is signed in now.

type DrinkPage = Page<Drink>;
type DrinkListData = InfiniteData<DrinkPage, unknown> | DrinkPage;

// Every cached list of posts. Most hold loaded pages; drinks.trending holds a single page.
const DRINK_LIST_QUERY_KEYS = new Set<unknown>([
  'drinks.all',
  'drinks.partners',
  'drinks.search',
  'drinks.trending',
  'drinks.byUser',
  'users.savedDrinks',
]);

const DRINK_ITEM_QUERY_KEYS = new Set<unknown>(['drinks.detail', 'drinks.comments']);

const PARTNER_FEED_QUERY_KEYS = new Set<unknown>(['drinks.partners', 'drinks.all', 'drinks.trending']);

// Every cached list or record that shows a user's name or avatar. users.detail is written directly.
const AUTHOR_BEARING_QUERY_KEYS = new Set<unknown>([
  'drinks.all',
  'drinks.partners',
  'drinks.search',
  'drinks.byUser',
  'drinks.detail',
  'drinks.comments',
  'users.savedDrinks',
  'users.search',
  'drink-partners',
]);

const isDrinkListQuery = ({ queryKey }: { queryKey: readonly unknown[] }) => DRINK_LIST_QUERY_KEYS.has(queryKey[0]);

const mapDrinkPages = (data: DrinkListData | undefined, mapPage: (page: DrinkPage) => DrinkPage) => {
  if (!data) return data;
  return 'pages' in data ? { ...data, pages: data.pages.map(mapPage) } : mapPage(data);
};

export const getNextCursor = <T,>(lastPage: Page<T>) => lastPage.nextCursor ?? undefined;

export function flattenPages<T>(data: InfiniteData<Page<T>, unknown> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

// A refetch makes one request per loaded page, and the API allows 100 per 15 minutes per IP.
// Trimming first makes it one request; the rest load again through Load more.
export function trimToFirstPage(queryClient: QueryClient, filters: QueryFilters): void {
  queryClient.setQueriesData<unknown>(filters, (existing) => {
    const isInfinite = !!existing && typeof existing === 'object' && 'pages' in existing && 'pageParams' in existing;
    if (!isInfinite) return existing;
    const { pages, pageParams } = existing as InfiniteData<unknown, unknown>;
    return pages.length > 1
      ? { ...existing, pages: pages.slice(0, 1), pageParams: pageParams.slice(0, 1) }
      : existing;
  });
}

export function trimAndInvalidate(queryClient: QueryClient, filters: QueryFilters): void {
  trimToFirstPage(queryClient, filters);
  queryClient.invalidateQueries(filters);
}

// Unsaving needs no request: the item leaves the cached list. Saving has to fetch the list, unless
// the removal emptied what is loaded while older pages remain, which would look like an empty list.
export function syncSavedList(queryClient: QueryClient, userId: string, drinkId: number, saved: boolean): void {
  const queryKey = ['users.savedDrinks', userId];
  if (saved) {
    trimAndInvalidate(queryClient, { queryKey });
    return;
  }
  const remaining = queryClient.setQueryData<InfiniteData<DrinkPage, unknown>>(queryKey, (existing) =>
    existing && {
      ...existing,
      pages: existing.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== drinkId),
      })),
    }
  );
  if (remaining && flattenPages(remaining).length === 0 && remaining.pages[remaining.pages.length - 1]?.nextCursor !== null) {
    trimAndInvalidate(queryClient, { queryKey });
  }
}

// What this user may see changed, so every post list, post and comment list is fetched again.
export function invalidateDrinkQueries(queryClient: QueryClient): void {
  trimAndInvalidate(queryClient, {
    predicate: (query) => isDrinkListQuery(query) || DRINK_ITEM_QUERY_KEYS.has(query.queryKey[0]),
  });
}

// The signed-in user's name or avatar changed.
export function invalidateAuthorQueries(queryClient: QueryClient): void {
  trimAndInvalidate(queryClient, {
    predicate: ({ queryKey }) => AUTHOR_BEARING_QUERY_KEYS.has(queryKey[0]),
  });
}

export function updateDrinkInCaches(
  queryClient: QueryClient,
  drinkId: number,
  updater: (drink: Drink) => Drink
): void {
  queryClient.setQueriesData<DrinkListData>({ predicate: isDrinkListQuery }, (existing) =>
    mapDrinkPages(existing, (page) => ({
      ...page,
      items: page.items.map((item) => (item.id === drinkId ? updater(item) : item)),
    }))
  );
  queryClient.setQueryData<Drink>(['drinks.detail', drinkId], (existing) => (existing ? updater(existing) : existing));
}

// Puts a new post on the signed-in user's own lists. A list not loaded yet stays that way, because
// one post would otherwise pass for the whole list. Discover never holds the user's own posts.
export function prependDrink(queryClient: QueryClient, drink: Drink, userId: string): void {
  const prepend = (existing: InfiniteData<DrinkPage, unknown> | undefined) => {
    if (!existing?.pages.length) return existing;
    const isKnown = existing.pages.some((page) => page.items.some((item) => item.id === drink.id));
    const pages = existing.pages.map((page, index) => {
      const items = page.items.filter((item) => item.id !== drink.id);
      return {
        ...page,
        items: index === 0 ? [drink, ...items] : items,
        ...(page.total !== undefined && { total: isKnown ? page.total : page.total + 1 }),
      };
    });
    return { ...existing, pages };
  };
  queryClient.setQueryData<InfiniteData<DrinkPage, unknown>>(['drinks.partners'], prepend);
  queryClient.setQueryData<InfiniteData<DrinkPage, unknown>>(['drinks.byUser', userId], prepend);
  queryClient.setQueryData<Drink>(['drinks.detail', drink.id], drink);
  trimAndInvalidate(queryClient, { queryKey: ['drinks.search'] });
}

// Removing an item keeps the cursors valid, because `before` works for an id that no longer exists,
// so a list that held the post stays where the user scrolled to. Only what the cache cannot work out
// goes back to the server, trimmed first: a total for a post on a page not loaded yet (a removal from
// DrinkDetail, say), a list now empty with more behind it, and trending, which has no later page to
// fill the gap from.
// A list fetch already on its way can still hold the post, so it is cancelled first. A list with data
// is only marked stale; a first load has nothing to show, so it starts again or would spin forever.
// refetchGaps false is for a report: the post still exists, so a refetch would bring it straight back.
// A list emptied with more behind it is still fetched, or it would look empty.
export function removeDrinkFromCaches(
  queryClient: QueryClient,
  drinkId: number,
  { refetchGaps = true }: { refetchGaps?: boolean } = {}
): void {
  const interrupted = queryClient.getQueryCache().findAll({
    predicate: (query) => isDrinkListQuery(query) && query.state.fetchStatus !== 'idle',
  });
  void queryClient.cancelQueries({ predicate: isDrinkListQuery });
  queryClient.getQueriesData<DrinkListData>({ predicate: isDrinkListQuery }).forEach(([queryKey, existing]) => {
    if (!existing) return;
    const pages: DrinkPage[] = 'pages' in existing ? existing.pages : [existing];
    const wasLoaded = pages.some((page) => page.items.some((item) => item.id === drinkId));
    if (wasLoaded) {
      queryClient.setQueryData<DrinkListData>(queryKey, mapDrinkPages(existing, (page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== drinkId),
        ...(page.total !== undefined && { total: Math.max(0, page.total - 1) }),
      })));
    }
    const hasOtherItems = pages.some((page) => page.items.some((item) => item.id !== drinkId));
    const hasMorePages = (pages[pages.length - 1]?.nextCursor ?? null) !== null;
    const isTotalStale = !wasLoaded && pages[0]?.total !== undefined;
    const isEmptiedWithMore = wasLoaded && !hasOtherItems && hasMorePages;
    const isTrendingGap = wasLoaded && queryKey[0] === 'drinks.trending';
    if (isEmptiedWithMore || (refetchGaps && (isTotalStale || isTrendingGap))) {
      trimAndInvalidate(queryClient, { queryKey, exact: true });
    }
  });
  interrupted.forEach(({ queryKey, state }) => {
    queryClient.invalidateQueries({ queryKey, exact: true, refetchType: state.data === undefined ? 'active' : 'none' });
  });
  queryClient.removeQueries({ queryKey: ['drinks.detail', drinkId] });
  queryClient.removeQueries({ queryKey: ['drinks.comments', drinkId] });
}

// Any cached copy of a post, from its own query or from a list. Undefined when none is held.
export function findCachedDrink(queryClient: QueryClient, drinkId: number): Drink | undefined {
  const detail = queryClient.getQueryData<Drink>(['drinks.detail', drinkId]);
  if (detail) return detail;
  for (const [, data] of queryClient.getQueriesData<DrinkListData>({ predicate: isDrinkListQuery })) {
    if (!data) continue;
    const pages: DrinkPage[] = 'pages' in data ? data.pages : [data];
    for (const page of pages) {
      const found = page.items.find((item) => item.id === drinkId);
      if (found) return found;
    }
  }
  return undefined;
}

// Before an optimistic cheer or save: a fetch already on its way (a refresh, or a refetch after an
// invalidate) could write the old state over it. Cancelled: queries that hold the post, already have
// data and are not loading a further page, so the cancel goes back to the data on screen; a first load
// or Load more is left alone. Returns the cancelled keys: the caller fetches them again with
// trimAndInvalidate once its requests have settled, so they do not stay on the old data.
export async function cancelDrinkFetches(queryClient: QueryClient, drinkId: number): Promise<(readonly unknown[])[]> {
  const holdsDrink = (queryKey: readonly unknown[], data: unknown) => {
    if (queryKey[0] === 'drinks.detail') return queryKey[1] === drinkId;
    if (!DRINK_LIST_QUERY_KEYS.has(queryKey[0])) return false;
    const list = data as DrinkListData;
    const pages: DrinkPage[] = 'pages' in list ? list.pages : [list];
    return pages.some((page) => page.items?.some((item) => item.id === drinkId));
  };
  const fetching = queryClient.getQueryCache().findAll({
    predicate: ({ queryKey, state }) => state.fetchStatus !== 'idle'
      && state.data !== undefined
      && !state.fetchMeta?.fetchMore
      && holdsDrink(queryKey, state.data),
  });
  await Promise.all(fetching.map(({ queryKey }) => queryClient.cancelQueries({ queryKey, exact: true })));
  return fetching.map(({ queryKey }) => queryKey);
}

// The cursors stay valid, as they do for a post. A list emptied with older pages behind it is fetched again.
export function removeCommentFromCache(queryClient: QueryClient, drinkId: number, commentId: number): void {
  const queryKey = ['drinks.comments', drinkId];
  const remaining = queryClient.setQueryData<InfiniteData<Page<Comment>, unknown>>(queryKey, (existing) =>
    existing && {
      ...existing,
      pages: existing.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== commentId),
      })),
    }
  );
  if (remaining && flattenPages(remaining).length === 0 && remaining.pages[remaining.pages.length - 1]?.nextCursor !== null) {
    trimAndInvalidate(queryClient, { queryKey });
  }
}

// With no user id, every cached profile: notifications do not say who acted.
const invalidateUserQueries = (queryClient: QueryClient, userId?: string) => {
  queryClient.invalidateQueries({ queryKey: userId ? ['users.detail', userId] : ['users.detail'] });
  queryClient.invalidateQueries({ queryKey: ['users.search'] });
  queryClient.invalidateQueries({ queryKey: ['drink-partners'] });
  queryClient.invalidateQueries({ queryKey: ['friends.count'] });
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
  queryClient.invalidateQueries({ queryKey: ['blocks'] });
};

// After a block. What that user wrote leaves the cache at once, then every list is fetched again, trimmed
// first. A post open on a screen stays cached: its refetch gets the 404 that screen knows how to show.
export function removeUserFromCaches(queryClient: QueryClient, userId: string): void {
  void queryClient.cancelQueries({ predicate: isDrinkListQuery });
  const postIds = new Set<unknown>();
  queryClient.getQueriesData<DrinkListData>({ predicate: isDrinkListQuery }).forEach(([queryKey, existing]) => {
    if (!existing) return;
    const pages: DrinkPage[] = 'pages' in existing ? existing.pages : [existing];
    let removedCount = 0;
    pages.forEach((page) => page.items.forEach((item) => {
      if (item.userId !== userId) return;
      postIds.add(item.id);
      removedCount += 1;
    }));
    queryClient.setQueryData<DrinkListData>(queryKey, mapDrinkPages(existing, (page) => ({
      ...page,
      items: page.items.filter((item) => item.userId !== userId),
      ...(page.total !== undefined && { total: Math.max(0, page.total - removedCount) }),
    })));
  });
  queryClient.getQueriesData<Drink>({ queryKey: ['drinks.detail'] }).forEach(([queryKey, existing]) => {
    if (existing?.userId === userId) postIds.add(queryKey[1]);
  });
  queryClient.setQueriesData<InfiniteData<Page<Comment>, unknown>>({ queryKey: ['drinks.comments'] }, (existing) =>
    existing && {
      ...existing,
      pages: existing.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.userId !== userId),
      })),
    }
  );
  queryClient.removeQueries({
    predicate: (query) => DRINK_ITEM_QUERY_KEYS.has(query.queryKey[0])
      && postIds.has(query.queryKey[1])
      && query.getObserversCount() === 0,
  });
  invalidateDrinkQueries(queryClient);
  invalidateUserQueries(queryClient, userId);
}

// A request changed and no partnership did, so no post list is affected.
export function invalidateAfterPartnerRequest(queryClient: QueryClient, userId?: string): void {
  invalidateUserQueries(queryClient, userId);
}

// A partnership started or ended, which moves posts between the partner feed and discover.
// Trimmed first, so this does not make one request per loaded page.
export function invalidateAfterPartnerChange(queryClient: QueryClient, userId?: string): void {
  trimAndInvalidate(queryClient, { predicate: ({ queryKey }) => PARTNER_FEED_QUERY_KEYS.has(queryKey[0]) });
  invalidateUserQueries(queryClient, userId);
}

// The button follows the answer at once, so a second press never acts on the old state.
export function setPartnerStatusInCaches(queryClient: QueryClient, userId: string, partnerStatus: PartnerStatus): void {
  const update = (user: BaseUser): BaseUser => ({
    ...user,
    partnerStatus,
    isPartner: partnerStatus === 'partner',
    partnerCount: partnerStatus === 'partner' ? user.partnerCount : undefined,
  });
  queryClient.setQueryData<BaseUser>(['users.detail', userId], (existing) => existing && update(existing));
  queryClient.setQueriesData<BaseUser[]>({ queryKey: ['users.search'] }, (existing) =>
    existing?.map((user) => (user.id === userId ? update(user) : user))
  );
}

// That user's posts and comments are visible again. The partnership does not come back.
export function invalidateAfterUnblock(queryClient: QueryClient, userId: string): void {
  invalidateDrinkQueries(queryClient);
  invalidateUserQueries(queryClient, userId);
}

// For a cheer, save or comment that got a 404. True when the post is gone, so the caller shows that
// instead of its usual error. Unlike the helpers above, this one checks the signed-in user itself.
export function removeDrinkIfNotFound(
  queryClient: QueryClient,
  error: unknown,
  drinkId: number,
  userId: string | null
): boolean {
  if (!isNotFoundError(error)) return false;
  if (isCurrentAuthUser(userId)) removeDrinkFromCaches(queryClient, drinkId);
  return true;
}
