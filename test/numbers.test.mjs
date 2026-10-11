import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as L from '../public/logic.js';
import seed from '../lib/seed.js';

const X = JSON.parse(fs.readFileSync(new URL('../data/excel-checksums.json', import.meta.url), 'utf8'));
const clone = (o) => structuredClone(o);
const eq = (a, b, msg) => assert.equal(L.cents(a), L.cents(b), msg + ` (got ${a}, expected ${b})`);

test('seed passes the same validation the API applies', () => {
  assert.deepEqual(L.validateState(seed), { ok: true });
});

test('every bill total equals the total printed in the spreadsheet', () => {
  for (const [ym, x] of Object.entries(X.months)) {
    const m = L.getM(seed, ym); assert.ok(m, 'month ' + ym);
    // generated installment lines for the same month are not part of the spreadsheet bills
    const sheetItems = m.items.filter((it) => !it.plan);
    const total = sheetItems.reduce((t, it) => t + L.cents(it.a), 0) / 100;
    eq(total, x.sheetGrandTotal, ym + ' bill vs the sheet grand total');
    eq(x.billTotal, x.sheetGrandTotal, ym + ' sum of section totals vs grand total');
  }
});

test('every person total in every bill equals the spreadsheet section total', () => {
  for (const [ym, x] of Object.entries(X.months)) {
    const m = L.getM(seed, ym), mine = {};
    m.items.filter((it) => !it.plan).forEach((it) => it.shares.forEach((s) => { mine[s.p] = (mine[s.p] || 0) + L.cents(s.a); }));
    for (const name of new Set([...Object.keys(mine), ...Object.keys(x.personTotals)])) {
      const a = (mine[name] || 0) / 100, b = x.personTotals[name] || 0;
      assert.ok(Math.abs(a - b) <= 0.011, `${ym} ${name}: app ${a} vs sheet ${b}`);
    }
  }
});

test('every share is positive and every item equals the sum of its shares', () => {
  for (const m of seed.months) for (const it of m.items) {
    eq(it.a, L.sumShares(it), it.d);
    it.shares.forEach((s) => assert.ok(s.a > 0 && s.pd <= s.a));
  }
});

test('installment plans add up to the exact price', () => {
  for (const p of seed.plans) {
    const sched = L.planSchedule(seed, p);
    assert.equal(sched.length, p.months);
    const total = sched.reduce((t, r) => t + L.cents(r.amount), 0) / 100;
    eq(total, p.total, p.name + ' schedule total');
  }
  const sharp = seed.plans.find((p) => p.name === 'Sharp Refrigerator'), ipad = seed.plans.find((p) => p.name.startsWith('iPad'));
  eq(sharp.total, X.installments['Sharp Refrigerator'].price, 'Sharp price');
  eq(ipad.total, X.installments['iPad A16 11th Gen'].price, 'iPad price');
  eq(L.planAmounts(ipad.total, 12).each, 2009, 'iPad monthly');
  assert.ok(Math.abs(L.planAmounts(sharp.total, 12).each - 2254.583) < 0.005, 'Sharp monthly rounds the sheet value');
});

test('remaining installments and balances', () => {
  const T = L.totals(seed, '2026-10');
  eq(T.owe, 30336.26, 'outstanding'); eq(T.past, 0, 'billed so far'); eq(T.fut, 30336.26, 'upcoming');
  eq(L.availableCredit(seed, '2026-10'), 90000 - 30336.26, 'available credit');
  const sharp = L.planInfo(seed, seed.plans[0]), ipad = L.planInfo(seed, seed.plans[1]);
  assert.equal(sharp.done, 3); assert.equal(ipad.done, 7);
  eq(sharp.left, 20291.26, 'Sharp left'); eq(ipad.left, 10045, 'iPad left');
  eq(sharp.left + ipad.left, T.owe, 'plans explain the whole balance');
});

test('equal splits never lose or gain a centavo', () => {
  assert.deepEqual(L.equalSplit(5000, ['a', 'b', 'c', 'd']).map((s) => s.a), [1250, 1250, 1250, 1250]);
  assert.deepEqual(L.equalSplit(100, ['a', 'b', 'c']).map((s) => s.a), [33.34, 33.33, 33.33]);
  for (let i = 0; i < 3000; i++) {
    const total = L.r2(Math.random() * 20000 + 0.01), n = 1 + Math.floor(Math.random() * 9);
    const sum = L.equalSplit(total, Array.from({ length: n }, (_, k) => 'p' + k)).reduce((t, s) => t + L.cents(s.a), 0);
    assert.equal(sum, L.cents(total), `split ${total} by ${n}`);
  }
});

test('random installment plans always add up exactly', () => {
  for (let i = 0; i < 3000; i++) {
    const total = L.r2(Math.random() * 90000 + 1), n = 2 + Math.floor(Math.random() * 59);
    const a = L.planAmounts(total, n);
    assert.equal(L.cents(a.each) * (n - 1) + L.cents(a.last), L.cents(total), `plan ${total} over ${n}`);
    assert.ok(L.cents(a.last) >= L.cents(a.each) && L.cents(a.last) - L.cents(a.each) < n, 'last payment stays close to the others');
  }
});

test('creating a plan with several payers adds up to the price', () => {
  const S = clone(seed); S.plans = [];
  const plan = { id: 'pt', name: 'Test TV', payers: ['Ian', 'Peach', 'Shan'], total: 10000, months: 7, start: '2026-11', day: 5, skip: null, gen: true };
  S.plans.push(plan); L.generatePlan(S, plan);
  let sum = 0;
  S.months.forEach((m) => m.items.filter((it) => it.plan && it.plan.id === 'pt').forEach((it) => { sum += L.cents(it.a); eq(it.a, L.sumShares(it), 'item = shares'); }));
  assert.equal(sum, 1000000);
  assert.deepEqual(L.validateState(S), { ok: true });
});

test('statements add up to the bill, and to each person card', () => {
  for (const m of seed.months) {
    const sts = L.monthStatements(seed, m.ym), t = L.mtot(m);
    eq(sts.reduce((a, s) => a + L.cents(s.total), 0) / 100, t.total, m.ym + ' statements vs bill');
    eq(sts.reduce((a, s) => a + L.cents(s.owe), 0) / 100, t.owe, m.ym + ' balances vs bill');
  }
  const people = L.allPeople(seed);
  eq(people.reduce((a, p) => a + L.cents(p.total), 0) / 100, L.totals(seed, '2026-10').total, 'people vs all bills');
  eq(people.reduce((a, p) => a + L.cents(p.owe), 0) / 100, L.totals(seed, '2026-10').owe, 'people balances vs all bills');
});

test('marking things paid moves the balance by exactly that amount', () => {
  const S = clone(seed), before = L.totals(S, '2026-10').owe;
  const m = L.getM(S, '2026-11'), it = m.items[0], s = it.shares[0]; const amt = s.a;
  s.pd = s.a; eq(L.totals(S, '2026-10').owe, before - amt, 'after paying one line');
  s.pd = L.r2(s.a / 2); eq(L.totals(S, '2026-10').owe, before - L.r2(s.a / 2), 'after a part payment');
  const st = L.personStatement(S, L.allPeople(S).find((p) => p.key === s.p.toLowerCase()), null);
  assert.ok(st.groups.every((g) => g.rows.every((l) => !L.sPaid(l.s))), 'an all-months SOA lists only unpaid lines');
});

test('SOA for one person: month view vs all-unpaid view', () => {
  const S = clone(seed), P = L.allPeople(S).find((p) => p.key === 'claud');
  const month = L.personStatement(S, P, '2026-11'), all = L.personStatement(S, P, null);
  eq(month.total, 2009, 'Claud Nov charges'); eq(month.owe, 2009, 'Claud Nov balance');
  eq(all.owe, 10045, 'Claud all unpaid');
  assert.equal(all.groups.length, 5);
});

test('the validator rejects data that does not add up', () => {
  const bad = clone(seed); bad.months[0].items[0].a += 5;
  assert.equal(L.validateState(bad).ok, false);
  const bad2 = clone(seed); bad2.months[0].items[0].shares[0].pd = bad2.months[0].items[0].shares[0].a + 10;
  assert.equal(L.validateState(bad2).ok, false);
  const bad3 = clone(seed); bad3.months.push({ ...clone(bad3.months[0]) });
  assert.equal(L.validateState(bad3).ok, false);
});

test('month helpers', () => {
  assert.equal(L.addM('2026-11', 3), '2027-02'); assert.equal(L.addM('2026-01', -1), '2025-12');
  assert.equal(L.monthsBetween('2026-08', '2026-10'), 2);
  assert.equal(L.defaultYM(seed, '2026-10'), '2026-10'); assert.equal(L.defaultYM(seed, '2026-12'), '2026-12'.slice(0, 0) + '2026-12');
});
