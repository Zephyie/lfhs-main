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
    'social science': 'ss', ss: 'ss', 'ict / computer science': 'ict', ict: 'ict', science: 'science', art: 'art', career: 'career',
    malayalam: 'malayalam', 'മലയാളം': 'malayalam', hindi: 'hindi', 'हिंदी': 'hindi', 'हिन्दी': 'hindi', 'ഹിന്ദി': 'hindi' };
  const k = direct[s] || null;
  if (cls === '8' && (k === 'physics' || k === 'chemistry' || k === 'biology')) return 'science';
  if ((cls === '9' || cls === '10') && k === 'science') return null;
  return k;
}
// Does the student name a subject outright ("in physics...")? Otherwise the ranking itself finds the subject.
const SUBJECT_WORDS = [['physics', /\bphysics\b/], ['chemistry', /\bchemistry\b/], ['biology', /\bbiology\b/], ['maths', /\b(maths|mathematics|math)\b/],
  ['english', /\benglish\b/], ['ss', /\b(social science|history|geography|civics|economics)\b/], ['ict', /\b(ict|computer science)\b/],
  ['malayalam', /\b(malayalam|padavali|kerala padavali|adisthana)\b|മലയാളം|പാഠാവലി/u], ['hindi', /\bhindi\b|हिंदी|हिन्दी|ഹിന്ദി/u]];
export function inferSubject(text, cls) {
  const t = String(text || '').toLowerCase();
  for (const [key, re] of SUBJECT_WORDS) if (re.test(t)) return subjectKey(key, String(cls));
  return null;
}

/* ---------------- Unicode text handling (English, Malayalam, Hindi) ---------------- */
// NFC, old-style Malayalam chillu (consonant + virama + ZWJ) -> the atomic chillu letter, and no zero-width characters.
const CHILLU = { 'ന': 'ൻ', 'ര': 'ർ', 'ല': 'ൽ', 'ള': 'ൾ', 'ണ': 'ൺ' };
export const normText = (t) => {
  const s = String(t == null ? '' : t);
  if (!/[^\x00-\x7f]/.test(s)) return s; // plain ASCII (English): nothing to normalise, keeps the index build fast
  return s.normalize('NFC').replace(/([നരലളണ])\u0d4d\u200d/g, (m, c) => CHILLU[c]).replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '');
};
const RE_ML = /[\u0d00-\u0d7f]/g, RE_HI = /[\u0900-\u097f]/g, RE_LAT = /[A-Za-z]/g;
export const scriptCounts = (t) => { const s = String(t || ''); return { ml: (s.match(RE_ML) || []).length, hi: (s.match(RE_HI) || []).length, en: (s.match(RE_LAT) || []).length }; };
// 'ml' | 'hi' | 'en' : the script a piece of text is mainly written in
export function scriptOf(text) {
  const c = scriptCounts(text); const tot = c.ml + c.hi + c.en; if (!tot) return 'en';
  if (c.ml >= 2 && c.ml >= c.hi && c.ml / tot >= 0.3) return 'ml';
  if (c.hi >= 2 && c.hi > c.ml && c.hi / tot >= 0.3) return 'hi';
  return 'en';
}
export const langOfScript = (sc) => (sc === 'ml' ? 'malayalam' : sc === 'hi' ? 'hindi' : 'english');
const langOfMedium = (m) => { const x = String(m || '').toLowerCase(); return x.startsWith('mal') ? 'malayalam' : x.startsWith('hin') ? 'hindi' : x.startsWith('eng') ? 'english' : null; };

const STOP_EN = new Set(('a an the is are was were be been am do does did of in on at to for from by with about into as and or but if then so than that this these those it its ' +
  'what which who whom whose when where why how can could should would will shall may might must i me my we our you your they them their he she his her ' +
  'explain describe define tell give show list write make create please help us more less some any each every all not no yes also very much many ' +
  'class chapter topic question questions answer answers sslc kerala syllabus textbook notes paper papers important difference between meaning mean means ' +
  'short long simple simply briefly clearly easy easily detail details example examples again word words simpler further elaborate summary summarize ' +
  'tell lesson lessons study studying learn learning ' +
  'story stories poem poems explanation theme central idea ' +
  '8th 9th 10th eighth ninth tenth malayalam hindi keralapadavali padavali adisthana scert').split(' '));
// Function words & study metadata terms (never content words), so they cannot hide a real topic.
const STOP_HI = new Set(('है हैं था थी थे हो हूँ और का की के को में से पर यह वह ये वे एक कि तो भी नहीं क्या कौन कैसे क्यों कब कहाँ कहां इस उस इन उन जो या तथा लिए द्वारा साथ बारे अपने अपना अपनी कृपया बताइए बताओ समझाइए समझाओ ' +
  'पाठ पाठों अध्याय कहानी कविता कविताएं कहानियां सारांश भावार्थ अर्थ व्याख्या विवरण विस्तार प्रश्न प्रश्नों प्रश्नोत्तर उत्तर समाधान किताब पुस्तक पाठ्यपुस्तक टिप्पणी नोट्स मुख्य महत्वपूर्ण जरूरी लिखिए दीजिए कीजिए बताएं समझाएं पात्र चरित्र विशेषताएं हिंदी हिन्दी').split(' '));
const STOP_ML = new Set(('ഒരു ആണ് ആയിരുന്നു എന്ന എന്ന് അത് ഇത് ആ ഈ എന്ത് എന്താണ് ആരാണ് എങ്ങനെ എന്തുകൊണ്ട് എപ്പോൾ എവിടെ ഏത് ഏതാണ് പറയൂ പറയുക വിശദീകരിക്കൂ വിശദീകരിക്കുക ദയവായി കുറിച്ച് ആണു അല്ല ഉം ' +
  'പാഠം പാഠങ്ങൾ പാഠത്തിന്റെ പാഠത്തിലെ കഥ കഥകൾ കഥയുടെ കഥയിലെ കവിത കവിതകൾ കവിതയുടെ കവിതയിലെ അധ്യായം അദ്ധ്യായം ആശയം സംഗ്രഹം സാരം വിവരണം വിവരിക്കുക വിശദീകരണം വ്യക്തമാക്കുക അർത്ഥം അർഥം ചോദ്യം ചോദ്യങ്ങൾ ചോദ്യോത്തരങ്ങൾ ഉത്തരം ഉത്തരങ്ങൾ പുസ്തകം ടെക്സ്റ്റ്ബുക്ക് പാഠപുസ്തകം കുറിപ്പ് കുറിപ്പുകൾ നോട്ട്സ് പ്രധാന പ്രധാനപ്പെട്ട മുഖ്യ എഴുതുക തയ്യാറാക്കുക സവിശേഷതകൾ പ്രത്യേകതകൾ കഥാപാത്രം കഥാപാത്രങ്ങൾ മലയാളം കേരളപാഠാവലി കേരളപദവലി അടിസ്ഥാനപാഠാവലി').split(' '));
const isIndic = (w) => w.charCodeAt(0) >= 0x900 && /[\u0900-\u0d7f]/.test(w);
const isStop = (w) => (isIndic(w) ? STOP_HI.has(w) || STOP_ML.has(w) : STOP_EN.has(w));

const INDIC_ALIASES = {
  narabali: 'നരബലി',
  naresh: 'നരേശ്',
  prayanam: 'പ്രയാണം',
  bal: 'തേൻ',
  then: 'തേൻ',
  fiza: 'ഫിസ',
  kalluvayal: 'കല്ലുവയൽ',
  arangum: 'അരങ്ങും',
  porulum: 'പൊരുളും',
  swargathile: 'സ്വർഗ്ഗത്തിലെ',
  kuttikal: 'കുട്ടികൾ',
  ekodarasodarar: 'ഏകോദരസോദരർ',
  ujvalahrudaya: 'ഉജ്ജ്വലഹൃദയസ്പന്ദങ്ങൾ',
  rasmikal: 'രശ്മികൾ',
  vidilla: 'വിടില്ലഞാനീരശ്മികളെ',
  onasadya: 'ഓണസദ്യ',
  kalavarsham: 'കാലവർഷം',
  mazhakkalam: 'മഴക്കാലം',
  puzhayum: 'പുഴയും',
  jeevithavum: 'ജീവിതവും',
  pusthakavum: 'പുസ്തകവും',
  vayanayum: 'വായനയും',
  khidki: 'खिड़की',
  khidkee: 'खिड़की',
  toota: 'टूटा',
  tuta: 'टूटा',
  hua: 'हुआ',
  aadmi: 'आदमी',
  admi: 'आदमी',
  galileo: 'गैलीलियो',
  zindagi: 'जिंदगी',
  safar: 'सफ़र',
  nikhurpa: 'निखुर्पा',
  kharbanda: 'खरबंदा',
  nadi: 'नदी',
  jeevan: 'जीवन',
  varsha: 'वर्षा',
  ritu: 'ऋतु',
  vidyalay: 'विद्यालय'
};

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
// Every word of a text, normalised. Letters, combining marks (virama, vowel signs, anusvara...) and digits of ANY script are kept.
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const ASCII_WORD = /[a-z0-9]+/g, NON_ASCII = /[^\x00-\x7f]/;
const words = (text) => { const s = normText(text).toLowerCase(); return (NON_ASCII.test(s) ? s.match(WORD_RE) : s.match(ASCII_WORD)) || []; }; // fast path for English
// Index/query keys for one word. English: stem. Malayalam/Hindi: the exact word plus a 5-code-point prefix key
// ("~" + prefix) so inflected forms (പുസ്തകത്തിന്റെ / പുസ്തകം, विद्यालयों / विद्यालय) still meet.
export function keysOf(w) {
  if (!isIndic(w)) {
    const s = stem(w);
    const alias = INDIC_ALIASES[w] || INDIC_ALIASES[s];
    if (alias) {
      const aliasKeys = keysOf(alias);
      return [[s, 1], [alias, 1], ...aliasKeys.map(([k, wt]) => [k, wt * 0.9])];
    }
    return [[s, 1]];
  }
  const n = w.charCodeAt(0) >= 0x0d00 ? 5 : 4; // Malayalam words are longer (5 code points); Devanagari 4
  const keys = [[w, 1]]; // Indic scripts live in the BMP, so string length == code points
  if (w.length > n) keys.push(['~' + w.slice(0, n), 0.6]);
  return keys;
}
const contentWords = (text) => words(text).filter((w) => w.length >= 2 && !isStop(w)); // numbers stay searchable, as before

export function extractTerms(text, max = 8) {
  const out = [];
  for (const w of words(text)) {
    if (isStop(w) || /^\p{N}+$/u.test(w)) continue;
    if (w.length < (isIndic(w) ? 2 : 3)) continue;
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
      const meta = s.res && s.res[r[0]]; const lang = langOfMedium(meta && meta.medium) || langOfScript(scriptOf(r[7]));
      const d = { resource_id: r[0], page: r[1], chapter_no: r[2] || null, chapter_title: title, kind: KIND_NAME[r[4]] || 'passage', marks: r[5] || null, qno: r[6] || null, text: r[7], subj: s.subj, lang };
      const idx = docs.push(d) - 1;
      const ws = contentWords(d.text); lens.push(ws.length);
      const tf = new Map(); for (const w of ws) for (const [k, wt] of keysOf(w)) tf.set(k, (tf.get(k) || 0) + wt);
      if (title) for (const w of new Set(contentWords(title))) for (const [k] of keysOf(w)) tf.set(k, (tf.get(k) || 0) + 0.35); // a chapter-title match is a weaker signal than the text itself
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
export function search({ cls, terms, subj, kinds, chapter, lang, limit = 18 }) {
  const ix = loadClass(cls); if (!ix.docs.length || !terms.length) return [];
  const qw = new Map(); for (const t of terms) for (const [k, wt] of keysOf(t)) qw.set(k, Math.max(qw.get(k) || 0, wt));
  const N = ix.docs.length; const k1 = 1.2, b = 0.75;
  const score = new Map();
  for (const [t, qwt] of qw) {
    const p = ix.post.get(t); if (!p) continue;
    const df = p.length / 2; const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) * qwt;
    for (let i = 0; i < p.length; i += 2) {
      const d = ix.docs[p[i]];
      if (subj && d.subj !== subj) continue;
      if (lang && d.lang !== lang) continue;
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

export function retrieve({ cls, subj, chapterNo, kinds, text, lang, limit = 6, maxPerResource = 3 }) {
  if (!CLASSES.includes(String(cls))) return { rows: [], terms: [], reason: 'no_class' };
  const terms = extractTerms(text);
  if (!terms.length) return { rows: [], terms, reason: 'no_terms' };
  const raw = search({ cls: String(cls), terms, subj: subj || null, kinds: kinds || null, chapter: chapterNo || null, lang: lang || null, limit: limit * 3 });
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
  const have = new Set(rows.slice(0, 5).flatMap((r) => contentWords(r.text).flatMap((w) => keysOf(w).map((k) => k[0]))));
  const q = [...new Set(terms)];
  const hit = q.filter((t) => keysOf(t).some(([k]) => have.has(k))).length;
  const coverage = hit / q.length; const need = q.length <= 1 ? 1 : minCoverage;
  return { ok: coverage >= need, coverage: Math.round(coverage * 100) / 100 };
}

// "why?", "explain that again", "give an example" - a follow-up rather than a new topic
export function isFollowUp(text) {
  const t = String(text || '').trim();
  const ws = words(t); const CUES = ['that', 'this', 'it', 'those', 'them', 'above', 'previous', 'same', 'more', 'इसे', 'यह', 'वह', 'उसे', 'इसके', 'ഇത്', 'അത്', 'ഇതിനെ', 'അതിനെ', 'ഇതിന്റെ'];
  return extractTerms(t).length === 0 || (ws.length <= 10 && ws.some((w) => CUES.includes(w)));
}

/* ---------------- prompt context + citation check ---------------- */
export function buildContext(rows, budgetChars = 3800) {
  let used = 0; const parts = []; const kept = [];
  for (const r of rows) {
    const text = String(r.text).slice(0, 900);
    const line = '[' + (kept.length + 1) + '] (' + (r.lang && r.lang !== 'english' ? r.lang + ' textbook, ' : '') + 'p.' + r.page + (r.chapter_title ? ', ' + r.chapter_title : '') + (r.kind !== 'passage' ? ', ' + r.kind : '') + ') ' + text;
    if (used + line.length > budgetChars && kept.length) break;
    used += line.length; parts.push(line); kept.push(r);
  }
  return { context: parts.join('\n'), kept };
}
export const sourcesOf = (kept) => kept.map((r, i) => ({ n: i + 1, id: r.resource_id, page: r.page, chapter: r.chapter_title || null, kind: r.kind, subj: r.subj, medium: r.lang || 'english' }));

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
  const norm = normText(topic).toLowerCase().replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
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
