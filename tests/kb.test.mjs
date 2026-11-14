import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLibrary } from './helpers.mjs';
process.env.LFHS_KB_DIR = makeLibrary();
const K = await import('../api/_kb.js');
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };
const get = (cls, text, o = {}) => { const r = K.retrieve({ cls, text, ...o }); return { ...r, gate: K.evidenceEnough(r.rows, r.terms) }; };

await t('terms drop filler words', () => assert.deepEqual(K.extractTerms('What is DNA fingerprinting? Explain simply'), ['dna', 'fingerprinting']));
await t('stemming joins word forms', () => { assert.equal(K.stem('fingerprinting'), K.stem('fingerprint')); assert.equal(K.stem('electricity'), K.stem('electrical')); assert.equal(K.stem('genes'), K.stem('gene')); });
await t('subject mapping (class 8 science merge)', () => { assert.equal(K.subjectKey('Biology', '8'), 'science'); assert.equal(K.subjectKey('Biology', '10'), 'biology'); assert.equal(K.subjectKey('Social Science', '9'), 'ss'); assert.equal(K.subjectKey('Malayalam', '10'), null); });
await t('subject named in the question is detected; otherwise left to ranking', () => { assert.equal(K.inferSubject('In physics, what is Ohm\'s law?', '10'), 'physics'); assert.equal(K.inferSubject('what is Ohm\'s law?', '10'), null); assert.equal(K.inferSubject('biology of the cell', '8'), 'science'); });

await t('REAL data: CRISPR question finds the Genetics chapter of the real textbook with its real page', () => {
  const r = get('10', 'How does CRISPR gene editing work?', { kinds: K.KINDS.explain });
  assert.ok(r.gate.ok, JSON.stringify(r.gate));
  const tb = r.rows.find((x) => x.resource_id === 'LFHS-218'); assert.ok(tb, 'textbook hit expected'); assert.equal(tb.chapter_no, 1); assert.ok(tb.page >= 7 && tb.page <= 34);
  console.log('     top:', r.rows.slice(0, 3).map((x) => x.resource_id + ' p' + x.page + ' ' + x.kind).join(' | '));
});
await t('REAL data: nerve impulse question lands in the right chapter range', () => {
  const r = get('10', 'How is an impulse transmitted through a neuron?', { kinds: K.KINDS.explain });
  assert.ok(r.gate.ok); assert.ok(r.rows.some((x) => x.resource_id === 'LFHS-218' && x.page >= 35));
});
await t('chapter hint boosts that chapter', () => { const r = get('10', 'neuron impulse nerve', { chapterNo: 3 }); assert.equal(r.rows[0].chapter_no, 3); });
await t('cross-subject ranking picks the subject itself (no selector needed)', () => {
  const a = get('10', 'What is Ohm\'s law?'); assert.ok(a.gate.ok); assert.equal(a.rows[0].subj, 'physics');
  const b = get('10', 'What is DNA fingerprinting?'); assert.ok(b.gate.ok); assert.equal(b.rows[0].subj, 'biology');
});
await t('class isolation: Class 9 / 8 never see Class 10 text', () => {
  const r9 = get('9', 'What is DNA fingerprinting?'); assert.ok(r9.rows.every((x) => x.resource_id.startsWith('SYN-BIO9')));
  const r8 = get('8', 'Ohm\'s law resistance'); assert.equal(r8.rows.length, 0);
  assert.equal(get('9', 'Ohm\'s law resistance').rows.length, 0);
});
await t('subject filter is honoured', () => { assert.equal(get('10', 'DNA nucleotides', { subj: 'physics' }).rows.length, 0); });
await t('off-syllabus question fails the evidence gate', () => { const r = get('10', 'Explain quantum entanglement and Bell inequalities'); assert.ok(!r.gate.ok, JSON.stringify(r.gate)); });
await t('question kinds are separable (questions are never facts)', () => {
  const q = get('10', 'blood groups antigen', { kinds: ['question'] }); assert.ok(q.rows.length && q.rows.every((x) => x.kind === 'question'));
  const e = get('10', 'blood groups antigen', { kinds: K.KINDS.explain }); assert.ok(e.rows.every((x) => x.kind !== 'question'));
});
await t('follow-up detection', () => { for (const s of ['why?', 'Explain that again in simpler words', 'give an example', 'what about this one']) assert.ok(K.isFollowUp(s), s); for (const s of ['What is DNA?', 'tell me a joke', 'Careers after plus two']) assert.ok(!K.isFollowUp(s), s); });
await t('context is numbered; citations to non-existent excerpts are stripped', () => {
  const r = get('10', 'DNA fingerprinting'); const { context, kept } = K.buildContext(r.rows); const src = K.sourcesOf(kept);
  assert.ok(context.startsWith('[1] (p.')); const c = K.checkCitations('A [1]. Fake [9]. Also [' + src.length + '].', src.length);
  assert.ok(!c.text.includes('[9]') && c.used.includes(1));
});
await t('cache keys separate class, subject, chapter, type, count, question type, version', () => {
  const b = { type: 'quiz', cls: '10', subj: 'biology', chapter: 1, topic: 'Genetics', count: 5, qtype: 'mcq', version: 'v1' }; const k = K.cacheKey(b);
  for (const [f, v] of [['cls', '9'], ['subj', 'physics'], ['chapter', 2], ['version', 'v2'], ['type', 'flashcards'], ['count', 10], ['qtype', 'short']]) assert.notEqual(K.cacheKey({ ...b, [f]: v }), k, f);
  assert.equal(K.cacheKey({ ...b, topic: '  GENETICS! ' }), k);
});
await t('circuit breaker opens after 3 failures and recovers', () => {
  K.breaker.reset(); const now = 1000; K.breaker.fail('groq', now); K.breaker.fail('groq', now); assert.ok(K.breaker.canUse('groq', now));
  K.breaker.fail('groq', now); assert.ok(!K.breaker.canUse('groq', now + 10)); assert.ok(K.breaker.canUse('groq', now + 61000));
});
await t('in-flight de-duplication runs the job once', async () => {
  let n = 0; const job = () => new Promise((r) => setTimeout(() => { n++; r('x'); }, 20)); const out = await Promise.all([K.dedupe('k', job), K.dedupe('k', job), K.dedupe('k', job)]);
  assert.equal(n, 1); assert.deepEqual(out, ['x', 'x', 'x']);
});
await t('in-memory cache evicts and expires', () => { K.memo.clear(); K.memo.set('a', 1); assert.equal(K.memo.get('a'), 1); for (let i = 0; i < 200; i++) K.memo.set('k' + i, i); assert.equal(K.memo.get('a'), null); });

await t('SCALE: a ~6 MB Class 10 library loads and answers quickly', () => {
  // replicate the real text 30x with word shuffling to simulate a full class (real Class 10 is expected at 3-6 MB of text)
  const real = JSON.parse(await_read('tests/fixtures/kb/10-biology.json')); const rows = [];
  for (let rep = 0; rep < 30; rep++) for (const r of real.c) { const w = r[7].split(' '); w.push('rep' + rep); rows.push([r[0] + '-' + rep, r[1], r[2], r[3], r[4], r[5], r[6], w.join(' ')]); }
  const big = { ...real, subj: 'maths', res: {}, c: rows }; const dir = makeLibrary({ real: false, synthetic: false });
  writeFileSync(join(dir, '10-maths.json'), JSON.stringify(big)); process.env.LFHS_KB_DIR = dir; K.resetIndex();
  const bytes = JSON.stringify(big).length; const t0 = performance.now(); K.loadClass('10'); const load = performance.now() - t0;
  const t1 = performance.now(); for (let i = 0; i < 20; i++) K.retrieve({ cls: '10', text: 'DNA fingerprinting genes inheritance' }); const q = (performance.now() - t1) / 20;
  console.log('     library ' + (bytes / 1048576).toFixed(1) + ' MB, ' + rows.length + ' chunks: cold load+index ' + load.toFixed(0) + ' ms, query ' + q.toFixed(1) + ' ms');
  assert.ok(load < 4000 && q < 100);
});
import { readFileSync } from 'node:fs'; function await_read(p) { return readFileSync(p, 'utf8'); }
console.log('\n' + pass + ' passed');
