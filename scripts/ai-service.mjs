#!/usr/bin/env node
// Local AI service helper (Windows). Everything lives under AI_ROOT (default D:\AI), never on C:.
//   npm run ai:setup   folders, user env vars, Ollama (to D:\AI\Ollama), Python venv, pip packages, models
//   npm run ai:start   Ollama + ai-service in the background, model warmed up, health checked
//   npm run ai:health  prints the ai-service health and exits 0 when it is ok
//   npm run ai:stop    stops the ai-service (and Ollama if this script started it)
// Paths and env vars are documented in docs/ai/LOCAL_SETUP.md.
/* global Buffer, setTimeout, AbortSignal */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_DIR = path.join(ROOT, 'ai-service');
export const AI_ROOT = process.env.DRINKME_AI_ROOT || 'D:\\AI';
const P = {
  ollamaDir: path.join(AI_ROOT, 'Ollama'),
  ollamaExe: path.join(AI_ROOT, 'Ollama', 'ollama.exe'),
  models: path.join(AI_ROOT, 'ollama-models'),
  venv: path.join(AI_ROOT, 'venvs', 'drinkme-ai'),
  python: path.join(AI_ROOT, 'venvs', 'drinkme-ai', 'Scripts', 'python.exe'),
  cache: path.join(AI_ROOT, 'cache'),
  pip: path.join(AI_ROOT, 'cache', 'pip'),
  hf: path.join(AI_ROOT, 'cache', 'huggingface'),
  torch: path.join(AI_ROOT, 'cache', 'torch'),
  tmp: path.join(AI_ROOT, 'cache', 'tmp'),
  downloads: path.join(AI_ROOT, 'cache', 'downloads'),
  datasets: path.join(AI_ROOT, 'datasets'),
  reports: path.join(AI_ROOT, 'reports'),
  pidFile: path.join(AI_ROOT, 'reports', 'ai-service.pid'),
  ollamaPidFile: path.join(AI_ROOT, 'reports', 'ollama.pid'),
};
export const VISION_MODEL = process.env.DRINKME_VISION_MODEL || 'qwen3-vl:4b-instruct';
export const TEXT_MODEL = process.env.DRINKME_TEXT_MODEL || VISION_MODEL;
// Re-reads labels the first model was unsure about ('none' disables). Does not fit in 8 GB next to the 4B: Ollama swaps.
export const SECOND_PASS_MODEL = process.env.DRINKME_SECOND_PASS_MODEL === 'none' ? '' : (process.env.DRINKME_SECOND_PASS_MODEL || 'qwen3-vl:8b-instruct');
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1:11434';
const OLLAMA_URL = `http://${OLLAMA_HOST.replace(/^https?:\/\//, '')}`;
export const AI_SERVICE_PORT = Number(process.env.AI_SERVICE_PORT || 8088);
export const AI_SERVICE_URL = `http://127.0.0.1:${AI_SERVICE_PORT}`;

const log = (msg) => console.log(`[ai] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Env for every child: caches, temp and models on D:. The user env vars are set too by setup. */
export const aiEnv = () => ({
  ...process.env,
  OLLAMA_MODELS: P.models,
  OLLAMA_HOST,
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '30m',
  PIP_CACHE_DIR: P.pip,
  HF_HOME: P.hf,
  TORCH_HOME: P.torch,
  TMP: P.tmp,
  TEMP: P.tmp,
  DRINKME_VISION_MODEL: VISION_MODEL,
  DRINKME_TEXT_MODEL: TEXT_MODEL,
  DRINKME_SECOND_PASS_MODEL: SECOND_PASS_MODEL,
  DRINKME_MAX_IMAGE_SIDE: process.env.DRINKME_MAX_IMAGE_SIDE || '768',
  // Two recipe slots at once on the GPU (the server's AI_RECIPE_CONCURRENCY, default 2).
  OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '2',
  AI_SERVICE_PORT: String(AI_SERVICE_PORT),
  PYTHONDONTWRITEBYTECODE: '1',
});

const getJson = async (url, timeoutMs = 3000) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
const ollamaUp = async () => Boolean(await getJson(`${OLLAMA_URL}/api/version`));
export const serviceHealth = () => getJson(`${AI_SERVICE_URL}/v1/health`, 5000);

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: aiEnv(), ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ''} failed (exit ${r.status})`);
};

// The value travels in the child's environment, never inside the command text, so no quoting can break it.
function setUserEnv(name, value) {
  if (process.platform !== 'win32') return;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::SetEnvironmentVariable($env:DM_NAME, $env:DM_VAL, "User")'], {
    stdio: 'ignore', env: { ...process.env, DM_NAME: name, DM_VAL: value },
  });
}

/** True when the file carries a valid Authenticode signature from Ollama Inc. */
function isSignedByOllama(file) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    // Single quotes only: Windows PowerShell 5.1 drops embedded double quotes from -Command arguments.
    "$s = Get-AuthenticodeSignature -LiteralPath $env:DM_FILE; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)"], {
    encoding: 'utf8', env: { ...process.env, DM_FILE: file },
  });
  const [status, subject = ''] = (r.stdout ?? '').trim().split('|');
  return status === 'Valid' && /O=Ollama Inc\./.test(subject);
}

async function setup() {
  if (!fs.existsSync(path.parse(AI_ROOT).root)) throw new Error(`Drive of ${AI_ROOT} not found`);
  for (const dir of [P.ollamaDir, P.models, path.dirname(P.venv), P.pip, P.hf, P.torch, P.tmp, P.downloads, P.datasets, P.reports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const [name, value] of [['OLLAMA_MODELS', P.models], ['PIP_CACHE_DIR', P.pip], ['HF_HOME', P.hf], ['TORCH_HOME', P.torch], ['OLLAMA_HOST', OLLAMA_HOST]]) {
    setUserEnv(name, value);
  }
  log('Folders and user env vars set (see docs/ai/LOCAL_SETUP.md).');

  if (!fs.existsSync(P.ollamaExe)) {
    const installer = path.join(P.downloads, 'OllamaSetup.exe');
    log('Downloading the Ollama installer to D: ...');
    const res = await fetch('https://ollama.com/download/OllamaSetup.exe');
    if (!res.ok) throw new Error(`Ollama download failed (${res.status})`);
    fs.writeFileSync(installer, Buffer.from(await res.arrayBuffer()));
    if (!isSignedByOllama(installer)) {
      fs.rmSync(installer, { force: true });
      throw new Error('The downloaded Ollama installer is not validly signed by Ollama Inc.; deleted, not run.');
    }
    log(`Installing Ollama to ${P.ollamaDir} ...`);
    spawnSync(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${P.ollamaDir}`], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
    if (!fs.existsSync(P.ollamaExe)) throw new Error('Ollama did not install');
  } else {
    log(`Ollama found in ${P.ollamaDir}.`);
  }

  if (!fs.existsSync(P.python)) {
    log(`Creating the Python venv in ${P.venv} ...`);
    run('py', ['-3.12', '-m', 'venv', P.venv]);
  }
  run(P.python, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q']);
  run(P.python, ['-m', 'pip', 'install', '-q', '-r', path.join(SERVICE_DIR, 'requirements.txt')]);
  log('Python packages installed.');

  await ensureOllama();
  for (const model of new Set([VISION_MODEL, TEXT_MODEL, SECOND_PASS_MODEL].filter(Boolean))) {
    log(`Pulling ${model} (stored in ${P.models}) ...`);
    run(P.ollamaExe, ['pull', model]);
  }
  log('Setup done. Next: npm run ai:start');
}

async function ensureOllama() {
  if (await ollamaUp()) return false;
  if (!fs.existsSync(P.ollamaExe)) throw new Error('Ollama is not installed: run npm run ai:setup');
  fs.mkdirSync(P.reports, { recursive: true });
  const out = fs.openSync(path.join(P.reports, 'ollama-serve.log'), 'a');
  const child = spawn(P.ollamaExe, ['serve'], { env: aiEnv(), detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.writeFileSync(P.ollamaPidFile, String(child.pid));
  for (let i = 0; i < 60 && !(await ollamaUp()); i++) await sleep(500);
  if (!(await ollamaUp())) throw new Error('Ollama did not start; see D:\\AI\\reports\\ollama-serve.log');
  log('Ollama started.');
  return true;
}

/** Loads the model into VRAM so the first scan does not pay the cold start (~10-60 s). */
async function warmModel(model) {
  log(`Warming up ${model} ...`);
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt: 'ok', stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    log('Warm-up did not finish; the first request will be slower.');
  }
}

/** Starts Ollama and the ai-service in the background if needed and waits until healthy. */
export async function ensureAiService({ timeoutMs = 240_000 } = {}) {
  const current = await serviceHealth();
  if (current?.status === 'ok') {
    log(`ai-service already running and healthy on ${AI_SERVICE_URL}.`);
    return current;
  }
  if (!fs.existsSync(P.python)) throw new Error('The Python venv is missing: run npm run ai:setup');
  await ensureOllama();
  await warmModel(VISION_MODEL);
  if (!current) {
    const out = fs.openSync(path.join(P.reports, 'ai-service.log'), 'a');
    const child = spawn(P.python, ['-m', 'app.main'], {
      cwd: SERVICE_DIR, env: aiEnv(), detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(P.pidFile, String(child.pid));
    log(`ai-service starting on ${AI_SERVICE_URL} (log: ${path.join(P.reports, 'ai-service.log')}) ...`);
  }
  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    health = await serviceHealth();
    if (health?.status === 'ok') break;
    await sleep(1000);
  }
  if (health?.status !== 'ok') {
    throw new Error(`ai-service is not healthy (${health ? JSON.stringify(health) : 'no answer'}); see D:\\AI\\reports\\ai-service.log`);
  }
  log(`ai-service healthy: vision=${health.models.vision}, text=${health.models.text}, ocr=${health.ocr}.`);
  return health;
}

function stop() {
  for (const [file, name] of [[P.pidFile, 'ai-service'], [P.ollamaPidFile, 'Ollama']]) {
    if (!fs.existsSync(file)) continue;
    const pid = fs.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(pid)) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    fs.rmSync(file, { force: true });
    log(`${name} stopped.`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'setup') return setup();
  if (command === 'start') return void (await ensureAiService());
  if (command === 'stop') return stop();
  if (command === 'test') {
    const r = spawnSync(P.python, ['-m', 'pytest', path.join(SERVICE_DIR, 'tests'), '-q', '-p', 'no:cacheprovider', ...process.argv.slice(3)], { stdio: 'inherit', env: aiEnv() });
    process.exitCode = r.status ?? 1;
    return;
  }
  if (command === 'health') {
    const health = await serviceHealth();
    console.log(JSON.stringify(health ?? { status: 'down', url: AI_SERVICE_URL }, null, 2));
    process.exitCode = health?.status === 'ok' ? 0 : 1;
    return;
  }
  console.log('Usage: node scripts/ai-service.mjs setup|start|stop|health|test');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ai] ${err.message}`);
    process.exitCode = 1;
  });
}
