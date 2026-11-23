// scripts/release-export.mjs (npm run release:export): what the clean release repository leaves out, how
// it rewrites internal links, and the zero-hit check. Development repository only (the export drops this file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SERVER_DIR } from './helpers/routes.js';

const exporter = await import(pathToFileURL(path.join(SERVER_DIR, '..', 'scripts', 'release-export.mjs')).href);

describe('release export', () => {
  test('leaves out the development tooling, its documents and run logs at any level', () => {
    for (const rel of [
      '.claude/skills/x/SKILL.md', 'agents/configs.ts', 'reports/test-sessions/a.md', 'logs/x.log', 'CLAUDE.md',
      'server/CLAUDE.md', 'AUTONOMOUS_RUN_LOG.md', 'docs/ai/RUN_LOG.md', 'docs/RELEASE_NOTES_run-2026-11-14.md',
      'docs/JOHN_TODO.md', 'docs/RELEASE_PROCESS.md', 'scripts/release-export.mjs', 'memory.md', 'codex.memory.md',
    ]) assert.equal(exporter.isExcluded(rel), true, rel);
    for (const rel of [
      'App.tsx', 'src/screens/HomeScreen.tsx', 'server/server.js', 'ai-service/app/main.py', 'docs/legal/terms.md',
      'docs/DEVICE_TEST_SESSION.md', 'scripts/test-session.mjs', 'server/test/route-coverage.test.js', 'docs/ai/ROLLOUT.md',
    ]) assert.equal(exporter.isExcluded(rel), false, rel);
  });

  test('internal contract links point to docs/contracts', () => {
    assert.equal(exporter.rewriteContractLinks('see `.claude/skills/drinkme-ai-service/SKILL.md`.'), 'see `docs/contracts/drinkme-ai-service.md`.');
    assert.equal(exporter.rewriteContractLinks('(see .claude/skills/recipe-schema)'), '(see docs/contracts/recipe-schema.md)');
    assert.equal(
      exporter.rewriteContractLinks('// Contracts: .claude/skills/drinkme-ai-service, recipe-schema, ingredient-taxonomy'),
      '// Contracts: docs/contracts/drinkme-ai-service.md, docs/contracts/recipe-schema.md, docs/contracts/ingredient-taxonomy.md',
    );
    assert.equal(exporter.stripFrontMatter('---\nname: x\ndescription: y\n---\n\n# Title\n'), '# Title\n');
  });

  test('package.json loses the tooling dependency and scripts, keeps everything else', () => {
    const pkg = {
      scripts: { check: 'x', 'agent:feature': 'tsx agents/x.ts', 'release:export': 'node scripts/release-export.mjs', 'test:ios': 'y' },
      dependencies: { expo: '~58.0.0' },
      devDependencies: { '@jackchen_me/open-multi-agent': 'github:x/y', typescript: '~6.0.3' },
    };
    const out = exporter.cleanPackageJson(pkg);
    assert.deepEqual(Object.keys(out.scripts), ['check', 'test:ios']);
    assert.deepEqual(out.devDependencies, { typescript: '~6.0.3' });
    assert.deepEqual(out.dependencies, { expo: '~58.0.0' });
    assert.ok(pkg.devDependencies['@jackchen_me/open-multi-agent'], 'the input is not changed');
    assert.equal(exporter.cleanGitignore('node_modules/\n.claude/worktrees/\n.env\n'), 'node_modules/\n.env\n');
  });

  test('the zero-hit check finds names in text, file names and AI SDK packages in lock files', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-export-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'clean.md'), 'A user agent string and a designated agent: fine.\n');
    assert.deepEqual(exporter.findForbidden(dir), []);

    const word = ['Cla', 'ude'].join('');
    fs.writeFileSync(path.join(dir, 'a.md'), `ok\nWritten with ${word} Code\n`);
    fs.writeFileSync(path.join(dir, 'b.txt'), `${['Co', 'Authored', 'By'].join('-')}: x\n`);
    fs.writeFileSync(path.join(dir, 'c.json'), `{"scripts": {"${['agent', 'feature'].join(':')}": "x"}}\n`);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"packages": {"node_modules/openai": {"version": "4.0.0"}}}\n');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi==1\nanthropic==0.40\n');
    const hits = exporter.findForbidden(dir).map((h) => `${h.file}:${h.line}`);
    assert.ok(hits.includes('a.md:2'));
    assert.ok(hits.includes('b.txt:1'));
    assert.ok(hits.includes('c.json:1'));
    assert.ok(hits.includes('package-lock.json:1'));
    assert.ok(hits.includes('requirements.txt:2'));
    assert.ok(!hits.some((h) => h.startsWith('clean.md')));
  });
});
