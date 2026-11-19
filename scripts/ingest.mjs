#!/usr/bin/env node
/* LFHS Knowledge Engine - PDF ingestion (writes search files into the repo; no database).
 *
 * Reads the existing catalog (data/pdfs.js), downloads each PDF from its catalog URL (or reads it from --local),
 * extracts text page by page with poppler's `pdftotext`, cleans and chunks it, and writes one shard per class+subject:
 *     api/_kb/10-biology.json, api/_kb/9-physics.json, ...   (+ api/_kb/index.json manifest)
 * The AI function loads these files at runtime. Nothing is extracted or downloaded when a student asks a question.
 *
 *   node scripts/ingest.mjs                              all PDFs in the catalog (skips ones unchanged since last run)
 *   node scripts/ingest.mjs --cls 10 --subj biology      a subset
 *   node scripts/ingest.mjs --ids LFHS-218,LFHS-350      specific resources
 *   node scripts/ingest.mjs --local ./pdfs               read PDFs from a folder instead of downloading
 *   node scripts/ingest.mjs --medium Malayalam           only Malayalam books (also Hindi, English)
 *   options: --force (re-process unchanged), --dry-run (report only, write nothing), --kb-dir DIR, --catalog FILE, --strict (exit 1 on any failure),
 *            --ocr auto|off (default auto: OCR pages whose text layer is blank/unreadable, if tesseract + language data exist)
 *
 * Requirements: Node 18+, poppler (`pkg install poppler` on Termux, `apt install poppler-utils`, `brew install poppler`).
 * Optional OCR (scanned or legacy-font PDFs): tesseract with eng, mal, hin data (`apt install tesseract-ocr tesseract-ocr-mal tesseract-ocr-hin`).
 * Languages: each catalog entry has a `medium` (English | Malayalam | Hindi). Text is kept in its original script (NFC-normalised, never transliterated).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const A = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  A[k] = v;
}
const CATALOG = resolve(A.catalog || 'data/pdfs.js');
const KB_DIR = resolve(A['kb-dir'] || 'api/_kb');
const DRY = !!A['dry-run'];
const FORCE = !!A.force;
const OCR_MODE = A.ocr === 'off' ? 'off' : 'auto';
const MEDIA = ['english', 'malayalam', 'hindi'];
const langOf = (e) => { const m = String(e.medium || 'English').toLowerCase(); return m.startsWith('mal') ? 'malayalam' : m.startsWith('hin') ? 'hindi' : 'english'; };
const CLASSES = ['8', '9', '10'];
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
const f_ids = list(A.ids), f_cls = list(A.cls), f_subj = list(A.subj), f_type = list(A.type);

/* ---------------- catalog ---------------- */
function loadCatalog() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(CATALOG, 'utf8'), sandbox);
  return Array.isArray(sandbox.window.LFHS_PDFS) ? sandbox.window.LFHS_PDFS : [];
}
// '8-9' (bridge courses) belongs to both classes
const classesOf = (e) => String(e.cls).split('-').map((s) => s.trim()).filter((c) => CLASSES.includes(c));

/* ---------------- text helpers ---------------- */
const MAX_CHUNK = 950;
const MIN_CHUNK = 40;

// NFC; old-style Malayalam chillu (consonant + virama + ZWJ) becomes the atomic chillu letter BEFORE zero-width characters are removed.
const CHILLU = { 'ന': 'ൻ', 'ര': 'ർ', 'ല': 'ൽ', 'ള': 'ൾ', 'ണ': 'ൺ' };
const normText = (t) => String(t == null ? '' : t).normalize('NFC')
  .replace(/([നരലളണ])\u0d4d\u200d/g, (m, c) => CHILLU[c])
  .replace(/[\u200b\u200c\u200d\u2060\ufeff\ufffd]/g, '')
  .replace(/(\p{M})\1+/gu, '$1');
// Output cleanup (after the page-quality decision). Word/PDF "symbol font" glyphs live in the private-use area (U+F0xx); the common ones
// are mapped to the real character (arrows, comparison signs, bullets), everything else private-use or U+FFFD is dropped.
const SYMBOLS = { f0ae: '\u2192', f0ac: '\u2190', f0ad: '\u2191', f0af: '\u2193', f0ba: '\u2261', f0b1: '\u00b1', f0b3: '\u2265', f0a3: '\u2264', f0b4: '\u00d7', f0b8: '\u00f7', f0b9: '\u2260', f0bb: '\u2248', f0b0: '\u00b0', f0a5: '\u221e', f0de: '\u21d2', f0db: '\u21d4',
  f0b7: '\u2022', f06c: '\u2022', f0a7: '\u25aa', f076: '\u2022', f0d8: '\u2022', f0fc: '\u2713', f020: ' ' };
const cleanSym = (t) => t.replace(/[\ue000-\uf8ff\ufffd]/g, (c) => SYMBOLS[c.charCodeAt(0).toString(16)] || '');
function tidy(s) {
  return normText(s).replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').replace(/ {2,}/g, ' ');
}

const scriptRe = { malayalam: /[\u0d00-\u0d7f]/g, hindi: /[\u0900-\u097f]/g };
// True when a page's text layer is unusable (legacy-font preface, private-use symbol soup, wrong script...). Language-aware.
function looksGarbled(t, lang = 'english') {
  const toks = t.match(/\S+/g) || [];
  if (toks.length < 15) return false;
  let bad = 0;
  for (const c of t) { const n = c.codePointAt(0); if (n === 0xfffd || (n >= 0xe000 && n <= 0xf8ff) || (n < 32 && n !== 9 && n !== 10 && n !== 12 && n !== 13)) bad++; } // replacement char, private-use area (legacy fonts), control chars
  if (bad / Math.max(1, t.length) > 0.02) return true;
  if (lang === 'malayalam' || lang === 'hindi') {
    const own = (t.match(scriptRe[lang]) || []).length; const chars = t.replace(/\s/g, '').length;
    return own / Math.max(1, chars) < 0.25; // a page of a Malayalam/Hindi textbook is mostly its own script
  }
  const ok = toks.filter((x) => /^([A-Za-z][a-z]{2,}[.,;:?)]*|[0-9]+[.)]?|[A-Za-z]\)|[-\u2013\u2014])$/.test(x)).length;
  let odd = 0;
  for (const c of t) { const n = c.charCodeAt(0); if (n > 127 && !'\u2013\u2014\u2019\u2018\u201c\u201d\u2022\u00b0\u00d7\u00f7\u00b2\u00b3\u2192\u2265\u2264\u00b1'.includes(c)) odd++; }
  return ok / toks.length < 0.45 || odd / Math.max(1, t.length) > 0.02;
}

/* ---------------- OCR (optional) ---------------- */
const OCR_LANGS = { english: 'eng', malayalam: 'mal+eng', hindi: 'hin+eng' };
let tessLangs = null;
function ocrAvailable(lang) {
  try {
    if (!tessLangs) tessLangs = execFileSync('tesseract', ['--list-langs'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\s+/);
    return OCR_LANGS[lang].split('+').every((l) => tessLangs.includes(l));
  } catch (e) { return false; }
}
function ocrPage(pdfPath, page, lang) {
  const base = join(tmpdir(), 'lfhs-ocr-' + process.pid + '-' + page);
  try {
    execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '200', '-singlefile', '-png', pdfPath, base], { stdio: 'ignore' });
    return execFileSync('tesseract', [base + '.png', 'stdout', '-l', OCR_LANGS[lang], '--psm', '6'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8');
  } catch (e) { return ''; } finally { try { unlinkSync(base + '.png'); } catch (x) { /* ignore */ } }
}

function splitLong(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const out = []; let cur = '';
  for (const s of text.split(/(?<=[.?!\u0964\u0965])\s+/)) {
    if ((cur + ' ' + s).length > MAX_CHUNK && cur) { out.push(cur.trim()); cur = s; } else cur = cur ? cur + ' ' + s : s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((p) => (p.length > MAX_CHUNK * 1.5 ? p.match(new RegExp('[\\s\\S]{1,' + MAX_CHUNK + '}', 'g')) : [p]));
}

function passageChunks(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim()).filter(Boolean);
  const out = []; let cur = '';
  for (const p of paras) {
    if (cur && (cur + ' ' + p).length > MAX_CHUNK) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  return out.flatMap(splitLong).filter((c) => c.length >= MIN_CHUNK);
}

/* ---------------- document-level structure ---------------- */
function repeatedLines(pages) {
  const n = pages.length; if (n < 8) return new Set();
  const freq = new Map();
  pages.forEach((p) => new Set(p.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 45 && !/^\d+$/.test(l))).forEach((l) => freq.set(l, (freq.get(l) || 0) + 1)));
  const cut = Math.max(4, Math.floor(n * 0.25));
  return new Set([...freq].filter(([, c]) => c >= cut).map(([l]) => l));
}
const stripFurniture = (text, rep) => text.split('\n').filter((l) => { const t = l.trim(); return !(rep.has(t) || /^\d{1,3}$/.test(t)); }).join('\n');

// Textbook: parse the "Contents" page and the printed-page offset (pdf page - printed page).
function textbookStructure(rawPages) {
  let chapters = [];
  for (let i = 0; i < Math.min(15, rawPages.length) && !chapters.length; i++) {
    let rows = [...rawPages[i].matchAll(/^\s*(\d{1,2})\s{2,}(\S.*?)\s{2,}(\d{1,3})\s*$/gm)];
    if (rows.length < 2) rows = [...rawPages[i].matchAll(/^\s*(\d{1,2})[.)]?\s+(\S.*?)\s*(?:[.\u00b7\u2026_]{2,}|\s{3,})\s*(\d{1,3})\s*$/gm)];
    if (rows.length >= 2) chapters = rows.map((m) => ({ n: Number(m[1]), title: normText(m[2]).trim(), printed: Number(m[3]) })).filter((c) => !/^\d+$/.test(c.title));
  }
  const votes = new Map();
  rawPages.forEach((p, i) => {
    const last = p.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (last && /^\d{1,3}$/.test(last)) { const off = i + 1 - Number(last); if (off >= -400 && off <= 40) votes.set(off, (votes.get(off) || 0) + 1); }
  });
  const offset = votes.size ? [...votes].sort((a, b) => b[1] - a[1])[0][0] : 0;
  chapters.forEach((c) => (c.start = c.printed + offset));
  chapters.sort((a, b) => a.start - b.start);
  return { chapters, offset };
}
const chapterAt = (chapters, page) => { let c = null; for (const x of chapters) if (x.start <= page) c = x; return c; };

function titleChapter(entry) {
  const m = (entry.title || '').match(/\bCh(?:apter)?\.?\s*(\d{1,2})\s*[:.\-\u2013\u2014]?\s*(.*)$/i) || (entry.file || '').match(/_Ch(\d{1,2})_([A-Za-z]+)/);
  return m ? { n: Number(m[1]), title: (m[2] || '').replace(/[()]/g, '').trim() || null } : null;
}

/* ---------------- numbered question / answer splitting ---------------- */
function splitNumbered(text, last) {
  const lines = text.split('\n'); const segs = []; let cur = { qno: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,3})[.)]\s+\S/);
    if (m) {
      const n = Number(m[1]);
      if (last === null ? n <= 2 : (n === last + 1 || n === 1)) {
        if (cur.lines.length) segs.push(cur);
        cur = { qno: n, lines: [line] }; last = n; continue;
      }
    }
    cur.lines.push(line);
  }
  if (cur.lines.length) segs.push(cur);
  return { segs, last };
}

/* ---------------- answer-key tables (word positions) ---------------- */
function keyTableRows(pdfPath, page) {
  const xml = execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdfPath, '-'], { maxBuffer: 1 << 26 }).toString('utf8');
  const pw = Number((xml.match(/<page width="([\d.]+)"/) || [])[1] || 595);
  const words = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], text: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") }));
  const anchors = words.filter((w) => w.x0 < pw * 0.13 && /^\d{1,2}$/.test(w.text)).sort((a, b) => a.y0 - b.y0);
  if (anchors.length < 4) return null;
  const rows = anchors.map((a, i) => {
    const top = a.y0 - 2, bot = i + 1 < anchors.length ? anchors[i + 1].y0 - 2 : Infinity;
    const ws = words.filter((w) => w.y0 >= top && w.y0 < bot && w.x0 >= pw * 0.12 && w.x1 <= pw * 0.89);
    const lines = []; ws.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0).forEach((w) => {
      const l = lines[lines.length - 1];
      if (l && Math.abs(l.y - w.y0) < 3) l.w.push(w); else lines.push({ y: w.y0, w: [w] });
    });
    const text = lines.map((l) => l.w.sort((p, q) => p.x0 - q.x0).map((w) => w.text).join(' ')).join('\n').trim();
    return { qno: Number(a.text), text };
  });
  return rows.filter((r) => r.text.length >= 5);
}

/* ---------------- one resource ---------------- */
function processPdf(entry, pdfPath) {
  const lang = langOf(entry);
  const rawPages0 = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { maxBuffer: 1 << 29 }).toString('utf8').split('\f');
  if (rawPages0.length && !rawPages0[rawPages0.length - 1].trim()) rawPages0.pop();
  const rawPages = rawPages0.map(tidy);
  // OCR pass: pages whose text layer is blank/unreadable (and, for Malayalam/Hindi books or scanned books, blank pages too)
  const ocrPages = []; let ocrNeeded = 0; let ocrMissing = false;
  if (OCR_MODE !== 'off') {
    const usable = rawPages.filter((x) => x.trim().length >= 60 && !looksGarbled(x, lang)).length; const scannedBook = usable < rawPages.length * 0.3;
    // English books are OCR'd only when the whole book is scanned. A few unreadable pages inside an otherwise normal English book are usually
    // legacy-font Malayalam prefaces: OCR with the English model would only produce junk, so they stay skipped (and are counted in the report).
    const want = (x) => (x.trim().length < 60 ? lang !== 'english' || scannedBook : (lang !== 'english' || scannedBook) && looksGarbled(x, lang));
    const can = rawPages.some(want) ? ocrAvailable(lang) : true;
    rawPages.forEach((x, i) => {
      if (!want(x)) return; ocrNeeded++; if (!can) return;
      const t = tidy(ocrPage(pdfPath, i + 1, lang));
      if (t.trim().length >= 60 && !looksGarbled(t, lang)) { rawPages[i] = t; ocrPages.push(i + 1); }
    });
    ocrMissing = ocrNeeded > 0 && !can;
  }
  const diag = (() => {
    const live = rawPages.filter((x) => x.trim().length >= 60); if (!live.length) return 'blank';
    const eng = live.filter((x) => { const w = x.match(/\S+/g) || []; return w.length >= 8 && w.filter((t) => /^[A-Za-z][a-z]{2,}[.,;:?)]*$/.test(t)).length / w.length > 0.5; }).length;
    return eng > live.length / 2 ? 'english_text' : 'unreadable_symbols';
  })();
  const types = entry.types || [];
  const isTextbook = types.includes('textbook');
  const isQB = types.includes('questionbank');
  const isKey = types.includes('answers') && !types.includes('papers') && !isQB;
  const isPaper = types.includes('papers');
  const rep = repeatedLines(rawPages);
  const fixed = titleChapter(entry);
  const tb = isTextbook ? textbookStructure(rawPages0) : null; // use untidied pages: the contents regex needs the column gaps

  const base = { resource_id: entry.id, cls: entry.cls, subj: entry.subj };
  const chunks = []; const skipped = []; const seen = new Set();
  let qbChapter = null, qbMode = 'question', marks = null, lastQ = null, lastKind = null;
  let useKeyTable = isKey && rawPages.length <= 4;

  rawPages.forEach((raw, idx) => {
    const page = idx + 1;
    if (raw.trim().length < 60) { skipped.push([page, 'blank']); return; }
    if (looksGarbled(raw, lang)) { skipped.push([page, 'unreadable text layer']); return; }
    const text = stripFurniture(raw, rep);
    if (tb && tb.chapters.length && tb.chapters[0].start <= rawPages.length && page < Math.max(1, tb.chapters[0].start)) { skipped.push([page, 'front matter']); return; }
    if (isQB && !qbChapter && !/^\s*Chapter\s*\d/m.test(text)) { skipped.push([page, 'front matter']); return; }

    // chapter for this page
    let chap = fixed ? { n: fixed.n, title: fixed.title } : null;
    if (tb) { const c = chapterAt(tb.chapters, page); chap = c ? { n: c.n, title: c.title } : null; }
    if (isQB || isPaper || isKey) {
      const m = text.match(/^\s*Chapter\s*(\d{1,2})\s*\n+\s*([A-Z][A-Z \-&,']{3,})\s*(\n\s*ANSWERS?\s*)?$/m);
      if (m) { qbChapter = { n: Number(m[1]), title: m[2].trim().toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase()) }; qbMode = m[3] ? 'answer' : 'question'; lastQ = null; marks = null; }
      if (qbChapter) chap = qbChapter;
    }
    const cn = chap ? chap.n : null, ct = chap ? chap.title : null;
    const push = (kind, body, extra) => {
      for (const piece of splitLong(cleanSym(normText(body)).replace(/\s*\n\s*/g, ' ').trim())) {
        if (piece.trim().length < 8) continue; // never keep empty / number-only fragments
        if (piece.length < MIN_CHUNK && !(extra && extra.qno)) continue;
        const key = page + '|' + kind + '|' + piece.slice(0, 80);
        if (seen.has(key)) continue; seen.add(key);
        chunks.push({ ...base, page, seq: chunks.length, chapter_no: cn, chapter_title: ct, kind, marks: (extra && extra.marks) || null, qno: (extra && extra.qno) || null, text: piece });
      }
    };

    if (useKeyTable) {
      const rows = keyTableRows(pdfPath, page);
      if (rows) { rows.forEach((r) => push('answer', r.text, { qno: r.qno })); return; }
    }
    if (isQB || isPaper || isKey) {
      const kind = isKey ? 'answer' : isQB ? qbMode : 'question';
      // update running marks heading, then split by question number
      const mk = [...text.matchAll(/^\s*(\d+)\s*Marks?(?:\s*Questions?)?\s*$/gim)];
      const body = text.replace(/^\s*(\d+)\s*Marks?(?:\s*Questions?)?\s*$/gim, (_, n) => '\u0001' + n + '\u0001');
      let curMarks = marks;
      const parts = body.split('\u0001');
      // parts alternates: text, marksNumber, text, ...
      let qlast = lastQ;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) { curMarks = Number(parts[i]); qlast = null; continue; }
        const { segs, last } = splitNumbered(parts[i], qlast); qlast = last;
        segs.forEach((s) => push(kind, s.lines.join('\n'), { qno: s.qno || (lastQ || null), marks: curMarks }));
      }
      lastQ = qlast; marks = curMarks;
      return;
    }
    passageChunks(text).forEach((c) => push('passage', c));
  });
  chunks.forEach((c, i) => (c.seq = i));
  return { chunks, skipped, pages: rawPages.length, chapters: tb ? tb.chapters : [], offset: tb ? tb.offset : null, lang, ocrPages, ocrNeeded, ocrMissing, diag };
}


/* ---------------- shards ---------------- */
const KIND = { passage: 'p', question: 'q', answer: 'a' };
const shards = new Map(); const dirty = new Set();
function shardFile(cls, subj) { return cls + '-' + subj + '.json'; }
function getShard(cls, subj) {
  const f = shardFile(cls, subj);
  if (shards.has(f)) return shards.get(f);
  let s = null;
  try { s = JSON.parse(readFileSync(join(KB_DIR, f), 'utf8')); } catch (e) { s = null; }
  if (!s || s.v !== 1 || !Array.isArray(s.c)) s = { v: 1, cls, subj, built: null, res: {}, titles: [], c: [] };
  shards.set(f, s); return s;
}
function putResource(shard, entry, meta, chunks) {
  const id = entry.id;
  shard.c = shard.c.filter((r) => r[0] !== id);
  const ti = new Map(shard.titles.map((t, i) => [t, i]));
  for (const c of chunks) {
    let t = -1;
    if (c.chapter_title) { if (!ti.has(c.chapter_title)) { ti.set(c.chapter_title, shard.titles.length); shard.titles.push(c.chapter_title); } t = ti.get(c.chapter_title); }
    shard.c.push([id, c.page, c.chapter_no || 0, t, KIND[c.kind] || 'p', c.marks || 0, c.qno || 0, c.text]);
  }
  shard.c.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable order per resource keeps git diffs small
  shard.res[id] = meta;
  shard.built = new Date().toISOString();
  dirty.add(shardFile(shard.cls, shard.subj));
}
function writeShards() {
  mkdirSync(KB_DIR, { recursive: true });
  for (const f of dirty) {
    const s = shards.get(f);
    // titles that no chunk uses any more are dropped and indexes re-numbered
    const used = [...new Set(s.c.map((r) => r[3]).filter((i) => i >= 0))].sort((a, b) => a - b);
    const remap = new Map(used.map((old, i) => [old, i])); const titles = used.map((i) => s.titles[i]);
    const rows = s.c.map((r) => JSON.stringify([r[0], r[1], r[2], r[3] >= 0 ? remap.get(r[3]) : -1, r[4], r[5], r[6], r[7]]));
    const head = JSON.stringify({ v: 1, cls: s.cls, subj: s.subj, built: s.built, res: s.res, titles });
    writeFileSync(join(KB_DIR, f), head.slice(0, -1) + ',"c":[\n' + rows.join(',\n') + '\n]}\n');
  }
  dirty.clear();
}
function writeManifest() {
  const m = { v: 1, built: new Date().toISOString(), shards: {}, resources: {}, totals: { shards: 0, resources: 0, chunks: 0, chars: 0 } };
  for (const f of existsSync(KB_DIR) ? readdirSync(KB_DIR) : []) {
    if (!/^\d+-[a-z]+\.json$/.test(f)) continue;
    const s = JSON.parse(readFileSync(join(KB_DIR, f), 'utf8'));
    const chars = s.c.reduce((n, r) => n + r[7].length, 0);
    m.shards[f] = { cls: s.cls, subj: s.subj, built: s.built, resources: Object.keys(s.res).length, chunks: s.c.length, chars };
    for (const [rid, rm] of Object.entries(s.res)) m.resources[rid] = { status: rm.status || 'ok', medium: rm.medium || 'English', pages: rm.pages, chunks: rm.chunks, ocr: rm.ocr || 0 };
    m.totals.shards++; m.totals.resources += Object.keys(s.res).length; m.totals.chunks += s.c.length; m.totals.chars += chars;
  }
  writeFileSync(join(KB_DIR, 'index.json'), JSON.stringify(m, null, 1) + '\n');
  return m;
}

/* ---------------- download + validation ---------------- */
async function download(url, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      writeFileSync(dest, Buffer.from(await r.arrayBuffer())); return;
    } catch (e) { lastErr = e; await new Promise((ok) => setTimeout(ok, 1500 * attempt)); }
  }
  throw lastErr;
}
// Catalog entry sanity: returns an error message or null.
function validateEntry(e) {
  if (!e || typeof e.id !== 'string' || !e.id.trim()) return 'catalog entry has no id';
  if (!classesOf(e).length) return 'class must be 8, 9, 10 or 8-9 (got ' + JSON.stringify(e.cls) + ')';
  if (typeof e.subj !== 'string' || !/^[a-z]+$/.test(e.subj)) return 'subject must be a lowercase key (got ' + JSON.stringify(e.subj) + ')';
  if (e.medium != null && !MEDIA.includes(String(e.medium).toLowerCase())) return 'medium must be English, Malayalam or Hindi (got ' + JSON.stringify(e.medium) + ')';
  if (A.local ? !e.file : !/^https?:\/\//i.test(String(e.url || ''))) return A.local ? 'no file name in catalog' : 'url is missing or not http(s)';
  return null;
}
// The downloaded file must really be a readable PDF. Returns its page count.
function validatePdf(path) {
  const size = statSync(path).size; if (size < 5000) throw new Error('file is only ' + size + ' bytes: not a textbook PDF');
  const head = readFileSync(path).subarray(0, 5).toString('latin1'); if (head !== '%PDF-') throw new Error('not a PDF (starts with "' + head.replace(/[^\x20-\x7e]/g, '?') + '")');
  let info; try { info = execFileSync('pdfinfo', [path], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { throw new Error('corrupted or unreadable PDF (pdfinfo failed)'); }
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]); if (!pages) throw new Error('PDF reports no pages'); return pages;
}

// Size used to decide "unchanged": the catalog's bytes, else the local file, else the server's content-length.
async function probeSize(e) {
  if (e.bytes) return e.bytes;
  try {
    if (A.local) { const f = join(resolve(A.local), e.file); return existsSync(f) ? statSync(f).size : 0; }
    const r = await fetch(e.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }); return r.ok ? Number(r.headers.get('content-length')) || 0 : 0;
  } catch (x) { return 0; }
}

/* ---------------- main ---------------- */
async function main() {
  const all = loadCatalog();
  const ids = new Map(); const dups = [];
  for (const e of all) { if (e && e.id) { if (ids.has(e.id)) dups.push(e.id); ids.set(e.id, true); } }
  if (dups.length) { console.error('Catalog has duplicate resource ids: ' + [...new Set(dups)].join(', ') + '. Fix data/pdfs.js first.'); process.exit(1); }
  let cat = all;
  if (f_ids) cat = cat.filter((e) => f_ids.includes(e.id));
  if (f_cls) cat = cat.filter((e) => classesOf(e).some((c) => f_cls.includes(c)));
  if (f_subj) cat = cat.filter((e) => f_subj.includes(e.subj));
  if (f_type) cat = cat.filter((e) => (e.types || []).some((t) => f_type.includes(t)));
  if (A.medium) cat = cat.filter((e) => langOf(e) === String(A.medium).toLowerCase());
  if (A.limit) cat = cat.slice(0, Number(A.limit));
  if (!cat.length) { console.log('No catalog entries match.'); return; }
  console.log((DRY ? 'DRY RUN' : 'INGEST') + ': ' + cat.length + ' resource(s) -> ' + KB_DIR + '\n');
  const stats = { done: 0, unchanged: 0, failed: [], empty: [], partial: [], pages: 0, ocr: 0, skippedPages: 0, warnings: [] }; let n = 0;
  for (const e of cat) {
    n++; const tag = '[' + n + '/' + cat.length + '] ' + e.id + ' ';
    const bad = validateEntry(e);
    if (bad) { console.log(tag + 'INVALID CATALOG ENTRY: ' + bad); stats.failed.push(e.id + ' (catalog: ' + bad + ')'); continue; }
    const classes = classesOf(e); const lang = langOf(e);
    const wantBytes = FORCE ? 0 : await probeSize(e);
    if (!FORCE && wantBytes && classes.every((c) => { const m = getShard(c, e.subj).res[e.id]; return m && m.bytes === wantBytes && (m.status || 'ok') === 'ok' && m.chunks > 0; })) { stats.unchanged++; console.log(tag + 'unchanged, skipped'); continue; }
    let path = null, tmp = false;
    try {
      if (A.local) { const p = join(resolve(A.local), e.file); if (!existsSync(p)) { console.log(tag + 'not in --local folder, skipped: ' + e.file); stats.failed.push(e.id + ' (missing file ' + e.file + ')'); continue; } path = p; }
      else { path = join(tmpdir(), 'lfhs-' + e.id + '.pdf'); await download(e.url, path); tmp = true; }
      const pdfPages = validatePdf(path);
      const bytes = readFileSync(path); const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const r = processPdf(e, path);
      if (r.pages !== pdfPages) stats.warnings.push(e.id + ': pdfinfo says ' + pdfPages + ' pages, text extraction saw ' + r.pages);
      if (e.pages && e.pages !== r.pages) stats.warnings.push(e.id + ': catalog says ' + e.pages + ' pages, PDF has ' + r.pages);
      const chars = r.chunks.reduce((n2, c) => n2 + c.text.length, 0);
      const textPages = new Set(r.chunks.map((c) => c.page)).size;
      // never record a failed extraction as a successful (empty) textbook
      let status = 'ok'; let problem = null;
      if (r.chunks.length === 0 && r.pages > 3) {
        if (lang !== 'english' && r.diag === 'english_text') { status = 'wrong_script'; problem = 'the PDF contains English text, not ' + lang + ': wrong medium in the catalog or wrong book'; }
        else { status = 'no_text'; problem = 'no extractable text' + (r.diag === 'unreadable_symbols' ? ' (the text layer is unreadable symbols: a legacy-font PDF)' : r.diag === 'blank' ? ' (scanned pages, no text layer)' : '') + (r.ocrMissing ? '; OCR needed but tesseract with ' + OCR_LANGS[lang] + ' data is not installed' : ' (even after OCR)'); }
      }
      else if (lang !== 'english') {
        const own = (r.chunks.map((c) => c.text).join('').match(scriptRe[lang]) || []).length;
        if (own / Math.max(1, chars) < 0.3) { status = 'wrong_script'; problem = 'text is not mostly ' + lang + ' script (' + Math.round(100 * own / Math.max(1, chars)) + '%): wrong medium in catalog, wrong book, or a legacy-font PDF that needs OCR'; }
      }
      const meta = { bytes: e.bytes || bytes.length, sha, pages: r.pages, chunks: r.chunks.length, skipped: r.skipped.length, usable: textPages, ocr: r.ocrPages.length, medium: String(e.medium || 'English'), status };
      stats.pages += r.pages; stats.ocr += r.ocrPages.length; stats.skippedPages += r.skipped.length;
      if (problem && lang !== 'english') { console.log(tag + (e.title || e.file) + ' | ' + lang + ' | FAILED: ' + problem); stats.failed.push(e.id + ' ' + problem); continue; }
      if (!DRY) classes.forEach((c) => putResource(getShard(c, e.subj), e, meta, r.chunks));
      stats.done++;
      let note = '';
      if (problem) { note = '  ** ' + problem.toUpperCase() + ' **'; stats.empty.push(e.id + ' ' + e.title); }
      else if (r.skipped.length > Math.max(3, r.pages * 0.3)) { note = '  ** many pages skipped **'; stats.partial.push(e.id + ' ' + e.title + ' (' + r.skipped.length + '/' + r.pages + ' pages unusable' + (r.ocrMissing ? '; OCR not installed' : '') + ')'); }
      else if (lang !== 'english' && textPages < r.pages * 0.5) stats.partial.push(e.id + ' ' + e.title + ' (text on only ' + textPages + '/' + r.pages + ' pages)');
      console.log(tag + (e.title || e.file) + ' | ' + classes.join('+') + '/' + e.subj + ' | ' + lang + ' | ' + r.pages + ' pp -> ' + r.chunks.length + ' chunks, ' + (chars / 1024).toFixed(0) + ' KB, skipped ' + r.skipped.length + (r.ocrPages.length ? ', OCR ' + r.ocrPages.length : '') + note);
      if (n % 25 === 0 && !DRY) writeShards(); // checkpoint on long runs
    } catch (err) { console.log(tag + 'FAILED: ' + err.message); stats.failed.push(e.id + ' ' + err.message.slice(0, 120)); }
    finally { if (tmp && path) try { unlinkSync(path); } catch (x) { /* ignore */ } }
  }
  if (!DRY) { writeShards(); const m = writeManifest(); console.log('\nLibrary now: ' + m.totals.shards + ' shard files, ' + m.totals.resources + ' resources, ' + m.totals.chunks + ' chunks, ' + (m.totals.chars / 1048576).toFixed(1) + ' MB of text'); }
  console.log('\nSummary: processed ' + stats.done + ', unchanged ' + stats.unchanged + ', failed ' + stats.failed.length + ' | pages ' + stats.pages + ', OCR ' + stats.ocr + ', unusable ' + stats.skippedPages);
  if (stats.failed.length) console.log('Failed (NOT added to the library):\n  ' + stats.failed.join('\n  '));
  if (stats.empty.length) console.log('No extractable text (English, stored empty; needs OCR):\n  ' + stats.empty.join('\n  '));
  if (stats.partial.length) console.log('Questionable (stored, check them):\n  ' + stats.partial.join('\n  '));
  if (stats.warnings.length) console.log('Warnings:\n  ' + stats.warnings.join('\n  '));
  if (!DRY) { try { mkdirSync(KB_DIR, { recursive: true }); writeFileSync(join(KB_DIR, 'ingest-report.json'), JSON.stringify({ at: new Date().toISOString(), processed: stats.done, unchanged: stats.unchanged, failed: stats.failed, questionable: stats.partial, noText: stats.empty, warnings: stats.warnings }, null, 1) + '\n'); } catch (e) { /* report is optional */ } }
  if (A.strict && stats.failed.length) process.exit(1);
  if (stats.failed.length && !stats.done && !stats.unchanged) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
