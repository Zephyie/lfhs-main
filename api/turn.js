// VANGUARD WebRTC TURN credentials. Keep both Cloudflare values in Vercel environment variables.
const TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || '';
const TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || '';
const credentialCache = new Map();
const requestWindows = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;

function respond(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respond(res, 405, { error: 'method_not_allowed' });
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
        return respond(res, 403, { error: 'origin_not_allowed' });
      }
    } catch {
      return respond(res, 403, { error: 'origin_not_allowed' });
    }
  }

  if (!TURN_KEY_ID || !TURN_API_TOKEN) {
    return respond(res, 503, { error: 'turn_not_configured' });
  }

  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || 'unknown')
    .split(',')[0].trim().slice(0, 80);
  const now = Date.now();
  const window = requestWindows.get(ip);
  if (window && now - window.startedAt < WINDOW_MS && window.count >= MAX_REQUESTS) {
    return respond(res, 429, { error: 'rate_limited' });
  }
  if (!window || now - window.startedAt >= WINDOW_MS) requestWindows.set(ip, { startedAt: now, count: 1 });
  else window.count++;

  const cached = credentialCache.get(ip);
  if (cached && cached.expiresAt > now) return respond(res, 200, cached.payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(TURN_KEY_ID) + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TURN_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 21600 }),
        signal: controller.signal,
      }
    );
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data || !Array.isArray(data.iceServers) || !data.iceServers.length) {
      console.error('[VANGUARD TURN] Credential request failed:', upstream.status);
      return respond(res, 502, { error: 'turn_credentials_unavailable' });
    }

    const payload = {
      iceServers: data.iceServers.map((server) => ({
        ...server,
        urls: Array.isArray(server.urls)
          ? server.urls.filter((url) => !url.includes(":53?") && !url.endsWith(":53") => !/:53(?:\\?|$)/.test(url))
          : server.urls,
      })).filter((server) => Array.isArray(server.urls) ? server.urls.length > 0 : !!server.urls),
    };
    if (!payload.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))
    )) {
      return respond(res, 502, { error: 'turn_relay_missing' });
    }

    credentialCache.set(ip, { payload, expiresAt: now + 5 * 60_000 });
    if (requestWindows.size > 1000) {
      for (const [key, value] of requestWindows) {
        if (now - value.startedAt >= WINDOW_MS) requestWindows.delete(key);
      }
    }
    return respond(res, 200, payload);
  } catch (error) {
    console.error('[VANGUARD TURN] Credential service error:', error && error.name === 'AbortError' ? 'timeout' : 'network');
    return respond(res, 502, { error: 'turn_credentials_unavailable' });
  } finally {
    clearTimeout(timeout);
  }
}
