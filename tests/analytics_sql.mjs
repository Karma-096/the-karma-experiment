import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import collector, {EVENTS, PRUNE_SQL, RECORD_SQL} from '../analytics/collector.mjs';

test('real SQLite: default off, aggregate-only storage, atomic cap, retention and report', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync('analytics/schema.sql','utf8'));
    const record = event => db.prepare(RECORD_SQL).all(event);
    const count = () => db.prepare('select count(*) as n from daily_counts').get().n;
    const report = () => db.prepare(readFileSync('analytics/report.sql','utf8')).all();
    assert.equal(record('page_view').length,0);
    assert.equal(count(),0);
    assert.equal(report().length,0,'No fabricated pre-launch history');
    assert.throws(()=>db.exec('update analytics_settings set enabled=1'),/CHECK constraint/);
    db.exec("update analytics_settings set enabled=1, collection_started_at=datetime('now'), daily_event_limit=3");
    for (const event of [null,'unknown','page_view; DROP TABLE x']) assert.throws(()=>record(event),/constraint/);
    for (const event of EVENTS) assert.equal(record(event).length,1);
    assert.equal(record('page_view').length,1);
    assert.equal(record('page_view').length,1);
    assert.equal(record('page_view').length,0,'Per-event daily cap is atomic');
    const row=report()[0];
    assert.equal(row.page_views,3);assert.equal(row.submit_successes,1);
    assert.equal(row.success_per_page_view_pct,33.33);assert.equal(row.success_per_attempt_pct,100);
    assert.ok(row.collection_started_at);
    assert.deepEqual(db.prepare('pragma table_info(daily_counts)').all().map(r=>r.name),['day','event','total']);
    assert.deepEqual(db.prepare("select name from sqlite_master where type='table' order by name").all().map(r=>r.name),['analytics_settings','daily_counts']);
    db.exec("insert into daily_counts values(date('now','-90 days'),'page_view',1),(date('now','-89 days'),'page_view',1)");
    db.exec(PRUNE_SQL);
    assert.equal(db.prepare("select count(*) n from daily_counts where day < date('now','-89 days')").get().n,0);
    assert.equal(db.prepare("select count(*) n from daily_counts where day = date('now','-89 days')").get().n,1);
    db.exec('update analytics_settings set enabled=0');
    assert.equal(record('wall_view').length,0);
    db.exec("delete from daily_counts where event='page_view'");
    assert.equal(report()[0].success_per_page_view_pct,null,'Missing denominator stays undefined');
    // Full HTTP handler through a transactional local D1 binding adapter.
    db.exec('update analytics_settings set enabled=1');
    const binding = {
      prepare:sql=>({sql,params:[],bind:event=>({sql,params:[event]})}),
      batch:async statements=>{
        db.exec('BEGIN');
        try {
          const results=statements.map(s=>({results:db.prepare(s.sql).all(...s.params)}));
          db.exec('COMMIT');return results;
        } catch (error) {db.exec('ROLLBACK');throw error;}
      }
    };
    const requests=Array.from({length:10},()=>collector.fetch(new Request('https://collector.invalid/collect',{
      method:'POST',headers:{Origin:'https://karma-096.github.io','Content-Type':'application/json'},body:JSON.stringify({event:'page_view'})
    }),{ANALYTICS_ENABLED:'true',ANALYTICS_DB:binding}));
    const statuses=(await Promise.all(requests)).map(r=>r.status);
    assert.equal(statuses.filter(s=>s===204).length,3);
    assert.equal(statuses.filter(s=>s===429).length,7);
    assert.equal(db.prepare("select total from daily_counts where event='page_view'").get().total,3);
    // No public report/SQL route is present, including with the correct Origin.
    for (const path of ['/report','/query','/collect']) {
      const response=await collector.fetch(new Request('https://collector.invalid'+path,{headers:{Origin:'https://karma-096.github.io'}}),{ANALYTICS_ENABLED:'true',ANALYTICS_DB:binding});
      assert.ok([404,405].includes(response.status));assert.equal(await response.text(),'');
    }
  } finally {db.close();}
});
