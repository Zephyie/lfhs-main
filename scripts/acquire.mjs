#!/usr/bin/env node
/* LFHS textbook acquisition: download, verify and (optionally) add new textbooks to the catalog.
 *
 *   node scripts/acquire.mjs                         download + verify every book in data/acquisition.json that has a url
 *   node scripts/acquire.mjs --local DIR             verify PDFs already on disk (matched by the manifest's "file" names)
 *   node scripts/acquire.mjs --keys c9-hi,c10-hi     only these books
 *   node scripts/acquire.mjs --include-superseded    also fetch books marked "superseded" (older editions)
 *   node scripts/acquire.mjs --add-to-catalog --host https://zephyie.github.io/lfhs-4/Textbooks/
 *        append the verified books to data/pdfs.js (existing entries are never touched; a .bak copy is written first)
 *   other options: --manifest FILE  --out DIR (default acquired)  --catalog FILE (default data/pdfs.js)  --min-bytes N (default 50000)
 *
 * Writes <out>/inventory.json and <out>/INVENTORY.md. A book is "verified" only when the PDF was really downloaded and checked
 * (valid PDF, readable page count, text in the expected script, not a duplicate). Nothing is assumed from a file name or a search result.
 * Requires Node 18+ and poppler (pdfinfo, pdftotext). */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const argv = process.argv.slice(2); const A = {};
for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) continue; const k = argv[i].slice(2); A[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const MANIFEST = resolve(A.manifest || 'data/acquisition.json'); const OUT = resolve(A.out || 'acquired'); const CATALOG = resolve(A.catalog || 'data/pdfs.js');
const keys = typeof A.keys === 'string' ? A.keys.split(',') : null;
const MIN_BYTES = Number(A['min-bytes']) || 50000; // real textbooks are megabytes; anything tiny is an error page
const nfc = (t) => String(t || '').normalize('NFC').replace(/[\u200b\u200c\u200d\ufeff\ufffd]/g, '').replace(/([\u0d3e-\u0d4d\u093e-\u094d])\1+/g, '$1');
const SCRIPT = { malayalam: /[\u0d00-\u0d7f]/g, hindi: /[\u0900-\u097f]/g };
function looksGarbled(t) {
  const toks = t.match(/\S+/g) || [];
  if (toks.length < 15) return false;
  let bad = 0;
  for (const c of t) { const n = c.codePointAt(0); if (n === 0xfffd || (n >= 0xe000 && n <= 0xf8ff) || (n < 32 && n !== 9 && n !== 10 && n !== 12 && n !== 13)) bad++; }
  if (bad / Math.max(1, t.length) > 0.02) return true;
  const ok = toks.filter((x) => /^([A-Za-z][a-z]{2,}[.,;:?)]*|[0-9]+[.)]?|[A-Za-z]\)|[-\u2013\u2014])$/.test(x)).length;
  let odd = 0;
  for (const c of t) { const n = c.charCodeAt(0); if (n > 127 && !'\u2013\u2014\u2019\u2018\u201c\u201d\u2022\u00b0\u00d7\u00f7\u00b2\u00b3\u2192\u2265\u2264\u00b1'.includes(c)) odd++; }
  return ok / toks.length < 0.45 || odd / Math.max(1, t.length) > 0.02;
}

async function download(url, dest) {
  let last; for (let a = 1; a <= 3; a++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(240000), headers: { 'User-Agent': 'LFHS-acquire/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); writeFileSync(dest, Buffer.from(await r.arrayBuffer())); return; }
    catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 1500 * a)); }
  } throw last;
}
function verify(file, b) {
  const size = statSync(file).size; const notes = [];
  if (size < MIN_BYTES) return { status: 'failed', notes: ['file is only ' + size + ' bytes: not a textbook'] };
  if (readFileSync(file).subarray(0, 5).toString('latin1') !== '%PDF-') return { status: 'failed', notes: ['not a PDF (probably an error or login page)'] };
  let pages; try { pages = Number((execFileSync('pdfinfo', [file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().match(/^Pages:\s+(\d+)/m) || [])[1]); } catch (e) { return { status: 'failed', notes: ['corrupted or unreadable PDF (pdfinfo failed)'] }; }
  if (!pages) return { status: 'failed', notes: ['PDF reports no pages'] };
  let sample = ''; try { sample = nfc(execFileSync('pdftotext', ['-f', '1', '-l', String(Math.min(pages, 10)), '-layout', file, '-'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8')); } catch (e) { /* handled below */ }
  const own = (sample.match(SCRIPT[String(b.medium).toLowerCase()] || /$^/g) || []).length; const latin = (sample.match(/[A-Za-z]/g) || []).length; const letters = own + latin;
  let status = 'verified';
  if (letters < 80) { status = 'needs_ocr'; notes.push('no usable text layer in the first pages: needs OCR (tesseract-ocr-' + (String(b.medium).toLowerCase().startsWith('mal') ? 'mal' : 'hin') + ')'); }
  else if (own / letters < 0.2) {
    if (looksGarbled(sample)) { status = 'needs_ocr'; notes.push('legacy font encoding detected (' + Math.round(100 * own / letters) + '% ' + b.medium + '): needs OCR (tesseract-ocr-' + (String(b.medium).toLowerCase().startsWith('mal') ? 'mal' : 'hin') + ')'); }
    else { status = 'wrong_language'; notes.push('text is mostly English/Latin (' + Math.round(100 * own / letters) + '% ' + b.medium + '): wrong book or a legacy-font PDF'); }
  }
  else if (b.expectHints && b.expectHints.length) {
    const noSpace = sample.replace(/([\u0900-\u097f])\s+([\u0900-\u097f])/g, '$1$2');
    if (!b.expectHints.some((h) => sample.includes(nfc(h)) || noSpace.includes(nfc(h).replace(/\s+/g, '')))) {
      status = 'verified_title_unconfirmed'; notes.push('none of the expected title words were found in the first pages: check the book by eye');
    }
  }
  return { status, pages, bytes: size, notes };
}
const human = (n) => (n / 1048576).toFixed(2) + ' MB';
const ascii = (s) => s.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function main() {
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8')); mkdirSync(OUT, { recursive: true });
  const files = new Map(); for (const b of man.books) { if (b.superseded && !A['include-superseded']) continue; if (files.has(b.file)) { console.error('Two books share the file name ' + b.file + ' (' + files.get(b.file) + ', ' + b.key + '). Fix the manifest.'); process.exit(1); } files.set(b.file, b.key); }
  const rows = []; const seenSha = new Map();
  for (const b of man.books) {
    if (keys && !keys.includes(b.key)) continue;
    const row = { key: b.key, cls: b.cls, subject: b.subj, medium: b.medium, name: b.series, part: b.part, edition: b.edition, year: b.year, sourceUrl: b.url || b.source, file: b.file, pages: null, bytes: null, sha256: null, status: null, notes: [], limitations: b.limitations || '' };
    rows.push(row);
    if (b.superseded && !A['include-superseded']) { row.status = 'superseded_skipped'; row.notes.push('older edition; use --include-superseded to fetch it anyway'); continue; }
    let path;
    if (A.local) { path = join(resolve(A.local), b.file); if (!existsSync(path)) { row.status = 'url_needed'; row.notes.push('not found in --local folder'); continue; } }
    else { if (!b.url) { row.status = 'url_needed'; row.notes.push('no url in the manifest'); continue; } path = join(OUT, b.file); try { await download(b.url, path); } catch (e) { row.status = 'failed'; row.notes.push('download failed: ' + e.message); continue; } }
    const v = verify(path, b); Object.assign(row, { status: v.status, pages: v.pages || null, bytes: v.bytes || null }); row.notes.push(...v.notes);
    if (v.bytes) { row.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex'); if (seenSha.has(row.sha256)) { row.status = 'failed'; row.notes.push('identical to ' + seenSha.get(row.sha256) + ' (duplicate download)'); } else seenSha.set(row.sha256, b.key); }
    console.log(b.key.padEnd(16) + row.status.padEnd(28) + (row.pages ? row.pages + ' pp, ' + human(row.bytes) : '') + (row.notes.length ? '  ' + row.notes.join('; ') : ''));
  }
  writeFileSync(join(OUT, 'inventory.json'), JSON.stringify({ at: new Date().toISOString(), books: rows }, null, 1) + '\n');
  const md = ['# Textbook acquisition inventory', '', 'Generated by `scripts/acquire.mjs`. "verified" means the PDF was downloaded and checked (valid PDF, page count, expected script, not a duplicate).', '',
    '| Class | Subject | Medium | Book | Part | Edition | Source | File | Pages | Status | Notes |', '|---|---|---|---|---|---|---|---|---|---|---|']
    .concat(rows.map((r) => '| ' + [r.cls, r.subject, r.medium, r.name, r.part, r.edition, r.sourceUrl, r.file, r.pages || '', r.status, r.notes.concat(r.limitations ? [r.limitations] : []).join('; ')].map((x) => String(x == null ? '' : x).replace(/\|/g, '/')).join(' | ') + ' |'));
  writeFileSync(join(OUT, 'INVENTORY.md'), md.join('\n') + '\n');
  const by = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}); console.log('\nSummary:', JSON.stringify(by), '-> ' + join(OUT, 'INVENTORY.md'));

  if (A['add-to-catalog']) {
    if (typeof A.host !== 'string' || !/^https?:\/\//.test(A.host)) { console.error('--add-to-catalog needs --host https://.../  (where the PDFs will be hosted, ending with the folder)'); process.exit(1); }
    const host = A.host.endsWith('/') ? A.host : A.host + '/'; const text = readFileSync(CATALOG, 'utf8');
    const sb = { window: {} }; vm.runInNewContext(text, sb); const cat = sb.window.LFHS_PDFS; const before = JSON.stringify(cat);
    let next = Math.max(...cat.map((p) => Number((String(p.id).match(/(\d+)$/) || [])[1]) || 0)) + 1; const added = [];
    for (const r of rows) {
      if (!['verified', 'verified_title_unconfirmed', 'needs_ocr'].includes(r.status)) continue;
      if (cat.some((p) => p.file === r.file || (p.cls === r.cls && p.subj === r.subject && p.title === r.name + ' Textbook \u2014 ' + r.part))) { console.log('skip ' + r.key + ': already in the catalog'); continue; }
      const entry = { id: 'LFHS-' + String(next++).padStart(3, '0'), isPdf: true, cls: r.cls, subj: r.subject, types: ['textbook'], year: String(r.year || ''), medium: r.medium, src: 'samagra', url: host + encodeURIComponent(r.file), title: r.name + ' Textbook \u2014 ' + r.part,
        kind: 'Official SCERT Textbook', desc: 'Official SCERT Kerala Class ' + r.cls + ' ' + r.name + ' textbook, ' + r.part + ' (' + (r.year || 'edition unknown') + '), ' + r.medium + '.', pages: r.pages, size: human(r.bytes), bytes: r.bytes, cat: 'Textbooks', file: r.file };
      added.push(entry); cat.push(entry);
    }
    if (!added.length) { console.log('Nothing to add to the catalog.'); return; }
    copyFileSync(CATALOG, CATALOG + '.bak');
    const body = added.map((e) => ascii(JSON.stringify(e))).join(',');
    const out = text.replace(/\]\s*;\s*$/, (m) => ',' + body + '];'); // existing entries stay byte-for-byte identical
    const chk = { window: {} }; vm.runInNewContext(out, chk); const after = chk.window.LFHS_PDFS;
    if (after.length !== cat.length || JSON.stringify(after.slice(0, after.length - added.length)) !== before.slice(0, 0) + JSON.stringify(after.slice(0, after.length - added.length))) throw new Error('catalog check failed');
    const ids = new Set(after.map((p) => p.id)); if (ids.size !== after.length) throw new Error('duplicate ids after adding');
    writeFileSync(CATALOG, out); console.log('Added ' + added.length + ' entries to ' + CATALOG + ' (backup: ' + CATALOG + '.bak): ' + added.map((e) => e.id + ' ' + e.title + ' [Class ' + e.cls + ']').join('; '));
    console.log('Now upload these PDFs to ' + host + ' and run the Build AI library workflow.');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
