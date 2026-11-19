// Multilingual tests: Malayalam + Hindi ingestion, retrieval, chat grounding, quiz top-up, and ingest failure handling.
// The PDFs are SYNTHETIC (own short sentences, see tests/make_lang_pdfs.py) but are real PDFs with real Unicode text layers,
// a scanned book, a legacy-font look-alike, a wrong-language book and broken files. Needs python3 + reportlab + Pillow.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import http from 'node:http';

if (spawnSync('python3', ['-c', 'import reportlab, PIL']).status !== 0) { console.log('SKIPPED: python3 with reportlab and Pillow is needed to build the test PDFs'); process.exit(0); }
const pdfDir = mkdtempSync(join(tmpdir(), 'lang-pdfs-')); const kbDir = mkdtempSync(join(tmpdir(), 'lang-kb-'));
const mk = spawnSync('python3', ['tests/make_lang_pdfs.py', pdfDir], { encoding: 'utf8' }); if (mk.status !== 0) { console.log('SKIPPED: could not build test PDFs\n' + mk.stderr.slice(0, 300)); process.exit(0); }
cpSync('tests/fixtures/kb/10-biology.json', join(kbDir, '10-biology.json'));           // real English shard (from real SCERT PDFs) already in the library
const englishBefore = JSON.parse(readFileSync(join(kbDir, '10-biology.json'), 'utf8')).c;

const E = (id, cls, subj, medium, file, extra = {}) => ({ id, cls, subj, medium, file, url: 'http://localhost:8199/' + file, title: id + ' ' + file, types: ['textbook'], ...extra });
const catalog = [
  E('LFHS-T01', '10', 'malayalam', 'Malayalam', 'ml_textbook.pdf', { title: 'Kerala Padavali (synthetic)', pages: 11 }),
  E('LFHS-T02', '10', 'hindi', 'Hindi', 'hi_textbook.pdf', { title: 'Hindi (synthetic)', pages: 11 }),
  E('LFHS-T03', '8', 'malayalam', 'Malayalam', 'ml_class8.pdf', { title: 'Class 8 Malayalam (synthetic)' }),
  E('LFHS-T10', '9', 'malayalam', 'Malayalam', 'legacy_font.pdf'), E('LFHS-T11', '9', 'malayalam', 'Malayalam', 'scanned_ml.pdf'), E('LFHS-T12', '9', 'malayalam', 'Malayalam', 'english_as_malayalam.pdf'),
  E('LFHS-T13', '9', 'hindi', 'Hindi', 'not_a_pdf.pdf'), E('LFHS-T14', '9', 'hindi', 'Hindi', 'truncated.pdf'), E('LFHS-T15', '9', 'hindi', 'Hindi', 'tiny.pdf'),
  E('LFHS-T16', '9', 'hindi', 'Tamil', 'ml_textbook.pdf'), E('LFHS-T17', '9', 'hindi', 'Hindi', 'missing-file.pdf'),
  E('LFHS-T20', '9', 'biology', 'English', 'scanned_en.pdf', { title: 'Scanned English (OCR test)' }),
];
const catPath = join(mkdtempSync(join(tmpdir(), 'lang-cat-')), 'pdfs.js'); writeFileSync(catPath, 'window.LFHS_PDFS=' + JSON.stringify(catalog) + ';');
const ingest = (...a) => spawnSync(process.execPath, ['scripts/ingest.mjs', '--catalog', catPath, '--kb-dir', kbDir, ...a], { encoding: 'utf8' });
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };

/* ---------- ingestion ---------- */
const run1 = ingest('--local', pdfDir); const out1 = run1.stdout; const shard = (f) => JSON.parse(readFileSync(join(kbDir, f), 'utf8'));
const hasOcr = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' }).stdout?.includes('eng');
await t('ingest: Malayalam and Hindi textbooks are extracted in their own script (NFC) with chapters, pages and medium', () => {
  assert.match(out1, /LFHS-T01.*malayalam.*11 pp/); assert.match(out1, /LFHS-T02.*hindi.*11 pp/);
  const ml = shard('10-malayalam.json'); assert.equal(ml.res['LFHS-T01'].status, 'ok'); assert.equal(ml.res['LFHS-T01'].medium, 'Malayalam'); assert.ok(ml.c.length >= 9);
  assert.ok(ml.c.every((r) => r[7] === r[7].normalize('NFC') && /[\u0d00-\u0d7f]/.test(r[7])), 'every chunk is NFC Malayalam text');
  assert.deepEqual(ml.titles.sort(), ['പുഴയും ജീവിതവും', 'പുസ്തകവും വായനയും', 'മഴക്കാലം'].sort());
  const ch1 = ml.c.filter((r) => r[2] === 1); assert.ok(ch1.length && ch1.every((r) => r[1] >= 3 && r[1] <= 5), 'chapter 1 = pages 3-5');
  const hi = shard('10-hindi.json'); assert.ok(hi.c.length >= 9 && hi.c.every((r) => /[\u0900-\u097f]/.test(r[7]))); assert.deepEqual(hi.titles.sort(), ['नदी और जीवन', 'वर्षा ऋतु', 'विद्यालय और पुस्तकें'].sort());
});
await t('ingest: front matter (cover) and nothing else is skipped; no page silently dropped', () => {
  const ml = shard('10-malayalam.json'); const pages = new Set(ml.c.map((r) => r[1])); for (let p = 3; p <= 11; p++) assert.ok(pages.has(p), 'page ' + p + ' has text');
});
await t('ingest: failed books are reported and NOT stored as successful empty books', () => {
  for (const id of ['LFHS-T10', 'LFHS-T11', 'LFHS-T12', 'LFHS-T13', 'LFHS-T14', 'LFHS-T15', 'LFHS-T16', 'LFHS-T17']) assert.match(out1, new RegExp(id + '[^\\n]*(FAILED|INVALID|missing)'), id);
  assert.match(out1, /LFHS-T10[^\n]*unreadable symbols[^\n]*legacy-font/); assert.match(out1, /LFHS-T12[^\n]*contains English text, not malayalam/);
  assert.match(out1, /LFHS-T13[^\n]*not a PDF/); assert.match(out1, /LFHS-T14[^\n]*(corrupted|unreadable)/); assert.match(out1, /LFHS-T15[^\n]*bytes/); assert.match(out1, /LFHS-T16[^\n]*medium must be/);
  assert.match(out1, /LFHS-T11[^\n]*scanned pages[^\n]*OCR needed/);
  for (const f of readdirSync(kbDir).filter((x) => /^9-(malayalam|hindi)\.json$/.test(x))) { const s = shard(f); for (const id of ['LFHS-T10', 'LFHS-T11', 'LFHS-T12', 'LFHS-T13', 'LFHS-T14', 'LFHS-T15', 'LFHS-T16', 'LFHS-T17']) assert.ok(!(id in s.res), id + ' must not be in ' + f); }
  const rep = JSON.parse(readFileSync(join(kbDir, 'ingest-report.json'), 'utf8')); assert.ok(rep.failed.length >= 8);
});
await t('ingest: scanned Malayalam without OCR data fails loudly and says what to install', () => { assert.match(out1, /LFHS-T11[^\n]*(tesseract|OCR)/); });
await t('ingest: OCR path works on a scanned book (English OCR here; Malayalam/Hindi need tesseract-ocr-mal/hin)', () => {
  if (!hasOcr) { console.log('     (tesseract not installed: skipped)'); return; }
  assert.match(out1, /LFHS-T20[^\n]*OCR [1-9]/); const s = shard('9-biology.json'); assert.equal(s.res['LFHS-T20'].status, 'ok'); assert.ok(s.res['LFHS-T20'].ocr >= 3);
  assert.ok(s.c.some((r) => /monsoon|Photosynthesis/i.test(r[7])), 'OCR text is searchable');
});
await t('ingest: existing English knowledge is untouched when new textbooks are added', () => { assert.deepEqual(shard('10-biology.json').c, englishBefore); });
await t('ingest: running again is safe: finished books are skipped, nothing is rewritten', () => {
  const before = readFileSync(join(kbDir, '10-malayalam.json'), 'utf8'); const r2 = ingest('--local', pdfDir, '--ids', 'LFHS-T01,LFHS-T02');
  assert.match(r2.stdout, /LFHS-T01 unchanged/); assert.match(r2.stdout, /LFHS-T02 unchanged/); assert.equal(readFileSync(join(kbDir, '10-malayalam.json'), 'utf8'), before);
});
await t('ingest: --force rebuilds deterministically (same chunks)', () => {
  const before = shard('10-hindi.json').c; ingest('--local', pdfDir, '--ids', 'LFHS-T02', '--force'); assert.deepEqual(shard('10-hindi.json').c, before);
});
await t('ingest: duplicate resource ids and --strict', () => {
  const dupCat = join(mkdtempSync(join(tmpdir(), 'dup-')), 'pdfs.js'); writeFileSync(dupCat, 'window.LFHS_PDFS=' + JSON.stringify([catalog[0], { ...catalog[1], id: 'LFHS-T01' }]) + ';');
  const r = spawnSync(process.execPath, ['scripts/ingest.mjs', '--catalog', dupCat, '--kb-dir', mkdtempSync(join(tmpdir(), 'x-')), '--local', pdfDir], { encoding: 'utf8' }); assert.equal(r.status, 1); assert.match(r.stderr, /duplicate resource ids: LFHS-T01/);
  const s = ingest('--local', pdfDir, '--ids', 'LFHS-T10', '--strict'); assert.equal(s.status, 1);
});
await t('ingest: download path rejects an HTML page served as a PDF and a 404, keeps going', async () => {
  const srv = http.createServer((q, r) => { if (q.url === '/ml_textbook.pdf') { r.end(readFileSync(join(pdfDir, 'ml_textbook.pdf'))); } else if (q.url === '/page.pdf') { r.setHeader('content-type', 'text/html'); r.end('<html>' + 'x'.repeat(9000) + '</html>'); } else { r.statusCode = 404; r.end('no'); } }).listen(8199);
  const dl = join(mkdtempSync(join(tmpdir(), 'dl-')), 'pdfs.js'); writeFileSync(dl, 'window.LFHS_PDFS=' + JSON.stringify([E('LFHS-D1', '10', 'malayalam', 'Malayalam', 'page.pdf'), E('LFHS-D2', '10', 'malayalam', 'Malayalam', 'gone.pdf'), E('LFHS-D3', '10', 'malayalam', 'Malayalam', 'ml_textbook.pdf')]) + ';');
  const r = await new Promise((ok) => { const p = spawn(process.execPath, ['scripts/ingest.mjs', '--catalog', dl, '--kb-dir', mkdtempSync(join(tmpdir(), 'dl-kb-'))]); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => ok({ stdout: o })); }); srv.close(); // async: the test's own web server must keep answering
  assert.match(r.stdout, /LFHS-D1[^\n]*not a PDF/); assert.match(r.stdout, /LFHS-D2[^\n]*HTTP 404/); assert.match(r.stdout, /LFHS-D3[^\n]*malayalam[^\n]*11 pp/);
});

/* ---------- retrieval ---------- */
process.env.LFHS_KB_DIR = kbDir; const K = await import('../api/_kb.js'); K.resetIndex();
const get = (cls, text, o = {}) => { const r = K.retrieve({ cls, text, kinds: K.KINDS.explain, ...o }); return { ...r, gate: K.evidenceEnough(r.rows, r.terms) }; };
await t('Unicode: tokens keep Malayalam/Hindi letters and combining marks; stop words removed; digits ignored in queries', () => {
  assert.deepEqual(K.extractTerms('പുസ്തകത്തിന്റെ വില എത്ര?'), ['പുസ്തകത്തിന്റെ', 'വില', 'എത്ര']); assert.deepEqual(K.extractTerms('नदी का पानी क्या है? 2024'), ['नदी', 'पानी']);
  assert.equal(K.normText('അവന്\u200d'), 'അവൻ'); assert.equal(K.normText('\u095d'), K.normText('\u0922\u093c')); assert.equal(K.scriptOf('മഴ പെയ്യുന്നു'), 'ml'); assert.equal(K.scriptOf('बारिश होती है'), 'hi'); assert.equal(K.scriptOf('rain falls'), 'en');
});
await t('Malayalam: chapter title and real questions find the right textbook, chapter and page', () => {
  const t1 = get('10', 'മഴക്കാലം', { lang: 'malayalam' }); assert.ok(t1.gate.ok); assert.ok(t1.rows.every((r) => r.resource_id === 'LFHS-T01' && r.lang === 'malayalam')); assert.equal(t1.rows[0].chapter_no, 1);
  const q = get('10', 'കേരളത്തിൽ കാലവർഷം എപ്പോൾ ആരംഭിക്കുന്നു?', { lang: 'malayalam' }); assert.ok(q.gate.ok); assert.ok(q.rows[0].page >= 3 && q.rows[0].page <= 5); assert.match(q.rows[0].text, /കാലവർഷം/); assert.equal(q.rows[0].subj, 'malayalam');
  const r = get('10', 'ആരാണ് പുഴ മലിനമാക്കുന്നത്?', { lang: 'malayalam' }); assert.equal(r.rows[0].chapter_no, 3);
});
await t('Malayalam: inflected forms match (പുസ്തകങ്ങൾ / പുസ്തകത്തിന്റെ / പുസ്തകം)', () => {
  for (const q of ['പുസ്തകങ്ങൾ', 'പുസ്തകത്തിന്റെ താളുകൾ', 'പുസ്തകം']) { const r = get('10', q, { lang: 'malayalam' }); assert.ok(r.gate.ok, q); assert.equal(r.rows[0].chapter_no, 2, q); }
});
await t('Hindi: chapter titles, questions and inflected forms find the right passages', () => {
  const a = get('10', 'वर्षा ऋतु', { lang: 'hindi' }); assert.ok(a.gate.ok); assert.equal(a.rows[0].chapter_no, 1); assert.ok(a.rows.every((r) => r.lang === 'hindi'));
  const b = get('10', 'भारत की प्रमुख नदियाँ कौन सी हैं?', { lang: 'hindi' }); assert.ok(b.gate.ok); assert.equal(b.rows[0].chapter_no, 3); assert.match(b.rows[0].text, /नदियाँ/);
  const c = get('10', 'नदियों को स्वच्छ कैसे रखें', { lang: 'hindi' }); assert.equal(c.rows[0].chapter_no, 3); const d = get('10', 'पुस्तकों से क्या लाभ है', { lang: 'hindi' }); assert.equal(d.rows[0].chapter_no, 2);
});
await t('NFC: a query typed with the precomposed nukta letter finds text stored decomposed (and vice versa)', () => {
  for (const q of ['पढ\u093c', 'पढ़']) { const r = get('10', q + 'ने से ज्ञान', { lang: 'hindi' }); assert.ok(r.rows.length > 0, JSON.stringify(q)); }
});
await t('medium-aware: a Malayalam/Hindi query never returns English rows; an English query still reaches English textbooks', () => {
  assert.ok(get('10', 'മഴക്കാലം', { lang: 'malayalam' }).rows.every((r) => r.lang === 'malayalam')); assert.ok(get('10', 'वर्षा ऋतु', { lang: 'hindi' }).rows.every((r) => r.lang === 'hindi'));
  const en = get('10', 'What is DNA fingerprinting?'); assert.ok(en.gate.ok); assert.equal(en.rows[0].lang, 'english'); assert.equal(en.rows[0].subj, 'biology');
  const crispr = get('10', 'How does CRISPR gene editing work?'); assert.ok(crispr.gate.ok); assert.ok(crispr.rows.some((r) => r.resource_id === 'LFHS-218' && r.page === 8));
});
await t('class isolation: Class 8 sees only its own Malayalam book; Class 9 sees none', () => {
  const c8 = get('8', 'ഓണസദ്യ', { lang: 'malayalam' }); assert.ok(c8.gate.ok); assert.ok(c8.rows.every((r) => r.resource_id === 'LFHS-T03')); assert.equal(get('8', 'മഴക്കാലം', { lang: 'malayalam' }).rows.length, 0); assert.equal(get('9', 'മഴക്കാലം', { lang: 'malayalam' }).rows.length, 0);
});
await t('no-evidence queries fail the gate in all three languages', () => {
  assert.ok(!get('10', 'ക്വാണ്ടം എന്റാംഗിൾമെന്റ് എന്താണ്?', { lang: 'malayalam' }).gate.ok); assert.ok(!get('10', 'क्वांटम उलझाव क्या है', { lang: 'hindi' }).gate.ok); assert.ok(!get('10', 'Explain quantum entanglement').gate.ok);
});
await t('a Malayalam question does not match a Hindi book and vice versa', () => { assert.equal(get('10', 'മഴക്കാലം', { lang: 'hindi' }).rows.length, 0); assert.equal(get('10', 'वर्षा ऋतु', { lang: 'malayalam' }).rows.length, 0); });
await t('follow-up detection works in Hindi and Malayalam', () => { assert.ok(K.isFollowUp('इसे और समझाओ')); assert.ok(K.isFollowUp('ഇത് വിശദീകരിക്കൂ')); assert.ok(!K.isFollowUp('वर्षा ऋतु क्या है')); });
await t('cache keys keep distinct Malayalam topics distinct', () => { const a = K.cacheKey({ type: 'quiz', cls: '10', topic: 'മഴക്കാലം' }), b = K.cacheKey({ type: 'quiz', cls: '10', topic: 'പുഴയും ജീവിതവും' }); assert.notEqual(a, b); });

/* ---------- chat API (mocked AI provider) ---------- */
Object.assign(process.env, { GROQ_API_KEY: 'gk-SECRET', GROQ_MODEL: 'm1' }); delete process.env.GEMINI_API_KEY; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
let last = null; let behaviour = 'ok'; const calls = { n: 0 };
global.fetch = async (url, opt = {}) => {
  const j = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) }); if (!String(url).includes('api.groq.com')) throw new Error('unexpected fetch ' + url);
  calls.n++; const b = JSON.parse(opt.body); last = b; const sys = b.messages[0].content; const user = b.messages[b.messages.length - 1].content; const reply = (c) => j(200, { choices: [{ message: { content: c } }] });
  if (/Write exactly (\d+)/.test(user)) { const n = Number(user.match(/exactly (\d+)/)[1]); return reply(JSON.stringify({ questions: Array.from({ length: n + 1 }, (_, i) => ({ q: 'ചോദ്യം ' + ['ഒന്ന്', 'രണ്ട്', 'മൂന്ന്', 'നാല്', 'അഞ്ച്', 'ആറ്', 'ഏഴ്', 'എട്ട്'][i] + '?', options: ['എ', 'ബി', 'സി', 'ഡി'], answer: i % 4, explain: 'വിശദീകരണം' })) })); }
  if (/Write up to (\d+)/.test(user)) return reply(JSON.stringify({ questions: [{ q: 'കേരളത്തിൽ കാലവർഷം ഏത് മാസത്തിൽ ആരംഭിക്കുന്നു?', options: ['ജൂൺ', 'ജനുവരി', 'മാർച്ച്', 'ഒക്ടോബർ'], answer: 0, explain: 'ജൂൺ', src: [1] }, { q: 'ബാഹ്യ ചോദ്യം', options: ['a', 'b', 'c', 'd'], answer: 1, src: [99] }] }));
  if (/Make up to (\d+) flashcards/.test(user)) return reply(JSON.stringify({ cards: [{ q: 'नदी हमारे जीवन का क्या है?', a: 'आधार', src: [1] }] }));
  if (/No matching excerpts/.test(sys)) return reply('[[GENERAL]] ഇത് പാഠപുസ്തകത്തിൽ ഇല്ല.');
  return reply('കേരളത്തിൽ ജൂൺ മാസത്തിൽ കാലവർഷം ആരംഭിക്കുന്നു [1]. കെട്ടിച്ചമച്ച വസ്തുത [9].');
};
const { default: handler } = await import('../api/chat.js');
const call = async (body) => { const out = { code: 0, body: null }; const res = { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }; await handler({ method: 'POST', headers: { 'x-forwarded-for': '7.7.7.' + Math.floor(Math.random() * 250) }, query: { provider: 'auto' }, body }, res); return out; };
const chat = (text, o = {}) => call({ messages: [{ role: 'user', text }], ctx: { cls: '10', action: 'chat', ...o } });
await t('chat: Malayalam question is answered from the Malayalam textbook with real citations; original text reaches the AI untouched', async () => {
  const r = await chat('കേരളത്തിൽ കാലവർഷം എപ്പോൾ ആരംഭിക്കുന്നു?'); assert.equal(r.code, 200); assert.ok(r.body.grounded && !r.body.supplementary);
  assert.ok(r.body.sources.length && r.body.sources.every((s) => s.medium === 'malayalam' && s.id === 'LFHS-T01' && s.page >= 3 && s.page <= 5)); assert.ok(!r.body.reply.includes('[9]') && r.body.reply.includes('[1]'));
  const prompt = last.messages[last.messages.length - 1].content; assert.match(prompt, /malayalam textbook, p\.\d/); assert.match(prompt, /കാലവർഷം ആരംഭിക്കുന്നു/); assert.match(last.messages[0].content, /original script/);
});
await t('chat: Hindi question is answered from the Hindi textbook', async () => {
  const r = await chat('भारत की प्रमुख नदियाँ कौन सी हैं?'); assert.ok(r.body.grounded); assert.ok(r.body.sources.every((s) => s.medium === 'hindi' && s.id === 'LFHS-T02')); assert.match(last.messages[last.messages.length - 1].content, /hindi textbook/);
});
await t('chat: Malayalam question with no textbook evidence is labelled general, never claimed to come from a textbook', async () => {
  const r = await chat('ക്വാണ്ടം എന്റാംഗിൾമെന്റ് എന്താണ്?'); assert.ok(r.body.supplementary && !r.body.grounded && r.body.sources.length === 0); assert.ok(!r.body.reply.includes('[[GENERAL]]'));
});
await t('chat: English textbook question still works with the multilingual library', async () => { const r = await chat('What is DNA fingerprinting?'); assert.ok(r.body.grounded); assert.ok(r.body.sources.every((s) => s.medium === 'english')); });
await t('chat: class 8 Malayalam question gets class 8 material only', async () => { const r = await chat('ഓണസദ്യ എന്താണ്?', { cls: '8' }); assert.ok(r.body.grounded); assert.ok(r.body.sources.every((s) => s.id === 'LFHS-T03')); });
await t('quiz: Malayalam quiz is grounded in the Malayalam book, and distinct Malayalam top-up questions are NOT collapsed by de-duplication', async () => {
  const g = calls.n; const r = await call({ messages: [{ role: 'user', text: 'x' }], ctx: { cls: '10', action: 'quiz', count: 5, topic: 'കാലവർഷം', subj: 'Malayalam', subjLabel: 'Malayalam' } });
  assert.equal(r.body.returned, 5); assert.equal(r.body.groundedCount, 1); assert.equal(r.body.generalCount, 4); assert.equal(new Set(r.body.items.map((i) => i.q)).size, 5);
  assert.ok(r.body.items[0].src.length && !r.body.items[0].general); assert.ok(r.body.items.slice(1).every((i) => i.general === true)); assert.equal(calls.n, g + 2);
  assert.match(last.messages[0].content, /Malayalam \(Malayalam script\)/);
});
await t('flashcards: Hindi flashcards come from the Hindi book and the rest are labelled general', async () => {
  const r = await call({ messages: [{ role: 'user', text: 'x' }], ctx: { cls: '10', action: 'flashcards', count: 1, topic: 'नदी', subj: 'Hindi', subjLabel: 'Hindi' } }); assert.equal(r.body.returned, 1); assert.equal(r.body.groundedCount, 1); assert.ok(r.body.items[0].src.length);
});
console.log('\n' + pass + ' passed');
