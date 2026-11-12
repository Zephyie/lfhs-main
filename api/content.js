// LFHS Academic Hub - live content API (notices, exam countdown, featured resources, contacts, update log).
// Location in your project: api/content.js
// Storage: a Supabase table named kv (see the setup steps). The service key stays on the server.
// Only signed-in creator accounts can save. The session is checked HERE on the server.

import { createHash } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || '').trim().toLowerCase();

const KEY_CONTENT = 'content';
const KEY_META = 'content:meta';
const TYPES = ['exam', 'circular', 'result', 'event', 'general'];
const UPD_TYPES = ['new', 'improved', 'fix', 'content'];
const SECTIONS = ['notices', 'countdown', 'featured', 'contacts', 'updates'];
const EMPTY = { notices: [], countdown: [], featured: [], contacts: [], updates: [] };


function sbConfig() {
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY };
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

// Table: kv (key text primary key, value text not null, expires_at timestamptz null)
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

/* ---------- cleaning: nothing from the browser is trusted ---------- */
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const day = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : '';
};
const link = (v) => { v = str(v, 300); return /^(https?:\/\/|#)/i.test(v) ? v : ''; };
const ident = (v) => str(v, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'x' + Math.random().toString(36).slice(2, 9);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function sanitize(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    notices: list(c.notices, 50).map((n) => ({
      id: ident(n && n.id),
      type: TYPES.indexOf(n && n.type) !== -1 ? n.type : 'general',
      aud: ['all', 'students', 'parents', 'teachers'].includes(n && n.aud) ? n.aud : '',
      title: str(n && n.title, 140),
      date: day(n && n.date),
      until: day(n && n.until),
      url: link(n && n.url),
      pin: !!(n && n.pin),
    })).filter((n) => n.title),
    countdown: list(c.countdown, 10).map((e) => ({
      id: ident(e && e.id),
      title: str(e && e.title, 80),
      date: day(e && e.date),
    })).filter((e) => e.title && e.date),
    featured: list(c.featured, 12).map((f) => str(f, 60)).filter((f) => /^[a-zA-Z0-9_-]+$/.test(f))
      .filter((f, i, a) => a.indexOf(f) === i),
    contacts: list(c.contacts, 12).map((p) => ({
      id: ident(p && p.id),
      name: str(p && p.name, 80),
      role: str(p && p.role, 80),
      phone: str(p && p.phone, 30).replace(/[^0-9+()\- ]/g, ''),
      email: /^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,}$/.test(str(p && p.email, 160)) ? str(p && p.email, 160) : '',
    })).filter((p) => p.name),
    updates: list(c.updates, 60).map((u) => ({
      id: ident(u && u.id),
      version: str(u && u.version, 20),
      type: UPD_TYPES.includes(u && u.type) ? u.type : 'new',
      date: day(u && u.date),
      title: str(u && u.title, 100),
      notes: str(u && u.notes, 900),
    })).filter((u) => u.title || u.notes),
  };
}

async function readState() {
  const [raw, metaRaw] = await Promise.all([kvGet(KEY_CONTENT), kvGet(KEY_META)]);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
  let meta = null;
  try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch (e) { meta = null; }
  const content = parsed ? sanitize(parsed) : EMPTY;
  const rev = meta && Number.isFinite(Number(meta.rev))
    ? Number(meta.rev)
    : (parsed && Number.isFinite(Number(parsed._rev)) ? Number(parsed._rev) : (raw ? 1 : 0));
  const srev = (meta && meta.srev && typeof meta.srev === 'object') ? meta.srev : {};
  return { content, rev, srev };
}

/* ---------- sessions: only creator accounts may save ---------- */
async function creatorSession(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const raw = await kvGet('sess:' + createHash('sha256').update(token).digest('hex'));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || s.r !== 'creator') return null;
    // Session version check
    const userRaw = await kvGet('user:' + s.u);
    if (!userRaw) return null;
    let user;
    try { user = JSON.parse(userRaw); } catch (e) { return null; }
    if ((s.ver || 1) !== (user.ver || 1)) return null;
    if (user.role !== 'creator') return null;
    const isOwner = !!OWNER_USERNAME && s.u === OWNER_USERNAME;
    if (!isOwner && (!OWNER_USERNAME || user.creatorGrantedBy !== OWNER_USERNAME)) return null;
    return s;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { url, key } = sbConfig();
  const configured = !!(url && key);

  if (req.method === 'GET') {
    if (!configured) return res.status(200).json({ content: EMPTY, rev: 0, storage: false });
    try {
      const { content, rev } = await readState();
      return res.status(200).json({ content, rev, storage: true });
    } catch (e) {
      console.error('content read failed:', e && e.message);
      return res.status(503).json({ error: 'Could not read content.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!configured) return res.status(503).json({ code: 'no_storage', error: 'Storage is not connected yet.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Bad request.' });
  if (JSON.stringify(body).length > 160000) return res.status(413).json({ error: 'Too much content.' });

  try {
    const token = body.token || (req.headers.authorization || '').replace(/^Bearer /, '');
    const session = await creatorSession(token);
    if (!session) return res.status(403).json({ code: 'not_creator', error: 'Owner-issued creator access is required.' });
    const isOwner = !!OWNER_USERNAME && session.u === OWNER_USERNAME;
    if (body.action === 'save') {
      const { content: oldContent, rev: curRev, srev: curSrev } = await readState();
      const hasSections = !!(body.sections && typeof body.sections === 'object' && !Array.isArray(body.sections));
      if (hasSections) {
        const submitted = SECTIONS.filter((k) =>
          Object.prototype.hasOwnProperty.call(body.sections, k) && !(k === 'contacts' && !isOwner)
        );
        const mergedRaw = Object.assign({}, oldContent);
        submitted.forEach((k) => { mergedRaw[k] = body.sections[k]; });
        const nextContent = sanitize(mergedRaw);
        if (!isOwner) nextContent.contacts = oldContent.contacts;

        const baseRev = Number(body.base);
        if (Number.isFinite(baseRev) && baseRev < curRev) {
          const conflicts = submitted.filter((k) =>
            (Number(curSrev[k]) || 0) > baseRev && JSON.stringify(nextContent[k]) !== JSON.stringify(oldContent[k])
          );
          if (conflicts.length) {
            return res.status(409).json({
              code: 'conflict',
              error: 'Another creator saved changes while you were editing.',
              content: oldContent,
              rev: curRev,
              conflicts,
            });
          }
        }

        const newRev = curRev + 1;
        const nextSrev = Object.assign({}, curSrev);
        submitted.forEach((k) => {
          if (JSON.stringify(nextContent[k]) !== JSON.stringify(oldContent[k])) {
            nextSrev[k] = newRev;
          }
        });
        await Promise.all([
          kvSet(KEY_CONTENT, JSON.stringify(nextContent)),
          kvSet(KEY_META, JSON.stringify({ rev: newRev, srev: nextSrev })),
        ]);
        return res.status(200).json({ ok: true, content: nextContent, rev: newRev, owner: isOwner });
      }

      const content = sanitize(body.content);
      if (!isOwner) content.contacts = oldContent.contacts;
      const newRev = curRev + 1;
      const nextSrev = Object.assign({}, curSrev);
      SECTIONS.forEach((k) => {
        if (JSON.stringify(content[k]) !== JSON.stringify(oldContent[k])) {
          nextSrev[k] = newRev;
        }
      });
      await Promise.all([
        kvSet(KEY_CONTENT, JSON.stringify(content)),
        kvSet(KEY_META, JSON.stringify({ rev: newRev, srev: nextSrev })),
      ]);
      return res.status(200).json({ ok: true, content, rev: newRev, owner: isOwner });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error('content write failed:', e && e.message);
    return res.status(503).json({ error: 'Storage error. Please try again.' });
  }
}
