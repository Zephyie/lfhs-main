// LFHS Knowledge Engine - runtime helpers (no database, no AI calls).
// The library is a set of JSON "shards" in api/_kb/ (one per class+subject) written by scripts/ingest.mjs and shipped
// with the Vercel function. Searching, evidence checks, citation checks, cache keys and circuit breakers are plain code.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CLASSES = ['8', '9', '10'];
// Where the library files live. Vercel bundles api/_kb/** next to the function (see vercel.json "includeFiles");
// we look in the project root first, then next to this file, so a different bundling layout still works.
let KB_PICK = null;
const kbDir = () => {
  if (process.env.LFHS_KB_DIR) return process.env.LFHS_KB_DIR;
  if (KB_PICK) return KB_PICK;
  const cands = [join(process.cwd(), 'api', '_kb'), typeof __dirname === 'string' ? join(__dirname, '_kb') : null, '/var/task/api/_kb'].filter(Boolean);
  const hit = cands.find((d) => { try { return existsSync(d); } catch (e) { return false; } });
  if (hit) KB_PICK = hit;
  return hit || cands[0];
};

/* ---------------- subject handling ---------------- */
// UI labels -> catalog subject keys (data/pdfs.js). Class 8 has one combined "science".
export function subjectKey(label, cls) {
  const s = String(label || '').toLowerCase().trim();
  if (!s || s === 'all' || s === '-') return null;
  const direct = { maths: 'maths', mathematics: 'maths', math: 'maths', physics: 'physics', chemistry: 'chemistry', biology: 'biology', english: 'english',
    'social science': 'ss', ss: 'ss', 'ict / computer science': 'ict', ict: 'ict', science: 'science', art: 'art', career: 'career' };
  const k = direct[s] || null;
  if (cls === '8' && (k === 'physics' || k === 'chemistry' || k === 'biology')) return 'science';
  if ((cls === '9' || cls === '10') && k === 'science') return null;
  return k;
}
// Does the student name a subject outright ("in physics...")? Otherwise the ranking itself finds the subject.
const SUBJECT_WORDS = [['physics', /\bphysics\b/], ['chemistry', /\bchemistry\b/], ['biology', /\bbiology\b/], ['maths', /\b(maths|mathematics|math)\b/],
  ['english', /\benglish\b/], ['ss', /\b(social science|history|geography|civics|economics)\b/], ['ict', /\b(ict|computer science)\b/]];
export function inferSubject(text, cls) {
  const t = String(text || '').toLowerCase();
  for (const [key, re] of SUBJECT_WORDS) if (re.test(t)) return subjectKey(key, String(cls));
  return null;
}

/* ---------------- tokens ---------------- */
const STOP = new Set(('a an the is are was were be been am do does did of in on at to for from by with about into as and or but if then so than that this these those it its ' +
  'what which who whom whose when where why how can could should would will shall may might must i me my we our you your they them their he she his her ' +
  'explain describe define tell give show list write make create please help us more less some any each every all not no yes also very much many ' +
  'class chapter topic question questions answer answers sslc kerala syllabus textbook notes paper papers important difference between meaning mean means ' +
  'short long simple simply briefly clearly easy easily detail details example examples again word words simpler further elaborate summary summarize ' +
  'tell lesson lessons study studying learn learning').split(' '));

const SUFFIXES = ['ization', 'ational', 'ations', 'ation', 'ments', 'ment', 'ities', 'ity', 'ness', 'ings', 'ing', 'ances', 'ance', 'ences', 'ence', 'ally', 'ions', 'ion', 'ful', 'ous', 'ive', 'ers', 'ed', 'er', 'ly', 'al'];
export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(ches|shes|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
  }
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 4 && /([^aeiouls])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}
const words = (text) => String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const tokens = (text) => words(text).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem);

export function extractTerms(text, max = 8) {
  const out = [];
  for (const w of String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- library loading + BM25 index (per class, kept in memory while the function is warm) ---------------- */
const KIND_NAME = { p: 'passage', q: 'question', a: 'answer' };
const INDEX = new Map();

function buildIndex(cls, shardFiles) {
  const docs = []; const post = new Map(); const lens = []; let version = [];
  for (const f of shardFiles) {
    let s;
    try { s = JSON.parse(readFileSync(join(kbDir(), f), 'utf8')); } catch (e) { console.error('[kb] could not read', f, e && e.message); continue; }
    if (!s || s.v !== 1 || !Array.isArray(s.c)) continue;
    version.push(f + ':' + s.built + ':' + s.c.length);
    for (const r of s.c) {
      const title = r[3] >= 0 ? s.titles[r[3]] : null;
      const d = { resource_id: r[0], page: r[1], chapter_no: r[2] || null, chapter_title: title, kind: KIND_NAME[r[4]] || 'passage', marks: r[5] || null, qno: r[6] || null, text: r[7], subj: s.subj };
      const idx = docs.push(d) - 1;
      const toks = tokens(d.text); lens.push(toks.length);
      const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      if (title) for (const t of new Set(tokens(title))) tf.set(t, (tf.get(t) || 0) + 0.35); // a chapter-title match is a weaker signal than the text itself
      for (const [t, c] of tf) { let p = post.get(t); if (!p) post.set(t, (p = [])); p.push(idx, c); }
    }
  }
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 1;
  return { docs, post, lens, avg, version: createHash('sha1').update(version.join('|')).digest('hex').slice(0, 10) };
}
export function loadClass(cls) {
  const key = String(cls);
  if (!INDEX.has(key)) {
    let files = [];
    try { files = existsSync(kbDir()) ? readdirSync(kbDir()).filter((f) => f.startsWith(key + '-') && f.endsWith('.json')).sort() : []; } catch (e) { files = []; }
    INDEX.set(key, buildIndex(key, files));
  }
  return INDEX.get(key);
}
export function resetIndex() { INDEX.clear(); }
export function kbVersion(cls) { return loadClass(cls).version; }
export function kbStatus() {
  try { return JSON.parse(readFileSync(join(kbDir(), 'index.json'), 'utf8')); } catch (e) { return null; }
}

// BM25 over one class. subj / kinds / chapter are filters+boost; returns best-first rows.
export function search({ cls, terms, subj, kinds, chapter, limit = 18 }) {
  const ix = loadClass(cls); if (!ix.docs.length || !terms.length) return [];
  const q = [...new Set(terms.map(stem))]; const N = ix.docs.length; const k1 = 1.2, b = 0.75;
  const score = new Map();
  for (const t of q) {
    const p = ix.post.get(t); if (!p) continue;
    const df = p.length / 2; const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < p.length; i += 2) {
      const d = ix.docs[p[i]];
      if (subj && d.subj !== subj) continue;
      if (kinds && !kinds.includes(d.kind)) continue;
      const tf = p[i + 1];
      score.set(p[i], (score.get(p[i]) || 0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * ix.lens[p[i]] / ix.avg)));
    }
  }
  const KW = { passage: 1, answer: 0.8, question: 0.8 }; // prefer textbook passages over terse answer-key lines
  return [...score].map(([i, s]) => ({ d: ix.docs[i], s: s * KW[ix.docs[i].kind] * (chapter && ix.docs[i].chapter_no === chapter ? 1.5 : 1) }))
    .sort((x, y) => y.s - x.s).slice(0, limit).map((x) => ({ ...x.d, rank: Math.round(x.s * 100) / 100 }));
}

/* ---------------- retrieval + evidence gate ---------------- */
// Which chunk kinds may be FACTUAL evidence. Question chunks contain wrong MCQ options, so they are only used for practice questions.
export const KINDS = { explain: ['passage', 'answer'], practice: ['question', 'answer', 'passage'], papers: ['question'] };

export function retrieve({ cls, subj, chapterNo, kinds, text, limit = 6, maxPerResource = 3 }) {
  if (!CLASSES.includes(String(cls))) return { rows: [], terms: [], reason: 'no_class' };
  const terms = extractTerms(text);
  if (!terms.length) return { rows: [], terms, reason: 'no_terms' };
  const raw = search({ cls: String(cls), terms, subj: subj || null, kinds: kinds || null, chapter: chapterNo || null, limit: limit * 3 });
  const per = new Map(); const rows = [];
  // no subject named: the best hit decides the subject; other subjects only stay if nearly as relevant
  const top = raw[0]; const focus = !subj && top ? top : null;
  for (const r of raw) {
    if (focus && r.subj !== focus.subj && r.rank < focus.rank * 0.6) continue;
    const n = per.get(r.resource_id) || 0; if (n >= maxPerResource) continue;
    per.set(r.resource_id, n + 1); rows.push(r); if (rows.length >= limit) break;
  }
  return { rows, terms, reason: rows.length ? 'ok' : 'no_rows' };
}

// Deterministic check: do the top passages really contain the question's key terms?
export function evidenceEnough(rows, terms, { minCoverage = 0.5 } = {}) {
  if (!rows.length || !terms.length) return { ok: false, coverage: 0 };
  const have = new Set(rows.slice(0, 3).flatMap((r) => tokens(r.text)));
  const q = [...new Set(terms.map(stem))];
  const hit = q.filter((t) => have.has(t)).length;
  const coverage = hit / q.length; const need = q.length <= 2 ? 1 : minCoverage;
  return { ok: coverage >= need, coverage: Math.round(coverage * 100) / 100 };
}

// "why?", "explain that again", "give an example" - a follow-up rather than a new topic
export function isFollowUp(text) {
  const t = String(text || '').trim();
  return extractTerms(t).length === 0 || (t.split(/\s+/).length <= 10 && /\b(that|this|it|those|them|above|previous|same|more)\b/i.test(t));
}

/* ---------------- prompt context + citation check ---------------- */
export function buildContext(rows, budgetChars = 3800) {
  let used = 0; const parts = []; const kept = [];
  for (const r of rows) {
    const text = String(r.text).slice(0, 900);
    const line = '[' + (kept.length + 1) + '] (p.' + r.page + (r.chapter_title ? ', ' + r.chapter_title : '') + (r.kind !== 'passage' ? ', ' + r.kind : '') + ') ' + text;
    if (used + line.length > budgetChars && kept.length) break;
    used += line.length; parts.push(line); kept.push(r);
  }
  return { context: parts.join('\n'), kept };
}
export const sourcesOf = (kept) => kept.map((r, i) => ({ n: i + 1, id: r.resource_id, page: r.page, chapter: r.chapter_title || null, kind: r.kind, subj: r.subj }));

// Keeps only [n] markers that point at a real retrieved excerpt.
export function checkCitations(answer, sourceCount) {
  const used = new Set();
  const clean = String(answer || '').replace(/\[(\d{1,2})\]/g, (m, d) => {
    const n = Number(d); if (n >= 1 && n <= sourceCount) { used.add(n); return m; } return '';
  }).replace(/[ \t]{2,}/g, ' ');
  return { text: clean.trim(), used: [...used].sort((a, b) => a - b) };
}

/* ---------------- cache (public study material only, never chat) ---------------- */
export function cacheKey({ type, cls, subj, chapter, topic, count, qtype, version }) {
  const norm = String(topic || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return 'kbc:' + createHash('sha256').update(JSON.stringify([type, String(cls), subj || '', chapter || '', norm, count || 0, qtype || '', version || '0'])).digest('hex').slice(0, 40);
}
const MEMO = new Map(); const MEMO_MAX = 150, MEMO_TTL = 12 * 3600 * 1000;
export const memo = {
  get(k) { const e = MEMO.get(k); if (!e) return null; if (e.at + MEMO_TTL < Date.now()) { MEMO.delete(k); return null; } MEMO.delete(k); MEMO.set(k, e); return e.v; },
  set(k, v) { MEMO.set(k, { v, at: Date.now() }); if (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value); },
  clear() { MEMO.clear(); },
};

/* ---------------- circuit breaker (per warm instance) ---------------- */
const BR = new Map(); const BR_FAILS = 3, BR_OPEN_MS = 60000;
export const breaker = {
  canUse(name, now = Date.now()) { const b = BR.get(name); return !b || b.until <= now; },
  fail(name, now = Date.now()) { const b = BR.get(name) || { fails: 0, until: 0 }; b.fails++; if (b.fails >= BR_FAILS) { b.until = now + BR_OPEN_MS; b.fails = 0; } BR.set(name, b); },
  ok(name) { BR.delete(name); },
  reset() { BR.clear(); },
};

/* ---------------- in-flight de-duplication (same instance, same key) ---------------- */
const FLIGHT = new Map();
export function dedupe(key, fn) {
  if (FLIGHT.has(key)) return FLIGHT.get(key);
  const p = Promise.resolve().then(fn).finally(() => FLIGHT.delete(key));
  FLIGHT.set(key, p); return p;
}
