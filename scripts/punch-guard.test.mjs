import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { guardedPunch } from '../cloudflare/src/punch-guard.ts';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('u'); CREATE TABLE punch_events(id TEXT, user_id TEXT, local_date TEXT, action TEXT);");
  db.exec(readFileSync(new URL('../cloudflare/migrations/0005_punch_guards.sql', import.meta.url), 'utf8'));
  db.exec("CREATE TABLE manual_punch_requests(id TEXT PRIMARY KEY, user_id TEXT, status TEXT); CREATE UNIQUE INDEX manual_punch_in_progress ON manual_punch_requests(user_id) WHERE status IN ('running','uncertain');");
  db.exec(readFileSync(new URL('../cloudflare/migrations/0008_daily_punch_locks.sql', import.meta.url), 'utf8'));
  const env = { DB: { prepare(sql) {
    return { bind(...values) {
      return {
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
      };
    } };
  } } };
  return { db, env };
}
const empty=async()=>({days:[{localDate:'14/10/2026'}],events:[]});const success=async()=>({ok:true,time:'09:00'});
test('existing local entry blocks a repeat regardless of the execution mode',async()=>{const {db,env}=setup();try{db.prepare('INSERT INTO punch_events VALUES (?,?,?,?)').run('mark','u','14/10/2026','entry');let calls=0;const result=await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>{calls++;return success()});assert.equal(result.code,'already_registered');assert.equal(calls,0);}finally{db.close()}});
test('a punch made directly in Timenet blocks an unsynced repeat',async()=>{const {db,env}=setup();try{let calls=0;const history=async()=>({days:[{localDate:'14/10/2026'}],events:[{localDate:'14/10/2026',action:'exit',time:'17:00'}]});const r=await guardedPunch(env,'u','14/10/2026','exit',history,async()=>{calls++;return success()});assert.equal(r.code,'already_registered');assert.equal(calls,0);}finally{db.close()}});
test('confirmed manual execution blocks later automatic execution of the same action',async()=>{const {db,env}=setup();try{let calls=0;const execute=async()=>{calls++;return success()};await guardedPunch(env,'u','14/10/2026','entry',empty,execute);const repeat=await guardedPunch(env,'u','14/10/2026','entry',empty,execute);assert.equal(repeat.code,'already_registered');assert.equal(calls,1);const exit=await guardedPunch(env,'u','14/10/2026','exit',empty,execute);assert.equal(exit.ok,true);assert.equal(calls,2);}finally{db.close()}});
test('simultaneous manual and automatic attempts cannot both reach Timenet',async()=>{const {db,env}=setup();try{let release;const gate=new Promise(r=>release=r);let calls=0;const execute=async()=>{calls++;await gate;return success()};const first=guardedPunch(env,'u','14/10/2026','entry',empty,execute);while(!calls)await new Promise(r=>setTimeout(r,0));const second=await guardedPunch(env,'u','14/10/2026','entry',empty,execute);const opposite=await guardedPunch(env,'u','14/10/2026','exit',empty,execute);assert.equal(second.code,'punch_in_progress');assert.equal(second.uncertain,undefined);assert.equal(opposite.code,'punch_in_progress');release();await first;assert.equal(calls,1);}finally{db.close()}});
test('unavailable history fails closed without sending a punch',async()=>{const {db,env}=setup();try{let calls=0;const result=await guardedPunch(env,'u','14/10/2026','entry',async()=>{throw Error('offline')},async()=>{calls++;return success()});assert.equal(result.code,'history_unavailable');assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) AS n FROM punch_guards').get().n,0);}finally{db.close()}});
test('uncertain confirmation keeps a durable lock and prevents another click',async()=>{const {db,env}=setup();try{let calls=0;await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>{calls++;return {ok:false,uncertain:true}});const retry=await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>{calls++;return success()});assert.equal(retry.code,'punch_locked');assert.equal(calls,1);}finally{db.close()}});
test('yesterdays record does not block todays entry',async()=>{const {db,env}=setup();try{db.prepare('INSERT INTO punch_events VALUES (?,?,?,?)').run('old','u','13/10/2026','entry');const result=await guardedPunch(env,'u','14/10/2026','entry',async()=>({days:[{localDate:'14/10/2026'}],events:[{localDate:'13/10/2026',action:'entry',time:'09:00'}]}),success);assert.equal(result.ok,true);assert.equal(result.skipped,undefined);}finally{db.close()}});

test('an unresolved previous-day punch never blocks a later day',async()=>{const {db,env}=setup();try{db.prepare('INSERT INTO punch_guards VALUES (?,?,?,?,?,?)').run('u','13/10/2026','entry','old','uncertain',1);let calls=0;const result=await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>{calls++;return success()});assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(db.prepare("SELECT status FROM punch_guards WHERE token='old'").get().status,'uncertain');}finally{db.close()}});
test('an uncertain entry still blocks exit on the same day',async()=>{const {db,env}=setup();try{await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>({ok:false,uncertain:true}));let calls=0;const result=await guardedPunch(env,'u','14/10/2026','exit',empty,async()=>{calls++;return success()});assert.equal(result.code,'punch_locked');assert.equal(calls,0);}finally{db.close()}});
test('browser failure before clicking releases the lock for a safe retry',async()=>{const {db,env}=setup();try{const failed=await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>({ok:false,uncertain:false,code:'browser_unavailable'}));assert.equal(failed.uncertain,false);assert.equal(db.prepare('SELECT count(*) AS n FROM punch_guards').get().n,0);assert.equal((await guardedPunch(env,'u','14/10/2026','entry',empty,success)).ok,true);}finally{db.close()}});
test('one users uncertain punch does not block another user',async()=>{const {db,env}=setup();try{db.prepare('INSERT INTO users VALUES (?)').run('other');await guardedPunch(env,'u','14/10/2026','entry',empty,async()=>({ok:false,uncertain:true}));assert.equal((await guardedPunch(env,'other','14/10/2026','entry',empty,success)).ok,true);}finally{db.close()}});
