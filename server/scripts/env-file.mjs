// Line-level edits of dotenv files for the owner's helper scripts (official.mjs, firebase-configure.mjs).
// Only the named lines change; every other byte stays as it is, line endings included. Nothing here prints.
import fs from 'node:fs';

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// Values written by these scripts are ids, URLs and paths: no quotes needed, and none may hold a newline.
const SAFE_VALUE = /^[^\s"'`#\\]+$/;

/**
 * Sets NAME=value for each entry: replaces the line in place, or appends it. A name that appears on more
 * than one line is refused (dotenv would take one of them, silently).
 * @param {string} text
 * @param {Record<string, string>} entries
 * @returns {{ ok: true, text: string, changed: string[] } | { ok: false, reason: string }}
 */
export function setEnvLines(text, entries) {
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, reason: `Invalid name ${name}` };
    if (!SAFE_VALUE.test(value)) return { ok: false, reason: `The value for ${name} has spaces, quotes or other characters this script does not write.` };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split(/(\r?\n)/); // [line, ending, line, ending, ..., last line]
  const changed = [];
  const appended = [];
  for (const [name, value] of Object.entries(entries)) {
    const indexes = [];
    for (let i = 0; i < parts.length; i += 2) {
      const match = ENV_LINE.exec(parts[i]);
      if (match && match[1] === name) indexes.push(i);
    }
    if (indexes.length > 1) return { ok: false, reason: `${name} appears on more than one line. Keep one by hand, then run this again.` };
    const line = `${name}=${value}`;
    if (indexes.length === 1) {
      if (parts[indexes[0]] !== line) {
        parts[indexes[0]] = line;
        changed.push(name);
      }
    } else {
      appended.push(line);
      changed.push(name);
    }
  }
  let out = parts.join('');
  if (appended.length > 0) {
    if (out.length > 0 && !out.endsWith('\n')) out += eol;
    out += appended.map((line) => `${line}${eol}`).join('');
  }
  return { ok: true, text: out, changed };
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written .env. */
export function writeFileAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}
