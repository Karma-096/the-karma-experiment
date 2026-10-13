import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

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
function json(body: object, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {status, headers: {...cors, ...extra, 'Content-Type': 'application/json; charset=utf-8'}});
}
type Form = { nickname: string; country_code: string; message: string; turnstile_token: string; consent: true };
function validBody(body: unknown): body is Form {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const f = body as Record<string, unknown>;
  const validText = (v: unknown, min: number, max: number) => typeof v === 'string' &&
    Array.from(v.trim()).length >= min && Array.from(v.trim()).length <= max && !v.includes('\0');
  return validText(f.nickname, 2, 40) && typeof f.country_code === 'string' && COUNTRY_CODES.has(f.country_code) &&
    validText(f.message, 1, 500) && typeof f.turnstile_token === 'string' &&
    f.turnstile_token.length >= 1 && f.turnstile_token.length <= 2048 && f.consent === true;
}
async function readLimited(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', {fatal:true}).decode(joined);
}
async function rateKey(secret: string, identity: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('karma-rate-v1:' + identity));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
}
Deno.serve(async request => {
  // Origin controls browser access; Siteverify and private RPC permissions control writes.
  if (request.headers.get('Origin') !== SITE_ORIGIN) return new Response('Forbidden', {status:403, headers:{'Cache-Control':'no-store','Vary':'Origin'}});
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
  if (request.method !== 'POST') return json({code:'method_not_allowed'},405, {'Allow':'POST, OPTIONS'});
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({code:'json_required'},415);
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json({code:'request_too_large'},413);
  let body: unknown;
  try { body = JSON.parse(await readLimited(request)); }
  catch (error) { return json({code:error instanceof RangeError ? 'request_too_large' : 'invalid_json'},error instanceof RangeError ? 413 : 400); }
  if (!validBody(body)) return json({code:'invalid_form_data'},400);
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !url || !serviceKey) return json({code:'service_unavailable'},503);
  const supabase = createClient(url, serviceKey, {auth:{persistSession:false, autoRefreshToken:false}});
  // Supabase gateway forwarded address. Raw addresses are never logged or stored.
  // Pseudonym cooldown below remains an additional limit, independent of this hint.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip');
  if (!ip || ip.length > 128) return json({code:'service_unavailable'},503);
  try {
    const {data, error} = await supabase.rpc('check_karma_message_rate_limit', {p_client_hash:await rateKey(secret, ip)});
    if (error) { console.error('Karma rate check failed', error.code); return json({code:'service_unavailable'},503); }
    if (data !== true) return json({code:'rate_limited'},429, {'Retry-After':'60'});
  } catch { return json({code:'service_unavailable'},503); }
  let verification: {success?:boolean; hostname?:string; action?:string; 'error-codes'?:string[]};
  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({secret, response:body.turnstile_token}),
      signal:AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error('verification_unavailable');
    verification = await result.json();
  } catch { return json({code:'verification_unavailable'},503); }
  if (verification.success !== true || verification.hostname !== SITE_HOSTNAME || verification.action !== 'karma_wall') {
    const codes = verification['error-codes'] || [];
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      console.error('Karma widget secret configuration rejected');
      return json({code:'verification_unavailable'},503);
    }
    return json({code:codes.includes('timeout-or-duplicate') ? 'verification_expired' : 'security_verification_failed'},403);
  }
  // An atomic private claim remains authoritative even if a provider erroneously
  // accepts the same token again. No token or raw digest is logged or exposed.
  try {
    const {data, error} = await supabase.rpc('claim_karma_turnstile_token', {
      p_token_hash:await rateKey(secret, 'turnstile-token:' + body.turnstile_token),
    });
    if (error) { console.error('Karma token claim failed', error.code); return json({code:'service_unavailable'},503); }
    if (data !== true) return json({code:'verification_expired'},403);
  } catch { return json({code:'service_unavailable'},503); }
  try {
    const {data, error} = await supabase.rpc('submit_karma_message', {
      p_nickname:body.nickname.trim(), p_country_code:body.country_code, p_message:body.message.trim(),
    });
    if (error) {
      if (error.code === '23505') return json({code:'duplicate_submission'},409);
      if (error.code === 'P0429') return json({code:'rate_limited'},429, {'Retry-After':'60'});
      if (error.code === '22023') return json({code:'invalid_form_data'},400);
      console.error('Karma RPC failed',error.code);
      return json({code:'service_unavailable'},503);
    }
    return json({success:true, submission_id:data, message:'Submitted for moderation'},200);
  } catch { return json({code:'service_unavailable'},503); }
});
