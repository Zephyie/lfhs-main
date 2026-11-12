// LFHS Academic Hub - AI chat backend for Vercel.
// Providers: Gemini (current stable models), Groq, OpenRouter (free models).
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Prefer the current stable model. Override only with model IDs enabled for this API key.
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODELS = (process.env.GROQ_MODEL || 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_MODELS = (process.env.OPENROUTER_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_TURNS = 12;
const MAX_CHARS = 2000;
// Only retry on transient upstream errors. Client validation errors (400) are terminal.
const TRANSIENT_STATUS = [0, 429, 500, 502, 503, 504];

const SYSTEM_PROMPT =
  'You are the LFHS Academic Hub study assistant for students of Classes 8 to 10 ' +
  '(Kerala State syllabus, SCERT) at Little Flower High School, Panaikulam. ' +
  'Explain clearly in short steps with a simple example. Reply in the language the student writes in (English or Malayalam). ' +
  'Help with school subjects, exam preparation, study planning, ICT/coding basics and career guidance after Class 10. ' +
  'Politely decline unrelated, unsafe or inappropriate requests. Be encouraging. ' +
  'Never invent facts, exam dates or web links; if unsure, say so and suggest checking the textbook or asking a teacher.';

/* ---------- per-instance best-effort per-IP rate limiter ----------
 * Vercel may run multiple function instances; use a shared atomic store for a global limit.
 */
const ipRateMap = new Map(); // ip -> { count, resetAt }
const MAX_REQ_PER_MIN = 20;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateMap.set(ip, { count: 1, resetAt: now + 60000 });
    // cleanup stale entries occasionally
    if (ipRateMap.size > 500) {
      for (const [k, v] of ipRateMap) { if (now > v.resetAt) ipRateMap.delete(k); }
    }
    return false;
  }
  entry.count++;
  if (entry.count > MAX_REQ_PER_MIN) return true;
  return false;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  let msgs = raw
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'model' ? 'model' : 'user', text: m.text.trim().slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

async function send(url, options, timeoutMs = 8500, deadline = Infinity) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, status: 504, data: { message: 'deadline_exceeded' } };
  timeoutMs = Math.min(timeoutMs, remaining);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e && e.name === 'AbortError' ? 'timeout' : 'network_error' } };
  } finally {
    clearTimeout(timer);
  }
}

// Tries each Gemini model in order. Advances on 404/transient errors, aborts on client 400.
async function askGemini(msgs, deadline) {
  let last = { ok: false, status: 0, data: {} };
  for (const model of GEMINI_MODELS) {
    if (Date.now() > deadline) break;
    const generationConfig = { maxOutputTokens: 4096 };
    // Configure thinking only for supported model families to prevent 400 INVALID_ARGUMENT
    if (model.startsWith('gemini-2.5')) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else if (model.startsWith('gemini-3')) {
      generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    }
    // Legacy/other model families omit thinkingConfig unless explicitly supported.

    last = await send(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: msgs.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
        generationConfig,
      }),
    }, 8500, deadline);
    // Success -> return immediately
    if (last.ok) return last;
    // Fatal client validation error (400) -> do not retry other models with same bad payload
    if (last.status === 400) return last;
    // A timeout/network failure should return to auto mode so another provider can use the remaining budget.
    if (last.status === 0) return last;
    // 404 (model not found) or transient 429/5xx -> try next model in chain
    if (!TRANSIENT_STATUS.includes(last.status) && last.status !== 404) return last;
  }
  return last;
}

function geminiReply(data) {
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// Tries each Groq model in order. Advances on transient errors, aborts on client 400.
async function askGroq(msgs, deadline) {
  let last = { ok: false, status: 0, data: {} };
  for (const model of GROQ_MODELS) {
    if (Date.now() > deadline) break;
    last = await send('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        temperature: 0.5,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(
          msgs.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))
        ),
      }),
    }, 8500, deadline);
    if (last.ok) return last;
    if (last.status === 400) return last;
    // Leave slow-provider failover to the outer provider loop.
    if (last.status === 0) return last;
    if (!TRANSIENT_STATUS.includes(last.status) && last.status !== 404) return last;
  }
  return last;
}

// OpenRouter free models. `models` lets OpenRouter try the next free model if one is busy or removed.
function askOpenRouter(msgs, deadline = Infinity) {
  return send('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + OR_KEY,
      'HTTP-Referer': 'https://lfhs-academic-hub.vercel.app',
      'X-Title': 'LFHS Academic Hub',
    },
    body: JSON.stringify({
      model: OR_MODELS[0],
      models: OR_MODELS,
      max_tokens: 2200,
      temperature: 0.5,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(
        msgs.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))
      ),
    }),
  }, 9000, deadline);
}

function canFailOverProvider(status) {
  return TRANSIENT_STATUS.includes(status) || status === 401 || status === 403 || status === 404;
}

// Groq and OpenRouter both return OpenAI-style replies.
function openAiReply(data) {
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Per-IP rate limiting
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.', retryable: true });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
  }
  const msgs = cleanMessages(body && body.messages);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Send a question first.' });
  }

  // End-to-end deadline budget: 24 seconds (comfortably under Vercel's 30s maxDuration)
  const deadline = Date.now() + 24000;

  // The page can ask for one provider at a time (?provider=groq, etc.) or auto-loop.
  const only = req.query && req.query.provider;
  if (only && only !== 'auto' && ['gemini', 'groq', 'openrouter'].indexOf(only) === -1) {
    return res.status(400).json({ error: 'Unknown AI provider.', retryable: false });
  }
  const isAuto = !only || only === 'auto';
  const providers = [];
  if (GROQ_KEY && (!only || only === 'groq' || isAuto)) providers.push({ name: 'groq', run: (m) => askGroq(m, deadline), read: openAiReply });
  if (OR_KEY && OR_MODELS.length && (!only || only === 'openrouter' || isAuto)) providers.push({ name: 'openrouter', run: (m) => askOpenRouter(m, deadline), read: openAiReply });
  if (GEMINI_KEY && (!only || only === 'gemini' || isAuto)) providers.push({ name: 'gemini', run: (m) => askGemini(m, deadline), read: geminiReply });
  if (!providers.length) {
    // A provider that is not set up is "not found" (404), so the page moves on to the next one.
    if (only && !isAuto) return res.status(404).json({ error: 'Provider not configured.', retryable: true, provider: only });
    return res.status(503).json({ error: 'AI is not configured yet.', retryable: false });
  }

  if (!isAuto) {
    // Single-provider behavior (explicit ?provider=X)
    const p = providers[0];
    const r = await p.run(msgs);
    if (r.ok) {
      const reply = p.read(r.data);
      if (reply) return res.status(200).json({ reply, provider: p.name });
    }
    console.error('[chat]', p.name, 'failed with', r.status, JSON.stringify(r.data).slice(0, 300));
    const status = r.ok ? 502 : r.status;
    const retryable = TRANSIENT_STATUS.includes(status);
    const message = status === 429
      ? 'The AI is busy right now. Please try again in a minute.'
      : status === 0
        ? 'The AI provider timed out or could not be reached.'
        : 'The AI could not answer right now. Please try again.';
    const e = r.data && r.data.error;
    const detail = String((e && (e.message || e.status)) || (r.data && r.data.message) || '').slice(0, 160);
    return res.status(status === 400 ? 400 : 502).json({ error: message, retryable, provider: p.name, upstream: status, detail });
  }

  // Auto mode: loop through all providers on retryable errors
  let lastErr = null;
  for (const p of providers) {
    if (Date.now() > deadline) break;
    const r = await p.run(msgs);
    if (r.ok) {
      const reply = p.read(r.data);
      if (reply) return res.status(200).json({ reply, provider: p.name });
    }
    console.error('[chat] auto', p.name, 'failed with', r.status, JSON.stringify(r.data).slice(0, 300));
    const status = r.ok ? 502 : r.status;
    if (!canFailOverProvider(status)) {
      // Non-retryable error — stop looping
      const e = r.data && r.data.error;
      const detail = String((e && (e.message || e.status)) || (r.data && r.data.message) || '').slice(0, 160);
      return res.status(status === 400 ? 400 : 502).json({ error: 'The AI could not answer right now. Please try again.', retryable: false, provider: p.name, upstream: status, detail });
    }
    lastErr = { status, data: r.data, name: p.name };
  }

  // All providers failed or deadline passed
  const status = lastErr ? lastErr.status : 504;
  const message = status === 429
    ? 'The AI is busy right now. Please try again in a minute.'
    : status === 0 || status === 504
      ? 'The AI provider timed out or could not be reached.'
      : 'The AI could not answer right now. Please try again.';
  const e = lastErr && lastErr.data && lastErr.data.error;
  const detail = String((e && (e.message || e.status)) || (lastErr && lastErr.data && lastErr.data.message) || '').slice(0, 160);
  return res.status(502).json({ error: message, retryable: true, provider: lastErr ? lastErr.name : 'none', upstream: status, detail });
}
