import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {EVENTS} from '../analytics/collector.mjs';

const html = readFileSync('index.html','utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = async () => { for (let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve)); };
async function setup({enabled=true, dnt, gpc, hidden=false, transport='ok', observer=true}={}) {
  const dom = new JSDOM(html,{url:'https://karma-096.github.io/the-karma-experiment/?private=secret#wall', runScripts:'outside-only', pretendToBeVisual:true});
  const w=dom.window, d=w.document, calls=[], submissions=[], observers=[];
  let widget, outcome={status:200,body:{success:true}}, visible=!hidden;
  Object.defineProperty(d,'visibilityState',{get:()=>visible?'visible':'hidden'});
  Object.defineProperty(d,'hidden',{get:()=>!visible});
  if (dnt) Object.defineProperty(w.navigator,'doNotTrack',{value:dnt});
  if (gpc) Object.defineProperty(w.navigator,'globalPrivacyControl',{value:true});
  w.matchMedia=()=>({matches:true});
  w.AbortSignal={}; // Compatibility with browsers lacking AbortSignal.timeout.
  w.IntersectionObserver=observer?class {
    constructor(cb) { this.cb=cb; this.targets=[]; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets=[]; }
  }:undefined;
  w.fetch=(url,options={})=>{
    if (url==='https://collector.invalid/collect') {
      calls.push({url,options});
      if (transport==='throw') throw new Error('synchronous failure');
      if (transport==='reject') return Promise.reject(new Error('offline'));
      if (transport==='stall') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true}));
      return Promise.resolve(new Response(null,{status:204}));
    }
    if (url.includes('/rest/v1/')) return Promise.resolve(Response.json(url.endsWith('get_karma_stats')?[{participants:0,countries:0,transfers:0}]:[]));
    submissions.push(JSON.parse(options.body));
    return Promise.resolve(Response.json(outcome.body,{status:outcome.status}));
  };
  w.turnstile={render:(box,options)=>(widget=options,'synthetic'), remove:()=>{},reset:()=>{}};
  let code=source;
  if (enabled) code=code.replace('const KARMA_ANALYTICS_ENABLED = false;','const KARMA_ANALYTICS_ENABLED = true;').replace("const KARMA_ANALYTICS_ENDPOINT = '';","const KARMA_ANALYTICS_ENDPOINT = 'https://collector.invalid/collect';");
  w.eval(code + ';window.__analyticsQA={analyticsOnce,analyticsPrivacy};');
  w.onKarmaTurnstileLoaded();
  const good=()=>{ d.querySelector('#nickname').value='PRIVATE_NICKNAME'; d.querySelector('#message').value='PRIVATE_MESSAGE'; d.querySelector('#country').value='DE'; d.querySelector('#consent').checked=true; };
  const submit=async()=>{ d.querySelector('#wishForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick(); };
  await tick();
  return {dom,w,d,calls,submissions,observers,good,submit, widget:()=>widget, outcome:value=>outcome=value,
    visibility:value=>{visible=value;d.dispatchEvent(new w.Event('visibilitychange'));},
    events:()=>calls.map(c=>JSON.parse(c.options.body).event)};
}

test('frontend defaults off; DNT/GPC suppress collection and hidden pages wait', async () => {
  for (const options of [{enabled:false},{dnt:'1'},{gpc:true}]) {
    const s=await setup(options);
    try {
      s.w.__analyticsQA.analyticsOnce('form_start');
      s.d.querySelector('#wishForm').dispatchEvent(new s.w.Event('input'));
      s.good();s.widget().callback('private-token');await s.submit();
      assert.equal(s.calls.length,0);
      assert.equal(s.submissions.length,1,'Privacy preference must not block the real form');
      assert.equal(s.d.querySelector('#formResult').dataset.key,'formSuccess');
    } finally {s.dom.window.close();}
  }
  const s=await setup({hidden:true});
  try {
    assert.equal(s.calls.length,0);
    s.visibility(true);await tick();
    assert.deepEqual(s.events(),['page_view']);
    s.visibility(false);s.visibility(true);await tick();
    assert.deepEqual(s.events(),['page_view'],'Visibility changes must not invent visits');
  } finally {s.dom.window.close();}
});

test('anonymous funnel covers exposure, validation, CAPTCHA, error and moderation acceptance once per page', async () => {
  const s=await setup();
  try {
    assert.deepEqual(s.events(),['page_view']);
    const io=s.observers[0];
    assert.deepEqual(io.targets.map(x=>x.id),['wall','wishForm']);
    io.cb([{target:s.d.querySelector('#wall'),isIntersecting:false,intersectionRatio:0}]);
    io.cb(io.targets.map(target=>({target,isIntersecting:true,intersectionRatio:0.2})));
    s.d.querySelector('#message').dispatchEvent(new s.w.Event('input',{bubbles:true}));
    await s.submit(); // Invalid form values.
    s.good();await s.submit(); // No CAPTCHA token.
    s.widget().callback('PRIVATE_TOKEN');
    s.outcome({status:503,body:{code:'service_unavailable'}});await s.submit();
    assert.equal(s.d.querySelector('#formResult').dataset.key,'formUnavailable');
    s.widget().callback('PRIVATE_TOKEN_2');
    s.outcome({status:200,body:{success:true,submission_id:'PRIVATE_ID'}});await s.submit();
    assert.equal(s.d.querySelector('#formResult').dataset.key,'formSuccess');
    // A second accepted message in the same document does not inflate the visit ratio.
    s.w.localStorage.removeItem('karma-last-message-at');s.good();s.widget().callback('PRIVATE_TOKEN_3');await s.submit();
    assert.equal(s.submissions.length,3);
    assert.equal(s.events().filter(e=>e==='submit_success').length,1);
    s.good();s.widget().callback('PRIVATE_TOKEN_4');await s.submit();
    assert.equal(s.d.querySelector('#formResult').dataset.key,'formTooSoon');
    s.widget()['error-callback']('110200');
    s.w.__analyticsQA.analyticsOnce('unknown');
    await tick();
    for (const event of EVENTS) assert.ok(s.events().includes(event),event);
    assert.equal(new Set(s.events()).size,s.events().length);
    for (const call of s.calls) {
      assert.deepEqual(Object.keys(JSON.parse(call.options.body)),['event']);
      assert.ok(EVENTS.includes(JSON.parse(call.options.body).event));
      assert.equal(call.options.credentials,'omit');
      assert.equal(call.options.referrerPolicy,'no-referrer');
      assert.equal(call.options.redirect,'error');
      assert.ok(!JSON.stringify(call).includes('PRIVATE_'));
      assert.ok(!JSON.stringify(call).includes('private=secret'));
    }
    for (const locale of ['en','ru','fr','de','es','pt']) {
      s.d.querySelector('#lang').value=locale;s.d.querySelector('#lang').dispatchEvent(new s.w.Event('change'));
      assert.equal(s.d.documentElement.lang,locale);
      const note=s.d.querySelector('[data-i="privacyNote"]').textContent;
      assert.ok(note.endsWith(s.w.__analyticsQA.analyticsPrivacy[locale]));
      assert.equal(note.split(s.w.__analyticsQA.analyticsPrivacy[locale]).length,2);
    }
    assert.equal(s.w.localStorage.getItem('karma-analytics-id'),null);
    assert.equal(s.d.cookie,'');
  } finally {s.dom.window.close();}
});

test('analytics failures and missing observer never block messages; no retries', async () => {
  for (const transport of ['throw','reject']) {
    const s=await setup({transport,observer:false});
    try {
      s.good();s.widget().callback('private-token');await s.submit();
      assert.equal(s.d.querySelector('#formResult').dataset.key,'formSuccess');
      assert.equal(s.submissions.length,1);
      s.w.__analyticsQA.analyticsOnce('page_view');await tick();
      assert.equal(s.events().filter(e=>e==='page_view').length,1);
    } finally {s.dom.window.close();}
  }
  const s=await setup({transport:'stall'});
  try {
    let expire, cleared=false;
    s.w.setTimeout=(fn,ms)=>{assert.equal(ms,2500);expire=fn;return 77;};
    s.w.clearTimeout=id=>{assert.equal(id,77);cleared=true;};
    s.w.__analyticsQA.analyticsOnce('wall_view');await tick();expire();await tick();
    assert.equal(cleared,true);
  } finally {s.dom.window.close();}
});
