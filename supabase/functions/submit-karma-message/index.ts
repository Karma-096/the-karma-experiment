import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE_ORIGIN = 'https://karma-096.github.io';
const SITE_HOSTNAME = 'karma-096.github.io';
const MAX_BODY_BYTES = 4096;
const COUNTRY_CODES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const cors = {
  'Access-Control-Allow-Origin': SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
  'Vary': 'Origin',
  'Cache-Control': 'no-store',
};

function json(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function validBody(body: unknown): body is {
  nickname: string;
  country_code: string;
  message: string;
  turnstile_token: string;
  consent: true;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  return typeof fields.nickname === 'string' &&
    fields.nickname.trim().length >= 2 &&
    fields.nickname.trim().length <= 40 &&
    !fields.nickname.includes('\0') &&
    typeof fields.country_code === 'string' &&
    COUNTRY_CODES.has(fields.country_code) &&
    typeof fields.message === 'string' &&
    fields.message.trim().length >= 1 &&
    fields.message.trim().length <= 500 &&
    !fields.message.includes('\0') &&
    typeof fields.turnstile_token === 'string' &&
    fields.turnstile_token.length >= 1 &&
    fields.turnstile_token.length <= 2048 &&
    fields.consent === true;
}

Deno.serve(async request => {
  // Origin is a browser access check; Turnstile and the private RPC enforce the write.
  if (request.headers.get('Origin') !== SITE_ORIGIN) {
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: 'JSON required' }, 415);
  }
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return json({ error: 'Request too large' }, 413);
  }
  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: 'Request too large' }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!validBody(body)) {
    return json({ error: 'Invalid form data' }, 400);
  }
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !url || !serviceKey) {
    console.error('Karma function configuration missing');
    return json({ error: 'Service unavailable' }, 503);
  }
  let verification: { success?: boolean; hostname?: string; action?: string };
  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: body.turnstile_token,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error('Siteverify unavailable');
    verification = await result.json();
  } catch {
    console.error('Karma Siteverify unavailable');
    return json({ error: 'Verification unavailable' }, 503);
  }
  if (verification.success !== true ||
      verification.hostname !== SITE_HOSTNAME ||
      verification.action !== 'karma_wall') {
    return json({ error: 'Security verification failed' }, 403);
  }
  const fields = body;
  let error: { code?: string } | null;
  try {
    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    ({ error } = await supabase.rpc('submit_karma_message', {
      p_nickname: fields.nickname.trim(),
      p_country_code: fields.country_code,
      p_message: fields.message.trim(),
    }));
  } catch {
    console.error('Karma RPC unavailable');
    return json({ error: 'Service unavailable' }, 503);
  }
  if (error) {
    if (error.code === '23505') return json({ error: 'Duplicate submission' }, 429);
    if (error.code === '22023') return json({ error: 'Invalid form data' }, 400);
    console.error('Karma RPC failed', error.code);
    return json({ error: 'Service unavailable' }, 503);
  }
  return json({ success: true, message: 'Submitted for moderation' }, 200);
});
