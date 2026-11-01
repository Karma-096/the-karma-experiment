// Cloudflare Worker. Intentionally no logging, client identity, or request forwarding.
export const EVENTS = Object.freeze([
  'page_view', 'wall_view', 'form_view', 'form_start', 'submit_intent',
  'validation_error', 'security_blocked', 'submit_attempt', 'submit_success',
  'submit_error', 'security_error', 'rate_limited',
]);
const ORIGIN = 'https://karma-096.github.io';
const MAX_BYTES = 64;
// SQLite uses its own UTC clock; clients cannot select dates or count increments.
export const PRUNE_SQL = `DELETE FROM daily_counts WHERE day < date('now', '-89 days')
  AND EXISTS (SELECT 1 FROM analytics_settings WHERE singleton = 1 AND enabled = 1)`;
export const RECORD_SQL = `INSERT INTO daily_counts(day, event, total)
  SELECT date('now'), ?1, 1 FROM analytics_settings WHERE singleton = 1 AND enabled = 1
  ON CONFLICT(day, event) DO UPDATE SET total = daily_counts.total + 1
    WHERE daily_counts.total < (SELECT daily_event_limit FROM analytics_settings WHERE singleton = 1)
  RETURNING total`;
const headers = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
  'Vary': 'Origin',
};

async function readEvent(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !EVENTS.includes(body.event)) throw new TypeError();
  return body.event;
}

export default {
  async fetch(request, env) {
    const respond = status => new Response(null, {status, headers});
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/collect' || url.search) return respond(404);
      if (request.headers.get('Origin') !== ORIGIN) return new Response(null, {status:403});
      if (request.method === 'OPTIONS') return respond(204);
      if (request.method !== 'POST') return respond(405);
      // Default off, independently of the browser and database switches.
      if (env.ANALYTICS_ENABLED !== 'true') return respond(204);
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return respond(415);
      if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return respond(413);
      let event;
      try { event = await readEvent(request); }
      catch (error) { return respond(error instanceof RangeError ? 413 : 400); }
      if (!env.ANALYTICS_DB) return respond(503);
      // Native binding, no HTTP subrequest: no visitor headers or CF metadata can
      // be forwarded into another provider's access logs. Batch is transactional.
      const results = await env.ANALYTICS_DB.batch([
        env.ANALYTICS_DB.prepare(PRUNE_SQL),
        env.ANALYTICS_DB.prepare(RECORD_SQL).bind(event),
      ]);
      return respond(results[1].results.length === 1 ? 204 : 429);
    } catch { return respond(503); }
  },
};
