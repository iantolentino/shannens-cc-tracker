// Pure money and date logic. Used by the browser (app.js), the API (validation) and the tests.
// Nothing in here touches the DOM, the network or the clock.

export const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export const pad = (n) => (n < 10 ? '0' : '') + n;
/** Round to centavos. */
export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Work in whole centavos to avoid floating point drift. */
export const cents = (n) => Math.round(n * 100);

export function ymLabel(ym) { const p = ym.split('-'); return MON[+p[1] - 1] + ' ' + p[0]; }
export function ymShort(ym) { return MON[+ym.split('-')[1] - 1].slice(0, 3); }
export function addM(ym, k) { const p = ym.split('-'); const t = (+p[0]) * 12 + (+p[1] - 1) + k; return Math.floor(t / 12) + '-' + pad(t % 12 + 1); }
export function monthsBetween(a, b) { const x = a.split('-'), y = b.split('-'); return (+y[0] - +x[0]) * 12 + (+y[1] - +x[1]); }
export function fdue(d) { const p = d.split('-'); return MON[+p[1] - 1].slice(0, 3) + ' ' + (+p[2]) + ', ' + p[0]; }
export function fshort(d) { const p = d.split('-'); return MON[+p[1] - 1].slice(0, 3) + ' ' + (+p[2]); }
export function uid() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- shares, items, months ---------- */
export const paidOf = (s) => Math.min(s.pd || 0, s.a);
export const sPaid = (s) => paidOf(s) >= s.a - 0.005;
export function sumShares(it) { let t = 0; it.shares.forEach((s) => { t += cents(s.a); }); return t / 100; }
export function iPaid(it) { let t = 0; it.shares.forEach((s) => { t += cents(paidOf(s)); }); return t / 100; }
export function mtot(m) {
  let t = 0, p = 0;
  m.items.forEach((it) => { t += cents(it.a); p += cents(iPaid(it)); });
  return { total: t / 100, paid: p / 100, owe: (t - p) / 100 };
}
export function statusOf(paid, total) { return total > 0 && paid >= total - 0.005 ? 'paid' : (paid > 0 ? 'part' : 'unpaid'); }

/** Split an amount between names to the centavo. The first names take the leftover centavos. */
export function equalSplit(amount, names) {
  const c = cents(amount), n = names.length, b = Math.floor(c / n), r = c - b * n;
  return names.map((p, i) => ({ p, a: (b + (i < r ? 1 : 0)) / 100, pd: 0, n: '' }));
}

/* ---------- state helpers ---------- */
export const getM = (S, ym) => S.months.find((m) => m.ym === ym);
export const monthsAsc = (S) => S.months.slice().sort((a, b) => (a.ym < b.ym ? -1 : 1));
export const monthsDesc = (S) => S.months.slice().sort((a, b) => (a.ym < b.ym ? 1 : -1));
export function ensureMonth(S, ym, day) {
  let m = getM(S, ym);
  if (!m) { m = { ym, due: ym + '-' + pad(Math.min(day || 1, 28)), items: [] }; S.months.push(m); }
  return m;
}
/** The latest month that is not in the future, or the oldest month if every month is ahead. */
export function defaultYM(S, cur) {
  const a = monthsAsc(S); let pick = null;
  a.forEach((m) => { if (m.ym <= cur) pick = m; });
  return pick ? pick.ym : (a[0] ? a[0].ym : cur);
}
export function findItem(S, id) {
  for (const m of S.months) { const j = m.items.findIndex((it) => it.id === id); if (j >= 0) return { m, it: m.items[j], j }; }
  return null;
}
/** Totals across every month. "past" is billed up to the current month, "fut" is later months. */
export function totals(S, cur) {
  let t = 0, p = 0, past = 0, fut = 0;
  S.months.forEach((m) => {
    const x = mtot(m); t += cents(x.total); p += cents(x.paid);
    if (m.ym <= cur) past += cents(x.owe); else fut += cents(x.owe);
  });
  return { total: t / 100, paid: p / 100, owe: (t - p) / 100, past: past / 100, fut: fut / 100 };
}
export const availableCredit = (S, cur) => (cents(S.limit) - cents(totals(S, cur).owe)) / 100;

export function allPeople(S) {
  const map = {}, order = [];
  const add = (n) => { n = n.trim(); const k = n.toLowerCase(); if (!map[k]) { map[k] = { key: k, name: n, lines: [] }; order.push(k); } return map[k]; };
  monthsAsc(S).forEach((m) => m.items.forEach((it) => it.shares.forEach((s, si) => add(s.p).lines.push({ m, it, s, si }))));
  (S.people || []).forEach((n) => add(n));
  return order.map((k) => {
    const P = map[k]; let t = 0, p = 0;
    P.lines.forEach((l) => { t += cents(l.s.a); p += cents(paidOf(l.s)); });
    P.total = t / 100; P.paid = p / 100; P.owe = (t - p) / 100; return P;
  }).sort((a, b) => b.owe - a.owe || a.name.localeCompare(b.name));
}

/* ---------- statements (SOA) ---------- */
/** One person's statement. With ym: every charge in that month. Without: every unpaid charge in all months. */
export function personStatement(S, P, ym) {
  const lines = P.lines.filter((l) => (ym ? l.m.ym === ym : !sPaid(l.s)));
  const by = {};
  lines.forEach((l) => { (by[l.m.ym] = by[l.m.ym] || { m: l.m, rows: [] }).rows.push(l); });
  const groups = Object.keys(by).sort().map((k) => by[k]);
  let t = 0, p = 0; lines.forEach((l) => { t += cents(l.s.a); p += cents(paidOf(l.s)); });
  return { key: P.key, name: P.name, ym: ym || null, groups, count: lines.length, total: t / 100, paid: p / 100, owe: (t - p) / 100 };
}
/** One statement per person with charges in the month, biggest balance first. */
export function monthStatements(S, ym) {
  return allPeople(S).map((P) => personStatement(S, P, ym)).filter((st) => st.count > 0)
    .sort((a, b) => b.owe - a.owe || a.name.localeCompare(b.name));
}

/* ---------- installments ---------- */
export function planAmounts(total, n) {
  const c = cents(total), b = Math.floor(c / n);
  return { each: b / 100, last: (c - b * (n - 1)) / 100 };
}
/** Create the monthly installment charges. Months up to plan.skip are already inside earlier bills. */
export function generatePlan(S, p) {
  const n = p.months, a = planAmounts(p.total, n);
  for (let k = 0; k < n; k++) {
    const ym = addM(p.start, k); if (p.skip && ym <= p.skip) continue;
    const amt = k === n - 1 ? a.last : a.each, m = ensureMonth(S, ym, p.day);
    m.items.push({ id: uid(), d: p.name + ' · installment ' + (k + 1) + ' of ' + n, a: amt, shares: equalSplit(amt, p.payers), plan: { id: p.id, k } });
  }
}
/** Every payment of a plan, in order, with its state. */
export function planSchedule(S, p) {
  const a = planAmounts(p.total, p.months), rows = [];
  for (let k = 0; k < p.months; k++) {
    const ym = addM(p.start, k), amount = k === p.months - 1 ? a.last : a.each;
    let item = null;
    S.months.forEach((m) => m.items.forEach((it) => { if (it.plan && it.plan.id === p.id && it.plan.k === k) item = it; }));
    const pre = !!(p.skip && ym <= p.skip);
    const paid = pre ? true : (item ? iPaid(item) >= item.a - 0.005 : false);
    rows.push({ k, ym, due: ym + '-' + pad(Math.min(p.day || 1, 28)), amount, pre, item, paid, missing: !pre && !item });
  }
  return rows;
}
export function planInfo(S, p) {
  const rows = planSchedule(S, p), a = planAmounts(p.total, p.months);
  let done = 0, left = 0, next = null;
  rows.forEach((r) => {
    if (r.paid) done++;
    else { left += cents(r.item ? r.item.a - iPaid(r.item) : r.amount); if (!next) next = r; }
  });
  return { rows, done, left: left / 100, next, each: a.each, last: a.last, end: addM(p.start, p.months - 1) };
}

/* ---------- validation (used by the API before anything is saved) ---------- */
export function validateState(d) {
  const bad = (m) => ({ ok: false, error: m });
  if (!d || typeof d !== 'object' || d.v !== 2) return bad('Wrong data version.');
  if (typeof d.limit !== 'number' || !(d.limit >= 0)) return bad('Credit limit must be a number.');
  if (!Array.isArray(d.months) || !Array.isArray(d.plans || [])) return bad('Months or plans are missing.');
  const seenYM = {}, seenId = {};
  for (const m of d.months) {
    if (!m || !/^\d{4}-\d{2}$/.test(m.ym) || !/^\d{4}-\d{2}-\d{2}$/.test(m.due) || m.due.slice(0, 7) !== m.ym) return bad('A month has a bad date.');
    if (seenYM[m.ym]) return bad('Month ' + m.ym + ' appears twice.'); seenYM[m.ym] = 1;
    if (!Array.isArray(m.items)) return bad('A month has no items.');
    for (const it of m.items) {
      if (!it || typeof it.id !== 'string' || typeof it.d !== 'string' || !Array.isArray(it.shares) || !it.shares.length) return bad('An item is incomplete.');
      if (seenId[it.id]) return bad('Item id ' + it.id + ' appears twice.'); seenId[it.id] = 1;
      let sum = 0;
      for (const s of it.shares) {
        if (typeof s.p !== 'string' || !s.p.trim() || typeof s.a !== 'number' || !(s.a > 0) || typeof s.pd !== 'number' || s.pd < 0 || s.pd > s.a + 0.005 || typeof s.n !== 'string') return bad('A share in "' + it.d + '" is invalid.');
        sum += cents(s.a);
      }
      if (typeof it.a !== 'number' || Math.abs(sum - cents(it.a)) > 1) return bad('"' + it.d + '": the shares do not add up to the bill.');
    }
  }
  for (const p of d.plans || []) {
    if (!p || typeof p.id !== 'string' || !(p.total > 0) || !(p.months >= 2 && p.months <= 60) || !/^\d{4}-\d{2}$/.test(p.start) || !Array.isArray(p.payers) || !p.payers.length) return bad('An installment plan is invalid.');
  }
  return { ok: true };
}
