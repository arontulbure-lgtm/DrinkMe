// Development-only listeners. Only src/lib/devLogBridge.ts sets them, and it is loaded only when
// __DEV__ (App.tsx), so in a release build they stay empty and every call site is skipped.
// Callers pass no request or response bodies, headers or tokens.

export type ApiFailure = {
  method: string;
  // Without the query string.
  path: string;
  // 0 when no answer arrived (offline, timeout, refused connection).
  status: number;
  code?: string;
  durationMs: number;
};

export const devHooks: {
  apiFailure?: (failure: ApiFailure) => void;
  boundaryError?: (error: Error, componentStack?: string | null) => void;
} = {};
