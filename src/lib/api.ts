import Constants from 'expo-constants';
import type { ImageURISource } from 'react-native';

type RequestConfig = RequestInit & {
  query?: Record<string, string | number | boolean | undefined | null>;
};

// ── Token store (module-level, nu global) ──────────────────────────────────
// AuthContext apelează setApiToken() imediat după ce primește JWT-ul de la server.
// apiFetch îl injectează automat pe toate request-urile care nu au deja Authorization.
let _apiToken: string | null = null;

export function setApiToken(token: string | null): void {
  _apiToken = token;
}

export function getApiToken(): string | null {
  return _apiToken;
}

// AuthContext rebuilds the session when the server stops accepting the JWT in use, for example after a
// verified sign-in elsewhere logged out every earlier one. The new exchange either gives a fresh JWT or
// ends on the sign-in or session error screen.
// The handler answers whether it started a rebuild. A rebuild clears the token itself (setApiToken(null)).
let _staleTokenHandler: (() => boolean) | null = null;

export function setStaleTokenHandler(handler: (() => boolean) | null): void {
  _staleTokenHandler = handler;
}

// ── Config ─────────────────────────────────────────────────────────────────
const RAW_BASE_URL = Constants.expoConfig?.extra?.apiUrl || process.env.EXPO_PUBLIC_API_URL;
const API_BASE_URL = RAW_BASE_URL ? RAW_BASE_URL.replace(/\/$/, '') : '';

class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// The server sends { error, code } on limits. Any other body has no code.
function parseErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function buildUrl(path: string, query?: RequestConfig['query']) {
  if (!API_BASE_URL) {
    throw new ApiError('Missing EXPO_PUBLIC_API_URL environment variable.');
  }

  const url = new URL(path.startsWith('http') ? path : `${API_BASE_URL}${path}`);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  return url.toString();
}

export async function apiFetch<T>(path: string, config: RequestConfig = {}): Promise<T> {
  const { query, headers, ...rest } = config;
  const url = buildUrl(path, query);
  const isFormData = rest.body instanceof FormData;

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(!isFormData && rest.body ? { 'Content-Type': 'application/json' } : {}),
    ...(headers as Record<string, string> | undefined),
  };

  // Injectează automat Authorization dacă există un token și caller-ul nu l-a setat deja
  const hasAuthHeader = Object.keys(finalHeaders).some(
    (key) => key.toLowerCase() === 'authorization'
  );
  if (!hasAuthHeader && _apiToken) {
    finalHeaders.Authorization = `Bearer ${_apiToken}`;
  }
  // The token in use, whether injected here or passed by a screen from getJwtToken(). A header holding any
  // other token, such as the stored one checked at session start, says nothing about the current session.
  const sentAuthorization = Object.entries(finalHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  const usedToken = _apiToken && sentAuthorization === `Bearer ${_apiToken}` ? _apiToken : null;

  const response = await fetch(url, {
    headers: finalHeaders,
    ...rest,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new ApiError(text || response.statusText, response.status, parseErrorCode(text));
    // Only for the token in use: a request that ran with a token since replaced says nothing about the
    // current session, and sign-in itself is the rebuild. A started rebuild clears the token at once, so
    // the other requests failing alongside this one do not start it again. When the handler declines
    // (throttled, or no ready session) the token stays, so a later 401 can still start the rebuild and
    // the app is never left signed in with no token.
    if (usedToken && usedToken === _apiToken && path !== '/api/auth/mobile' && isStaleJwtError(error)) {
      _staleTokenHandler?.();
    }
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// Image source for a path or URL from the API: own media or https, otherwise no image.
// The token goes only to this server's /media routes.
// The prefix ends in a slash, so it cannot match another host that merely starts the same way.
// Other URLs get an empty headers object, not none: Android's image view ignores null headers and
// would otherwise resend the previous image's token, for example to a Google photo URL.
export function getImageSource(uri: string | null | undefined): ImageURISource {
  if (!uri) return {};
  const isRelativeMedia = uri.startsWith('/media/');
  if (isRelativeMedia && !API_BASE_URL) return {};
  const absoluteUri = isRelativeMedia ? `${API_BASE_URL}${uri}` : uri;
  const isOwnMedia = isRelativeMedia || (!!API_BASE_URL && uri.startsWith(`${API_BASE_URL}/media/`));
  if (!isOwnMedia && !uri.startsWith('https://')) return {};
  return {
    uri: absoluteUri,
    headers: isOwnMedia && _apiToken ? { Authorization: `Bearer ${_apiToken}` } : {},
  };
}

export function isStorageFullError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 507;
}

// The post a request names no longer exists, for example because its owner deleted it.
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

// The post is alcoholic and this user has not confirmed their age.
export function isAgeRequiredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'age_required';
}

// For queries about one post. Neither a deleted post nor a missing age confirmation is worth the app's one retry.
export function retryUnlessNotFound(failureCount: number, error: unknown): boolean {
  return !isNotFoundError(error) && !isAgeRequiredError(error) && failureCount < 1;
}

// Translation key for a failed comment POST, shared by the comment drawer and the detail screen.
export function getCommentErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'errors.commentFailed';
  if (error.code === 'age_required') return 'ageGate.required';
  if (error.code === 'daily_comment_limit') return 'errors.commentDailyLimit';
  if (error.status === 429) return 'common.tooManyRequests';
  if (error.status === 507) return 'common.serviceUnavailable';
  return 'errors.commentFailed';
}

// Translation keys for a failed report or block, shown inside the actions sheet.
export function getReportErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'report.failed';
  if (error.code === 'daily_report_limit') return 'report.dailyLimit';
  if (error.status === 429) return 'common.tooManyRequests';
  if (error.status === 507) return 'common.serviceUnavailable';
  return 'report.failed';
}

export function getBlockErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'block.failed';
  if (error.code === 'block_limit') return 'block.limitReached';
  if (error.status === 429) return 'common.tooManyRequests';
  if (error.status === 507) return 'common.serviceUnavailable';
  return 'block.failed';
}

// The deletion request was sent and may have worked. Only rebuilding the session can tell.
export class DeletionOutcomeUnknownError extends Error {
  constructor() {
    super('Account deletion outcome unknown');
    this.name = 'DeletionOutcomeUnknownError';
  }
}

// Firebase's codes for a wrong password. Newer projects report the second one.
const WRONG_PASSWORD_CODES = new Set(['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials']);

// Takes Firebase errors too, because deleting an account re-authenticates first.
export function getDeleteAccountErrorKey(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && WRONG_PASSWORD_CODES.has(code)) return 'deleteAccount.wrongPassword';
  if (code === 'auth/too-many-requests' || (error instanceof ApiError && error.status === 429)) return 'common.tooManyRequests';
  return 'deleteAccount.failed';
}

// The JWT was refused by the login check itself: its user is gone or it expired. The session must be rebuilt to tell which.
export function isStaleJwtError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === undefined;
}

// Translation key for the session error screen. 503 is a failed save or missing Firebase key, 507 is full storage.
export function getSessionErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'session.errorBody';
  if (error.status === 503 || error.status === 507) return 'common.serviceUnavailable';
  if (error.status === 429) return 'common.tooManyRequests';
  return 'session.errorBody';
}

export { ApiError, API_BASE_URL };
