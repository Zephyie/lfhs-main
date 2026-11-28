// Serves the WebRTC relay (TURN) servers for the VANGUARD easter egg.
// Credentials live only in Vercel environment variables, never in the repository.
//
// Set EITHER:
//   ICE_TURN_URLS        comma-separated, e.g. turn:relay1.expressturn.com:3478?transport=udp,turn:relay1.expressturn.com:3478?transport=tcp,turns:relay1.expressturn.com:443?transport=tcp
//   ICE_TURN_USERNAME
//   ICE_TURN_CREDENTIAL
// OR a single ICE_SERVERS_JSON holding a full iceServers array (several providers are fine).
// Redeploy after changing environment variables.

function parseServers() {
  const out = [];
  const raw = (process.env.ICE_SERVERS_JSON || '').trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out.push(...arr);
    } catch (e) { /* ignore a malformed value */ }
  }
  const urls = (process.env.ICE_TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
  const username = (process.env.ICE_TURN_USERNAME || '').trim();
  const credential = (process.env.ICE_TURN_CREDENTIAL || '').trim();
  if (urls.length && username && credential) out.push({ urls, username, credential });
  return out
    .filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    .slice(0, 6)
    .map((s) => ({ urls: s.urls, ...(s.username ? { username: String(s.username) } : {}), ...(s.credential ? { credential: String(s.credential) } : {}) }));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');   // the game runs in a sandboxed frame, so its origin is "null"
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  if (req.headers['sec-fetch-mode'] === 'navigate') return res.status(404).end();   // not meant to be opened in the address bar
  return res.status(200).json(parseServers());
}