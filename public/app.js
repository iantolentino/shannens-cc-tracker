// CC Tracker front end. All money math lives in logic.js; this file draws pages and talks to the API.
import * as L from './logic.js';
const { MON, r2, ymLabel, ymShort, addM, fdue, fshort, uid, paidOf, sPaid, iPaid, mtot, statusOf, equalSplit, getM, monthsAsc, monthsDesc,
  ensureMonth, defaultYM, findItem, totals, allPeople, personStatement, monthStatements, planAmounts, generatePlan, planInfo, sumShares } = L;

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
const money = (n) => peso.format(n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);
const pad = (n) => (n < 10 ? '0' : '') + n;
const now = new Date();
const curYM = now.getFullYear() + '-' + pad(now.getMonth() + 1);

let S = null;        // all cards and data
let version = 0;     // version of the data on the server
const ui = { anim: true, page: 'dashboard', previous: 'dashboard', cardId: 'card-default', planOrder: 'newest', ym: curYM, pm: 'all', q: '', sure: null, onlyOwing: true, menu: false, banner: null, soa: null, openPeople: new Set(), openPlans: new Set(), storage: null, storageLoading: false, settingsYear: null };

/* ---------- talking to the server ---------- */
let dirty = false, saving = false, timer = null, halted = false, conflict = false;

function save() { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 350); }

function setBanner(kind, msg) { ui.banner = kind ? { kind, msg } : null; if (S) render(); }

async function flush() {
  if (saving || !dirty || conflict) return;
  saving = true; dirty = false; halted = false;
  try {
    const r = await fetch('/api/state', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: version, data: S }) });
    if (r.ok) { version = (await r.json()).version; if (ui.banner) setBanner(null); }
    else if (r.status === 409) { conflict = true; setBanner('conflict'); }
    else if (r.status === 401) { dirty = true; halted = true; showLogin('Your session ended. Sign in again to save your changes.'); }
    else { const j = await r.json().catch(() => ({})); dirty = true; halted = r.status === 422; setBanner('error', j.error || 'Could not save.'); }
  } catch (e) { dirty = true; setBanner('offline'); }
  saving = false;
  if (dirty && !conflict && !halted) { clearTimeout(timer); timer = setTimeout(flush, ui.banner ? 4000 : 50); }
}
window.addEventListener('pagehide', () => {
  if (dirty && S && !conflict) { try { fetch('/api/state', { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: version, data: S }) }); } catch (e) { /* page is closing */ } }
});

function showLogin(msg) {
  $('#boot').hidden = true; $('#shell').hidden = true; $('#login').hidden = false;
  $('#loginErr').textContent = msg || ''; $('#pw').value = ''; $('#pw').focus();
}
function showFatal(msg) {
  $('#login').hidden = true; $('#shell').hidden = true; $('#boot').hidden = false;
  $('#boot').innerHTML = '<div class="counter"><div class="sign" style="color:var(--bronze)">Cannot open the tracker</div><p style="margin:8px 0 12px">' + esc(msg) + '</p><button class="counter-btn" id="retry" type="button">Try again</button></div>';
  $('#retry').onclick = () => location.reload();
}

async function boot() {
  try {
    const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { showLogin(); return; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showFatal(j.error || 'The server returned an error.'); return; }
    S = j.data; version = j.version; conflict = false; dirty = false;
    S.plans = S.plans || []; S.people = S.people || [];
    S.cards = S.cards || [{ id: 'card-default', name: 'Primary card', bank: 'Existing card' }];
    let migrated = false;
    if (!S.cards.some((c) => c.id === 'card-default')) S.cards.unshift({ id: 'card-default', name: 'Primary card', bank: 'Existing card' });
    if (!S.cards.some((c) => !c.archived)) S.cards[0].archived = false;
    S.months.forEach((m) => { if (!m.cardId) { m.cardId = 'card-default'; migrated = true; } });
    S.plans.forEach((p) => { if (!p.cardId) { p.cardId = 'card-default'; migrated = true; } });
    ui.cardId = localStorage.getItem('cc-card-' + location.host) || 'card-default';
    if (!S.cards.some((c) => c.id === ui.cardId && !c.archived)) ui.cardId = S.cards.find((c) => !c.archived).id;
    if (migrated || !j.data.cards) save();
    ui.ym = ui.pm = defaultYM(S, curYM);
    $('#boot').hidden = true; $('#login').hidden = true; $('#shell').hidden = false;
    ui.anim = true; render();
  } catch (e) { showFatal('Cannot reach the server. Check your internet and try again.'); }
}

/* ---------- helpers ---------- */
const pill = (st) => '<span class="pill ' + (st === 'paid' ? 'ok' : st === 'part' ? 'part' : 'owe') + '">' + (st === 'paid' ? 'Paid' : st === 'part' ? 'Part paid' : 'Unpaid') + '</span>';
const money0 = (n) => (n >= 1000 ? '₱' + (n / 1000).toFixed(1) + 'k' : '₱' + Math.round(n));
const people = () => allPeople(cardData());
const nameList = () => people().map((p) => p.name).sort((a, b) => a.localeCompare(b));
const cardData = () => ({ ...S, months: S.months.filter((m) => (m.cardId || 'card-default') === ui.cardId), plans: S.plans.filter((p) => (p.cardId || 'card-default') === ui.cardId) });
const activeCards = () => S.cards.filter((c) => !c.archived);
const activeCard = () => S.cards.find((c) => c.id === ui.cardId && !c.archived) || activeCards()[0] || S.cards[0];

/* ---------- pages ---------- */
function pageDashboard() {
  const D = cardData(), T = totals(D, curYM), ms = monthsAsc(D);
  let hi = null, hiT = -1, max = 1;
  ms.forEach((m) => { const t = mtot(m).total; if (t > hiT) { hiT = t; hi = m; } if (t > max) max = t; });
  let i = 0;
  let h = '<div class="grid kpis">' +
    '<div class="counter kpi" style="--i:' + (i++) + '"><div class="k">Outstanding balance</div><div class="v owe n">' + money(T.owe) + '</div><div class="s">Unpaid on current and past bills ' + money(T.past) + '<br>Upcoming installments ' + money(T.fut) + '</div></div>' +
    '<div class="counter kpi" style="--i:' + (i++) + '"><div class="k">Highest month</div><div class="v n" style="font-size:var(--t25)">' + (hi ? esc(ymLabel(hi.ym)) : 'None yet') + '</div><div class="s n">' + (hi ? money(hiT) + ' charged' : '') + '</div></div></div>';
  h += '<section class="counter" style="--i:4;margin-bottom:20px" aria-label="Charges by month"><h2>Charges by month</h2><p class="help" style="margin:0">Tap a month to open its card.</p><div class="chart">' +
    ms.map((m) => {
      const t = mtot(m), ht = Math.max(t.total ? 4 : 0, Math.round(t.total / max * 170)), oh = t.total ? Math.round(t.owe / t.total * ht) : 0, ph = ht - oh;
      return '<button class="col' + (m === hi ? ' hi' : '') + '" data-month="' + m.ym + '" type="button" aria-label="' + esc(ymLabel(m.ym)) + ' ' + money(t.total) + '">' + (m === hi ? '<span class="tag">Highest</span>' : '') + '<span class="cv">' + money0(t.total) + '</span><span class="bar" style="height:' + ht + 'px"><i class="p" style="height:' + ph + 'px"></i><i class="o" style="height:' + oh + 'px"></i></span><span class="cm">' + ymShort(m.ym) + '<small>' + m.ym.slice(2, 4) + '</small></span></button>';
    }).join('') + '</div><div class="legend"><span><i style="background:var(--olive)"></i>Paid</span><span><i style="background:var(--bronze)"></i>Outstanding</span></div></section>';
  h += '<div class="grid two" style="margin-bottom:20px"><section class="counter" style="--i:5"><div class="row-act" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Installments</h2><button class="btn2" data-go="plans" type="button">Open installments</button></div>';
  if (!D.plans.length) h += '<div class="empty">No installment plans yet.</div>';
  D.plans.forEach((p) => {
    const f = planInfo(D, p), pct = Math.round(f.done / p.months * 100);
    h += '<div class="plan"><div class="row-act" style="justify-content:space-between"><b>' + esc(p.name) + '</b><span class="n">' + money(f.each) + ' / month</span></div><div class="prog" role="img" aria-label="' + f.done + ' of ' + p.months + ' paid"><i style="width:' + pct + '%"></i></div><div class="help">' + f.done + ' of ' + p.months + ' paid · ' + money(f.left) + ' left</div></div>';
  });
  h += '</section><section class="counter" style="--i:6"><h2>Who still owes</h2>';
  const owing = allPeople(D).filter((p) => p.owe > 0.005);
  if (!owing.length) h += '<div class="empty">Everyone is paid up.</div>';
  else h += '<div class="tw"><table><tbody>' + owing.map((p) => '<tr class="click" tabindex="0" data-person="' + esc(p.key) + '"><td>' + esc(p.name) + '</td><td class="r n"><b style="color:var(--bronze)">' + money(p.owe) + '</b></td></tr>').join('') + '</tbody></table></div>';
  h += '</section></div>';
  const outstandingMonths = monthsDesc(D).filter((m) => mtot(m).owe > 0.005);
  h += '<section class="counter" style="--i:7"><h2>Months with outstanding balances</h2><div class="tw"><table><thead><tr><th>Month</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Outstanding</th><th>Status</th></tr></thead><tbody>' +
    (outstandingMonths.length ? outstandingMonths.map((m) => {
      const t = mtot(m), st = statusOf(t.paid, t.total);
      return '<tr class="click" tabindex="0" data-month="' + m.ym + '"><td>' + esc(ymLabel(m.ym)) + '</td><td>' + esc(fdue(m.due)) + '</td><td class="r n">' + money(t.total) + '</td><td class="r n">' + money(t.paid) + '</td><td class="r n">' + money(t.owe) + '</td><td>' + (m.ym > curYM && t.paid === 0 ? '<span class="pill soon">Upcoming</span>' : pill(st)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">There are no months with an outstanding balance.</td></tr>') + '</tbody></table></div></section>';
  return h;
}

function selectors() {
  const D = cardData();
  let y0 = +curYM.slice(0, 4), y1 = y0;
  D.months.forEach((m) => { const y = +m.ym.slice(0, 4); if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const cy = ui.ym.slice(0, 4), cm = ui.ym.slice(5, 7);
  let ys = ''; for (let y = y1; y >= y0; y--) ys += '<option value="' + y + '"' + (String(y) === cy ? ' selected' : '') + '>' + y + '</option>';
  let mo = ''; for (let i = 1; i <= 12; i++) mo += '<option value="' + pad(i) + '"' + (pad(i) === cm ? ' selected' : '') + '>' + MON[i - 1] + (getM(D, cy + '-' + pad(i)) ? '' : ' (no bill)') + '</option>';
  return '<label class="f">Year<select id="yy">' + ys + '</select></label><label class="f">Month<select id="mm">' + mo + '</select></label>';
}

function pageMonth() {
  const D = cardData(), m = getM(D, ui.ym);
  let h = '<div class="ctrl">' + selectors() + '<button class="counter-btn" data-statements="1" type="button"' + (m ? '' : ' disabled') + '>Monthly statements</button><button class="btn2" data-act="charge" type="button">Add charge</button></div>';
  if (!m) return h + '<div class="counter"><div class="empty">There is no bill for ' + esc(ymLabel(ui.ym)) + ' yet.<br><br><button class="counter-btn" data-newym="' + ui.ym + '" type="button">Create this month</button></div></div>';
  const t = mtot(m);
  h += '<section class="counter stmt"><div class="stmt-h"><div><div class="sign" style="color:var(--bronze)">Credit card bill</div><h2 style="margin:0">' + esc(ymLabel(m.ym)) + '</h2><div class="help">Due ' + esc(fdue(m.due)) + '</div></div>' + pill(statusOf(t.paid, t.total)) + '</div>';
  h += '<div class="srow head sign"><span>Transaction</span><span class="a">Amount</span><span>Person</span><span>Status</span></div>';
  if (!m.items.length) h += '<div class="empty">No charges in this month yet.</div>';
  m.items.forEach((it) => {
    const st = statusOf(iPaid(it), it.a), multi = it.shares.length > 1;
    h += '<div class="srow' + (st === 'paid' ? ' paid' : '') + '"><span class="t">' + esc(it.d) + (multi ? '<small>Split between ' + it.shares.length + ' people</small>' : (it.shares[0].n ? '<small>' + esc(it.shares[0].n) + '</small>' : '')) + '</span><span class="a n">' + money(it.a) + '</span><span class="who">' +
      it.shares.map((s) => '<div><a href="#" data-person="' + esc(s.p.trim().toLowerCase()) + '">' + esc(s.p) + '</a>' + (multi ? ' <span class="n">' + money(s.a) + '</span>' + (sPaid(s) ? ' ✓' : '') : '') + '</div>').join('') + '</span><span class="st">' + pill(st) + '</span></div>';
  });
  h += '<div class="tot"><div class="tr big"><span>Total credit amount for the month</span><span class="n">' + money(t.total) + '</span></div>' +
    '<div class="tr"><span>Paid</span><span class="n">' + money(t.paid) + '</span></div>' +
    '<div class="tr"><span>Outstanding this month</span><span class="n" style="color:var(--bronze);font-weight:700">' + money(t.owe) + '</span></div>' +
    '</div></section>';
  return h;
}

function lineHTML(l) {
  const it = l.it, s = l.s, key = it.id + '|' + l.si, paid = sPaid(s), st = statusOf(paidOf(s), s.a), sure = ui.sure === key, multi = it.shares.length > 1;
  const others = it.shares.filter((x, i) => i !== l.si).map((x) => x.p).join(', ');
  return '<div class="ln' + (paid ? ' paid' : '') + '"><input type="checkbox" data-tog="' + key + '" ' + (paid ? 'checked' : '') + ' aria-label="Paid: ' + esc(it.d) + '"><input class="ed d" data-f="d|' + key + '" value="' + esc(it.d) + '" aria-label="Product">' +
    '<div class="r2"><input class="ed a" data-f="a|' + key + '" type="number" step="0.01" min="0.01" value="' + s.a + '" aria-label="Price">' + pill(st) + '</div>' +
    '<div class="r3"><input class="ed nt rem" data-f="n|' + key + '" value="' + esc(s.n) + '" placeholder="Add a remark" aria-label="Remarks"><button class="xb" data-split="' + it.id + '" type="button" title="Split or edit this bill" aria-label="Split or edit bill">Split</button><button class="xb' + (sure ? ' sure' : '') + '" data-del="' + key + '" type="button" aria-label="Remove">' + (sure ? 'Remove?' : '✕') + '</button></div>' +
    (multi ? '<div class="sp">Bill ' + money(it.a) + ' split with ' + esc(others) + '</div>' : '') + '</div>';
}

function pagePeople() {
  const D = cardData(), q = ui.q.trim().toLowerCase(), list = allPeople(D), ms = monthsDesc(D);
  let h = '<div class="pbar"><label class="f grow">Find<input id="q" type="search" placeholder="Person or product" value="' + esc(ui.q) + '"></label><label class="f">Month<select id="pm"><option value="all">All months</option>' + ms.map((m) => '<option value="' + m.ym + '"' + (ui.pm === m.ym ? ' selected' : '') + '>' + esc(ymLabel(m.ym)) + '</option>').join('') + '</select></label><button class="counter-btn" data-act="person" type="button">Add person</button></div>';
  const cards = []; let i = 0;
  list.forEach((P) => {
    const nameHit = q && P.name.toLowerCase().indexOf(q) > -1;
    const ls = P.lines.filter((l) => (ui.pm === 'all' || l.m.ym === ui.pm) && (!q || nameHit || l.it.d.toLowerCase().indexOf(q) > -1 || (l.s.n || '').toLowerCase().indexOf(q) > -1));
    if (!ls.length && (q || ui.pm !== 'all')) return;
    let t = 0, p = 0; ls.forEach((l) => { t += Math.round(l.s.a * 100); p += Math.round(paidOf(l.s) * 100); });
    t /= 100; p /= 100; const owe = r2(t - p);
    const expanded = ui.openPeople.has(P.key);
    let c = '<article class="counter tight pc" style="--i:' + Math.min(i++, 8) + '"><div class="pc-h"><div class="pc-name">' + esc(P.name) + '</div>' + (t === 0 ? '<span class="pill soon">No charges</span>' : (owe > 0.005 ? '<span class="pill owe">Balance</span>' : '<span class="pill ok">All paid</span>')) + '</div>' +
      '<div class="sum"><div><span class="help">Total bill</span><b class="n">' + money(t) + '</b></div><div><span class="help">Outstanding</span><b class="n" style="color:' + (owe > 0.005 ? 'var(--bronze)' : 'var(--olive)') + '">' + money(owe) + '</b></div></div>';
    const by = {}; ls.forEach((l) => { (by[l.m.ym] = by[l.m.ym] || { m: l.m, rows: [] }).rows.push(l); });
    Object.keys(by).map((k) => by[k]).sort((a, b) => (a.m.ym < b.m.ym ? 1 : -1)).forEach((g) => {
      let gt = 0, gl = 0; g.rows.forEach((l) => { gt += l.s.a; gl += l.s.a - paidOf(l.s); });
      c += '<div class="mg"><div class="mg-h"><span><b>' + esc(ymLabel(g.m.ym)) + '</b><br><span class="help">Due ' + esc(fshort(g.m.due)) + ' · ' + money(r2(gt)) + '</span></span>' + (gl > 0.005 ? '<button class="plaque" data-allpaid="' + g.m.ym + '|' + esc(P.key) + '" type="button">Mark all paid</button>' : '<span class="pill ok">Paid</span>') + '</div><div' + (expanded ? '' : ' hidden') + '>' + g.rows.map(lineHTML).join('') + '</div></div>';
    });
    if (!ls.length) c += '<p class="help" style="margin:0">No charges yet.</p>';
    c += '<div class="row-act" style="margin-top:auto;justify-content:space-between"><button class="plaque" data-toggle-person="' + esc(P.key) + '" aria-expanded="' + expanded + '" type="button">' + (expanded ? 'Hide all items' : 'Show all items') + '</button><button class="plaque" data-charge-for="' + esc(P.name) + '" type="button">+ Add item</button><button class="btn2" data-soa="' + esc(P.key) + '" type="button">Statement (SOA)</button><button class="plaque warn" data-delete-person="' + esc(P.key) + '" type="button">' + (ui.sure === 'person:' + P.key ? 'Tap again to remove' : 'Delete person') + '</button></div></article>';
    cards.push(c);
  });
  return h + (cards.length ? '<div class="pgrid">' + cards.join('') + '</div>' : '<div class="empty">Nothing matches.</div>');
}

/* statements: one receipt per person */
function receiptHTML(st) {
  const D = cardData(), single = !!st.ym, m = single ? getM(D, st.ym) : null;
  const title = single ? 'Monthly statement' : 'Statement of account';
  const sub = single ? ymLabel(st.ym) + ' bill · due ' + fdue(m.due) : 'All unpaid charges';
  const rows = st.groups.map((g) => (single ? '' : '<li class="gl">' + esc(ymLabel(g.m.ym)) + ' · due ' + esc(fdue(g.m.due)) + '</li>') +
    g.rows.map((l) => {
      const paid = sPaid(l.s);
      return '<li class="i' + (paid ? ' pd' : '') + '"><span>' + esc(l.it.d) + (l.it.shares.length > 1 ? '<small>Your share of the ' + money(l.it.a) + ' bill</small>' : '') + (l.s.n ? '<small>' + esc(l.s.n) + '</small>' : '') + '</span><span class="n">' + money(l.s.a) + (paid ? '<small>Paid</small>' : '') + '</span></li>';
    }).join('')).join('') || '<li class="gl">Nothing unpaid</li>';
  const due = single ? fdue(m.due) : '';
  return '<article class="receipt" aria-label="' + esc(title) + ' for ' + esc(st.name) + '"><div class="rh"><div class="seal" aria-hidden="true">' + esc(st.name.charAt(0).toUpperCase()) + '</div><div><div class="sign" style="color:var(--bronze)">' + title + '</div><h3>' + esc(st.name) + '</h3><div class="help">' + esc(sub) + '</div></div></div><div class="rb"><ol>' + rows + '</ol><div class="rtot"><div class="tr"><span>Total charges</span><span class="n">' + money(st.total) + '</span></div><div class="tr"><span>Paid so far</span><span class="n">' + money(st.paid) + '</span></div><div class="tr big"><span>Balance due</span><span class="n" style="color:' + (st.owe > 0.005 ? 'var(--bronze)' : 'var(--olive)') + '">' + money(st.owe) + '</span></div>' + (st.owe <= 0.005 ? '<span class="stamp">Paid in full</span>' : '') + '</div>' +
    '<p class="rfoot">' + (st.owe > 0.005 ? 'Please send ' + money(st.owe) + (single ? ' by ' + esc(due) : '') + '. Thank you!' : 'Thank you. Nothing more to pay.') + '</p></div></article>';
}
function receiptText(st) {
  const D = cardData(), single = !!st.ym, m = single ? getM(D, st.ym) : null;
  const out = ['CC TRACKER · ' + (single ? 'MONTHLY STATEMENT' : 'STATEMENT OF ACCOUNT'), 'Name: ' + st.name, single ? 'Bill: ' + ymLabel(st.ym) + ' (due ' + fdue(m.due) + ')' : 'All unpaid charges', ''];
  let n = 0;
  st.groups.forEach((g) => {
    if (!single) out.push(ymLabel(g.m.ym) + ' (due ' + fdue(g.m.due) + ')');
    g.rows.forEach((l) => { n++; out.push(n + '. ' + l.it.d + (l.it.shares.length > 1 ? ' (your share of ' + money(l.it.a) + ')' : '') + (l.s.n ? ' [' + l.s.n + ']' : '') + ' - ' + money(l.s.a) + (sPaid(l.s) ? ' [paid]' : '')); });
  });
  out.push('', 'Total: ' + money(st.total), 'Paid: ' + money(st.paid), 'Balance due: ' + money(st.owe));
  return out.join('\n');
}
function pageStatements() {
  const D = cardData(), m = getM(D, ui.ym);
  let h = '<div class="ctrl">' + selectors() + '<label class="f" style="flex-direction:row;align-items:center;gap:8px;font-weight:400"><input id="onlyowing" type="checkbox"' + (ui.onlyOwing ? ' checked' : '') + '> Only people who still owe</label><button class="btn2" data-go="month" type="button">Back to monthly card</button></div>';
  if (!m) return h + '<div class="counter"><div class="empty">There is no bill for ' + esc(ymLabel(ui.ym)) + '.</div></div>';
  const list = monthStatements(D, ui.ym).filter((st) => !ui.onlyOwing || st.owe > 0.005);
  if (!list.length) return h + '<div class="counter"><div class="empty">' + (ui.onlyOwing ? 'Nobody owes anything for ' + esc(ymLabel(m.ym)) + '. Untick the box above to see everyone.' : 'No charges this month.') + '</div></div>';
  return h + '<div class="rgrid">' + list.map((st, i) => '<div class="rc" style="--i:' + Math.min(i, 8) + '">' + receiptHTML(st) + '<div class="row-act"><button class="btn2" data-copy="' + esc(st.key) + '" type="button">Copy as text</button>' + (st.owe > 0.005 ? '<button class="plaque" data-allpaid="' + m.ym + '|' + esc(st.key) + '" type="button">Mark all paid</button>' : '') + '</div></div>').join('') + '</div>';
}

/* installments page */
function pagePlans() {
  let h = '<div class="ctrl"><button class="counter-btn" data-act="plan" type="button">New installment</button></div>';
  h = '<div class="ctrl"><button class="counter-btn" data-act="plan" type="button">New installment</button><label class="f">Sort installments<select id="planOrder"><option value="newest"' + (ui.planOrder === 'newest' ? ' selected' : '') + '>Newest to oldest</option><option value="oldest"' + (ui.planOrder === 'oldest' ? ' selected' : '') + '>Oldest to newest</option></select></label></div>';
  const D = cardData(), plans = D.plans.slice().sort((a,b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name)) * (ui.planOrder === 'newest' ? -1 : 1));
  if (!plans.length) return h + '<div class="counter"><div class="empty">No installment plans on this card yet.<br>Press New installment to add one.</div></div>';
  h += '<div class="grid" style="gap:20px">' + plans.map((p, i) => {
    const f = planInfo(D, p), pct = Math.round(f.done / p.months * 100), total = r2(p.total), expanded = ui.openPlans.has(p.id);
    return '<section class="counter" style="--i:' + Math.min(i, 8) + '"><div class="row-act" style="justify-content:space-between;align-items:flex-start"><div><h2 style="margin:0">' + esc(p.name) + '</h2><div class="help">Paid by ' + esc(p.payers.join(', ')) + ' · due on day ' + (p.day || 1) + ' of each month</div></div><button class="plaque warn" data-delplan="' + p.id + '" type="button">' + (ui.sure === 'plan:' + p.id ? 'Tap again to delete' : 'Delete plan') + '</button></div>' +
      '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0"><div class="sum" style="display:block"><div><span class="help">Total price</span><b class="n">' + money(total) + '</b></div></div><div class="sum" style="display:block"><div><span class="help">Each month</span><b class="n">' + money(f.each) + '</b></div></div><div class="sum" style="display:block"><div><span class="help">Paid</span><b class="n">' + f.done + ' of ' + p.months + '</b></div></div><div class="sum" style="display:block"><div><span class="help">Still to pay</span><b class="n" style="color:' + (f.left > 0.005 ? 'var(--bronze)' : 'var(--olive)') + '">' + money(f.left) + '</b></div></div></div>' +
      '<div class="prog" role="img" aria-label="' + f.done + ' of ' + p.months + ' paid"><i style="width:' + pct + '%"></i></div>' +
      '<div class="row-act" style="margin:14px 0"><button class="plaque" data-toggle-plan="' + esc(p.id) + '" aria-expanded="' + expanded + '" type="button">' + (expanded ? 'Hide payment months' : 'Show payment months') + '</button></div>' +
      '<div class="tw"' + (expanded ? '' : ' hidden') + '><table class="sched"><thead><tr><th>#</th><th>Due date</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>' +
      f.rows.map((r) => '<tr><td class="num n">' + (r.k + 1) + '</td><td>' + esc(fdue(r.due)) + '</td><td class="r n">' + money(r.amount) + '</td><td>' +
        (r.pre ? '<span class="pill ok">Paid</span> <span class="help">in an earlier bill</span>' :
          r.item ? '<label style="display:inline-flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-plantog="' + r.item.id + '" ' + (r.paid ? 'checked' : '') + ' aria-label="Paid ' + esc(fdue(r.due)) + '" style="width:18px;height:18px"> ' + (r.paid ? '<span class="pill ok">Paid</span>' : '<span class="pill owe">Unpaid</span>') + '</label>' :
            '<span class="pill soon">Removed</span>') + '</td></tr>').join('') +
      '</tbody></table></div></section>';
  }).join('') + '</div>';
  return h;
}

function pageSettings() {
  const u = ui.storage, used = u && Number.isFinite(u.usedBytes) ? u.usedBytes : 0, limit = u && u.limitBytes || 1073741824;
  const pct = Math.min(100, Math.max(0, used / limit * 100)), storage = ui.storageLoading ? '<p class="help">Loading database size…</p>' : u && !u.error ?
    '<div class="storage-numbers"><b>' + esc(formatBytes(used)) + '</b><span class="help"> of ' + esc(formatBytes(limit)) + '</span><span class="help storage-percent">' + pct.toFixed(2) + '%</span></div><div class="storage-track" role="progressbar" aria-label="Neon database storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct.toFixed(2) + '"><i class="' + (pct >= 90 ? 'storage-high' : pct >= 75 ? 'storage-warn' : '') + '" style="width:' + pct.toFixed(2) + '%"></i></div><p class="help" style="margin:8px 0 0">Database size estimate against the Neon Free plan 1 GB reference. Neon may take time to reclaim space after deletions.</p>' :
      '<p class="help">' + esc((u && u.error) || 'Storage usage is not available yet.') + '</p>';
  const cardMonths = monthsDesc(cardData());
  const settingsYears = [...new Set([curYM.slice(0, 4), ...cardMonths.map((m) => m.ym.slice(0, 4))])].sort().reverse();
  const selectedYear = ui.settingsYear || curYM.slice(0, 4);
  const months = cardMonths.filter((m) => selectedYear === 'all' || m.ym.slice(0, 4) === selectedYear).map((m) => {
    const totalsForMonth = mtot(m), linked = m.items.some((it) => it.plan);
    return '<div class="settings-month"><div><b>' + esc(ymLabel(m.ym)) + '</b><div class="help">' + m.items.length + (m.items.length === 1 ? ' item' : ' items') + ' · ' + money(totalsForMonth.total) + ' total · ' + money(totalsForMonth.owe) + ' outstanding</div>' + (linked ? '<div class="help">Delete its linked installment plan before deleting this month.</div>' : '') + '</div><button class="plaque warn" data-delete-month="' + esc(m.ym) + '" type="button"' + (linked ? ' disabled title="Delete the linked installment plan first"' : '') + '>Delete month</button></div>';
  }).join('') || '<p class="help">No months found for this year.</p>';
  const cardRows = S.cards.map((c) => {
    const monthsOnCard = S.months.filter((m) => (m.cardId || 'card-default') === c.id).length;
    const plansOnCard = S.plans.filter((p) => (p.cardId || 'card-default') === c.id).length;
    const records = monthsOnCard + ' ' + (monthsOnCard === 1 ? 'month' : 'months') + ' · ' + plansOnCard + ' ' + (plansOnCard === 1 ? 'installment plan' : 'installment plans');
    if (c.archived) return '<div class="settings-month"><div><b>' + esc(c.name) + '</b><div class="help">' + esc(c.bank || 'Credit card') + ' · Removed from selector · ' + records + ' preserved</div></div><button class="plaque" data-restore-card="' + esc(c.id) + '" type="button">Restore card</button></div>';
    const lastCard = activeCards().length === 1;
    return '<div class="settings-month"><div><b>' + esc(c.name) + (c.id === ui.cardId ? ' <span class="help">(current)</span>' : '') + '</b><div class="help">' + esc(c.bank || 'Credit card') + ' · ' + records + ' preserved</div></div><button class="plaque warn" data-delete-card="' + esc(c.id) + '" type="button"' + (lastCard ? ' disabled title="At least one card must remain active"' : '') + '>Remove card</button></div>';
  }).join('');
  return '<div class="settings-grid"><section class="counter settings-account"><div class="sign" style="color:var(--bronze);margin-bottom:8px">Account</div><h2>Change master password</h2><p class="help" style="margin:0 0 18px">Your password is stored as a one-way hash. You will stay signed in on this device after changing it.</p>' +
    '<form id="fpassword" autocomplete="on"><label class="f">Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>' +
    '<label class="f" style="margin-top:12px">New password<input name="newPassword" type="password" autocomplete="new-password" minlength="8" required><span class="help">Use at least 8 characters.</span></label>' +
    '<label class="f" style="margin-top:12px">Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></label>' +
    '<div class="err" id="passwordErr" role="alert"></div><div class="row-act" style="margin-top:16px"><button class="counter-btn" type="submit">Update password</button></div></form></section>' +
    '<section class="counter settings-storage"><div class="row-act" style="justify-content:space-between"><div><div class="sign" style="color:var(--bronze);margin-bottom:8px">Storage</div><h2 style="margin:0">Database usage</h2></div><button class="plaque" data-storage-refresh type="button">Refresh</button></div>' + storage + '</section>' +
    '<section class="counter settings-cards"><div class="sign" style="color:var(--bronze);margin-bottom:8px">Cards</div><h2>Manage bank cards</h2><p class="help">Removing a card hides it from the card selector. Its months, transactions, payment history, and installment plans stay saved and can be restored here.</p><div class="settings-month-list">' + cardRows + '</div></section>' +
    '<section class="counter settings-months"><div class="sign" style="color:var(--bronze);margin-bottom:8px">Data maintenance</div><h2>Delete a month</h2><p class="help">Deleting a month permanently removes its transactions and removes that month from saved daily recovery copies. Download a backup first if you may need it later. Months containing installment payments must have their linked plan deleted first.</p><label class="f settings-year-filter">Show months from<select id="settingsYear"><option value="all"' + (selectedYear === 'all' ? ' selected' : '') + '>All years</option>' + settingsYears.map((year) => '<option value="' + year + '"' + (selectedYear === year ? ' selected' : '') + '>' + year + (year === curYM.slice(0, 4) ? ' (current year)' : '') + '</option>').join('') + '</select></label><div class="settings-month-list">' + months + '</div></section></div>';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB']; let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + units[i];
}

async function refreshStorage() {
  ui.storageLoading = true; render();
  try {
    const r = await fetch('/api/storage', { credentials: 'same-origin', cache: 'no-store' }), j = await r.json().catch(() => ({}));
    ui.storage = r.ok ? j : { error: j.error || 'Could not load database size.' };
  } catch { ui.storage = { error: 'Cannot reach the server to read database size.' }; }
  finally { ui.storageLoading = false; if (ui.page === 'settings') render(); }
}

function confirmDeleteMonth(ym) {
  const m = getM(S, ym, ui.cardId); if (!m) return;
  if (m.items.some((it) => it.plan)) { toast('Delete the linked installment plan first'); return; }
  const x = mtot(m);
  openModal('Delete ' + esc(ymLabel(ym)) + '?', '<p>This removes ' + m.items.length + (m.items.length === 1 ? ' item' : ' items') + ' totaling <b>' + money(x.total) + '</b> from this card and its saved daily recovery copies. This cannot be undone.</p><div class="err" id="monthDeleteErr" role="alert"></div><div class="row-act"><button class="counter-btn" data-confirm-month="' + esc(ym) + '" type="button">Delete month</button><button class="btn2" data-closem="1" type="button">Cancel</button></div>');
}

async function deleteMonth(ym, button) {
  const m = getM(S, ym, ui.cardId); if (!m) { closeModal(); render(); return; }
  button.disabled = true;
  const err = $('#monthDeleteErr');
  try {
    if (saving) while (saving) await new Promise((resolve) => setTimeout(resolve, 40));
    if (dirty) { clearTimeout(timer); await flush(); }
    if (dirty || conflict) { err.textContent = 'Your latest edits could not be saved. Resolve that first, then reload before deleting.'; return; }
    const data = structuredClone(S); data.months = data.months.filter((item) => !(item.ym === ym && (item.cardId || 'card-default') === ui.cardId));
    const r = await fetch('/api/month', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ym, cardId: ui.cardId, baseVersion: version, data }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || 'Could not delete this month.'; if (r.status === 409) conflict = true; return; }
    S = j.data; version = j.version; dirty = false; conflict = false; ui.storage = null; ui.ym = defaultYM(cardData(), curYM); closeModal(); render(); toast(ymLabel(ym) + ' deleted');
  } catch { err.textContent = 'Cannot reach the server. The month was not deleted.'; }
  finally { if ($('#monthDeleteErr')) button.disabled = false; }
}

function bannerHTML() {
  const b = ui.banner; if (!b) return '';
  if (b.kind === 'conflict') return '<div class="banner" role="alert"><span>This data was changed on another device. Reload to see the latest. Your last change was not saved.</span><button class="counter-btn" data-reload="1" type="button">Reload</button></div>';
  if (b.kind === 'offline') return '<div class="banner" role="alert"><span>You seem to be offline. Your changes are kept on this screen and will save when you are back online.</span></div>';
  return '<div class="banner" role="alert"><span>Your last change did not save. ' + esc(b.msg || '') + '</span><button class="counter-btn" data-reload="1" type="button">Reload</button></div>';
}

function render() {
  if (!S) return;
  const cur = ui.page === 'statements' ? 'month' : ui.page;
  document.querySelectorAll('.dl').forEach((b) => { if (b.dataset.go === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const picker = $('#cardSelect');
  if (picker) picker.innerHTML = activeCards().map((c) => '<option value="' + esc(c.id) + '"' + (c.id === ui.cardId ? ' selected' : '') + '>' + esc(c.name) + (c.bank ? ' · ' + esc(c.bank) : '') + '</option>').join('');
  const app = $('#app'); app.className = 'wrap' + (ui.anim ? ' anim' : ''); ui.anim = false;
  const back = '<div class="page-top">' + (ui.page === 'dashboard' ? '' : '<button class="btn2" data-back type="button">← Back</button>') + '<div><div class="sign">' + esc(activeCard().bank || 'Credit card') + '</div><h1>' + esc(activeCard().name) + '</h1></div></div>';
  app.innerHTML = bannerHTML() + back + (ui.page === 'month' ? pageMonth() : ui.page === 'people' ? pagePeople() : ui.page === 'statements' ? pageStatements() : ui.page === 'plans' ? pagePlans() : ui.page === 'settings' ? pageSettings() : pageDashboard());
  $('#dept').classList.toggle('open', ui.menu); $('#menuBtn').setAttribute('aria-expanded', ui.menu);
  $('#menuBackdrop').hidden = !ui.menu;
  if ($('#soaBody')) renderSOA();
  if (ui.page === 'settings' && !ui.storage && !ui.storageLoading) refreshStorage();
}
function go(p) { if (ui.page !== p) ui.previous = ui.page; ui.anim = true; ui.page = p; ui.sure = null; ui.menu = false; render(); window.scrollTo(0, 0); }

/* ---------- modals ---------- */
function openModal(title, body, cls) {
  $('#modal').innerHTML = '<div class="scrim"><div class="sheet' + (cls ? ' ' + cls : '') + '" role="dialog" aria-modal="true" aria-labelledby="mtitle"><div class="sheet-h"><h2 id="mtitle" style="margin:0">' + title + '</h2><button class="xb" data-closem="1" type="button" aria-label="Close">✕</button></div>' + body + '</div></div>';
  const f = $('#modal input:not([type=hidden]):not([type=checkbox]),#modal select'); if (f) f.focus();
}
function closeModal() { $('#modal').innerHTML = ''; ui.soa = null; }

/* a payer row: a real dropdown of people, plus "New person" */
function personOptions(sel) {
  const names = nameList(); const low = (sel || '').toLowerCase();
  if (sel && !names.some((n) => n.toLowerCase() === low)) names.push(sel);
  return '<option value=""' + (sel ? '' : ' selected') + ' disabled>Choose person</option>' + names.map((n) => '<option value="' + esc(n) + '"' + (sel && n.toLowerCase() === low ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '<option value="__new">+ New person…</option>';
}
function prow(p, a, rm) {
  return '<div class="prow"><select class="pn" aria-label="Payer">' + personOptions(p) + '</select><input class="pa" type="number" step="0.01" min="0" value="' + (a === '' ? '' : a) + '" placeholder="Share" aria-label="Share amount" inputmode="decimal"><button class="xb" data-rmrow="1" type="button" aria-label="Remove payer"' + (rm ? '' : ' style="visibility:hidden"') + '>✕</button><input class="pnew" hidden placeholder="New person\'s name" aria-label="New person name" autocomplete="off"></div>';
}
function readRows() {
  return [...document.querySelectorAll('#modal .prow')].map((r) => {
    const sel = r.querySelector('.pn').value;
    return { p: sel === '__new' ? r.querySelector('.pnew').value.trim() : sel, a: r.querySelector('.pa').value };
  });
}
function writeRows(rows) { $('#rows').innerHTML = rows.map((r) => prow(r.p, r.a, rows.length > 1)).join(''); updateAssigned(); }
function updateAssigned() {
  const el = $('#assigned'); if (!el) return;
  const tot = parseFloat($('#mt2').value) || 0; let sum = 0;
  readRows().forEach((r) => { sum += Math.round((parseFloat(r.a) || 0) * 100); });
  const diff = Math.round(tot * 100) - sum;
  el.textContent = 'Assigned ' + money(sum / 100) + ' of ' + money(r2(tot)) + (diff === 0 ? ' · matches' : diff > 0 ? ' · ' + money(diff / 100) + ' left to assign' : ' · ' + money(-diff / 100) + ' too much');
}
function openCharge(itemId, person) {
  const D = cardData(), f = itemId ? findItem(D, itemId) : null, ms = monthsDesc(D);
  if (!ms.length) { openMonth(curYM); return; }
  const ym = f ? f.m.ym : (D.months.some((m) => m.ym === ui.ym) ? ui.ym : ms[0].ym);
  const rows = f ? f.it.shares.map((s) => ({ p: s.p, a: s.a })) : [{ p: person || '', a: '' }];
  openModal(f ? 'Split or edit bill' : 'Add charge', '<form id="fcharge" data-item="' + (itemId || '') + '">' +
    '<div class="two-f"><label class="f">Month<select id="mm2"' + (f ? ' disabled' : '') + '>' + ms.map((m) => '<option value="' + m.ym + '"' + (m.ym === ym ? ' selected' : '') + '>' + esc(ymLabel(m.ym)) + '</option>').join('') + '</select></label>' +
    '<label class="f">Total bill (₱)<input id="mt2" type="number" step="0.01" min="0.01" required inputmode="decimal" value="' + (f ? f.it.a : '') + '"></label></div>' +
    '<label class="f">Product or place<input id="mp2" required autocomplete="off" value="' + esc(f ? f.it.d : '') + '" placeholder="Example: Dinner at Rustica"><span class="help">What was bought.</span></label>' +
    '<div><div style="font-weight:600;margin-bottom:6px">Who pays</div><div id="rows">' + rows.map((r) => prow(r.p, r.a, rows.length > 1)).join('') + '</div><div class="row-act"><button class="btn2" data-addrow="1" type="button">Add payer</button><button class="btn2" data-equal="1" type="button">Split equally</button></div><div class="help" id="assigned" style="margin-top:8px" aria-live="polite"></div><div class="help">One payer pays the whole bill. For a shared bill, add each person and press Split equally, or type each share.</div></div>' +
    '<div class="err" id="err" role="alert"></div><div class="row-act"><button class="counter-btn" type="submit">' + (f ? 'Save bill' : 'Add to card') + '</button><button class="btn2" data-closem="1" type="button">Cancel</button></div></form>');
  updateAssigned();
}
function openPlan() {
  const ym = addM(curYM, 1);
  openModal('New installment', '<form id="fplan"><label class="f">Product<input id="pp" required autocomplete="off" placeholder="Example: Washing machine"></label>' +
    '<fieldset class="chips"><legend>Who pays</legend>' + nameList().map((n) => '<label class="chip"><input type="checkbox" name="payer" value="' + esc(n) + '">' + esc(n) + '</label>').join('') + '</fieldset>' +
    '<label class="f">Someone new (optional)<input id="pnewp" autocomplete="off" placeholder="Type a name"><span class="help">Each month is split equally between everyone chosen.</span></label>' +
    '<div class="two-f"><label class="f">Total price (₱)<input id="ptot" type="number" step="0.01" min="0.01" required inputmode="decimal"></label><label class="f">Number of months<input id="pn" type="number" min="2" max="60" step="1" value="12" required></label>' +
    '<label class="f">First payment month<input id="pst" type="month" value="' + ym + '" required></label><label class="f">Due day<input id="pday" type="number" min="1" max="28" value="5" required><span class="help">Day of the month, 1 to 28.</span></label></div>' +
    '<div class="prev" id="prev" aria-live="polite">Fill in the price and months to see the plan.</div><div class="err" id="err" role="alert"></div><div class="row-act"><button class="counter-btn" type="submit">Create plan</button><button class="btn2" data-closem="1" type="button">Cancel</button></div></form>');
}
function updatePlanPrev() {
  const el = $('#prev'); if (!el) return;
  const t = parseFloat($('#ptot').value), n = parseInt($('#pn').value, 10), st = $('#pst').value;
  if (!(t > 0) || !(n >= 2) || !st) { el.textContent = 'Fill in the price and months to see the plan.'; return; }
  const a = planAmounts(t, n), end = addM(st, n - 1);
  el.innerHTML = '<b>' + money(a.each) + '</b> a month for ' + n + ' months' + (a.last !== a.each ? ', with a last payment of <b>' + money(a.last) + '</b> so the total is exact' : '') + '.<br>From ' + esc(ymLabel(st)) + ' to ' + esc(ymLabel(end)) + '. Total ' + money(r2(t)) + '.';
}
function openMonth(ym) {
  openModal('New month', '<form id="fmonth"><label class="f">Bill due date<input id="mdue" type="date" required value="' + (ym ? ym + '-01' : '') + '"><span class="help">The month is taken from this date.</span></label><div class="row-act"><button class="counter-btn" type="submit">Create month</button><button class="btn2" data-closem="1" type="button">Cancel</button></div></form>');
}
function openPerson() {
  openModal('Add person', '<form id="fperson"><label class="f">Name<input id="pname" required autocomplete="off"><span class="help">A card is made for this person. Add items to it afterward.</span></label><div class="row-act"><button class="counter-btn" type="submit">Create card</button><button class="btn2" data-closem="1" type="button">Cancel</button></div></form>');
}
function openCard() {
  openModal('Add bank card', '<form id="fcard"><label class="f">Card name<input id="cname" required maxlength="60" autocomplete="off" placeholder="Example: Travel card"></label><label class="f" style="margin-top:12px">Bank or issuer<input id="cbank" required maxlength="60" autocomplete="off" placeholder="Example: BPI"></label><div class="help" style="margin:12px 0">New card starts empty. Your existing bills and payments stay on your current card.</div><div class="err" id="err" role="alert"></div><div class="row-act"><button class="counter-btn" type="submit">Add card</button><button class="btn2" data-closem="1" type="button">Cancel</button></div></form>');
}

function confirmDeleteCard(cardId) {
  const card = S.cards.find((c) => c.id === cardId && !c.archived);
  if (!card) return;
  if (activeCards().length <= 1) { toast('At least one card must remain active'); return; }
  const monthCount = S.months.filter((m) => (m.cardId || 'card-default') === cardId).length;
  const planCount = S.plans.filter((p) => p.cardId === cardId).length;
  openModal('Remove ' + esc(card.name) + '?', '<p class="card-remove-copy">This hides the card from the selector. <b>No data will be deleted.</b> Its ' + monthCount + ' month record' + (monthCount === 1 ? '' : 's') + ' and ' + planCount + ' installment plan' + (planCount === 1 ? '' : 's') + ' will be preserved and the card can be restored in Settings.</p><div class="row-act card-remove-actions"><button class="counter-btn" data-confirm-card="' + esc(cardId) + '" type="button">Remove card</button><button class="btn2" data-closem="1" type="button">Cancel</button></div>');
}

function removeCard(cardId) {
  if (activeCards().length <= 1) { closeModal(); toast('At least one card must remain active'); return; }
  const card = S.cards.find((c) => c.id === cardId && !c.archived);
  if (!card) { closeModal(); return; }
  card.archived = true;
  if (ui.cardId === cardId) {
    ui.cardId = activeCards()[0].id;
    localStorage.setItem('cc-card-' + location.host, ui.cardId);
    ui.ym = ui.pm = defaultYM(cardData(), curYM);
  }
  ui.storage = null; closeModal(); save(); render(); toast('Card removed; all records were preserved');
}

/* statement of account for one person (the SOA button on a card) */
function openSOA(key) {
  const P = people().find((x) => x.key === key); if (!P) return;
  ui.soa = { key, ym: ui.pm !== 'all' && P.lines.some((l) => l.m.ym === ui.pm) ? ui.pm : null };
  openModal('Statement (SOA)', '<div id="soaBody"></div>', 'wide');
  renderSOA();
}
function soaStatement() {
  const P = people().find((x) => x.key === ui.soa.key); if (!P) return null;
  return { P, st: personStatement(S, P, ui.soa.ym) };
}
function renderSOA() {
  const body = $('#soaBody'); if (!body || !ui.soa) return;
  const x = soaStatement(); if (!x) { closeModal(); return; }
  const mons = [...new Set(x.P.lines.map((l) => l.m.ym))].sort().reverse();
  body.innerHTML = '<div class="soa"><label class="f" style="margin-bottom:14px">Show<select id="soaym"><option value="">All unpaid charges</option>' + mons.map((m) => '<option value="' + m + '"' + (ui.soa.ym === m ? ' selected' : '') + '>' + esc(ymLabel(m)) + ' bill</option>').join('') + '</select></label>' + receiptHTML(x.st) + '</div>' +
    '<div class="row-act soa-act"><button class="btn2" data-soacopy="1" type="button">Copy as text</button>' + (x.st.owe > 0.005 ? '<button class="plaque" data-soapaid="1" type="button">Mark all paid</button>' : '') + '<button class="btn2" data-closem="1" type="button">Close</button></div>';
}
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 1800); }
function copyText(t) {
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ } ta.remove(); toast(ok ? 'Copied' : 'Copy did not work'); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('Copied'), fallback); else fallback();
}
function markPaid(lines) { lines.forEach((l) => { l.s.pd = l.s.a; }); save(); render(); }

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('scrim')) { closeModal(); return; }
  if (e.target.id === 'menuBtn') { ui.menu = !ui.menu; render(); return; }
  const t = e.target.closest('[data-menu-close],[data-go],[data-back],[data-month],[data-person],[data-act],[data-statements],[data-newym],[data-allpaid],[data-del],[data-split],[data-charge-for],[data-closem],[data-addrow],[data-rmrow],[data-equal],[data-copy],[data-delplan],[data-soa],[data-soacopy],[data-soapaid],[data-reload],[data-toggle-person],[data-toggle-plan],[data-storage-refresh],[data-delete-month],[data-confirm-month],[data-delete-person],[data-delete-card],[data-confirm-card],[data-restore-card]');
  if (!t) return; const d = t.dataset;
  if (d.menuClose !== undefined) { ui.menu = false; render(); return; }
  if (d.reload) { location.reload(); return; }
  if (d.togglePerson) { ui.openPeople.has(d.togglePerson) ? ui.openPeople.delete(d.togglePerson) : ui.openPeople.add(d.togglePerson); render(); return; }
  if (d.togglePlan) { ui.openPlans.has(d.togglePlan) ? ui.openPlans.delete(d.togglePlan) : ui.openPlans.add(d.togglePlan); render(); return; }
  if (d.storageRefresh !== undefined) { ui.storage = null; refreshStorage(); return; }
  if (d.deleteMonth) { confirmDeleteMonth(d.deleteMonth); return; }
  if (d.confirmMonth) { deleteMonth(d.confirmMonth, t); return; }
  if (d.deleteCard) { confirmDeleteCard(d.deleteCard); return; }
  if (d.confirmCard) { removeCard(d.confirmCard); return; }
  if (d.restoreCard) { const card = S.cards.find((c) => c.id === d.restoreCard && c.archived); if (card) { card.archived = false; save(); render(); toast('Card restored'); } return; }
  if (d.closem) { closeModal(); return; }
  if (d.go) { go(d.go); return; }
  if (d.back !== undefined) { go(ui.previous === ui.page ? 'dashboard' : ui.previous); return; }
  if (d.deletePerson) {
    const P = allPeople(S).find((x) => x.key === d.deletePerson);
    if (!P) return;
    if (ui.sure !== 'person:' + d.deletePerson) { ui.sure = 'person:' + d.deletePerson; render(); return; }
    P.lines.forEach((line) => { line.s.p = 'Former person'; });
    S.people = (S.people || []).filter((n) => n.trim().toLowerCase() !== d.deletePerson);
    ui.sure = null; save(); render(); toast('Person removed; transaction amounts and payment records were kept'); return;
  }
  if (d.month) { ui.ym = d.month; go('month'); return; }
  if (d.person) { e.preventDefault(); ui.q = d.person; ui.pm = 'all'; go('people'); return; }
  if (d.statements) { go('statements'); return; }
  if (d.newym) { openMonth(d.newym); return; }
  if (d.act === 'charge') { openCharge(); return; }
  if (d.act === 'plan') { openPlan(); return; }
  if (d.act === 'newmonth') { openMonth(); return; }
  if (d.act === 'person') { openPerson(); return; }
  if (d.act === 'addcard') { openCard(); return; }
  if (d.act === 'logout') { fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).finally(() => { S = null; showLogin(); }); return; }
  if (d.act === 'export') { const b = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'cc-tracker-backup-' + now.toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove(); return; }
  if (d.chargeFor) { openCharge(null, d.chargeFor); return; }
  if (d.split) { openCharge(d.split); return; }
  if (d.soa) { openSOA(d.soa); return; }
  if (d.soacopy) { const x = soaStatement(); if (x) copyText(receiptText(x.st)); return; }
  if (d.soapaid) { const x = soaStatement(); if (x) markPaid(x.st.groups.flatMap((g) => g.rows)); return; }
  if (d.allpaid) { const a = d.allpaid.split('|'), m = getM(S, a[0], ui.cardId); const lines = []; m.items.forEach((it) => it.shares.forEach((s) => { if (s.p.trim().toLowerCase() === a[1]) lines.push({ s }); })); markPaid(lines); return; }
  if (d.del) { const p = d.del.split('|'); if (ui.sure === d.del) { const f = findItem(S, p[0]); f.it.shares.splice(+p[1], 1); if (!f.it.shares.length) f.m.items.splice(f.j, 1); else f.it.a = sumShares(f.it); ui.sure = null; save(); } else ui.sure = d.del; render(); return; }
  if (d.delplan) {
    if (ui.sure === 'plan:' + d.delplan) { const id = d.delplan; S.plans = S.plans.filter((x) => x.id !== id); S.months.forEach((m) => { m.items = m.items.flatMap((it) => { if (!it.plan || it.plan.id !== id) return [it]; if (iPaid(it) < it.a - 0.005) return []; const historical = { ...it }; delete historical.plan; return [historical]; }); }); ui.sure = null; save(); } else ui.sure = 'plan:' + d.delplan;
    render(); return;
  }
  if (d.addrow) { const rows = readRows(); rows.push({ p: '', a: '' }); writeRows(rows); return; }
  if (d.rmrow) { const row = t.closest('.prow'), all = readRows(), idx = [...document.querySelectorAll('#modal .prow')].indexOf(row); all.splice(idx, 1); writeRows(all); return; }
  if (d.equal) {
    const rs = readRows().filter((r) => r.p), tot = parseFloat($('#mt2').value);
    if (!rs.length || !(tot > 0)) { $('#err').textContent = 'Enter the total bill and choose at least one person first.'; return; }
    $('#err').textContent = ''; writeRows(equalSplit(tot, rs.map((r) => r.p)).map((s) => ({ p: s.p, a: s.a }))); return;
  }
  if (d.copy) { const st = monthStatements(cardData(), ui.ym).find((x) => x.key === d.copy); if (st) copyText(receiptText(st)); return; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal').firstChild) { closeModal(); return; }
  if (e.key === 'Escape' && ui.menu) { ui.menu = false; render(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.click')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('pn')) { const nw = t.closest('.prow').querySelector('.pnew'); nw.hidden = t.value !== '__new'; if (!nw.hidden) nw.focus(); updateAssigned(); return; }
  if (t.id === 'soaym') { ui.soa.ym = t.value || null; renderSOA(); return; }
  if (t.dataset.tog) { const p = t.dataset.tog.split('|'), f = findItem(S, p[0]), s = f.it.shares[+p[1]]; s.pd = t.checked ? s.a : 0; save(); render(); return; }
  if (t.dataset.plantog) { const f = findItem(S, t.dataset.plantog); f.it.shares.forEach((s) => { s.pd = t.checked ? s.a : 0; }); save(); render(); return; }
  if (t.dataset.f) {
    const q = t.dataset.f.split('|'), g = findItem(S, q[1]), sh = g.it.shares[+q[2]];
    if (q[0] === 'a') { const v = r2(parseFloat(t.value)); if (!(v > 0)) { render(); return; } sh.a = v; if (sh.pd > v) sh.pd = v; g.it.a = sumShares(g.it); }
    else if (q[0] === 'd') { if (!t.value.trim()) { render(); return; } g.it.d = t.value.trim(); }
    else sh.n = t.value.trim();
    save(); render(); return;
  }
  if (t.id === 'cardSelect') { ui.cardId = t.value; localStorage.setItem('cc-card-' + location.host, ui.cardId); ui.ym = ui.pm = defaultYM(cardData(), curYM); ui.settingsYear = null; ui.storage = null; render(); return; }
  if (t.id === 'planOrder') { ui.planOrder = t.value; render(); return; }
  if (t.id === 'settingsYear') { ui.settingsYear = t.value; render(); return; }
  if (t.id === 'yy' || t.id === 'mm') { ui.ym = $('#yy').value + '-' + $('#mm').value; render(); return; }
  if (t.id === 'pm') { ui.pm = t.value; render(); return; }
  if (t.id === 'onlyowing') { ui.onlyOwing = t.checked; render(); return; }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { ui.q = t.value; const pos = t.selectionStart; render(); const q = $('#q'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } return; }
  if (t.id === 'mt2' || t.classList.contains('pa') || t.classList.contains('pnew')) updateAssigned();
  if (t.id === 'ptot' || t.id === 'pn' || t.id === 'pst') updatePlanPrev();
});
document.addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target, err = $('#err');
  if (f.id === 'loginForm') {
    const pw = $('#pw').value; $('#loginErr').textContent = '';
    fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      .then(async (r) => { if (r.ok) { if (S) { $('#login').hidden = true; $('#shell').hidden = false; if (dirty) flush(); render(); } else boot(); } else { const j = await r.json().catch(() => ({})); $('#loginErr').textContent = j.error || 'Could not sign in.'; } })
      .catch(() => { $('#loginErr').textContent = 'Cannot reach the server.'; });
    return;
  }
  if (f.id === 'fpassword') {
    const currentPassword = f.elements.currentPassword.value, newPassword = f.elements.newPassword.value;
    const confirmPassword = f.elements.confirmPassword.value, err = $('#passwordErr');
    err.textContent = '';
    if (newPassword !== confirmPassword) { err.textContent = 'The new passwords do not match.'; return; }
    if (newPassword.length < 8) { err.textContent = 'The new password must be at least 8 characters.'; return; }
    const button = f.querySelector('button[type="submit"]'); button.disabled = true;
    fetch('/api/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = j.error || 'Could not update the password.'; return; }
        f.reset(); toast('Password updated');
      })
      .catch(() => { err.textContent = 'Cannot reach the server. Try again.'; })
      .finally(() => { button.disabled = false; });
    return;
  }
  if (f.id === 'fcharge') {
    const tot = r2(parseFloat($('#mt2').value)), d = $('#mp2').value.trim(), rows = readRows().filter((r) => r.p || r.a !== ''), itemId = f.dataset.item;
    if (!d || !(tot > 0)) { err.textContent = 'Enter a product and a total bill.'; return; }
    if (!rows.length || rows.some((r) => !r.p)) { err.textContent = 'Choose a person for every row.'; return; }
    const seen = {}; for (const r of rows) { const k = r.p.toLowerCase(); if (seen[k]) { err.textContent = r.p + ' is listed twice. Combine their shares into one row.'; return; } seen[k] = 1; }
    let shares;
    if (rows.length === 1) shares = [{ p: rows[0].p, a: tot, pd: 0, n: '' }];
    else {
      let sum = 0; shares = rows.map((r) => { const a = r2(parseFloat(r.a) || 0); sum += Math.round(a * 100); return { p: r.p, a, pd: 0, n: '' }; });
      if (Math.abs(sum - Math.round(tot * 100)) > 0) { err.textContent = 'The shares add up to ' + money(sum / 100) + ' but the bill is ' + money(tot) + '. Press Split equally or fix the amounts.'; return; }
      if (shares.some((s) => !(s.a > 0))) { err.textContent = 'Every share must be more than zero.'; return; }
    }
    if (itemId) {
      const fi = findItem(S, itemId);
      shares.forEach((s) => { const old = fi.it.shares.find((o) => o.p.trim().toLowerCase() === s.p.toLowerCase()); if (old) { s.pd = Math.min(old.pd || 0, s.a); s.n = old.n || ''; } });
      fi.it.d = d; fi.it.a = tot; fi.it.shares = shares;
    } else { getM(S, $('#mm2').value, ui.cardId).items.push({ id: uid(), d, a: tot, shares }); }
    save(); closeModal(); render(); return;
  }
  if (f.id === 'fplan') {
    const name = $('#pp').value.trim(), total = r2(parseFloat($('#ptot').value)), n = parseInt($('#pn').value, 10), st = $('#pst').value, day = parseInt($('#pday').value, 10);
    const payers = [...document.querySelectorAll('#modal input[name=payer]:checked')].map((x) => x.value);
    $('#pnewp').value.split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => { if (!payers.some((p) => p.toLowerCase() === x.toLowerCase())) payers.push(x); });
    if (!name || !payers.length || !(total > 0) || !(n >= 2 && n <= 60) || !st || !(day >= 1 && day <= 28)) { err.textContent = 'Check every field. Choose who pays. Months must be from 2 to 60 and the due day from 1 to 28.'; return; }
    const plan = { id: 'p' + uid(), name, payers, total, months: n, start: st, day, skip: null, gen: true, cardId: ui.cardId };
    S.plans.push(plan); generatePlan(S, plan); save(); closeModal(); ui.page = 'plans'; ui.anim = true; render(); toast('Installment plan created'); return;
  }
  if (f.id === 'fmonth') { const due = $('#mdue').value; if (!due) return; const mo = ensureMonth(S, due.slice(0, 7), 1, ui.cardId); mo.due = due; ui.ym = mo.ym; save(); closeModal(); go('month'); return; }
  if (f.id === 'fperson') { const nm = $('#pname').value.trim(); if (!nm) return; S.people.push(nm); save(); closeModal(); ui.q = nm; ui.pm = 'all'; render(); }
  if (f.id === 'fcard') { const name = $('#cname').value.trim(), bank = $('#cbank').value.trim(); if (!name || !bank) return; const id = 'card-' + uid(); S.cards.push({ id, name, bank }); ui.cardId = id; localStorage.setItem('cc-card-' + location.host, id); save(); closeModal(); ui.ym = ui.pm = defaultYM(cardData(), curYM); render(); toast('Card added'); return; }
});

boot();
