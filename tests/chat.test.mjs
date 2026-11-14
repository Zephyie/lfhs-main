// End-to-end tests of api/chat.js: mocked Groq/Gemini, real library files (real sample shard + synthetic shards).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { makeLibrary } from './helpers.mjs';
Object.assign(process.env, { GROQ_API_KEY: 'gk-SECRET-1', GEMINI_API_KEY: 'gm-SECRET-2', GROQ_MODEL: 'm1', GEMINI_MODELS: 'g1', LFHS_KB_DIR: makeLibrary() });
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const { default: handler } = await import('../api/chat.js'); const K = await import('../api/_kb.js');

const calls = { groq: 0, gemini: 0 }; let behaviour = 'ok', last = null, answerText = null;
global.fetch = async (url) => { throw new Error('unexpected fetch ' + url); };
global.fetch = async (url, opt = {}) => {
  const u = String(url); const j = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.includes('api.groq.com')) {
    calls.groq++; const b = JSON.parse(opt.body); last = b; if (behaviour === '429') return j(429, { error: { message: 'rate' } });
    const sys = b.messages[0].content; const user = b.messages[b.messages.length - 1].content; const reply = (c) => j(200, { choices: [{ message: { content: c } }] });
    if (/Make up to (\d+) flashcards/.test(user)) return reply(JSON.stringify({ cards: [0, 1, 2, 3, 4, 5].map((i) => ({ q: 'Card ' + i + '?', a: 'Answer ' + i, src: [1] })) }));
    if (/Write up to (\d+)/.test(user)) {
      const good = (i) => ({ q: 'Q' + i + '?', options: ['a', 'b', 'c', 'd'], answer: i % 4, explain: 'e', src: [1] });
      const items = behaviour === 'fewer' ? [good(0), good(1), { q: 'no source', options: ['a', 'b', 'c', 'd'], answer: 1, src: [99] }, { q: 'bad answer', options: ['a', 'b', 'c', 'd'], answer: 7, src: [1] }] : [0, 1, 2, 3, 4, 5, 6].map(good);
      return reply('```json\n' + JSON.stringify({ questions: items }) + '\n```');
    }
    if (answerText) return reply(answerText);
    if (/No matching excerpts/.test(sys)) return reply(/joke|hello|hi\b|career/i.test(user) ? 'Sure! Here is a friendly answer.' : '[[GENERAL]] Quantum entanglement is a physics idea beyond Class 10.');
    return reply('DNA fingerprinting compares DNA patterns [1]. It identifies people [2]. Invented claim [9].');
  }
  if (u.includes('generativelanguage')) { calls.gemini++; return j(503, { error: { message: 'down' } }); }
  throw new Error('unexpected fetch ' + u);
};
const call = async (body, query = { provider: 'auto' }, method = 'POST') => {
  const out = { code: 0, body: null }; const res = { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ method, headers: { 'x-forwarded-for': '9.9.9.' + Math.floor(Math.random() * 250) }, query, body }, res); return out;
};
const ctxOf = (o = {}) => ({ cls: '10', action: 'chat', ...o });
const chat = (text, o = {}, history = []) => call({ messages: history.concat([{ role: 'user', text }]), ctx: ctxOf(o) });
let pass = 0; const t = async (n, f) => { try { K.breaker.reset(); K.memo.clear(); behaviour = 'ok'; answerText = null; await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };

await t('academic question: library searched automatically, grounded answer, sources, invented [9] stripped', async () => {
  const r = await chat('What is DNA fingerprinting?'); assert.equal(r.code, 200); assert.ok(r.body.grounded && !r.body.supplementary);
  assert.ok(r.body.sources.length && r.body.sources.every((s) => /^LFHS-\d+$/.test(s.id) && s.page > 0)); assert.ok(!r.body.reply.includes('[9]') && r.body.reply.includes('[1]'));
  assert.ok(last.messages[0].content.includes('Class 10')); assert.ok(last.messages[last.messages.length - 1].content.includes('EXCERPTS:'));
  console.log('     sources:', r.body.sources.map((s) => s.id + ' p' + s.page + (s.cited ? '*' : '')).join(', '));
});
await t('class reaches the AI invisibly: Class 9 gets its own materials only', async () => {
  const r = await chat('What is DNA?', { cls: '9' }); assert.ok(last.messages[0].content.includes('Class 9')); assert.ok(r.body.sources.every((s) => s.id.startsWith('SYN-BIO9')), JSON.stringify(r.body.sources));
});
await t('no subject selector needed: Ohm\'s law resolves to physics by itself', async () => {
  const r = await chat('What is Ohm\'s law?'); assert.ok(r.body.grounded); assert.ok(r.body.sources.every((s) => s.subj === 'physics'));
});
await t('off-syllabus academic question: answered but honestly labelled general (marker stripped, no sources)', async () => {
  const r = await chat('Explain quantum entanglement'); assert.equal(r.code, 200); assert.ok(r.body.supplementary && !r.body.grounded && r.body.sources.length === 0); assert.ok(!r.body.reply.includes('[[GENERAL]]'));
  assert.ok(last.messages[0].content.includes('No matching excerpts'));
});
await t('non-academic message (careers/chitchat): normal answer, no label, no sources', async () => {
  const r = await chat('tell me a joke'); assert.equal(r.code, 200); assert.ok(!r.body.supplementary && !r.body.grounded && r.body.sources.length === 0);
});
await t('model that ignores the excerpts and says [[GENERAL]]: sources are dropped and label shown', async () => {
  answerText = '[[GENERAL]] From general knowledge: ...'; const r = await chat('What is DNA fingerprinting?'); assert.ok(r.body.supplementary && r.body.sources.length === 0);
});
await t('answer with no citations is flagged unverified', async () => {
  answerText = 'DNA fingerprinting is a technique.'; const r = await chat('What is DNA fingerprinting?'); assert.ok(r.body.grounded && r.body.unverified);
});
await t('follow-up keeps the earlier topic ("explain that again")', async () => {
  const h = [{ role: 'user', text: 'What is DNA fingerprinting?' }, { role: 'model', text: 'It compares DNA patterns.' }];
  const r = await chat('Explain that again in simpler words', {}, h); assert.ok(r.body.grounded && r.body.sources.length, JSON.stringify(r.body).slice(0, 200));
});
await t('a new topic after an academic one is NOT glued to the old topic', async () => {
  const h = [{ role: 'user', text: 'What is DNA fingerprinting?' }, { role: 'model', text: 'It compares DNA patterns.' }];
  const r = await chat('tell me a joke', {}, h); assert.ok(!r.body.grounded && r.body.sources.length === 0);
});
await t('quiz: only validated items, never padded to the requested count', async () => {
  behaviour = 'fewer'; const r = await chat('x', { action: 'quiz', count: 10, topic: 'Genetics DNA', subj: 'biology' });
  assert.equal(r.body.returned, 2); assert.equal(r.body.requested, 10); assert.ok(r.body.shortfall); assert.ok(r.body.items.every((i) => i.src.length && i.options.length === 4));
});
await t('quiz caps at the requested count and is built from library text', async () => {
  const r = await chat('x', { action: 'quiz', count: 5, topic: 'Nucleotides DNA structure', subj: 'biology' }); assert.equal(r.body.returned, 5); assert.ok(last.messages[1].content.includes('EXCERPTS:'));
});
await t('quiz for a subject with no library (Malayalam): honest message, zero AI calls', async () => {
  const g = calls.groq; const r = await chat('x', { action: 'quiz', count: 5, topic: 'Poems', subj: 'Malayalam', subjLabel: 'Malayalam' }); assert.ok(r.body.noEvidence && /Malayalam/.test(r.body.reply)); assert.equal(calls.groq, g);
});
await t('quiz on an unrelated topic: noEvidence, zero AI calls', async () => {
  const g = calls.groq; const r = await chat('x', { action: 'quiz', count: 5, topic: 'Quantum entanglement', subj: 'biology' }); assert.ok(r.body.noEvidence); assert.equal(calls.groq, g);
});
await t('flashcards from the library; cards carry source numbers', async () => {
  const r = await chat('x', { action: 'flashcards', count: 5, topic: 'Heredity genes DNA', subj: 'biology' }); assert.equal(r.body.returned, 5); assert.ok(r.body.items.every((c) => c.src.length));
});
await t('cache: same request served without AI; other class / chapter / count never share', async () => {
  const o = { action: 'flashcards', count: 5, topic: 'Heredity genes DNA', subj: 'biology' };
  await chat('x', o); const g = calls.groq; const b = await chat('x', o); assert.ok(b.body.cached && calls.groq === g);
  await chat('x', { ...o, chapter: 1 }); assert.ok(calls.groq > g, 'different chapter must miss'); const g2 = calls.groq; await chat('x', { ...o, count: 6 }); assert.ok(calls.groq > g2, 'different count must miss');
  const r9 = await chat('x', { ...o, cls: '9' }); assert.ok(!r9.body.cached);
});
await t('chat answers are never cached', async () => { const g = calls.groq; await chat('What is DNA fingerprinting?'); await chat('What is DNA fingerprinting?'); assert.equal(calls.groq, g + 2); });
await t('revision sheet is library-only and cited', async () => { const r = await chat('x', { action: 'revision', topic: 'Genetics of life', subj: 'biology' }); assert.equal(r.code, 200); assert.ok(r.body.sources.length && r.body.grounded); });
await t('past questions need no AI and say they are not predictions', async () => {
  const g = calls.groq; const r = await chat('x', { action: 'important', topic: 'blood groups antigen', subj: 'biology' }); assert.ok(r.body.noAi && /does not predict/.test(r.body.reply) && r.body.sources.length); assert.equal(calls.groq, g);
});
await t('provider failures: bounded attempts, breaker opens, no endless retries', async () => {
  behaviour = '429'; calls.groq = 0; calls.gemini = 0; const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await chat('What is DNA fingerprinting?')).code);
  console.log('     codes', codes.join(','), '| groq calls', calls.groq, '| gemini calls', calls.gemini); assert.ok(codes.every((c) => c === 502)); assert.ok(calls.groq <= 3 && calls.gemini <= 3);
});
await t('library missing entirely: no crash; academic question answered with general label, study actions say no material', async () => {
  const keep = process.env.LFHS_KB_DIR; process.env.LFHS_KB_DIR = mkdtempSync(join(tmpdir(), 'empty-')); K.resetIndex();
  const a = await chat('Explain quantum entanglement'); assert.equal(a.code, 200); assert.ok(a.body.supplementary);
  const q = await chat('x', { action: 'quiz', count: 5, topic: 'Genetics', subj: 'biology' }); assert.ok(q.body.noEvidence);
  process.env.LFHS_KB_DIR = keep; K.resetIndex();
});
await t('old clients (no ctx) keep the old response shape', async () => { const r = await call({ messages: [{ role: 'user', text: 'hello' }] }); assert.equal(r.code, 200); assert.deepEqual(Object.keys(r.body).sort(), ['provider', 'reply']); });
await t('bad class falls back to legacy; empty question rejected', async () => {
  const r = await call({ messages: [{ role: 'user', text: 'hi' }], ctx: { cls: '12' } }); assert.deepEqual(Object.keys(r.body).sort(), ['provider', 'reply']);
  assert.equal((await call({ messages: [], ctx: { cls: '10', action: 'chat' } })).code, 400);
});
await t('status endpoint reports library + provider flags, never secrets', async () => {
  const r = await call(null, { status: '1' }, 'GET'); assert.equal(r.code, 200); assert.ok(r.body.library.totals.chunks > 0); assert.ok(r.body.providers.groq && r.body.providers.gemini && !r.body.providers.openrouter); assert.ok(!/SECRET/.test(JSON.stringify(r.body)));
});
await t('API keys never appear in any response', async () => { for (const q of ['What is DNA fingerprinting?', 'quantum', 'joke']) assert.ok(!/SECRET/.test(JSON.stringify((await chat(q)).body))); });
console.log('\n' + pass + ' passed');
