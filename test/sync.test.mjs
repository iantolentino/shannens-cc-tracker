import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { mergeStates, sameState } from '../public/sync.js';
import * as L from '../public/logic.js';
import { memoryStore } from '../lib/store.js';
import { state } from '../lib/handlers.js';
import { makeToken } from '../lib/auth.js';

const fixture = () => ({ v: 2, people: ['Ange'], cards: [{ id: 'card-default', name: 'Primary', bank: 'BPI' }], plans: [], months: [{ ym: '2026-10', due: '2026-10-03', cardId: 'card-default', items: [{ id: 'bill', d: 'Dinner', a: 100, shares: [{ p: 'Ange', a: 100, pd: 0, n: '' }] }] }] });
const clone = (v) => structuredClone(v);
const env = { SESSION_SECRET: 'sync-test-secret-that-is-long-enough', NODE_ENV: 'test' };
const cookie = 'cct_session=' + makeToken(env.SESSION_SECRET);
async function server(store, url, options = {}) {
  assert.equal(url, '/api/state');
  let result;
  const req = { method: options.method || 'GET', headers: { cookie, 'content-type': 'application/json', ...options.headers }, body: options.body ? JSON.parse(options.body) : undefined };
  const res = { statusCode: 200, setHeader() {}, end(body) { result = JSON.parse(body); } };
  await state(req, res, { env, store });
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => clone(result) };
}
function storage() { const map = new Map(); return { getItem: (k) => map.get(k) || null, setItem: (k,v) => map.set(k,v), removeItem: (k) => map.delete(k), map }; }
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace(/boot\(\);\s*$/, '');
function client(initial, fetcher, localStorage = storage(), sessionStorage = storage()) {
  const handlers = {}, elements = { '#modal': { firstChild: null } };
  const context = vm.createContext({ L, mergeStates, sameState, Intl, Date, Set, Map, URL, console, localStorage, sessionStorage, location: { host: 'tracker.test', href: 'https://tracker.test/' }, fetch: fetcher, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, window: { addEventListener() {}, scrollTo() {} }, document: { hidden: false, activeElement: null, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelector: (selector) => elements[selector] || null, querySelectorAll: () => [] } });
  vm.runInContext(source, context);
  context.initial = clone(initial);
  vm.runInContext('S=cloneState(initial.data);baseState=cloneState(initial.data);version=initial.version;render=()=>{};toast=()=>{};closeModal=()=>{};showLogin=()=>{};', context);
  return { context, elements, handlers, localStorage, sessionStorage, run: (js) => vm.runInContext(js, context), data: () => JSON.parse(vm.runInContext('JSON.stringify(S)', context)) };
}

test('three-way merge preserves additions on two devices and edits to different fields', () => {
  const base = fixture(), a = clone(base), b = clone(base);
  a.cards.push({ id: 'a', name: 'A' }); b.cards.push({ id: 'b', name: 'B' });
  a.cards[0].statementDay = 13; b.cards[0].bank = 'New bank';
  const out = mergeStates(base, a, b);
  assert.equal(out.conflicts.length, 0); assert.equal(out.data.cards.length, 3);
  assert.equal(out.data.cards[0].statementDay, 13); assert.equal(out.data.cards[0].bank, 'New bank');
});
test('payments and other-device remarks merge without changing totals', () => {
  const base = fixture(), a = clone(base), b = clone(base);
  a.months[0].items[0].shares[0].pd = 100; b.months[0].items[0].shares[0].n = 'Bank transfer';
  const out = mergeStates(base,a,b); assert.equal(out.conflicts.length,0);
  assert.deepEqual(out.data.months[0].items[0].shares[0], {p:'Ange',a:100,pd:100,n:'Bank transfer'});
  assert.equal(L.validateState(out.data).ok,true);
});
test('same-field edits and delete-versus-edit require an explicit choice', () => {
  const base=fixture(),a=clone(base),b=clone(base); a.cards[0].name='Mine';b.cards[0].name='Theirs';
  assert.equal(mergeStates(base,a,b).conflicts.length,1);
  assert.equal(mergeStates(base,a,b,'remote').data.cards[0].name,'Theirs');
  a.cards=[]; assert.equal(mergeStates(base,a,b).conflicts.length,1);
});
test('renaming/deleting people and scheduled months are not duplicated or resurrected', () => {
  const base=fixture(),a=clone(base),b=clone(base); a.people=[];b.people.push('Ian');
  a.months=[]; b.cards.push({id:'new',name:'New'});
  const out=mergeStates(base,a,b);assert.deepEqual(out.data.people,['Ian']);assert.deepEqual(out.data.months,[]);assert.equal(out.conflicts.length,0);
});
test('two real API clients save new cards despite a stale version, then reload with both cards', async () => {
  const store=memoryStore();const initial=await store.init(fixture());
  const a=client(initial,(...args)=>server(store,...args)),b=client(initial,(...args)=>server(store,...args));
  a.run("S.cards.push({id:'a',name:'A'});save()");b.run("S.cards.push({id:'b',name:'B'});save()");
  await a.run('flush()');await b.run('flush()'); // b receives 409, reads latest and merges.
  assert.equal(b.run('conflict'),false);assert.equal(b.data().cards.length,3);
  await b.run('flush()');await a.run('pollState()');
  const saved=await store.get();assert.equal(saved.data.cards.length,3);assert.deepEqual(a.data(),saved.data);
  const reloaded=client(saved,(...args)=>server(store,...args));assert.equal(reloaded.data().cards.length,3);
});
test('edits made during an in-flight save are queued and saved afterwards', async () => {
  const store=memoryStore(),initial=await store.init(fixture());let release,entered;
  const started=new Promise((resolve)=>{entered=resolve});
  const a=client(initial,async(...args)=>{if(args[1]?.method==='PUT'){entered();await new Promise((resolve)=>{release=resolve});}return server(store,...args)});
  a.run("S.cards.push({id:'a',name:'A'});save()");const first=a.run('flush()');await started;
  a.run("S.cards.push({id:'b',name:'B'});save()");release();await first;
  assert.equal(a.run('dirty'),true);
  a.context.fetch=(...args)=>server(store,...args);await a.run('flush()');
  assert.equal((await store.get()).data.cards.length,3);assert.equal(a.run('dirty'),false);
});
test('offline additions survive refresh and merge with cards saved by another device', async () => {
  const store=memoryStore(),initial=await store.init(fixture());const local=storage(),session=storage();
  const a=client(initial,async()=>{throw new Error('offline')},local,session);
  a.run("S.cards.push({id:'offline-card',name:'Offline card'});save()");await a.run('flush()');
  assert.equal(local.map.size,1);const other=fixture();other.cards.push({id:'other',name:'Other'});await store.put(other,initial.version);
  const b=client(await store.get(),(...args)=>server(store,...args),local,session);
  // Exercise the actual boot recovery path with harmless DOM/initialization hooks.
  for(const selector of ['#boot','#login','#shell','#loginErr','#pw']) b.elements[selector]={hidden:false,value:'',focus(){}};
  await b.run('boot()');await b.run('flush()');
  assert.equal((await store.get()).data.cards.length,3);assert.equal(local.map.size,0);
});
test('same-field conflicts stay protected across refresh and resolve only the chosen fields', async () => {
  const store=memoryStore(),initial=await store.init(fixture()),local=storage(),session=storage();
  const a=client(initial,(...args)=>server(store,...args),local,session),b=client(initial,(...args)=>server(store,...args));
  a.run("S.cards[0].name='Mine';S.cards.push({id:'only-mine',name:'Mine card'});save()");
  b.run("S.cards[0].name='Theirs';save()");await b.run('flush()');await a.run('flush()');
  assert.equal(a.run('conflict'),true);assert.equal((await store.get()).data.cards[0].name,'Theirs');
  const reload=client(await store.get(),(...args)=>server(store,...args),local,session);
  for(const selector of ['#boot','#login','#shell','#loginErr','#pw']) reload.elements[selector]={hidden:false,value:'',focus(){}};
  await reload.run('boot()');assert.equal(reload.run('conflict'),true);
  reload.run("resolveSyncConflict('remote')");
  // resolve starts flush; wait for the real API promise chain, then ensure completion.
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(reload.data().cards[0].name,'Theirs');assert.equal(reload.data().cards.length,2);
});
test('automatic polling defers updates while a modal or input is being edited', async () => {
  const store=memoryStore(),initial=await store.init(fixture());let reads=0;
  const a=client(initial,(...args)=>{reads++;return server(store,...args)});
  a.elements['#modal'].firstChild={};await a.run('pollState()');assert.equal(reads,0);
  a.elements['#modal'].firstChild=null;a.context.document.activeElement={matches:()=>true};await a.run('pollState()');assert.equal(reads,0);
});
test('statement day saves valid integers only, separately per card, without changing bills', () => {
  const initial={version:1,data:fixture()},a=client(initial,async()=>{});const before=clone(a.data().months);
  a.elements['#statementDayHelp']={textContent:''};
  const input={id:'statementDay',value:'13',setAttribute(){}};a.handlers.input({target:input});
  assert.equal(a.data().cards[0].statementDay,13);input.value='32';a.handlers.input({target:input});assert.equal(a.data().cards[0].statementDay,13);
  input.value='1.5';a.handlers.input({target:input});assert.equal(a.data().cards[0].statementDay,13);
  assert.deepEqual(a.data().months,before);assert.equal(a.run('dirty'),true);
});
test('conflicting bill splits resolve as whole valid financial records', () => {
  const base=fixture(),a=clone(base),b=clone(base);
  a.months[0].items[0].a=125;a.months[0].items[0].shares[0].a=125;
  b.months[0].items[0].shares=[{p:'Ange',a:50,pd:0,n:''},{p:'Ian',a:50,pd:0,n:''}];
  for(const choice of ['local','remote']) {
    const out=mergeStates(base,a,b,choice);assert.ok(out.conflicts.length);assert.equal(L.validateState(out.data).ok,true);
  }
});

test('polling returns a small version response when data has not changed', async () => {
  const store=memoryStore(),initial=await store.init(fixture());
  const result=await server(store,'/api/state',{headers:{'x-state-version':String(initial.version)}});
  assert.deepEqual(await result.json(),{version:initial.version,unchanged:true});
  const full=await server(store,'/api/state',{headers:{'x-state-version':'0'}});
  assert.deepEqual((await full.json()).data,initial.data);
});

test('statement day saves during a stale-version conflict without disturbing the focused field', async () => {
  const store=memoryStore(),initial=await store.init(fixture());
  const a=client(initial,(...args)=>server(store,...args)),b=client(initial,(...args)=>server(store,...args));
  b.run("S.cards.push({id:'other',name:'Other'});save()");await b.run('flush()');
  a.context.document.activeElement={matches:()=>true};
  a.run('S.cards[0].statementDay=13;save()');await a.run('flush()');await a.run('flush()');
  const result=await store.get();assert.equal(result.data.cards[0].statementDay,13);assert.equal(result.data.cards.length,2);
  assert.equal(a.run('renderPending'),true);assert.equal(a.run('dirty'),false);
});

test('later edits to a disputed field require a new review instead of being overwritten', async () => {
  const store=memoryStore(),initial=await store.init(fixture());
  const a=client(initial,(...args)=>server(store,...args)),b=client(initial,(...args)=>server(store,...args));
  a.run("S.cards[0].name='Mine';save()");b.run("S.cards[0].name='Theirs';save()");await b.run('flush()');await a.run('flush()');
  a.run("S.cards[0].name='Later local edit';save();resolveSyncConflict('remote')");
  assert.equal(a.run('conflict'),true);assert.equal(a.data().cards[0].name,'Later local edit');
  assert.equal((await store.get()).data.cards[0].name,'Theirs');
});

test('Settings separates Hide from Delete and includes Delete for hidden empty cards', () => {
  const data=fixture();data.cards.push({id:'empty',name:'Test',archived:true});
  const a=client({version:1,data},async()=>{});const html=a.run('pageSettings()');
  assert.match(html,/>Hide card</);assert.doesNotMatch(html,/>Remove card</);
  assert.match(html,/data-delete-card="empty" type="button">Delete card/);
  assert.match(html,/data-delete-card="card-default" type="button" disabled/);
});

test('Hide preserves all records and cannot hide the last active card', () => {
  const data=fixture();data.cards.push({id:'other',name:'Other'});
  const a=client({version:1,data},async()=>{}),before=clone(data.months);
  a.run("hideCard('card-default')");assert.equal(a.data().cards[0].archived,true);assert.deepEqual(a.data().months,before);
  a.run("hideCard('other')");assert.notEqual(a.data().cards[1].archived,true);
  assert.equal(a.run("canDeleteCard(S.cards[0])"),false);assert.equal(a.run("canDeleteCard(S.cards[1])"),false);
});

test('empty-card deletion persists and does not recreate a deleted empty default card after refresh', async () => {
  const data=fixture();data.cards.push({id:'other',name:'Other'});data.months[0].cardId='other';
  const store=memoryStore(),initial=await store.init(data),a=client(initial,(...args)=>server(store,...args));
  await a.run("deleteEmptyCard('card-default')");
  assert.equal((await store.get()).data.cards.some((c)=>c.id==='card-default'),false);
  assert.deepEqual((await store.get()).data.months,data.months);
  for(const selector of ['#boot','#login','#shell','#loginErr','#pw']) a.elements[selector]={hidden:false,value:'',focus(){}};
  await a.run('boot()');assert.equal(a.data().cards.some((c)=>c.id==='card-default'),false);
});

test('deletion checks latest server records before removing a card', async () => {
  const data=fixture();data.cards.push({id:'test',name:'Test',archived:true});
  const store=memoryStore(),initial=await store.init(data),a=client(initial,(...args)=>server(store,...args));
  const next=clone(data);next.months.push({ym:'2026-11',due:'2026-11-03',cardId:'test',items:[]});await store.put(next,initial.version);
  await a.run("deleteEmptyCard('test')");assert.equal(a.data().cards.some((c)=>c.id==='test'),true);
  assert.deepEqual((await store.get()).data,next);
});

test('sync keeps a card if another device adds a month during deletion', async () => {
  const data=fixture();data.cards.push({id:'test',name:'Test'});
  const store=memoryStore(),initial=await store.init(data);let concurrent=true;
  const a=client(initial,async(url,options)=>{
    if(concurrent && options?.method==='PUT') { concurrent=false;const next=clone(data);next.months.push({ym:'2026-11',due:'2026-11-03',cardId:'test',items:[]});await store.put(next,initial.version); }
    return server(store,url,options);
  });
  await a.run("deleteEmptyCard('test')");
  assert.equal(a.data().cards.some((c)=>c.id==='test'),true);assert.equal(a.data().months.length,2);
  assert.equal(a.run('dirty'),false);assert.equal((await store.get()).data.cards.length,2);
});
