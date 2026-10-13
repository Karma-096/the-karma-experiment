import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const original = await readFile(new URL('../supabase/functions/submit-karma-message/index.ts', import.meta.url), 'utf8');
const directory = await mkdtemp(join(tmpdir(),'karma-contract-'));
const path = join(directory,'edge.ts');
const source = original.replace(/import \{ createClient \} from 'npm:@supabase\/supabase-js@[^']+';/, 'const createClient = globalThis.__client;');
assert.notEqual(source, original, 'The actual production import must be replaced for this isolated mock test');
await writeFile(path, source);
let handler, rateAllowed=true, writeError=null, verify={success:true,hostname:'karma-096.github.io',action:'karma_wall'}, fetchError=false;
let verificationCalls=0, writeCalls=0, rateCalls=0, envMissing=false;
globalThis.Deno={env:{get:name=>envMissing?undefined:({TURNSTILE_SECRET_KEY:'synthetic-secret',SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'})[name]},serve:fn=>handler=fn};
globalThis.__client=()=>({rpc:async(name,params)=>{
  if(name==='check_karma_message_rate_limit'){rateCalls++;assert.match(params.p_client_hash,/^[a-f0-9]{64}$/);return {data:rateAllowed,error:null};}
  assert.equal(name,'submit_karma_message');writeCalls++;return {data:'synthetic-id',error:writeError};
}});
globalThis.fetch=async(url,options)=>{assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');verificationCalls++;if(fetchError)throw new Error('synthetic unavailable');return Response.json(verify);};
const good={nickname:'KARMA_TEST',country_code:'DE',message:'Synthetic contract test',turnstile_token:'synthetic-token',consent:true};
const req=(body=good,headers={},method='POST',raw=false)=>new Request('https://synthetic.invalid/submit',{method,headers:{Origin:'https://karma-096.github.io','Content-Type':'application/json','x-forwarded-for':'198.51.100.1',...headers},...(method==='POST'?{body:raw?body:JSON.stringify(body)}:{})});
let checks=0;
async function check(name,request,status,expectedCode,verifyDelta=0,writeDelta=0){
 const v=verificationCalls,w=writeCalls;const response=await handler(request);
 assert.equal(response.status,status,name);assert.equal(verificationCalls-v,verifyDelta,name+' verification calls');assert.equal(writeCalls-w,writeDelta,name+' content writes');
 if(expectedCode)assert.equal((await response.json()).code,expectedCode,name+' code');checks++;return response;
}
try{
 await import(pathToFileURL(path).href);
 await check('missing Origin',req(good,{Origin:''}),403);
 await check('foreign Origin',req(good,{Origin:'https://elsewhere.invalid'}),403);
 const preflight=await check('CORS preflight',req(good,{},'OPTIONS'),204);
 assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://karma-096.github.io');
 await check('GET',req(good,{},'GET'),405,'method_not_allowed');
 await check('wrong content type',req(good,{'Content-Type':'text/plain'}),415,'json_required');
 await check('JSON prefix spoof',req(good,{'Content-Type':'application/json-evil'}),415,'json_required');
 await check('malformed JSON',req('{',{},'POST',true),400,'invalid_json');
 await check('oversized body without Content-Length',req('a'.repeat(4097),{},'POST',true),413,'request_too_large');
 for(const [name,body] of [['empty',{}],['old field names',{nickname:'TEST',country:'DE',message:'test',turnstileToken:'bad',consent:true}],['no consent',{...good,consent:false}],['unknown country',{...good,country_code:'ZZ'}],['short name',{...good,nickname:'x'}],['long name',{...good,nickname:'x'.repeat(41)}],['empty text',{...good,message:' '}],['long text',{...good,message:'x'.repeat(501)}],['NUL',{...good,message:'a\0b'}],['blank token',{...good,turnstile_token:''}],['long token',{...good,turnstile_token:'x'.repeat(2049)}]])await check(name,req(body),400,'invalid_form_data');
 envMissing=true;await check('missing configuration',req(),503,'service_unavailable');envMissing=false;
 await check('missing gateway IP',req(good,{'x-forwarded-for':''}),503,'service_unavailable');
 rateAllowed=false;const limited=await check('rate limit before Siteverify',req(),429,'rate_limited');assert.equal(limited.headers.get('Retry-After'),'60');rateAllowed=true;
 verify={success:false,'error-codes':['invalid-input-response']};await check('false token',req(),403,'security_verification_failed',1);
 verify={success:false,'error-codes':['timeout-or-duplicate']};await check('expired or replayed token',req(),403,'verification_expired',1);
 verify={success:false,'error-codes':['invalid-input-secret']};await check('wrong widget secret',req(),503,'verification_unavailable',1);
 for(const [name,value] of [['hostname',{success:true,hostname:'foreign.invalid',action:'karma_wall'}],['action',{success:true,hostname:'karma-096.github.io',action:'other'}]]){verify=value;await check(name,req(),403,'security_verification_failed',1);}
 verify={success:true,hostname:'karma-096.github.io',action:'karma_wall'};
 fetchError=true;await check('Siteverify unavailable',req(),503,'verification_unavailable',1);fetchError=false;
 const success=await check('mocked success',req(),200,null,1,1);assert.equal((await success.json()).success,true);
 await check('40 Unicode characters',req({...good,nickname:'😀'.repeat(40)}),200,null,1,1);
 for(const [code,status,label] of [['23505',409,'duplicate_submission'],['P0429',429,'rate_limited'],['22023',400,'invalid_form_data'],['OTHER',503,'service_unavailable']]){writeError={code};await check('RPC '+code,req(),status,label,1,1);}
 console.log(`PASS: ${checks} mocked Edge contract scenarios. No production CAPTCHA or content write was performed.`);
}finally{await rm(directory,{recursive:true,force:true});}
