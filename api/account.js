// LFHS Academic Hub - accounts: register, log in, log out, and save/load each user's study data.
// Stored in the Supabase table kv (same table as the site content). Passwords are hashed (scrypt).
// Location in your project: api/account.js

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || '').trim().toLowerCase();
const SESSION_DAYS = 30;
const MAX_FAILS = 8;
const LOCK_SECONDS = 900;
const MAX_DATA_CHARS = 200000;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sbConfig() {
  const ok = (v) => v && !String(v).startsWith('PASTE_');
  return {
    url: ok(SUPABASE_URL) ? SUPABASE_URL : (process.env.SUPABASE_URL || ''),
    key: ok(SUPABASE_SERVICE_KEY) ? SUPABASE_SERVICE_KEY : (process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
  };
}
async function sb(method, path, body, extra) {
  const { url, key } = sbConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + path, {
      method,
      headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.message) || 'supabase ' + res.status);
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('supabase timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function kvGet(key) {
  const rows = await sb('GET', 'kv?key=eq.' + encodeURIComponent(key) + '&select=value,expires_at');
  const r = rows && rows[0];
  if (!r) return null;
  if (r.expires_at && new Date(r.expires_at) < new Date()) return null;
  return r.value;
}
async function kvSet(key, value, ttlSec) {
  const expires = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
  await sb('POST', 'kv?on_conflict=key', { key: key, value: String(value), expires_at: expires },
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}
async function kvDel(key) {
  await sb('DELETE', 'kv?key=eq.' + encodeURIComponent(key), null, { Prefer: 'return=minimal' });
}

/* ---------- passwords ---------- */
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const want = Buffer.from(parts[2], 'hex');
  const got = scryptSync(String(pw), parts[1], want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ---------- lockout helpers ---------- */
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim().replace(/[^0-9a-fA-F.:]/g, '') || 'unknown';
}

// per-user-per-IP (login attempts)
async function lockedUser(ip, username) { return Number((await kvGet('afail:u:' + sha(ip + ':' + username))) || 0) >= MAX_FAILS; }
async function failedUser(ip, username) {
  const n = Number((await kvGet('afail:u:' + sha(ip + ':' + username))) || 0);
  await kvSet('afail:u:' + sha(ip + ':' + username), n + 1, LOCK_SECONDS);
  await sleep(500);
}
// global IP ceiling (35 attempts)
const MAX_GLOBAL_FAILS = 35;
async function lockedGlobal(ip) { return Number((await kvGet('afail:ip:' + sha(ip))) || 0) >= MAX_GLOBAL_FAILS; }
async function failedGlobal(ip) {
  const n = Number((await kvGet('afail:ip:' + sha(ip))) || 0);
  await kvSet('afail:ip:' + sha(ip), n + 1, LOCK_SECONDS);
}

/* ---------- sessions ---------- */
async function sessionOf(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const raw = await kvGet('sess:' + sha(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function newSession(username, role, ver) {
  const token = randomBytes(32).toString('hex');
  await kvSet('sess:' + sha(token), JSON.stringify({ u: username, r: role, ver: ver || 1 }), SESSION_DAYS * 86400);
  return token;
}

async function removeUnissuedCreatorRole(username, user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return false;
  const isOwner = !!OWNER_USERNAME && username === OWNER_USERNAME;
  const ownerGranted = !!OWNER_USERNAME && user.creatorGrantedBy === OWNER_USERNAME;
  if (user.role !== 'creator' || isOwner || ownerGranted) return false;
  user.role = 'user';
  user.ver = (user.ver || 1) + 1;
  delete user.creatorGrantedBy;
  delete user.creatorGrantedAt;
  await kvSet('user:' + username, JSON.stringify(user));
  return true;
}

/* ---------- session auth helper ---------- */
async function authSession(tokenOrBearer) {
  const s = await sessionOf(tokenOrBearer);
  if (!s) return null;
  const userRaw = await kvGet('user:' + s.u);
  if (!userRaw) {
    // User deleted — clean up stale session
    await kvDel('sess:' + sha(tokenOrBearer));
    return null;
  }
  let user;
  try { user = JSON.parse(userRaw); } catch (e) { return null; }
  if (await removeUnissuedCreatorRole(s.u, user)) {
    await kvDel('sess:' + sha(tokenOrBearer));
    return { expired: true };
  }
  if ((s.ver || 1) !== (user.ver || 1) || s.r !== user.role) {
    // Session version mismatch — password or access level changed
    await kvDel('sess:' + sha(tokenOrBearer));
    return { expired: true };
  }
  const isOwner = !!OWNER_USERNAME && s.u === OWNER_USERNAME && user.role === 'creator';
  return { s, user, isOwner };
}

/* ---------- input rules ---------- */
const cleanName = (v) => String(v || '').trim().toLowerCase();
const validName = (n) => /^[a-z0-9_.]{3,20}$/.test(n);
const validPass = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 100;
const cleanData = (d) => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const out = {};
  const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  const validDate = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    const [y, m, dd] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, dd));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === dd ? v : '';
  };
  // tasks
  if (Array.isArray(d.tasks)) {
    out.tasks = d.tasks.slice(0, 300).map((t) => {
      if (!t || typeof t !== 'object') return null;
      const title = str(t.title, 160);
      if (!title) return null;
      return {
        id: str(t.id, 40) || ('t' + Math.random().toString(36).slice(2)),
        title,
        subj: str(t.subj, 30),
        due: validDate(t.due),
        done: !!t.done,
        priority: ['low', 'med', 'high', ''].includes(t.priority) ? (t.priority || '') : '',
        createdAt: (typeof t.createdAt === 'number' && t.createdAt > 0) ? t.createdAt : Date.now(),
      };
    }).filter(Boolean);
  }
  // progress
  if (d.progress && typeof d.progress === 'object' && !Array.isArray(d.progress)) {
    out.progress = {};
    let count = 0;
    for (const [k, v] of Object.entries(d.progress)) {
      if (count >= 500) break;
      const key = str(k, 60);
      if (key && ['todo', 'progress', 'done'].includes(v)) { out.progress[key] = v; count++; }
    }
  }
  // saved
  if (Array.isArray(d.saved)) {
    out.saved = d.saved.slice(0, 300).map((s) => str(s, 60)).filter(Boolean);
  }
  // recent
  if (Array.isArray(d.recent)) {
    out.recent = d.recent.slice(0, 20).map((s) => str(s, 60)).filter(Boolean);
  }
  // recentSearch
  if (Array.isArray(d.recentSearch)) {
    out.recentSearch = d.recentSearch.slice(0, 10).map((s) => str(s, 100)).filter(Boolean);
  }
  // class
  if (['8', '9', '10'].includes(d.class)) out.class = d.class;
  // theme
  if (['light', 'dark'].includes(d.theme)) out.theme = d.theme;
  // focusStats (new optional field)
  if (d.focusStats && typeof d.focusStats === 'object') {
    out.focusStats = {
      sessions: Math.max(0, Math.floor(Number(d.focusStats.sessions) || 0)),
      minutes: Math.max(0, Math.floor(Number(d.focusStats.minutes) || 0)),
      lastDate: validDate(str(d.focusStats.lastDate, 10)),
    };
  }
  // Spaced-repetition flashcard library (bounded to keep account payloads small).
  if (Array.isArray(d.flashcards)) {
    out.flashcards = d.flashcards.slice(-30).map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cls = ['8', '9', '10'].includes(String(c.cls)) ? String(c.cls) : '';
      const q = str(c.q, 320), a = str(c.a, 800), id = str(c.id, 80);
      if (!cls || !q || !a || !id) return null;
      const dueAt = Number(c.dueAt), lastReviewed = Number(c.lastReviewed);
      const updatedAt = Number(c.updatedAt);
      return {
        id, cls, subj: str(c.subj, 40), topic: str(c.topic, 120), q, a,
        dueAt: Number.isFinite(dueAt) && dueAt > 0 ? Math.min(dueAt, Date.now() + 3 * 365 * 86400000) : Date.now(),
        intervalDays: Math.max(0, Math.min(60, Math.floor(Number(c.intervalDays) || 0))),
        reps: Math.max(0, Math.min(100, Math.floor(Number(c.reps) || 0))),
        lastReviewed: Number.isFinite(lastReviewed) && lastReviewed > 0 ? lastReviewed : 0,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
      };
    }).filter(Boolean);
  }
  // Recent quiz summaries retain only missed questions, so students can retry them.
  if (Array.isArray(d.quizHistory)) {
    out.quizHistory = d.quizHistory.slice(-5).map((h) => {
      if (!h || typeof h !== 'object') return null;
      const cls = ['8', '9', '10'].includes(String(h.cls)) ? String(h.cls) : '';
      const total = Math.max(1, Math.min(10, Math.floor(Number(h.total) || 0)));
      const id = str(h.id, 60), topic = str(h.topic, 120);
      if (!cls || !id || !topic) return null;
      const missed = Array.isArray(h.missed) ? h.missed.slice(0, 10).map((q) => {
        if (!q || typeof q !== 'object' || typeof q.q !== 'string' || !Array.isArray(q.options) || q.options.length !== 4) return null;
        const options = q.options.map((o) => str(o, 100));
        const answer = Number(q.answer);
        if (!q.q.trim() || options.some((o) => !o) || !Number.isInteger(answer) || answer < 0 || answer > 3) return null;
        return { q: str(q.q, 240), options, answer, explain: str(q.explain, 180) };
      }).filter(Boolean) : [];
      const date = Number(h.date);
      return {
        id, cls, subj: str(h.subj, 40), topic,
        score: Math.max(0, Math.min(total, Math.floor(Number(h.score) || 0))), total,
        date: Number.isFinite(date) && date > 0 ? date : Date.now(), missed,
      };
    }).filter(Boolean);
  }
  out.updatedAt = new Date().toISOString();
  return out;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { url, key } = sbConfig();
  if (!url || !key) return res.status(503).json({ code: 'no_storage', error: 'Accounts are not set up yet.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Bad request.' });
  const ip = clientIp(req);

  try {
    if (body.action === 'register') {
      const username = cleanName(body.username);
      if (!validName(username)) return res.status(400).json({ error: 'Username: 3 to 20 letters, numbers, dots or underscores.' });
      if (!validPass(body.password)) return res.status(400).json({ error: 'Password: at least 6 characters.' });
      if (await kvGet('user:' + username)) return res.status(409).json({ error: 'That username is taken.' });
      const role = 'user';
      await kvSet('user:' + username, JSON.stringify({ hash: hashPassword(body.password), role, ver: 1, data: {}, created: new Date().toISOString() }));
      const token = await newSession(username, role, 1);
      return res.status(200).json({ ok: true, token: token, username: username, role: role, isOwner: false });
    }

    if (body.action === 'login') {
      if (await lockedGlobal(ip)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
      const username = cleanName(body.username);
      if (await lockedUser(ip, username)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
      const raw = validName(username) ? await kvGet('user:' + username) : null;
      const user = raw ? JSON.parse(raw) : null;
      if (!user || !checkPassword(body.password, user.hash)) {
        await failedUser(ip, username);
        await failedGlobal(ip);
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      await removeUnissuedCreatorRole(username, user);
      const token = await newSession(username, user.role, user.ver || 1);
      return res.status(200).json({ ok: true, token: token, username: username, role: user.role, isOwner: !!OWNER_USERNAME && username === OWNER_USERNAME && user.role === 'creator' });
    }

    if (body.action === 'logout') {
      const t = body.token || String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (typeof t === 'string' && t) await kvDel('sess:' + sha(t));
      return res.status(200).json({ ok: true });
    }

    // Public username-based password-help request. Never return whether a username exists.
    if (body.action === 'requestPasswordReset') {
      const username = cleanName(body.username);
      if (!validName(username)) return res.status(400).json({ error: 'Enter a valid username.' });
      const throttleKey = 'pwreq:ip:' + sha(ip);
      if (await kvGet(throttleKey)) return res.status(429).json({ error: 'A request was already sent recently. Please wait before trying again.' });
      await kvSet(throttleKey, '1', 300);
      const raw = await kvGet('user:' + username);
      if (raw) {
        const queue = JSON.parse((await kvGet('pwreset:queue')) || '[]');
        const existing = queue.find((q) => q.username === username && !q.reviewed);
        if (!existing) {
          queue.unshift({ id: randomUUID(), username, created: new Date().toISOString(), reviewed: false });
          await kvSet('pwreset:queue', JSON.stringify(queue.slice(0, 100)));
        }
      }
      return res.status(200).json({ ok: true });
    }

    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const tokenOrBearer = body.token || bearer;
    const auth = await authSession(tokenOrBearer);
    if (!auth) return res.status(401).json({ code: 'session', error: 'Please log in again.' });
    if (auth.expired) return res.status(401).json({ code: 'session', error: 'Session expired or password changed. Please log in again.' });

    const { s, user: sessionUser, isOwner } = auth;

    if (body.action === 'me') return res.status(200).json({ ok: true, username: s.u, role: sessionUser.role, isOwner });

    if (body.action === 'listPasswordResetRequests') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const requests = JSON.parse((await kvGet('pwreset:queue')) || '[]');
      return res.status(200).json({ ok: true, requests: requests.filter((q) => q && !q.reviewed).slice(0, 100) });
    }
    if (body.action === 'resolvePasswordReset') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const id = String(body.id || '').slice(0, 80);
      const requests = JSON.parse((await kvGet('pwreset:queue')) || '[]');
      const found = requests.find((q) => q && q.id === id);
      if (!found) return res.status(404).json({ error: 'Request not found.' });
      found.reviewed = true;
      found.reviewedAt = new Date().toISOString();
      await kvSet('pwreset:queue', JSON.stringify(requests.slice(0, 100)));
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'listMembers') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const rows = await sb('GET', 'kv?key=like.user%3A%25&select=key,value&limit=500');
      const members = [];
      for (const row of rows || []) {
        const username = String(row.key || '').slice(5);
        if (!validName(username)) continue;
        let u = {}; try { const parsed = JSON.parse(row.value || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) u = parsed; } catch (e) {}
        await removeUnissuedCreatorRole(username, u);
        const isOwner = !!OWNER_USERNAME && username === OWNER_USERNAME;
        members.push({ username, role: isOwner ? 'owner' : (u.role || 'user'), isOwner, created: u.created || null });
      }
      members.sort((a, b) => a.username.localeCompare(b.username));
      return res.status(200).json({ ok: true, members });
    }
    if (body.action === 'memberProfile') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const username = cleanName(body.username);
      if (!validName(username)) return res.status(400).json({ error: 'Choose a valid username.' });
      const raw = await kvGet('user:' + username);
      if (!raw) return res.status(404).json({ error: 'Member not found.' });
      const targetUser = JSON.parse(raw);
      if (!targetUser || typeof targetUser !== 'object' || Array.isArray(targetUser)) return res.status(404).json({ error: 'Member profile is unavailable.' });
      await removeUnissuedCreatorRole(username, targetUser);
      const data = targetUser.data && typeof targetUser.data === 'object' ? targetUser.data : {};
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const progress = data.progress && typeof data.progress === 'object' && !Array.isArray(data.progress) ? Object.values(data.progress) : [];
      const quizzes = Array.isArray(data.quizHistory) ? data.quizHistory : [];
      const quizAverage = quizzes.length ? Math.round(quizzes.reduce((sum, q) => sum + (Number(q.score) / Math.max(1, Number(q.total) || 1)) * 100, 0) / quizzes.length) : null;
      const isTargetOwner = !!OWNER_USERNAME && username === OWNER_USERNAME;
      return res.status(200).json({ ok: true, profile: {
        username,
        role: isTargetOwner ? 'owner' : (targetUser.role || 'user'),
        created: targetUser.created || null,
        class: ['8', '9', '10'].includes(String(data.class)) ? String(data.class) : null,
        tasks: tasks.length,
        completedTasks: tasks.filter((t) => t && t.done).length,
        savedResources: Array.isArray(data.saved) ? data.saved.length : 0,
        trackedTopics: progress.length,
        completedTopics: progress.filter((status) => status === 'done').length,
        flashcards: Array.isArray(data.flashcards) ? data.flashcards.length : 0,
        quizAttempts: quizzes.length,
        quizAverage,
        focusMinutes: Math.max(0, Math.floor(Number(data.focusStats && data.focusStats.minutes) || 0)),
        lastStudyUpdate: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      } });
    }
    if (body.action === 'setMemberCreator') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const username = cleanName(body.username);
      if (!validName(username) || typeof body.creator !== 'boolean') return res.status(400).json({ error: 'Choose a valid member and creator status.' });
      if (username === s.u || (OWNER_USERNAME && username === OWNER_USERNAME)) return res.status(400).json({ error: 'The owner account is protected from role changes.' });
      const raw = await kvGet('user:' + username);
      if (!raw) return res.status(404).json({ error: 'Member not found.' });
      const targetUser = JSON.parse(raw);
      if (!targetUser || typeof targetUser !== 'object' || Array.isArray(targetUser)) return res.status(404).json({ error: 'Member account is unavailable.' });
      await removeUnissuedCreatorRole(username, targetUser);
      const currentCreator = targetUser.role === 'creator' && !!OWNER_USERNAME && targetUser.creatorGrantedBy === OWNER_USERNAME;
      if (currentCreator === body.creator) return res.status(200).json({ ok: true, changed: false, role: targetUser.role || 'user' });
      targetUser.role = body.creator ? 'creator' : 'user';
      targetUser.ver = (targetUser.ver || 1) + 1;
      if (body.creator) {
        targetUser.creatorGrantedBy = s.u;
        targetUser.creatorGrantedAt = new Date().toISOString();
      } else {
        delete targetUser.creatorGrantedBy;
        delete targetUser.creatorGrantedAt;
      }
      await kvSet('user:' + username, JSON.stringify(targetUser));
      return res.status(200).json({ ok: true, changed: true, role: targetUser.role, sessionsRevoked: true });
    }
    if (body.action === 'deleteMember') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const username = cleanName(body.username);
      if (!validName(username)) return res.status(400).json({ error: 'Choose a valid username.' });
      if (username === s.u || (OWNER_USERNAME && username === OWNER_USERNAME)) return res.status(400).json({ error: 'The owner account is protected from deletion.' });
      if (!(await kvGet('user:' + username))) return res.status(404).json({ error: 'Member not found.' });
      await kvDel('user:' + username);
      try {
        const queue = JSON.parse((await kvGet('pwreset:queue')) || '[]');
        const remaining = queue.filter((q) => !q || q.username !== username);
        if (remaining.length !== queue.length) await kvSet('pwreset:queue', JSON.stringify(remaining.slice(0, 100)));
      } catch (e) {
        // Account deletion is complete even if an old password-help request cannot be cleaned up.
        console.error('password-help cleanup failed:', e && e.message);
      }
      return res.status(200).json({ ok: true, deleted: true, username });
    }
    if (body.action === 'resetPassword') {
      if (!isOwner) return res.status(403).json({ error: 'Owner account required.' });
      const username = cleanName(body.username);
      const newPassword = body.newPassword;
      if (!validName(username) || !validPass(newPassword)) return res.status(400).json({ error: 'Choose a valid username and a password of 6 to 100 characters.' });
      if (OWNER_USERNAME && username === OWNER_USERNAME) return res.status(400).json({ error: 'The owner account is protected from member password resets.' });
      const raw = await kvGet('user:' + username);
      if (!raw) return res.status(404).json({ error: 'Member not found.' });
      const targetUser = JSON.parse(raw);
      targetUser.hash = hashPassword(newPassword);
      targetUser.ver = (targetUser.ver || 1) + 1;
      await kvSet('user:' + username, JSON.stringify(targetUser));
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'load') {
      return res.status(200).json({ ok: true, data: cleanData(sessionUser.data), updatedAt: (sessionUser.data && sessionUser.data.updatedAt) || null });
    }

    if (body.action === 'save') {
      const data = cleanData(body.data);
      if (JSON.stringify(data).length > MAX_DATA_CHARS) return res.status(413).json({ error: 'Too much data to save.' });
      const userRaw = await kvGet('user:' + s.u);
      const userObj = userRaw ? JSON.parse(userRaw) : {};
      if (!userObj.hash) return res.status(404).json({ error: 'Account not found.' });
      userObj.data = data;
      await kvSet('user:' + s.u, JSON.stringify(userObj));
      return res.status(200).json({ ok: true, updatedAt: data.updatedAt });
    }

    if (body.action === 'changePassword') {
      if (!sessionUser.hash || !checkPassword(body.oldPassword, sessionUser.hash)) return res.status(401).json({ error: 'The current password is wrong.' });
      if (!validPass(body.newPassword)) return res.status(400).json({ error: 'New password: at least 6 characters.' });
      sessionUser.hash = hashPassword(body.newPassword);
      sessionUser.ver = (sessionUser.ver || 1) + 1;
      await kvSet('user:' + s.u, JSON.stringify(sessionUser));
      // Invalidate old session
      await kvDel('sess:' + sha(tokenOrBearer));
      // Issue new session with new ver
      const newToken = await newSession(s.u, sessionUser.role, sessionUser.ver);
      return res.status(200).json({ ok: true, token: newToken });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error('account error:', e && e.message);
    return res.status(503).json({ error: 'Storage error. Please try again.' });
  }
}
