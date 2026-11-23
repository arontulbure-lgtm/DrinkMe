// End-to-end check of the AI flows through the REAL Express server and the REAL ai-service + model, without the app.
// Starts server.js in development mode with the insecure dev sign-in (no Firebase), a throwaway database under
// D:\AI\cache\tmp and AI_PROVIDER=local, then walks the app's flows over HTTP:
//   sign in → 18+ → privacy notice → AI status → AI notice → scan photo → barcode → recipes (scan mode)
//   → another batch (no repeats) → Smart Bar items → recipes (Smart Bar mode, only bar + basics) → save → list → unsave.
// Needs `npm run ai:start` first. Usage: node ai-service/eval/e2e_api.mjs [photo.jpg] [ean]
/* global setTimeout, AbortSignal */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5057;
const BASE = `http://127.0.0.1:${PORT}`;
const photo = process.argv[2];
const ean = process.argv[3];
const tmp = fs.mkdtempSync(path.join('D:\\AI\\cache\\tmp', 'e2e-'));
const results = [];
const step = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` – ${detail}` : ''}`); };

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp,
    NODE_ENV: 'development', ALLOW_INSECURE_DEV_AUTH: 'true', PORT: String(PORT), HOST: '127.0.0.1',
    JWT_SECRET: crypto.randomBytes(48).toString('base64'), FIREBASE_SERVICE_ACCOUNT_KEY: '',
    DB_FILE: path.join(tmp, 'db.json'), AI_PROVIDER: 'local', AI_SERVICE_URL: 'http://127.0.0.1:8088',
    AI_PHOTO_DIR: path.join(tmp, 'ai-scans'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let token = '';
const api = async (method, url, body, timeoutMs = 180_000) => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${url}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, ms: Date.now() - t0 };
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const uid = `e2e-${crypto.randomBytes(4).toString('hex')}`;
  const auth = await api('POST', '/api/auth/mobile', { idToken: 'dev-fallback-token', uid, email: `${uid}@example.test` });
  token = auth.body?.token;
  step('sign in (dev)', auth.status === 200 && !!token);
  step('age confirmation', (await api('POST', `/api/users/${uid}/acknowledgements`, { type: 'age', confirmed: true })).status === 200);
  step('privacy notice', (await api('POST', `/api/users/${uid}/acknowledgements`, { type: 'privacy', version: 2 })).status === 200);

  const status = await api('GET', '/api/ai/status?language=ro');
  step('AI status available', status.body?.available === true && status.body?.provider === 'local', JSON.stringify({ available: status.body?.available, noticeAccepted: status.body?.noticeAccepted }));
  const beforeNotice = await api('POST', '/api/ai/recipes', { mode: 'smart_bar' });
  step('notice required first', beforeNotice.status === 403 && beforeNotice.body?.code === 'ai_notice_required');
  step('accept AI notice', (await api('POST', '/api/ai/notice', { version: 1 })).status === 200);

  let item = { category: 'spirit', brand: 'Tanqueray', product: 'London Dry Gin', style: 'gin', abv: 43.1, volumeMl: 700 };
  if (photo) {
    const scan = await api('POST', '/api/ai/scan', { imageBase64: fs.readFileSync(photo).toString('base64'), language: 'en' });
    step('scan photo (real model)', scan.status === 200 && ['recognized', 'low_confidence'].includes(scan.body?.status),
      `${scan.ms} ms → ${scan.body?.status} ${scan.body?.item?.category} / ${scan.body?.item?.brand} / ${scan.body?.item?.product}`);
    if (scan.body?.item) item = scan.body.item;
    step('photo not kept without opt-in', !fs.existsSync(path.join(tmp, 'ai-scans')) || fs.readdirSync(path.join(tmp, 'ai-scans')).length === 0);
  }
  if (ean) {
    const bc = await api('POST', '/api/ai/barcode', { ean, language: 'en' });
    step('barcode lookup (Open Food Facts)', bc.status === 200, `${bc.ms} ms → ${bc.body?.status} ${bc.body?.item?.category} / ${bc.body?.item?.brand} / ${bc.body?.item?.product}`);
  }

  const first = await api('POST', '/api/ai/recipes', { mode: 'scan', item, language: 'ro', newSession: true });
  step('recipes from scanned item', first.status === 200 && first.body.recipes.length >= 1,
    `${first.ms} ms → ${first.body?.recipes?.map((r) => `${r.name}${r.isAlcoholic ? '' : ' [mocktail]'}`).join('; ') ?? first.body?.code}`);
  const second = await api('POST', '/api/ai/recipes', { mode: 'scan', item, language: 'ro' });
  const firstNames = new Set((first.body?.recipes ?? []).map((r) => r.name.toLowerCase()));
  const repeats = (second.body?.recipes ?? []).filter((r) => firstNames.has(r.name.toLowerCase()));
  step('another batch, no repeats', second.status === 200 && repeats.length === 0,
    `${second.ms} ms → ${second.body?.recipes?.map((r) => r.name).join('; ') ?? second.body?.code}${second.body?.exhausted ? ' (exhausted)' : ''}`);

  for (const name of ['Bombay Sapphire Gin', 'Schweppes Tonic', 'cucumber', 'lime', 'orange juice']) {
    await api('POST', '/api/smart-bar', { name, quantity: '1', unit: 'bottle' });
  }
  const bar = await api('POST', '/api/ai/recipes', { mode: 'smart_bar', language: 'en', newSession: true });
  step('recipes from Smart Bar', bar.status === 200 && bar.body.recipes.length >= 1,
    `${bar.ms} ms → ${bar.body?.recipes?.map((r) => `${r.name}${r.isAlcoholic ? ` (${r.standardDrinks} SD)` : ' [mocktail]'}`).join('; ') ?? bar.body?.code}`);
  step('Smart Bar batch has a mocktail', (bar.body?.recipes ?? []).some((r) => !r.isAlcoholic));

  const recipe = bar.body?.recipes?.[0] ?? first.body?.recipes?.[0];
  if (recipe) {
    const saved = await api('POST', '/api/recipes/saved', { recipe });
    step('save recipe', saved.status === 201);
    const list = await api('GET', '/api/recipes/saved');
    step('saved list', list.body?.items?.[0]?.id === recipe.id);
    step('unsave recipe', (await api('DELETE', `/api/recipes/saved/${recipe.id}`)).status === 204);
  }
  const leaked = /data:image|base64,|\/9j\//.test(serverOut);
  step('server log has no image data', !leaked);
} catch (err) {
  step('run', false, err.message);
} finally {
  server.kill();
  fs.writeFileSync(path.join('D:\\AI\\reports', `e2e-${Date.now()}.json`), JSON.stringify(results, null, 2));
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1500);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  process.exitCode = failed ? 1 : 0;
}
