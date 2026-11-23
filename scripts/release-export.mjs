#!/usr/bin/env node
// npm run release:export [-- --ref <git ref>] [-- --out <folder>] [-- --check-only]
//
// Builds the clean release repository from a committed git ref (default: main): a plain folder, not a worktree,
// with only what the app, the server, the ai-service, their tests and the builds need. Development tooling
// and its documents are left out, internal contract documents are copied to docs/contracts/, and the result
// must pass a zero-hit check. Process and rules: docs/RELEASE_PROCESS.md (dev repository only).
//
// Never reads or copies secrets: the export starts from `git archive`, so untracked and git-ignored files
// (.env, service-account keys, server/data, logs) cannot be in it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'D:\\DrinkMeApp\\_release\\drinkme-clean';
const MARKER = '.drinkme-release-export';
const NPM_CACHE = 'D:\\DrinkMeApp\\.npm-cache';

// Paths (relative, forward slashes) left out of the export. A trailing slash means the whole folder.
export const EXCLUDE = [
  '.claude/',
  'agents/',
  'reports/',
  'logs/',
  '.vscode/',
  'AUTONOMOUS_RUN_LOG.md',
  'codex.memory.md',
  'memory.md',
  'docs/JOHN_TODO.md',
  'docs/RELEASE_PROCESS.md',
  'docs/SECURITY_ROTATION.md',
  'docs/ai/PROGRESS.md',
  'docs/ai/RUN_LOG.md',
  'scripts/release-export.mjs',
  'server/test/release-export.test.js',
];
// Any file with one of these names, at any level.
export const EXCLUDE_NAMES = ['CLAUDE.md'];
// Any file whose name matches (run logs and run release notes of the development process).
export const EXCLUDE_PATTERNS = [/(^|\/)[^/]*RUN_LOG[^/]*\.md$/i, /^docs\/RELEASE_NOTES_run-[^/]*\.md$/];

// Internal contract documents referenced from code comments and docs; copied without their front matter.
export const CONTRACT_DOCS = ['drinkme-ai-service', 'recipe-schema', 'ingredient-taxonomy', 'drinkme-backend-api', 'legal-compliance'];

// package.json entries that only serve the development tooling.
export const DROP_DEV_DEPENDENCIES = ['@jackchen_me/open-multi-agent'];
export const DROP_SCRIPT = (name) => /^agent:/.test(name) || name === 'release:export';

// The zero-hit check, case-insensitive, over every exported file (lock files and requirements included).
export const FORBIDDEN = /claude|anthropic|co-authored-by|@anthropic-ai|\bagent:[a-z]/i;
// AI SDK packages that must not be dependencies of the release.
export const FORBIDDEN_PACKAGES = /(^|["/\s])(openai|@anthropic-ai\/[a-z-]+|anthropic)(["@=<>~\s]|$)/im;

const TEXT_EXT = /\.(md|mdx|txt|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|py|html|css|toml|cfg|ini|sh|ps1|gitignore|dockerignore|env\.example|example)$/i;

export const toPosix = (p) => p.split(path.sep).join('/');

export function isExcluded(rel) {
  if (EXCLUDE_NAMES.includes(path.posix.basename(rel))) return true;
  if (EXCLUDE_PATTERNS.some((re) => re.test(rel))) return true;
  return EXCLUDE.some((item) => (item.endsWith('/') ? rel.startsWith(item) : rel === item));
}

/** `.claude/skills/<name>/SKILL.md` and `.claude/skills/<name>` become `docs/contracts/<name>.md`. */
export function rewriteContractLinks(text) {
  let out = text
    .replace(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g, 'docs/contracts/$1.md')
    .replace(/\.claude\/skills\/([a-z0-9-]+)/g, 'docs/contracts/$1.md');
  // "docs/contracts/a.md, recipe-schema and ingredient-taxonomy": every listed contract name gets its path.
  const follower = /(docs\/contracts\/[a-z0-9-]+\.md)(,\s*|\s+and\s+)(recipe-schema|ingredient-taxonomy|drinkme-[a-z-]+|legal-compliance)\b(?!\.md)/g;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(follower, (m, link, sep, name) => `${link}${sep.includes('and') ? ' and ' : ', '}docs/contracts/${name}.md`);
  }
  return out;
}

/** Drops YAML front matter (name/description for the tooling) from a contract document. */
export function stripFrontMatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}

export function cleanPackageJson(pkg) {
  const out = structuredClone(pkg);
  for (const name of DROP_DEV_DEPENDENCIES) {
    if (out.devDependencies) delete out.devDependencies[name];
    if (out.dependencies) delete out.dependencies[name];
  }
  if (out.scripts) for (const name of Object.keys(out.scripts)) if (DROP_SCRIPT(name)) delete out.scripts[name];
  return out;
}

export function cleanGitignore(text) {
  return text.split(/\r?\n/).filter((line) => !/claude/i.test(line)).join('\n');
}

const walk = (dir, base = dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, base, out);
    } else out.push(toPosix(path.relative(base, full)));
  }
  return out;
};

/** Every forbidden hit in a folder: [{ file, line, text }]. Lock files and requirements are scanned too. */
export function findForbidden(dir) {
  const hits = [];
  for (const rel of walk(dir)) {
    const full = path.join(dir, rel);
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) {
      if (FORBIDDEN.test(rel)) hits.push({ file: rel, line: 0, text: '(file name)' });
      continue; // binary
    }
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (FORBIDDEN.test(rel)) hits.push({ file: rel, line: 0, text: '(file name)' });
    lines.forEach((text, i) => { if (FORBIDDEN.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 160) }); });
    if (/(^|\/)(package(-lock)?\.json|requirements[^/]*\.txt)$/.test(rel)) {
      lines.forEach((text, i) => { if (FORBIDDEN_PACKAGES.test(text)) hits.push({ file: rel, line: i + 1, text: `AI SDK package: ${text.trim().slice(0, 120)}` }); });
    }
  }
  return hits;
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  return r.stdout;
};

function safeEmptyOut(out) {
  if (!fs.existsSync(out)) { fs.mkdirSync(out, { recursive: true }); return; }
  const entries = fs.readdirSync(out);
  if (entries.length === 0) return;
  // Only a folder this script made earlier may be replaced.
  if (!entries.includes(MARKER)) throw new Error(`${out} is not empty and was not made by release:export; choose another --out.`);
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(out, { recursive: true });
}

export function exportTree({ ref = 'main', out = DEFAULT_OUT, regenerateLock = true, log = console.log } = {}) {
  const sha = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT }).trim();
  safeEmptyOut(out);

  // git archive → a tar in the temp folder → extracted into out.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-export-'));
  const tar = path.join(tmp, 'tree.tar');
  try {
    run('git', ['archive', '--format=tar', '-o', tar, sha], { cwd: ROOT });
    run('tar', ['-xf', tar, '-C', out]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Contract documents first (their sources are under .claude/, which is removed next).
  fs.mkdirSync(path.join(out, 'docs', 'contracts'), { recursive: true });
  for (const name of CONTRACT_DOCS) {
    const src = run('git', ['show', `${sha}:.claude/skills/${name}/SKILL.md`], { cwd: ROOT });
    fs.writeFileSync(path.join(out, 'docs', 'contracts', `${name}.md`), rewriteContractLinks(stripFrontMatter(src)));
  }

  let removed = 0;
  for (const rel of walk(out)) {
    if (isExcluded(rel)) { fs.rmSync(path.join(out, rel)); removed += 1; }
  }
  // Empty folders left behind.
  const prune = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
    if (dir !== out && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  prune(out);

  for (const rel of walk(out)) {
    if (!TEXT_EXT.test(rel) && !/(^|\/)(Dockerfile|\.gitignore|\.dockerignore)$/.test(rel)) continue;
    const full = path.join(out, rel);
    const before = fs.readFileSync(full, 'utf8');
    let after = rewriteContractLinks(before);
    if (/(^|\/)\.gitignore$/.test(rel)) after = cleanGitignore(after);
    if (after !== before) fs.writeFileSync(full, after);
  }

  const pkgFile = path.join(out, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  fs.writeFileSync(pkgFile, `${JSON.stringify(cleanPackageJson(pkg), null, 2)}\n`);
  if (regenerateLock) {
    log('Regenerating package-lock.json (lock only, cache on D:)…');
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--cache=${NPM_CACHE}`], { cwd: out });
  }

  fs.writeFileSync(path.join(out, MARKER), `${sha}\n`);
  return { sha, removed, out };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = arg('--out') || DEFAULT_OUT;
  if (!args.includes('--check-only')) {
    const ref = arg('--ref') || 'main';
    const { sha, removed } = exportTree({ ref, out });
    console.log(`Exported ${ref} (${sha.slice(0, 12)}) to ${out}; ${removed} development file(s) left out.`);
  }
  const hits = findForbidden(out);
  if (hits.length) {
    console.error(`Zero-hit check FAILED: ${hits.length} hit(s).`);
    for (const h of hits.slice(0, 200)) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    process.exit(1);
  }
  console.log('Zero-hit check passed: 0 hits.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
