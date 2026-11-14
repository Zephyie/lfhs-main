#!/usr/bin/env node
/* Deploy-readiness check. Run from the project root:  node scripts/verify.mjs
 *   --library-only   only check the AI library files (used by the GitHub workflow)
 * Prints PASS / WARN / FAIL lines and exits 1 if anything FAILED. Needs no network and no PDFs. */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const LIB_ONLY = process.argv.includes('--library-only');
let fails = 0, warns = 0;
const ok = (m) => console.log('PASS  ' + m);
const warn = (m) => { warns++; console.log('WARN  ' + m); };
const bad = (m) => { fails++; console.log('FAIL  ' + m); };
const read = (p) => readFileSync(p, 'utf8');

/* ---- catalog ---- */
let catalog = [];
try { const sb = { window: {} }; vm.runInNewContext(read('data/pdfs.js'), sb); catalog = sb.window.LFHS_PDFS || []; ok('catalog data/pdfs.js: ' + catalog.length + ' resources'); } catch (e) { bad('data/pdfs.js cannot be read: ' + e.message); }
const byId = new Map(catalog.map((p) => [p.id, p]));

/* ---- library ---- */
const KB = 'api/_kb';
if (!existsSync(KB)) { (LIB_ONLY ? bad : warn)('api/_kb does not exist yet: run the "Build AI library" workflow (or node scripts/ingest.mjs)'); }
else {
  const files = readdirSync(KB).filter((f) => /^\d+-[a-z]+\.json$/.test(f));
  if (!files.length) warn('api/_kb has no library files yet: the assistant will answer without textbook search until you build it');
  let chunks = 0, bytes = 0; const seen = new Set(); const classes = new Set();
  for (const f of files) {
    const size = statSync(join(KB, f)).size; bytes += size; if (size > 40 * 1048576) bad(f + ' is ' + (size / 1048576).toFixed(0) + ' MB (too big for one shard)');
    let s; try { s = JSON.parse(read(join(KB, f))); } catch (e) { bad(f + ' is not valid JSON: ' + e.message); continue; }
    if (s.v !== 1 || !Array.isArray(s.c) || !s.res || !Array.isArray(s.titles)) { bad(f + ' has an unexpected format'); continue; }
    classes.add(s.cls); let badRows = 0, badRefs = 0, badPage = 0;
    for (const r of s.c) {
      if (!Array.isArray(r) || r.length !== 8 || typeof r[7] !== 'string' || !r[7].trim() || !Number.isInteger(r[1]) || r[1] < 1) { badRows++; continue; }
      if (r[3] >= s.titles.length) badRows++;
      seen.add(r[0]); const c = byId.get(r[0]);
      if (catalog.length && !c && !String(r[0]).startsWith('SYN-')) badRefs++;
      if (c && c.pages && r[1] > c.pages) badPage++;
    }
    chunks += s.c.length;
    if (badRows) bad(f + ': ' + badRows + ' malformed chunk rows'); if (badRefs) bad(f + ': ' + badRefs + ' chunks point at resource IDs that are not in data/pdfs.js'); if (badPage) bad(f + ': ' + badPage + ' chunks cite a page beyond the PDF length');
    if (!badRows && !badRefs && !badPage) ok(f + ': ' + s.c.length + ' chunks, ' + Object.keys(s.res).length + ' resources, ' + (size / 1024).toFixed(0) + ' KB');
  }
  if (files.length) {
    ok('library total: ' + files.length + ' files, ' + chunks + ' chunks, ' + (bytes / 1048576).toFixed(1) + ' MB (Vercel function limit is 250 MB)');
    if (bytes > 120 * 1048576) warn('library is over 120 MB; consider splitting further');
    if (catalog.length) {
      const wanted = catalog.filter((p) => String(p.cls).split('-').some((c) => ['8', '9', '10'].includes(c)));
      const missing = wanted.filter((p) => !seen.has(p.id));
      if (missing.length) warn(missing.length + ' of ' + wanted.length + ' catalog resources have no text in the library yet (not ingested, scanned, or unreadable). First few: ' + missing.slice(0, 5).map((p) => p.id).join(', '));
      else ok('every catalog resource has text in the library');
    }
    for (const c of ['8', '9', '10']) if (!classes.has(c)) warn('no library files for Class ' + c + ' yet');
  }
}
if (LIB_ONLY) { console.log('\n' + fails + ' failed, ' + warns + ' warnings'); process.exit(fails ? 1 : 0); }

/* ---- code ---- */
const jsFiles = [...readdirSync('api').filter((f) => f.endsWith('.js')).map((f) => 'api/' + f), ...(existsSync('scripts') ? readdirSync('scripts').filter((f) => f.endsWith('.mjs')).map((f) => 'scripts/' + f) : []), 'sw.js'];
for (const f of jsFiles) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok('syntax ' + f); } catch (e) { bad('syntax error in ' + f + ': ' + String(e.stderr).split('\n')[0]); } }
try {
  const html = read('index.html'); const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let n = 0; for (const code of scripts) { try { new vm.Script(code); n++; } catch (e) { bad('index.html inline script: ' + e.message); } }
  ok('index.html: ' + n + '/' + scripts.length + ' inline scripts parse');
  for (const need of ['/api/chat', 'aiToolsBtn', 'openPdfViewer(id,page)']) if (!html.includes(need)) bad('index.html is missing "' + need + '"');
  for (const gone of ['data-aimode', 'id="aiSubj"']) if (html.includes(gone)) bad('index.html still contains removed control ' + gone);
} catch (e) { bad('index.html: ' + e.message); }

/* ---- vercel.json ---- */
try {
  const v = JSON.parse(read('vercel.json')); ok('vercel.json is valid JSON');
  const inc = v.functions && v.functions['api/chat.js'] && v.functions['api/chat.js'].includeFiles;
  if (inc !== 'api/_kb/**') bad('vercel.json: api/chat.js must have includeFiles "api/_kb/**" (found ' + JSON.stringify(inc) + ')'); else ok('vercel.json bundles api/_kb/** with the AI function');
  const ign = existsSync('.vercelignore') ? read('.vercelignore') : '';
  if (/^\s*(api|api\/_kb|_kb)\s*$/m.test(ign)) bad('.vercelignore excludes the library'); else ok('.vercelignore does not exclude api/_kb');
} catch (e) { bad('vercel.json: ' + e.message); }

/* ---- secrets ---- */
const envFiles = readdirSync('.').filter((f) => /^\.env/.test(f));
if (envFiles.length) warn('env files present in the folder: ' + envFiles.join(', ') + ' (they must not be committed; check .gitignore)'); else ok('no .env files in the folder');
const gi = existsSync('.gitignore') ? read('.gitignore') : ''; if (!/\.env/.test(gi)) warn('.gitignore does not list .env files');
const PAT = [/gsk_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /sk-or-v1-[A-Za-z0-9]{20,}/, /eyJhbGciOi[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\./, /sb_secret_[A-Za-z0-9_-]{10,}/];
let leaks = 0;
(function walk(d) { for (const f of readdirSync(d)) { if (['.git', 'node_modules', 'pdfs'].includes(f)) continue; const p = join(d, f); const st = statSync(p); if (st.isDirectory()) { walk(p); continue; } if (st.size > 3 * 1048576 || !['.js', '.mjs', '.html', '.json', '.md', '.yml', '.txt', '.css', '.webmanifest', '.py'].includes(extname(f))) continue; const t = read(p); for (const re of PAT) if (re.test(t)) { leaks++; bad('possible API key in ' + p); break; } } })('.');
if (!leaks) ok('no API keys found in source files');
try { const c = read('api/chat.js'); if (/(GROQ|GEMINI|OPENROUTER)_API_KEY\s*=\s*['"][^'"]+/.test(c)) bad('hard-coded key in api/chat.js'); else ok('api/chat.js reads keys from environment variables only'); } catch (e) { /* ignore */ }

console.log('\n' + fails + ' failed, ' + warns + ' warnings'); process.exit(fails ? 1 : 0);
