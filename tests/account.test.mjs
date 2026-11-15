// Account API tests with an in-memory stand-in for Supabase's kv table. Covers class accounts and the password check.
import assert from 'node:assert/strict';
Object.assign(process.env, { SUPABASE_URL: 'http://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-SECRET', OWNER_USERNAME: 'owner' });
const kv = new Map();
global.fetch = async (url, opt = {}) => {
  const u = String(url); const method = opt.method || 'GET'; const j = (status, data) => ({ ok: status < 400, status, text: async () => (data === null ? '' : JSON.stringify(data)) });
  if (!u.includes('/rest/v1/kv')) throw new Error('unexpected fetch ' + u);
  if (method === 'GET') {
    const like = u.match(/key=like\.([^&]+)/); if (like) { const pre = decodeURIComponent(like[1]).replace(/%$/, ''); return j(200, [...kv].filter(([k]) => k.startsWith(pre)).map(([k, v]) => ({ key: k, value: v.value }))); }
    const k = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]); return j(200, kv.has(k) ? [{ value: kv.get(k).value, expires_at: kv.get(k).expires_at }] : []);
  }
  if (method === 'POST') { const b = JSON.parse(opt.body); kv.set(b.key, { value: b.value, expires_at: b.expires_at }); return j(201, null); }
  if (method === 'DELETE') { kv.delete(decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1])); return j(204, null); }
  throw new Error('unexpected ' + method);
};
const { default: handler } = await import('../api/account.js');
let ipn = 1;
const call = async (body, token, ip) => {
  const out = { code: 0, body: null }; const res = { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ method: 'POST', headers: { 'x-forwarded-for': ip || '10.0.0.' + (ipn++), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return out;
};
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };
const PW = 'correct-horse-9'; let ownerTok, userTok, classTok;

await t('owner account can be created and is the owner', async () => { const r = await call({ action: 'register', username: 'owner', password: PW }); assert.equal(r.code, 200); ownerTok = r.body.token; assert.equal(r.body.classAccount, false); });
await t('promote owner to creator (set up as in production: via stored record)', async () => {
  const rec = JSON.parse(kv.get('user:owner').value); rec.role = 'creator'; kv.set('user:owner', { value: JSON.stringify(rec) });
  const l = await call({ action: 'login', username: 'owner', password: PW }); ownerTok = l.body.token; assert.ok(l.body.isOwner);
});
await t('normal account: classAccount is false everywhere', async () => {
  const r = await call({ action: 'register', username: 'ayesha.k', password: PW }); assert.equal(r.code, 200); userTok = r.body.token; assert.equal(r.body.classAccount, false);
  assert.equal((await call({ action: 'me' }, userTok)).body.classAccount, false); assert.equal((await call({ action: 'login', username: 'ayesha.k', password: PW })).body.classAccount, false);
});
await t('class account: flag is stored and returned by register, login and me', async () => {
  const r = await call({ action: 'register', username: 'class10a', password: PW, classAccount: true }); assert.equal(r.code, 200); assert.equal(r.body.classAccount, true); classTok = r.body.token;
  assert.equal((await call({ action: 'login', username: 'class10a', password: PW })).body.classAccount, true); assert.equal((await call({ action: 'me' }, classTok)).body.classAccount, true);
});
await t('only a real boolean true makes a class account ("true" text or 1 do not)', async () => {
  for (const [name, v] of [['strtrue', 'true'], ['numone', 1]]) { const r = await call({ action: 'register', username: name, password: PW, classAccount: v }); assert.equal(r.body.classAccount, false); }
});
await t('password check: right password ok, wrong password 403, no session 401', async () => {
  assert.equal((await call({ action: 'verifyPassword', password: PW }, classTok)).code, 200);
  const bad = await call({ action: 'verifyPassword', password: 'nope-nope-1' }, classTok); assert.equal(bad.code, 403); assert.match(bad.body.error, /Wrong password/);
  assert.equal((await call({ action: 'verifyPassword', password: PW })).code, 401);
  assert.equal((await call({ action: 'verifyPassword' }, classTok)).code, 403, 'missing password is rejected');
});
await t('password check cannot be used to guess: locks after repeated wrong tries, even for the right password', async () => {
  const reg = await call({ action: 'register', username: 'lockme', password: PW, classAccount: true }); const tok = reg.body.token; const ip = '172.16.0.9'; let last;
  for (let i = 0; i < 9; i++) last = await call({ action: 'verifyPassword', password: 'wrong-' + i + '-pw' }, tok, ip);
  assert.equal(last.code, 429); assert.equal((await call({ action: 'verifyPassword', password: PW }, tok, ip)).code, 429);
});
await t('owner member list and profile show which accounts are class accounts', async () => {
  const m = await call({ action: 'listMembers' }, ownerTok); assert.equal(m.code, 200); const by = Object.fromEntries(m.body.members.map((x) => [x.username, x]));
  assert.equal(by['class10a'].classAccount, true); assert.equal(by['ayesha.k'].classAccount, false);
  const p = await call({ action: 'memberProfile', username: 'class10a' }, ownerTok); assert.equal(p.code, 200); assert.equal(p.body.profile.classAccount, true);
});
await t('non-owners cannot read member lists', async () => { assert.notEqual((await call({ action: 'listMembers' }, userTok)).code, 200); });
await t('class flag survives saving study data (save keeps the account record)', async () => {
  const s = await call({ action: 'save', data: { class: '10', tasks: [] } }, classTok); assert.equal(s.code, 200);
  assert.equal((await call({ action: 'me' }, classTok)).body.classAccount, true); assert.equal(JSON.parse(kv.get('user:class10a').value).classAccount, true);
});
await t('flashcards keep the "general answer" marker when saved and loaded; normal cards stay unmarked', async () => {
  const card = (id, gen) => ({ id, cls: '10', subj: 'Biology', topic: 'Genetics', q: 'Q ' + id + '?', a: 'A', dueAt: 1, intervalDays: 0, reps: 0, lastReviewed: 0, updatedAt: 1, ...(gen ? { gen: true } : {}) });
  await call({ action: 'save', data: { flashcards: [card('fcaaa', true), card('fcbbb', false)] } }, classTok);
  const l = await call({ action: 'load' }, classTok); const cards = l.body.data.flashcards; assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.id === 'fcaaa').gen, true); assert.ok(!('gen' in cards.find((c) => c.id === 'fcbbb')));
});
await t('change password still works and needs the old password', async () => {
  const bad = await call({ action: 'changePassword', oldPassword: 'wrong-old-pw', newPassword: 'brand-new-pw-1' }, userTok); assert.ok(bad.code >= 400);
  const ok = await call({ action: 'changePassword', oldPassword: PW, newPassword: 'brand-new-pw-1' }, userTok); assert.equal(ok.code, 200);
  assert.equal((await call({ action: 'login', username: 'ayesha.k', password: 'brand-new-pw-1' })).code, 200);
});
await t('logout still works', async () => { assert.equal((await call({ action: 'logout', token: classTok })).code, 200); assert.equal((await call({ action: 'me' }, classTok)).code, 401); });
console.log('\n' + pass + ' passed');
