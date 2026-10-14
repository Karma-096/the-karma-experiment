import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {runCryptoScan} from './crypto-scan-engine.mjs';

const json = (body:unknown,status=200) => new Response(JSON.stringify(body),{
  status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}
});

Deno.serve(async request => {
  if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
  const length=Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(length) || length>2048) return json({error:'request_too_large'},413);
  let body:{token?:string;mode?:string};
  try { body=await request.json(); } catch { return json({error:'invalid_json'},400); }
  if (!body || !/^[0-9a-f-]{36}$/.test(body.token || '') || !['scheduled','manual','health_check'].includes(body.mode || '')) return json({error:'invalid_request'},400);
  const url=Deno.env.get('SUPABASE_URL');
  const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({error:'configuration_error'},500);
  const client=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const rpc=async(name:string,args:Record<string,unknown>)=>{
    const {data,error}=await client.rpc(name,args);
    if(error) throw new Error(`Database operation failed: ${error.code || 'unknown'}`);
    return data;
  };
  let claim;
  try { claim=await rpc('claim_karma_crypto_scan_invocation',{p_token:body.token}); }
  catch { return json({error:'authorization_failed'},403); }
  if (!claim?.authorized || claim.mode!==body.mode) return json({error:'forbidden'},403);
  try {
    const result=await runCryptoScan(claim,{rpc});
    console.log(JSON.stringify({event:'crypto_scan_complete',run_id:claim.run_id,mode:claim.mode,status:result.status,discovered:result.discovered,verified:result.verified,valued:result.valued}));
    return json({ok:true,run_id:claim.run_id,status:result.status,discovered:result.discovered,verified:result.verified,valued:result.valued});
  } catch (error) {
    const safe=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'provider').slice(0,300):'Unknown scan failure';
    try { await rpc('finish_karma_crypto_scan_run',{p_run_id:claim.run_id,p_status:'failed',p_details:{},p_discovered:0,p_verified:0,p_valued:0,p_safe_error:safe}); } catch { /* best effort */ }
    console.error(JSON.stringify({event:'crypto_scan_failed',run_id:claim.run_id,mode:claim.mode,error:safe}));
    return json({error:'scan_failed',run_id:claim.run_id},500);
  }
});
