// Acquisition tests: download + verification + catalog append, against synthetic PDFs served locally.
import assert from 'node:assert/strict'; import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process'; import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import vm from 'node:vm';
if (spawnSync('python3', ['-c', 'import reportlab, PIL']).status !== 0) { console.log('SKIPPED: python3 with reportlab and Pillow is needed'); process.exit(0); }
const pdfDir = mkdtempSync(join(tmpdir(), 'acq-pdfs-')); const out = mkdtempSync(join(tmpdir(), 'acq-out-')); const work = mkdtempSync(join(tmpdir(), 'acq-work-'));
spawnSync('python3', ['tests/make_lang_pdfs.py', pdfDir]);
const man = { version: 1, books: [
  { key: 'ok-ml', cls: '10', subj: 'malayalam', medium: 'Malayalam', series: 'Kerala Padavali', part: 'Part 1', file: 'Class-10-ML.pdf', year: '2025', edition: 'test', url: 'http://localhost:8198/ml_textbook.pdf', expectHints: ['മഴക്കാലം'] },
  { key: 'ok-hi', cls: '10', subj: 'hindi', medium: 'Hindi', series: 'Hindi', part: 'Part 1', file: 'Class-10-HI.pdf', year: '2025', edition: 'test', url: 'http://localhost:8198/hi_textbook.pdf', expectHints: ['वर्षा'] },
  { key: 'hint-miss', cls: '8', subj: 'malayalam', medium: 'Malayalam', series: 'Adisthana Padavali', part: 'Part 1', file: 'Class-8-ML.pdf', url: 'http://localhost:8198/ml_class8.pdf', expectHints: ['ഇല്ലാത്തവാക്ക്'] },
  { key: 'dup', cls: '9', subj: 'malayalam', medium: 'Malayalam', series: 'Dup', part: 'Part 1', file: 'Class-9-dup.pdf', url: 'http://localhost:8198/ml_textbook.pdf' },
  { key: 'wrong-lang', cls: '9', subj: 'malayalam', medium: 'Malayalam', series: 'W', part: 'Part 1', file: 'w.pdf', url: 'http://localhost:8198/english_as_malayalam.pdf' },
  { key: 'html', cls: '9', subj: 'hindi', medium: 'Hindi', series: 'H', part: 'Part 1', file: 'h.pdf', url: 'http://localhost:8198/page.pdf' },
  { key: 'gone', cls: '9', subj: 'hindi', medium: 'Hindi', series: 'G', part: 'Part 1', file: 'g.pdf', url: 'http://localhost:8198/gone.pdf' },
  { key: 'no-url', cls: '9', subj: 'hindi', medium: 'Hindi', series: 'N', part: 'Part 1', file: 'n.pdf', url: null },
  { key: 'old', cls: '8', subj: 'hindi', medium: 'Hindi', series: 'Old', part: 'Part 1', file: 'old.pdf', url: 'http://localhost:8198/hi_textbook.pdf', superseded: true },
] };
const manPath = join(work, 'acq.json'); writeFileSync(manPath, JSON.stringify(man));
const oldCatalog = readFileSync('data/pdfs.js', 'utf8').replace(/,\s*\{"id":"LFHS-(36[3-9]|37[0-2])"[\s\S]*\];/, '];');
writeFileSync(join(work, 'pdfs.js'), oldCatalog);
const srv = http.createServer((q, r) => { const f = q.url.slice(1); if (f === 'page.pdf') { r.end('<html>' + 'x'.repeat(60000) + '</html>'); } else if (existsSync(join(pdfDir, f))) r.end(readFileSync(join(pdfDir, f))); else { r.statusCode = 404; r.end('no'); } }).listen(8198);
const runAsync = (args) => new Promise((ok) => { const p = spawn(process.execPath, ['scripts/acquire.mjs', ...args]); let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('close', (code) => ok({ code, o, e })); });
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };
const r1 = await runAsync(['--min-bytes', '10000', '--manifest', manPath, '--out', out, '--catalog', join(work, 'pdfs.js'), '--add-to-catalog', '--host', 'https://example.test/lfhs-4/Textbooks/']); srv.close();
const inv = JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8')).books; const st = Object.fromEntries(inv.map((b) => [b.key, b]));
await t('verified books are really checked (page count, bytes, sha, script)', () => { assert.equal(st['ok-ml'].status, 'verified'); assert.equal(st['ok-ml'].pages, 11); assert.ok(st['ok-ml'].bytes > 10000 && st['ok-ml'].sha256.length === 64); assert.equal(st['ok-hi'].status, 'verified'); });
await t('title hint that is not found is flagged, not silently accepted', () => { assert.equal(st['hint-miss'].status, 'verified_title_unconfirmed'); });
await t('duplicate downloads, wrong-language, HTML-as-PDF, 404 and missing urls are all reported correctly', () => {
  assert.equal(st['dup'].status, 'failed'); assert.match(st['dup'].notes.join(), /duplicate/); assert.equal(st['wrong-lang'].status, 'wrong_language'); assert.equal(st['html'].status, 'failed'); assert.match(st['html'].notes.join(), /not a PDF/);
  assert.equal(st['gone'].status, 'failed'); assert.match(st['gone'].notes.join(), /HTTP 404/); assert.equal(st['no-url'].status, 'url_needed');
});
await t('superseded editions are skipped unless asked for', () => { assert.equal(st['old'].status, 'superseded_skipped'); assert.equal(st['old'].pages, null); });
await t('inventory files are written', () => { assert.match(readFileSync(join(out, 'INVENTORY.md'), 'utf8'), /\| 10 \| malayalam \| Malayalam \| Kerala Padavali \| Part 1 \|/); });
await t('catalog append: only verified books are added, old entries are byte-for-byte unchanged, ids continue, backup exists', () => {
  const oldText = oldCatalog; const newText = readFileSync(join(work, 'pdfs.js'), 'utf8'); assert.ok(existsSync(join(work, 'pdfs.js.bak'))); assert.equal(readFileSync(join(work, 'pdfs.js.bak'), 'utf8'), oldText);
  const cut = oldText.replace(/\]\s*;\s*$/, ''); assert.ok(newText.startsWith(cut), 'existing entries untouched');
  const sb = { window: {} }; vm.runInNewContext(newText, sb); const cat = sb.window.LFHS_PDFS; const old = { window: {} }; vm.runInNewContext(oldText, old); const n0 = old.window.LFHS_PDFS.length;
  assert.equal(cat.length, n0 + 3); const added = cat.slice(n0); assert.deepEqual(JSON.parse(JSON.stringify(added.map((e) => e.subj))).sort(), ['hindi', 'malayalam', 'malayalam']); assert.ok(added.every((e) => e.medium && e.url.startsWith('https://example.test/lfhs-4/Textbooks/') && e.pages > 0 && e.bytes > 0 && e.types[0] === 'textbook'));
  assert.equal(new Set(cat.map((e) => e.id)).size, cat.length); assert.ok(!/[^\x00-\x7f]/.test(newText.slice(cut.length)), 'appended entries use \\u escapes like the rest of the file'); assert.match(newText.slice(cut.length), /\\u2014/);
  const ml = added.find((e) => e.key === undefined && e.cls === '10' && e.subj === 'malayalam'); assert.equal(ml.title, 'Kerala Padavali Textbook \u2014 Part 1');
});
await t('catalog append is idempotent (running again adds nothing)', async () => { const r = await runAsync(['--min-bytes', '10000', '--manifest', manPath, '--out', out, '--local', out, '--catalog', join(work, 'pdfs.js'), '--add-to-catalog', '--host', 'https://example.test/lfhs-4/Textbooks/']); assert.match(r.o, /already in the catalog/); });
console.log('\n' + pass + ' passed');
