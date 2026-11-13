// Development-only log bridge for device test sessions (npm run test:ios, docs/IOS_TEST_SESSION.md).
//
// App.tsx loads this file only when __DEV__, so a release build does not contain it. It sends to
// POST /__dev/client-log on the API server, which exists only when the server runs with
// NODE_ENV=development (server/dev-log-bridge.js). When the server answers 404 the bridge turns itself off.
//
// Captured: console.error and console.warn, the global JS error handler (fatal or not), unhandled promise
// rejections (React Native reports them through console.warn), ErrorBoundary catches, failed API calls
// (method, path without query, status, error code, duration), screen changes and tester notes.
// Never captured: request or response bodies, headers or tokens. Every text is redacted here (emails,
// JWTs, bearer tokens, key=value secrets, Google keys, long opaque tokens, URL query strings) and again
// on the server.
import { Platform } from 'react-native';

import { API_BASE_URL } from './api';
import { devHooks, type ApiFailure } from './devHooks';

type EntryKind = 'console' | 'error' | 'rejection' | 'boundary' | 'api' | 'nav' | 'note';

type LogEntry = {
  kind: EntryKind;
  clientTs: string;
  appSession: string;
  platform: string;
  screen?: string;
  trail?: string[];
  level?: 'error' | 'warn' | 'info';
  message?: string;
  stack?: string;
  componentStack?: string;
  fatal?: boolean;
} & Partial<Omit<ApiFailure, 'path'>> & { path?: string };

const FLUSH_INTERVAL_MS = 2000;
// Keeps a batch well under the server's 100 kB JSON limit.
const MAX_BATCH = 15;
const MAX_QUEUE = 200;
const SEND_TIMEOUT_MS = 5000;
const TRAIL_LENGTH = 5;
const MESSAGE_LIMIT = 1500;
const STACK_LIMIT = 3000;

const REDACTIONS: [RegExp, string | ((match: string, base: string) => string)][] = [
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[jwt]'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [token]'],
  [/\bAIza[\w-]{30,}/g, '[google-key]'],
  [/[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/[\w.+-]+%40[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi, '[email]'],
  [/(\bhttps?:\/\/[^\s?#"']+)\?[^\s#"']*/gi, (match, base) => (/\.(bundle|map)$/i.test(base) ? match : `${base}?[query]`)],
  [/([\w-]*(?:token|password|passwd|secret|api_?key|apikey|private_?key|authorization|code_verifier)["']?\s*[:=]\s*["']?)(?!Bearer\b|\[)[^\s"'&,;}\]]+/gi, '$1[redacted]'],
  // A bare code or key only when the value is long: "code":"age_required" and status codes stay readable.
  [/(\b(?:code|key)\b["']?\s*[:=]\s*["']?)(?!\[)[^\s"'&,;}\]]{16,}/gi, '$1[redacted]'],
];
const OPAQUE_RUN = /[A-Za-z0-9_+/=-]{32,}/g;
const looksLikeToken = (run: string) => (
  /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && (run.match(/\//g)?.length ?? 0) <= 2
);

export function redactDevText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  }
  return out.replace(OPAQUE_RUN, (run) => (looksLikeToken(run) ? '[token]' : run));
}

const cut = (value: string | undefined | null, limit: number) => {
  if (!value) return undefined;
  const text = redactDevText(value);
  return text.length > limit ? `${text.slice(0, limit)}…[cut]` : text;
};

const appSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let isInstalled = false;
let isDisabled = false;
let isSending = false;
let queue: LogEntry[] = [];
let currentScreen: string | undefined;
let trail: string[] = [];
// The unwrapped console, so the bridge never logs through itself.
let originalLog: (...args: unknown[]) => void = () => {};

const enqueue = (entry: Omit<LogEntry, 'clientTs' | 'appSession' | 'platform' | 'screen' | 'trail'>, withTrail = false) => {
  if (isDisabled) return;
  queue.push({
    ...entry,
    clientTs: new Date().toISOString(),
    appSession,
    platform: Platform.OS,
    screen: currentScreen,
    ...(withTrail && trail.length > 0 && { trail: trail.slice(-TRAIL_LENGTH) }),
  });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
};

async function flush(): Promise<void> {
  if (isDisabled || isSending || queue.length === 0 || !API_BASE_URL) return;
  isSending = true;
  const batch = queue.slice(0, MAX_BATCH);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/__dev/client-log`, {
      method: 'POST',
      // The server refuses a batch without this header, so a web page cannot post one with a plain form.
      headers: { 'Content-Type': 'application/json', 'X-DrinkMe-Dev-Log': '1' },
      body: JSON.stringify({ entries: batch }),
      signal: controller.signal,
    });
    if (response.status === 404) {
      // The server is not in development mode: stop collecting for this app session.
      isDisabled = true;
      queue = [];
      originalLog('[devLog] The API server has no /__dev/client-log (NODE_ENV is not development); app logs are not sent.');
      return;
    }
    // Sent, or refused for good (400, 413): either way this batch is done. 429 and 5xx retry later.
    if (response.ok || response.status === 400 || response.status === 413) queue = queue.slice(batch.length);
  } catch {
    // Offline or the server is down: keep the queue (capped) and try again on the next tick.
  } finally {
    clearTimeout(timeout);
    isSending = false;
  }
}

const formatArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
};

const wrapConsole = (level: 'error' | 'warn') => {
  const original = console[level].bind(console);
  let isInside = false;
  console[level] = (...args: unknown[]) => {
    if (!isInside) {
      isInside = true;
      try {
        const message = args.map(formatArg).join(' ');
        const error = args.find((arg): arg is Error => arg instanceof Error);
        const isRejection = /possible unhandled promise rejection/i.test(message);
        enqueue({
          kind: isRejection ? 'rejection' : 'console',
          level,
          message: cut(message, MESSAGE_LIMIT),
          stack: cut(error?.stack, STACK_LIMIT),
        }, true);
      } catch {
        // Logging must never break the app.
      } finally {
        isInside = false;
      }
    }
    original(...args);
  };
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler?: () => GlobalErrorHandler; setGlobalHandler?: (handler: GlobalErrorHandler) => void };

// Kept on globalThis: Fast Refresh re-runs this module, and a second install would wrap console again.
const INSTALLED_FLAG = '__drinkmeDevLogBridgeInstalled';

export function installDevLogBridge(): void {
  const globalFlags = globalThis as unknown as Record<string, boolean | undefined>;
  if (!__DEV__ || isInstalled || globalFlags[INSTALLED_FLAG]) return;
  isInstalled = true;
  globalFlags[INSTALLED_FLAG] = true;
  if (!API_BASE_URL) return;
  originalLog = console.log.bind(console);

  wrapConsole('error');
  wrapConsole('warn');

  const errorUtils = (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  const previousHandler = errorUtils?.getGlobalHandler?.();
  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    try {
      const asError = error instanceof Error ? error : new Error(formatArg(error));
      enqueue({
        kind: 'error',
        level: 'error',
        fatal: Boolean(isFatal),
        message: cut(`${asError.name}: ${asError.message}`, MESSAGE_LIMIT),
        stack: cut(asError.stack, STACK_LIMIT),
      }, true);
      void flush();
    } catch {
      // Never stand between the app and React Native's own handler.
    }
    previousHandler?.(error, isFatal);
  });

  devHooks.apiFailure = (failure) => {
    enqueue({ kind: 'api', level: failure.status >= 500 || failure.status === 0 ? 'error' : 'warn', ...failure }, true);
  };
  devHooks.boundaryError = (error, componentStack) => {
    enqueue({
      kind: 'boundary',
      level: 'error',
      message: cut(`${error?.name ?? 'Error'}: ${error?.message ?? ''}`, MESSAGE_LIMIT),
      stack: cut(error?.stack, STACK_LIMIT),
      componentStack: cut(componentStack, STACK_LIMIT),
    }, true);
    void flush();
  };

  setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
}

/** The current screen, from NavigationContainer's onReady and onStateChange. */
export function setDevLogScreen(name: string | undefined): void {
  if (!name || name === currentScreen) return;
  currentScreen = name;
  trail = [...trail, name].slice(-TRAIL_LENGTH * 2);
  enqueue({ kind: 'nav' });
}

export function getDevLogScreen(): string | undefined {
  return currentScreen;
}

/** A tester's note, saved with the current screen and time. Sent at once. */
export function addDevNote(text: string): void {
  const message = cut(text.trim(), MESSAGE_LIMIT);
  if (!message) return;
  enqueue({ kind: 'note', level: 'info', message }, true);
  void flush();
}

export function isDevLogBridgeActive(): boolean {
  return isInstalled && !isDisabled && Boolean(API_BASE_URL);
}
