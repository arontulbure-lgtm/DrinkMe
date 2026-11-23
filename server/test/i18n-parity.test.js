// i18n completeness (launch quality gate): every UI string exists in both English and Romanian, none is empty,
// and no screen renders hard-coded text (the brand name excepted). The client has no test framework yet,
// so this reads the source, like client-source.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SERVER_DIR } from './helpers/routes.js';

const ROOT = path.resolve(SERVER_DIR, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'context', 'LocalizationContext.tsx'), 'utf8');

const loadTranslations = () => {
  const start = source.indexOf('const translations = ') + 'const translations = '.length;
  const end = source.indexOf('export type SupportedLocale');
  const literal = source.slice(start, end).trim().replace(/;\s*$/, '').replace(/\s+as const\s*$/, '');
  // The object is plain literals (strings and nested objects), so it can be evaluated on its own.
  return Function(`return (${literal})`)();
};
const keysOf = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) => (
  value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`]
));
const valueAt = (object, key) => key.split('.').reduce((current, part) => current?.[part], object);

test('English and Romanian have the same keys and no empty strings', () => {
  const translations = loadTranslations();
  const en = keysOf(translations.en);
  const ro = keysOf(translations.ro);
  assert.ok(en.length > 300, `only ${en.length} keys parsed`);
  assert.deepEqual(en.filter((key) => !ro.includes(key)), [], 'missing in ro');
  assert.deepEqual(ro.filter((key) => !en.includes(key)), [], 'missing in en');
  for (const [lang, table] of [['en', translations.en], ['ro', translations.ro]]) {
    const empty = keysOf(table).filter((key) => typeof valueAt(table, key) === 'string' && !valueAt(table, key).trim());
    assert.deepEqual(empty, [], `empty ${lang} strings`);
  }
});

test('placeholders ({{name}}) are the same in both languages', () => {
  const translations = loadTranslations();
  const placeholders = (value) => [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  const mismatched = keysOf(translations.en).filter((key) => (
    placeholders(valueAt(translations.en, key)) !== placeholders(valueAt(translations.ro, key))
  ));
  assert.deepEqual(mismatched, []);
});

test('no screen renders hard-coded text (except the brand name)', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'App.tsx'));
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // <Text only (not <TextInput); an arrow function's => inside the props does not end the tag.
    for (const match of text.matchAll(/<Text(?=[\s>])(?:[^>]|(?<==)>)*>\s*([A-Za-zĂÂÎȘȚăâîșț][^<{]{2,})/g)) {
      if (match[1].trim() !== 'DrinkMe') offenders.push(`${path.relative(ROOT, file)}: ${match[1].trim().slice(0, 40)}`);
    }
    for (const match of text.matchAll(/(Alert\.alert|accessibilityLabel=|placeholder=)\(?\s*['"]([A-Za-z][^'"]*)['"]/g)) {
      offenders.push(`${path.relative(ROOT, file)}: ${match[2].slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
