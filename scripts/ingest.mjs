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
 *   options: --force (re-process unchanged), --dry-run (report only, write nothing), --kb-dir DIR, --catalog FILE
 *
 * Requirements: Node 18+, poppler (`pkg install poppler` on Termux, `apt install poppler-utils`, `brew install poppler`).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
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

function tidy(s) {
  return s.replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/[ \t]+$/gm, '').replace(/ {2,}/g, ' ');
}

// True when a page's text layer is unusable (legacy-font Malayalam preface, symbol soup, etc.).
function looksGarbled(t) {
  const toks = t.match(/\S+/g) || [];
  if (toks.length < 15) return false;
  const ok = toks.filter((x) => /^([A-Za-z][a-z]{2,}[.,;:?)]*|[0-9]+[.)]?|[A-Za-z]\)|[-\u2013\u2014])$/.test(x)).length;
  let odd = 0;
  for (const c of t) { const n = c.charCodeAt(0); if (n > 127 && !'\u2013\u2014\u2019\u2018\u201c\u201d\u2022\u00b0\u00d7\u00f7\u00b2\u00b3\u2192\u2265\u2264\u00b1'.includes(c)) odd++; }
  return ok / toks.length < 0.45 || odd / Math.max(1, t.length) > 0.02;
}

function splitLong(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const out = []; let cur = '';
  for (const s of text.split(/(?<=[.?!])\s+/)) {
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
    const rows = [...rawPages[i].matchAll(/^\s*(\d{1,2})\s{2,}(\S.*?)\s{2,}(\d{1,3})\s*$/gm)];
    if (rows.length >= 2) chapters = rows.map((m) => ({ n: Number(m[1]), title: m[2].trim(), printed: Number(m[3]) }));
  }
  const votes = new Map();
  rawPages.forEach((p, i) => {
    const last = p.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (last && /^\d{1,3}$/.test(last)) { const off = i + 1 - Number(last); if (off >= -5 && off <= 40) votes.set(off, (votes.get(off) || 0) + 1); }
  });
  const offset = votes.size ? [...votes].sort((a, b) => b[1] - a[1])[0][0] : 0;
  chapters.forEach((c) => (c.start = c.printed + offset));
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
  const rawPages0 = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { maxBuffer: 1 << 29 }).toString('utf8').split('\f');
  if (rawPages0.length && !rawPages0[rawPages0.length - 1].trim()) rawPages0.pop();
  const rawPages = rawPages0.map(tidy);
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
    if (looksGarbled(raw)) { skipped.push([page, 'unreadable text layer']); return; }
    const text = stripFurniture(raw, rep);
    if (tb && tb.chapters.length && page < tb.chapters[0].start) { skipped.push([page, 'front matter']); return; }
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
      for (const piece of splitLong(body.replace(/\s*\n\s*/g, ' ').trim())) {
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
  return { chunks, skipped, pages: rawPages.length, chapters: tb ? tb.chapters : [], offset: tb ? tb.offset : null };
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
  const m = { v: 1, built: new Date().toISOString(), shards: {}, totals: { shards: 0, resources: 0, chunks: 0, chars: 0 } };
  for (const f of existsSync(KB_DIR) ? readdirSync(KB_DIR) : []) {
    if (!/^\d+-[a-z]+\.json$/.test(f)) continue;
    const s = JSON.parse(readFileSync(join(KB_DIR, f), 'utf8'));
    const chars = s.c.reduce((n, r) => n + r[7].length, 0);
    m.shards[f] = { cls: s.cls, subj: s.subj, built: s.built, resources: Object.keys(s.res).length, chunks: s.c.length, chars };
    m.totals.shards++; m.totals.resources += Object.keys(s.res).length; m.totals.chunks += s.c.length; m.totals.chars += chars;
  }
  writeFileSync(join(KB_DIR, 'index.json'), JSON.stringify(m, null, 1) + '\n');
  return m;
}

/* ---------------- download ---------------- */
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

/* ---------------- main ---------------- */
async function main() {
  let cat = loadCatalog();
  if (f_ids) cat = cat.filter((e) => f_ids.includes(e.id));
  if (f_cls) cat = cat.filter((e) => classesOf(e).some((c) => f_cls.includes(c)));
  if (f_subj) cat = cat.filter((e) => f_subj.includes(e.subj));
  if (f_type) cat = cat.filter((e) => (e.types || []).some((t) => f_type.includes(t)));
  if (A.limit) cat = cat.slice(0, Number(A.limit));
  if (!cat.length) { console.log('No catalog entries match.'); return; }
  console.log((DRY ? 'DRY RUN' : 'INGEST') + ': ' + cat.length + ' resource(s) -> ' + KB_DIR + '\n');
  const stats = { done: 0, unchanged: 0, failed: [], empty: [], partial: [] }; let n = 0;
  for (const e of cat) {
    n++; const tag = '[' + n + '/' + cat.length + '] ' + e.id + ' ';
    const classes = classesOf(e);
    if (!classes.length || !e.subj) { console.log(tag + 'skipped: no usable class/subject in catalog'); stats.failed.push(e.id + ' (catalog)'); continue; }
    if (!FORCE && classes.every((c) => { const m = getShard(c, e.subj).res[e.id]; return m && e.bytes && m.bytes === e.bytes; })) { stats.unchanged++; console.log(tag + 'unchanged, skipped'); continue; }
    let path = null, tmp = false;
    try {
      if (A.local) { const p = join(resolve(A.local), e.file); if (!existsSync(p)) { console.log(tag + 'not in --local folder, skipped: ' + e.file); stats.failed.push(e.id + ' (missing)'); continue; } path = p; }
      else { path = join(tmpdir(), 'lfhs-' + e.id + '.pdf'); await download(e.url, path); tmp = true; }
      const bytes = readFileSync(path); const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const r = processPdf(e, path);
      const chars = r.chunks.reduce((s, c) => s + c.text.length, 0);
      const meta = { bytes: e.bytes || bytes.length, sha, pages: r.pages, chunks: r.chunks.length, skipped: r.skipped.length };
      if (!DRY) classes.forEach((c) => putResource(getShard(c, e.subj), e, meta, r.chunks));
      stats.done++;
      let note = '';
      if (r.pages > 3 && r.chunks.length === 0) { note = '  ** NO TEXT (scanned images?) **'; stats.empty.push(e.id + ' ' + e.title); }
      else if (r.skipped.length > Math.max(3, r.pages * 0.3)) { note = '  ** many pages skipped **'; stats.partial.push(e.id + ' ' + e.title + ' (' + r.skipped.length + '/' + r.pages + ')'); }
      console.log(tag + (e.title || e.file) + ' | ' + classes.join('+') + '/' + e.subj + ' | ' + r.pages + ' pp -> ' + r.chunks.length + ' chunks, ' + (chars / 1024).toFixed(0) + ' KB, skipped ' + r.skipped.length + note);
      if (n % 25 === 0 && !DRY) writeShards(); // checkpoint on long runs
    } catch (err) { console.log(tag + 'FAILED: ' + err.message); stats.failed.push(e.id + ' ' + err.message.slice(0, 80)); }
    finally { if (tmp && path) try { unlinkSync(path); } catch (x) { /* ignore */ } }
  }
  if (!DRY) { writeShards(); const m = writeManifest(); console.log('\nLibrary now: ' + m.totals.shards + ' shard files, ' + m.totals.resources + ' resources, ' + m.totals.chunks + ' chunks, ' + (m.totals.chars / 1048576).toFixed(1) + ' MB of text'); }
  console.log('\nSummary: processed ' + stats.done + ', unchanged ' + stats.unchanged + ', failed ' + stats.failed.length);
  if (stats.failed.length) console.log('Failed:\n  ' + stats.failed.join('\n  '));
  if (stats.empty.length) console.log('No extractable text (need OCR, skipped):\n  ' + stats.empty.join('\n  '));
  if (stats.partial.length) console.log('Mostly unreadable pages:\n  ' + stats.partial.join('\n  '));
  if (stats.failed.length && !stats.done && !stats.unchanged) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
