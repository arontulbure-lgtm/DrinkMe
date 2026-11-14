#!/usr/bin/env node
// npm run env:remove -- <NAME> [file]
// Removes the line(s) that set NAME from a dotenv file (default: the project root .env). Every other byte
// stays as it is. Prints only the name, the file and how many lines were removed, never a value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeEnvLine, writeFileAtomic } from './env-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function main() {
  const [name, fileArg] = process.argv.slice(2);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Usage: npm run env:remove -- <NAME> [file]');
  const file = path.resolve(process.cwd(), fileArg ?? path.join(ROOT, '.env'));
  if (!/(^|[\\/])\.env(\.[\w.-]+)?$/.test(file)) throw new Error('Only .env files can be edited with this command.');
  if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);
  const { text, removed } = removeEnvLine(fs.readFileSync(file, 'utf8'), name);
  if (removed === 0) {
    console.log(`${name} is not set in ${file}. Nothing changed.`);
    return;
  }
  writeFileAtomic(file, text);
  console.log(`Removed ${removed} line(s) setting ${name} from ${file}.`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
