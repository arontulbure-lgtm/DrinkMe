import Constants from 'expo-constants';

type RequestConfig = RequestInit & {
  query?: Record<string, string | number | boolean | undefined | null>;
};

declare global {
  var __DRINKME_UID: string | null | undefined;
}

if (typeof globalThis.__DRINKME_UID === 'undefined') {
  globalThis.__DRINKME_UID = null;
}

const RAW_BASE_URL = Constants.expoConfig?.extra?.apiUrl || process.env.EXPO_PUBLIC_API_URL;
const API_BASE_URL = RAW_BASE_URL ? RAW_BASE_URL.replace(/\/$/, '') : '';

class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
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

  const hasAuthHeader = Object.keys(finalHeaders).some(
    (key) => key.toLowerCase() === 'authorization'
  );

  if (!hasAuthHeader && globalThis.__DRINKME_UID) {
    finalHeaders.Authorization = `Bearer ${globalThis.__DRINKME_UID}`;
  }

  const response = await fetch(url, {
    headers: finalHeaders,
    ...rest,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(text || response.statusText, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export { ApiError, API_BASE_URL };
