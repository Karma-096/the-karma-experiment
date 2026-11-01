import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import collector, {EVENTS, PRUNE_SQL, RECORD_SQL} from '../analytics/collector.mjs';

test('collector validates bounded enum-only input, defaults off, and never forwards identity', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let result = [{total:1}], fail = false;
  globalThis.fetch = () => { throw new Error('No outbound HTTP is allowed'); };
  const db = {
    prepare:sql=>({sql,bind:event=>({sql,params:[event]})}),
    batch:async statements=>{
      calls.push(statements.map(s=>({sql:s.sql,...(s.params?{params:s.params}:{})})));
      if (fail) throw new Error('synthetic failure');
      return [{results:[]},{results:result}];
    }
  };
  const env = {ANALYTICS_ENABLED:'true', ANALYTICS_DB:db};
  const request = (body = {event:'page_view'}, headers = {}, method = 'POST', path = '/collect') => new Request('https://collector.invalid' + path, {
    method, headers:{Origin:'https://karma-096.github.io', 'Content-Type':'application/json', ...headers},
    ...(method === 'POST' ? {body:typeof body === 'string' ? body : JSON.stringify(body)} : {})
  });
  const check = async (req, status, vars = env) => assert.equal((await collector.fetch(req, vars)).status, status);
  try {
    await check(request(),204,{});
    await check(request(),204,{...env, ANALYTICS_ENABLED:'false'});
    assert.equal(calls.length,0,'Disabled collectors perform no database writes');
    await check(request({}, {Origin:''}),403);
    await check(request({}, {Origin:'https://evil.invalid'}),403);
    await check(request({}, {}, 'POST', '/collect?message=private'),404);
    await check(request({}, {}, 'POST', '/other'),404);
    const preflight = await collector.fetch(request({}, {}, 'OPTIONS'),env);
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://karma-096.github.io');
    await check(request({}, {}, 'GET'),405);
    await check(request({}, {'Content-Type':'text/plain'}),415);
    await check(request({}, {'Content-Type':'application/json-evil'}),415);
    await check(request('{'),400);
    await check(request('x'.repeat(65)),413);
    await check(request({}, {'Content-Length':'65'}),413);
    for (const value of [{}, [], null, {event:'unknown'}, {event:12}, {event:'page_view',ip:'1'}, {event:'page_view',nickname:'N'}, {event:'page_view',message:'secret'}, {event:'page_view',id:'x'}, {event:'page_view',day:'2000-01-01'}]) {
      await check(request(JSON.stringify(value)),400);
    }
    assert.equal(calls.length,0,'Rejected inputs never reach D1');
    await check(request(),503,{ANALYTICS_ENABLED:'true'});
    for (const event of EVENTS) {
      await check(request({event}, {'CF-Connecting-IP':'198.51.100.1',Cookie:'private',Referer:'https://private.invalid/?secret=yes','User-Agent':'private-device','X-Forwarded-For':'198.51.100.2'}),204);
      assert.deepEqual(calls.at(-1),[{sql:PRUNE_SQL},{sql:RECORD_SQL,params:[event]}]);
      assert.ok(!JSON.stringify(calls.at(-1)).includes('private'));
      assert.ok(!JSON.stringify(calls.at(-1)).includes('198.51.100'));
    }
    result = []; await check(request(),429);
    fail = true; await check(request(),503);
  } finally { globalThis.fetch=originalFetch; }
});

test('deployment configuration keeps all collection and logging off', () => {
  const config = JSON.parse(readFileSync('analytics/wrangler.json','utf8'));
  assert.equal(config.vars.ANALYTICS_ENABLED,'false');
  assert.equal(config.logpush,false);
  assert.equal(config.preview_urls,false);
  assert.equal(config.observability.enabled,false);
  assert.equal(config.observability.logs.enabled,false);
  assert.equal(config.observability.logs.invocation_logs,false);
  assert.equal(config.observability.traces.enabled,false);
  assert.equal(config.d1_databases[0].binding,'ANALYTICS_DB');
  assert.equal(config.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000','No provisioned production database in this PR');
  assert.ok(!/console\.|request\.(cf|clone)|headers\.get\(['"](?:cf-connecting-ip|x-forwarded-for|cookie|user-agent|referer)/i.test(readFileSync('analytics/collector.mjs','utf8')));
});
