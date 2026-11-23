#!/usr/bin/env node
// Builds the static legal site in docs/public/ from the drafts in docs/legal/.
// Dependency-free (Node 18+). Usage: node scripts/build-public-pages.mjs
//
// Output layout: docs/public/index.html and docs/public/{en,ro}/<key>.html, so that
// getLegalUrl(doc, locale) (docs/legal/CODE_GAPS_PLAN.md, T-01) can build `<base>/<locale>/<key>`
// (most static hosts serve `<key>.html` for an extensionless path; see docs/public/README.md).
//
// The converter supports only the Markdown the legal drafts use: headings, paragraphs, flat
// ordered/unordered lists, pipe tables, horizontal rules, **bold**, *italic* and `code`.
// Every page carries a visible "draft – pending legal review" banner until the lawyer signs off.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'docs', 'legal');
const OUT = join(ROOT, 'docs', 'public');

const CONTACT_EMAIL = 'drinkmesocialapp@gmail.com';
const LOCALES = ['en', 'ro'];

// Public key (file name without .html) -> source file base name in docs/legal/.
// Keys are what getLegalUrl(doc, locale) should use.
const DOCS = [
  { key: 'privacy', source: 'privacy-policy' },
  { key: 'terms', source: 'terms' },
  { key: 'community-guidelines', source: 'community-guidelines' },
  { key: 'content-moderation', source: 'content-moderation' },
  { key: 'account-deletion', source: 'account-deletion' },
  { key: 'age-and-alcohol', source: 'age-and-alcohol' },
  { key: 'imprint', source: 'imprint' },
  // AI Transparency Notice ("How AI works in DrinkMe"); applies once the AI features are switched on (LC-43).
  { key: 'ai-transparency', source: 'ai-transparency' },
  { key: 'copyright', source: 'copyright' },
  { key: 'device-storage-notice', source: 'device-storage-notice' },
  { key: 'privacy-eu-uk', source: 'privacy-eu-uk' },
  { key: 'privacy-us', source: 'privacy-us' },
  { key: 'privacy-apac', source: 'privacy-apac' },
  { key: 'privacy-other', source: 'privacy-other' },
  { key: 'brand-partner-terms', source: 'brand-partner-terms' },
];
const KEY_BY_SOURCE = new Map(DOCS.map((d) => [d.source, d.key]));

const UI = {
  en: {
    banner: 'Draft – pending legal review',
    bannerNote: 'This text is a draft that a qualified lawyer has not yet reviewed. It is not legal advice and may change before DrinkMe is published.',
    lastUpdated: 'Last updated',
    draftVersion: 'Draft version',
    otherLanguage: 'Română',
    allDocs: 'All documents',
    contact: 'Contact',
    internal: 'internal record (not published)',
    groups: { main: 'Main documents', addenda: 'Regional privacy addenda', more: 'More' },
  },
  ro: {
    banner: 'Ciornă – în curs de revizuire juridică',
    bannerNote: 'Acest text este o ciornă care nu a fost încă revizuită de un avocat calificat. Nu reprezintă consultanță juridică și se poate schimba înainte de publicarea DrinkMe.',
    lastUpdated: 'Ultima actualizare',
    draftVersion: 'Versiunea ciornei',
    otherLanguage: 'English',
    allDocs: 'Toate documentele',
    contact: 'Contact',
    internal: 'evidență internă (nepublicată)',
    groups: { main: 'Documente principale', addenda: 'Anexe regionale de confidențialitate', more: 'Altele' },
  },
};
const GROUP_OF = (key) =>
  key.startsWith('privacy-') ? 'addenda'
  : ['privacy', 'terms', 'community-guidelines', 'account-deletion', 'age-and-alcohol'].includes(key) ? 'main'
  : 'more';

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sourcePath(source, locale) {
  return join(SRC, locale === 'en' ? `${source}.md` : `${source}.${locale}.md`);
}

// Parses status lines ("DRAFT vX – date – ..." and "CIORNĂ vX – date – ...") and the H1 title.
function readDoc(source, locale) {
  const raw = readFileSync(sourcePath(source, locale), 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  let version = '';
  const dates = [];
  const body = [];
  let title = '';
  for (const line of lines) {
    if (/^(DRAFT|CIORNĂ) v\d/.test(line)) {
      const m = line.match(/v(\d+(?:\.\d+)*)/);
      if (m && !version) version = m[1];
      for (const d of line.matchAll(/\d{4}-\d{2}-\d{2}/g)) dates.push(d[0]);
      continue;
    }
    if (!title && /^# /.test(line)) { title = line.slice(2).trim(); continue; }
    body.push(line);
  }
  dates.sort();
  return { title, version, updated: dates[dates.length - 1] || '', body };
}

const titles = {};
for (const locale of LOCALES) {
  titles[locale] = {};
  for (const d of DOCS) titles[locale][d.key] = readDoc(d.source, locale).title;
}

// Inline formatting. Code spans that name a published legal draft become links to its page in the
// same language; any other file reference (internal records, code paths) is replaced by a neutral label.
function inline(text, locale) {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      const code = part.slice(1, -1);
      const doc = code.match(/^([a-z0-9-]+?)(?:\.(?:en|ro))?\.md$/);
      if (doc && KEY_BY_SOURCE.has(doc[1])) {
        const key = KEY_BY_SOURCE.get(doc[1]);
        return `<a href="${key}.html">${escapeHtml(titles[locale][key])}</a>`;
      }
      if (/\.md$|^\.claude\/|^server\/|^src\//.test(code)) {
        return `<span class="internal">${escapeHtml(UI[locale].internal)}</span>`;
      }
      if (/^\[.*\]$/.test(code)) return `<mark>${escapeHtml(code)}</mark>`;
      return `<code>${escapeHtml(code)}</code>`;
    }
    let s = escapeHtml(part);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\[(TO FILL BY JOHN|to be set at [^\]]+|se stabilește la [^\]]+|DE COMPLETAT DE JOHN|[^\]]*VERIFY[^\]]*)\]/g, '<mark>[$1]</mark>');
    s = s.replace(/(https?:\/\/[^\s<)]+[^\s<).,;])/g, '<a href="$1">$1</a>');
    s = s.replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '<a href="mailto:$1">$1</a>');
    return s;
  }).join('');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on pipes outside code spans.
  const cells = [];
  let cur = '';
  let inCode = false;
  for (const ch of s) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderBody(lines, locale) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{2,4}) (.*)$/))) {
      const level = m[1].length;
      const text = m[2].trim();
      const id = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(text, locale)}</h${level}>`);
      i++;
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++; }
      const header = splitRow(rows[0]);
      const bodyRows = rows.slice(1).filter((r) => !/^\|?\s*:?-{2,}/.test(r.trim()));
      out.push(`<div class="table-wrap" role="region" tabindex="0" aria-label="${locale === 'ro' ? 'tabel' : 'table'}">`);
      out.push(`<table><thead><tr>${header.map((c) => `<th scope="col">${inline(c, locale)}</th>`).join('')}</tr></thead><tbody>`);
      for (const r of bodyRows) out.push(`<tr>${splitRow(r).map((c) => `<td>${inline(c, locale)}</td>`).join('')}</tr>`);
      out.push('</tbody></table></div>');
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      out.push('<ul>');
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*[-*] /, ''), locale)}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }
    if (/^\s*\d+\. /.test(line)) {
      const start = Number(line.match(/^\s*(\d+)\./)[1]);
      out.push(start === 1 ? '<ol>' : `<ol start="${start}">`);
      while (i < lines.length && /^\s*\d+\. /.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*\d+\. /, ''), locale)}</li>`);
        i++;
      }
      out.push('</ol>');
      continue;
    }
    // Each plain line is its own paragraph: the drafts put one statement per line.
    out.push(`<p>${inline(line.trim(), locale)}</p>`);
    i++;
  }
  return out.join('\n');
}

const CSS = `
:root{color-scheme:dark;--bg:#000000;--primary:#8B5FBF;--link:#C4A3EA;--card:#1F2937;--card-dark:#0F172A;--text:#FFFFFF;--muted:#9CA3AF;--border:#374151;--warn:#FFD700}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
.wrap{max-width:820px;margin:0 auto;padding:0 16px}
header.site{border-bottom:1px solid var(--border);background:var(--card-dark)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:14px;padding-bottom:14px}
.brand{color:var(--text);text-decoration:none;font-weight:700;font-size:20px;letter-spacing:.2px}
.brand span{color:var(--primary)}
nav.site a{color:var(--link);margin-left:14px;font-size:15px}
.banner{margin:20px 0 8px;padding:12px 14px;border:2px solid var(--warn);border-radius:10px;background:#1a1600}
.banner strong{color:var(--warn);display:block;font-size:17px}
.banner p{margin:4px 0 0;color:var(--text);font-size:14px}
.meta{color:var(--muted);font-size:14px;margin:0 0 8px}
h1{font-size:28px;line-height:1.25;margin:20px 0 6px}
h2{font-size:21px;margin:30px 0 8px;padding-top:8px;border-top:1px solid var(--border)}
h3,h4{font-size:18px;margin:22px 0 6px}
a{color:var(--link)}
a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
p,li{margin:8px 0}
ul,ol{padding-left:22px}
strong{color:#fff}
code{background:var(--card);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:.9em}
mark{background:#3b3200;color:var(--warn);padding:0 3px;border-radius:3px}
.internal{color:var(--muted);font-style:italic}
hr{border:0;border-top:1px solid var(--border);margin:28px 0}
.table-wrap{overflow-x:auto;margin:12px 0;border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:520px;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:9px 11px;border-bottom:1px solid var(--border)}
th{background:var(--card);color:#fff}
tr:last-child td{border-bottom:0}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:14px 0}
.card h2{border:0;margin-top:0;padding-top:0}
.card ul{list-style:none;padding:0}
.card li{margin:6px 0}
footer.site{margin-top:40px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
footer.site .wrap{padding-top:16px;padding-bottom:28px}
@media (max-width:480px){h1{font-size:24px}nav.site a{margin-left:10px}}
@media print{body{background:#fff;color:#000}header.site,footer.site,nav.site{display:none}a{color:#000}.banner{background:#fff}}
`.trim();

function page({ lang, title, description, bodyHtml, nav, base = '' }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${CSS}</style>
</head>
<body>
<!-- Generated by scripts/build-public-pages.mjs from docs/legal/. Do not edit by hand. -->
<header class="site"><div class="wrap"><a class="brand" href="${base}index.html">Drink<span>Me</span></a><nav class="site">${nav}</nav></div></header>
<main class="wrap">
${bodyHtml}
</main>
<footer class="site"><div class="wrap">DrinkMe · Tulbure Aron PFA · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></div></footer>
</body>
</html>
`;
}

function banner(locale, version, updated) {
  const t = UI[locale];
  return `<div class="banner" role="note"><strong>${t.banner}</strong><p>${t.bannerNote}</p></div>
<p class="meta">${t.lastUpdated}: <time datetime="${updated}">${updated}</time> · ${t.draftVersion}: v${escapeHtml(version)}</p>`;
}

const written = [];
function write(rel, content) {
  const full = join(OUT, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  written.push(rel.replace(/\\/g, '/'));
}

for (const locale of LOCALES) {
  const other = locale === 'en' ? 'ro' : 'en';
  const t = UI[locale];
  for (const d of DOCS) {
    if (!existsSync(sourcePath(d.source, locale))) throw new Error(`Missing source ${sourcePath(d.source, locale)}`);
    const doc = readDoc(d.source, locale);
    const nav = `<a href="index.html">${t.allDocs}</a><a href="../${other}/${d.key}.html" hreflang="${other}" lang="${other}">${t.otherLanguage}</a>`;
    const bodyHtml = `${banner(locale, doc.version, doc.updated)}\n<h1>${inline(doc.title, locale)}</h1>\n${renderBody(doc.body, locale)}`;
    write(join(locale, `${d.key}.html`), page({
      lang: locale,
      title: `${doc.title} – DrinkMe`,
      description: `${doc.title} – DrinkMe (${t.banner})`,
      bodyHtml,
      nav,
      base: '../',
    }));
  }
  // Per-language index.
  const groups = { main: [], addenda: [], more: [] };
  for (const d of DOCS) groups[GROUP_OF(d.key)].push(`<li><a href="${d.key}.html">${escapeHtml(titles[locale][d.key])}</a></li>`);
  const cards = Object.entries(groups).map(([g, items]) => `<section class="card"><h2>${t.groups[g]}</h2><ul>${items.join('')}</ul></section>`).join('\n');
  write(join(locale, 'index.html'), page({
    lang: locale,
    title: `DrinkMe – ${t.allDocs}`,
    description: `DrinkMe – ${t.allDocs}`,
    bodyHtml: `<div class="banner" role="note"><strong>${t.banner}</strong><p>${t.bannerNote}</p></div>\n<h1>DrinkMe – ${t.allDocs}</h1>\n${cards}\n<p>${t.contact}: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`,
    nav: `<a href="../${other}/index.html" hreflang="${other}" lang="${other}">${t.otherLanguage}</a>`,
    base: '../',
  }));
}

// Root index: both languages.
const rootCards = LOCALES.map((locale) => {
  const t = UI[locale];
  const items = DOCS.filter((d) => GROUP_OF(d.key) === 'main')
    .map((d) => `<li><a href="${locale}/${d.key}.html">${escapeHtml(titles[locale][d.key])}</a></li>`).join('');
  return `<section class="card" lang="${locale}"><h2>${locale === 'en' ? 'English' : 'Română'}</h2><p class="banner-inline"><mark>${t.banner}</mark></p><ul>${items}<li><a href="${locale}/index.html">${t.allDocs} →</a></li></ul></section>`;
}).join('\n');
write('index.html', page({
  lang: 'en',
  title: 'DrinkMe – Legal',
  description: 'DrinkMe legal documents: privacy policy, terms, community guidelines, account deletion.',
  bodyHtml: `<div class="banner" role="note"><strong>${UI.en.banner} · ${UI.ro.banner}</strong><p>${UI.en.bannerNote}</p><p lang="ro">${UI.ro.bannerNote}</p></div>\n<h1>DrinkMe – Legal</h1>\n<p class="meta">DrinkMe is a social app for discovering drinks, with or without alcohol, for adults of legal drinking age (18+). DrinkMe does not sell alcohol.</p>\n${rootCards}\n<p>Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`,
  nav: '<a href="en/index.html" hreflang="en">English</a><a href="ro/index.html" hreflang="ro" lang="ro">Română</a>',
  base: '',
}));

console.log(`Wrote ${written.length} files to docs/public/:`);
for (const f of written) console.log(`  ${f}`);
