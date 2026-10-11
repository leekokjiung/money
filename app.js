/* Money: personal tracker web app. Talks to the Google Apps Script backend (see backend/Code.gs). */
'use strict';

/* ---------------- State ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('money.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('money.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
let conn = LS.get('conn', null);              // { url, key }
let D = LS.get('cache', null) || empty();     // last loaded data
let tab = LS.get('tab', 'records');
let recMode = 'list';                          // list | calendar
let statMode = 'expense';                      // expense | income | budget
let cur = new Date(); cur.setDate(1);
let selDay = null;
let search = '';

function empty() {
  return { settings: { currency: 'RM', rates: {} }, txns: [], accounts: [], categories: [], budgets: [], rules: [] };
}

const TABS = [
  ['records', '📒', 'Records'],
  ['stats', '📊', 'Stats'],
  ['accounts', '🏦', 'Accounts'],
  ['settings', '⚙️', 'Settings'],
];
const PALETTE = ['#10a873', '#f2b324', '#3b82f6', '#e0543f', '#8b5cf6', '#14b8a6', '#f97316', '#ec4899', '#64748b', '#84cc16', '#06b6d4', '#a16207'];

/* ---------------- Backend ---------------- */
async function api(action, payload = {}) {
  if (!conn) throw new Error('Not connected');
  // text/plain keeps this a "simple" request, so the browser doesn't need a CORS preflight.
  const res = await fetch(conn.url, { method: 'POST', body: JSON.stringify(Object.assign({ key: conn.key, action }, payload)) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'Something went wrong');
  return out.data;
}
async function apiSafe(action, payload) {
  try { return await api(action, payload); } catch (e) { toast(e.message === 'Failed to fetch' ? 'No connection. Try again.' : e.message); throw e; }
}
async function load(quiet) {
  try {
    const d = await api('load');
    d.txns.forEach(t => { t.amount = Number(t.amount) || 0; t.ts = Number(t.ts) || 0; });
    D = d; LS.set('cache', D); render();
    if (!quiet) toast('Up to date');
  } catch (e) {
    if (!quiet) toast(e.message === 'Failed to fetch' ? 'Offline: showing saved data' : e.message);
    render();
  }
}

/* ---------------- Helpers ---------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monthKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
const base = () => D.settings.currency || 'RM';
const fmt = (n, c) => (c || base()) + ' ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = n => Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 });
/** Amount in the main currency (uses Settings > Currency rates for anything else). */
const conv = t => t.currency && t.currency !== base() ? t.amount * (Number((D.settings.rates || {})[t.currency]) || 1) : t.amount;
const catOf = name => D.categories.find(c => c.name === name);
const catIcon = name => (catOf(name) || {}).icon || (name ? '📦' : '🔁');
const catColor = name => { const i = D.categories.findIndex(c => c.name === name); return PALETTE[(i < 0 ? 8 : i) % PALETTE.length]; };
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 2600); }
const inMonth = (d = cur) => { const k = monthKey(d); return D.txns.filter(t => String(t.date).slice(0, 7) === k); };
function totals(list) {
  let inc = 0, exp = 0;
  list.forEach(t => { if (t.type === 'income') inc += conv(t); else if (t.type === 'expense') exp += conv(t); });
  return { inc, exp, net: inc - exp };
}
const byNewest = (a, b) => (b.date + (b.time || '') + b.ts).localeCompare(a.date + (a.time || '') + a.ts);
const reviewList = () => D.txns.filter(t => t.status === 'review').sort(byNewest);
function shiftMonth(n) { cur.setMonth(cur.getMonth() + n); selDay = null; render(); }
function go(t) { tab = t; LS.set('tab', t); render(); window.scrollTo(0, 0); }

/* ---------------- Render shell ---------------- */
function render() {
  if (!conn) return renderSetup();
  document.body.classList.remove('no-conn');
  const navHtml = TABS.map(([k, i, l]) => `<button class="${tab === k ? 'on' : ''}" onclick="go('${k}')"><span class="ti">${i}</span>${l}</button>`).join('');
  $('nav').innerHTML = navHtml;
  $('tabbar').innerHTML = navHtml;
  $('fab').style.display = tab === 'records' || tab === 'stats' ? '' : 'none';
  ({ records: renderRecords, stats: renderStats, accounts: renderAccounts, settings: renderSettings })[tab]();
}

function monthHeader(withSummary) {
  const t = totals(inMonth());
  return `<div class="month">
      <button class="icon-btn" onclick="shiftMonth(-1)" aria-label="Previous month">‹</button>
      <h1>${cur.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h1>
      <button class="icon-btn" onclick="shiftMonth(1)" aria-label="Next month">›</button></div>
    ${withSummary ? `<div class="summary">
      <div><small>Income</small><b class="inc num">${fmt(t.inc)}</b></div>
      <div><small>Expense</small><b class="exp num">${fmt(t.exp)}</b></div>
      <div><small>Balance</small><b class="num">${fmt(t.net)}</b></div></div>` : ''}`;
}

/* ---------------- Records ---------------- */
function txnRow(t) {
  const cls = t.type === 'income' ? 'inc' : t.type === 'expense' ? 'exp' : 'xfer';
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const title = t.type === 'transfer' ? `${t.account} → ${t.toAccount}` : (t.category || 'Uncategorised');
  const sub = [t.time, t.note, t.type === 'transfer' ? '' : t.account].filter(Boolean).join(' · ');
  const badge = t.status === 'review' ? '<span class="badge review">Check</span>'
    : (['Apple Pay', 'Email', 'SMS'].includes(t.source) ? `<span class="badge src">${esc(t.source)}</span>` : '');
  return `<div class="row" onclick="openTxn('${esc(t.id)}')">
    <div class="ico">${esc(catIcon(t.category))}</div>
    <div class="grow"><div>${esc(title)}${badge}</div><div class="sub">${esc(sub)}</div></div>
    <div class="amt ${cls}">${sign}${fmt(t.amount, t.currency || base())}</div></div>`;
}
function dayCards(list) {
  const byDay = {};
  list.forEach(t => (byDay[t.date] = byDay[t.date] || []).push(t));
  return Object.keys(byDay).sort().reverse().map(d => {
    const tt = totals(byDay[d]);
    const label = new Date(d + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `<div class="card"><div class="day-head"><span>${label}</span><span class="num">${tt.inc ? '<span class="inc">+' + fmt(tt.inc) + '</span> ' : ''}${tt.exp ? '<span class="exp">−' + fmt(tt.exp) + '</span>' : ''}</span></div>
      ${byDay[d].sort(byNewest).map(txnRow).join('')}</div>`;
  }).join('');
}
function renderRecords() {
  $('hdr').innerHTML = monthHeader(true);
  const rv = reviewList();
  const banner = rv.length ? `<div class="banner" onclick="openReview()"><span style="font-size:24px">✨</span>
    <div class="grow"><b>${rv.length} new payment${rv.length > 1 ? 's' : ''} auto-added</b><span class="sub">Tap to check the categories</span></div><span>›</span></div>` : '';
  $('view').innerHTML = `${banner}
    <div class="seg"><button class="${recMode === 'list' ? 'on' : ''}" onclick="recMode='list';render()">Daily</button>
      <button class="${recMode === 'calendar' ? 'on' : ''}" onclick="recMode='calendar';render()">Calendar</button></div>
    ${recMode === 'list'
      ? `<input class="search" type="search" placeholder="Search" value="${esc(search)}" oninput="search=this.value;drawList()"><div id="recList"></div>`
      : `<div id="calWrap"></div>`}`;
  recMode === 'list' ? drawList() : drawCalendar();
}
function drawList() {
  const q = search.trim().toLowerCase();
  const list = (q ? D.txns : inMonth()).filter(t => !q || [t.note, t.category, t.account, t.merchant, t.toAccount, t.amount].join(' ').toLowerCase().includes(q));
  $('recList').innerHTML = list.length ? dayCards(list)
    : `<div class="empty"><span class="big-ico">🌱</span>${q ? 'Nothing matches your search.' : 'No records this month yet.<br>Tap + to add one, or just pay. Auto-tracking will add it.'}</div>`;
}
function drawCalendar() {
  const first = new Date(cur), daysIn = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // Monday first
  const byDay = {};
  inMonth().forEach(t => (byDay[t.date] = byDay[t.date] || []).push(t));
  const today = isoDate(new Date());
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < offset; i++) cells += '<div class="d out"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const key = monthKey(cur) + '-' + pad(d), tt = totals(byDay[key] || []);
    cells += `<div class="d ${key === today ? 'today' : ''} ${key === selDay ? 'sel' : ''}" onclick="selDay='${key}';drawCalendar()">
      <span class="n">${d}</span>${tt.inc ? `<span class="inc num">${fmt0(tt.inc)}</span>` : ''}${tt.exp ? `<span class="exp num">${fmt0(tt.exp)}</span>` : ''}</div>`;
  }
  const dayList = selDay && byDay[selDay] ? dayCards(byDay[selDay]) : selDay ? '<div class="empty">No records on this day.</div>' : '<p class="sub" style="text-align:center">Tap a day to see its records.</p>';
  $('calWrap').innerHTML = `<div class="cal">${cells}</div>${dayList}`;
}

/* ---------------- Review auto-added ---------------- */
function openReview() {
  const rv = reviewList();
  if (!rv.length) { closeSheet(); render(); return; }
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Check auto-added</h3><span style="width:38px"></span></div>
    <p class="sub">These came in automatically. Fix anything that's wrong, or tap ✓ if it's right.</p>
    <div class="card">${rv.map(t => `<div class="row" style="cursor:default">
      <div class="ico" onclick="openTxn('${esc(t.id)}')" style="cursor:pointer">${esc(catIcon(t.category))}</div>
      <div class="grow" onclick="openTxn('${esc(t.id)}')" style="cursor:pointer"><div>${esc(t.merchant || t.note || t.category)}</div>
        <div class="sub">${esc([t.date.slice(5), t.time, t.category, t.account, t.source].filter(Boolean).join(' · '))}</div></div>
      <div class="amt ${t.type === 'income' ? 'inc' : 'exp'}">${fmt(t.amount, t.currency || base())}</div>
      <button class="icon-btn" title="Looks right" onclick="okReview(['${esc(t.id)}'])">✓</button></div>`).join('')}</div>
    <button class="btn" onclick="okReview(reviewList().map(t=>t.id))">All look right</button>`;
  $('modal').className = 'open';
}
async function okReview(ids) {
  ids.forEach(id => { const t = D.txns.find(x => x.id === id); if (t) t.status = 'ok'; });
  LS.set('cache', D);
  openReview();
  await apiSafe('markReviewed', { ids });
}

/* ---------------- Add / edit ---------------- */
let F = {};
function openTxn(id) {
  const t = id ? D.txns.find(x => x.id === id) : null;
  const now = new Date();
  F = t ? Object.assign({}, t) : { type: 'expense', date: isoDate(now), time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    account: (D.accounts[0] || {}).name || '', toAccount: '', category: '', note: '', amount: '' };
  const accOpts = sel => D.accounts.map(a => `<option ${a.name === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
    + (sel && !D.accounts.some(a => a.name === sel) ? `<option selected>${esc(sel)}</option>` : '');
  $('sheet').innerHTML = `
    <div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>${t ? 'Edit record' : 'New record'}</h3><span style="width:38px"></span></div>
    <div class="seg" id="typeSeg">${['expense', 'income', 'transfer'].map(k => `<button data-k="${k}" class="${k === F.type ? 'on' : ''}" onclick="setType('${k}')">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    <input id="fAmount" class="amount-in num" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${t ? t.amount : ''}" aria-label="Amount">
    ${t && t.currency && t.currency !== base() ? `<p class="sub" style="text-align:right;margin:4px 2px 0">in ${esc(t.currency)}</p>` : ''}
    <div id="catBlock"><label>Category</label><div class="chips" id="fCats"></div></div>
    <div class="grid2"><div><label id="accLabel">Account</label><select id="fAccount">${accOpts(F.account)}</select></div>
      <div id="toBlock"><label>To account</label><select id="fTo">${accOpts(F.toAccount)}</select></div></div>
    <div class="grid2"><div><label>Date</label><input id="fDate" type="date" value="${esc(F.date)}"></div>
      <div><label>Time</label><input id="fTime" type="time" value="${esc(F.time || '')}"></div></div>
    <label>Note</label><input id="fNote" value="${esc(F.note)}" placeholder="What was it for?">
    ${t && t.merchant && t.merchant !== t.note ? `<p class="sub">Merchant: ${esc(t.merchant)} · from ${esc(t.source)}</p>` : ''}
    <button class="btn" onclick="saveTxn()">Save</button>
    ${t && t.merchant ? `<button class="btn ghost" onclick="saveTxn(true)">Save and always use this category for “${esc(shortMerchant(t.merchant))}”</button>` : ''}
    ${t ? `<button class="btn danger" onclick="deleteTxn('${esc(t.id)}')">Delete</button>` : ''}`;
  setType(F.type);
  $('modal').className = 'open';
  if (!t) setTimeout(() => $('fAmount').focus(), 60);
}
const shortMerchant = m => String(m).toLowerCase().replace(/[^a-z0-9&' ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
function setType(k) {
  F.type = k;
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  $('catBlock').style.display = k === 'transfer' ? 'none' : '';
  $('toBlock').style.display = k === 'transfer' ? '' : 'none';
  $('accLabel').textContent = k === 'transfer' ? 'From account' : 'Account';
  const cats = D.categories.filter(c => c.type === k);
  if (!cats.some(c => c.name === F.category)) F.category = (cats[0] || {}).name || '';
  $('fCats').innerHTML = cats.map(c => `<button class="chip ${c.name === F.category ? 'on' : ''}" data-name="${esc(c.name)}" onclick="pickCat(this, this.dataset.name)">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
}
function pickCat(el, name) { F.category = name; document.querySelectorAll('#fCats .chip').forEach(c => c.classList.toggle('on', c === el)); }
async function saveTxn(learn) {
  const txn = Object.assign({}, F, {
    amount: parseFloat($('fAmount').value), date: $('fDate').value, time: $('fTime').value,
    account: $('fAccount').value, toAccount: $('fTo').value, note: $('fNote').value.trim(), status: 'ok',
  });
  if (!(txn.amount > 0)) return toast('Enter an amount');
  if (txn.type === 'transfer' && txn.account === txn.toAccount) return toast('Pick two different accounts');
  if (!txn.id) txn.source = 'Manual';
  closeSheet();
  const saved = await apiSafe('saveTxn', { txn });
  saved.amount = Number(saved.amount); saved.ts = Number(saved.ts);
  const i = D.txns.findIndex(x => x.id === saved.id);
  if (i >= 0) D.txns[i] = saved; else D.txns.push(saved);
  if (learn && saved.merchant) {
    const kw = shortMerchant(saved.merchant);
    D.rules = [{ keyword: kw, category: saved.category, account: '' }].concat(D.rules.filter(r => r.keyword !== kw));
    D.rules = await apiSafe('saveList', { list: 'rules', rows: D.rules });
    toast(`Saved. “${kw}” will be ${saved.category} from now on`);
  } else toast('Saved');
  LS.set('cache', D); render();
}
async function deleteTxn(id) {
  if (!confirm('Delete this record?')) return;
  closeSheet();
  await apiSafe('deleteTxn', { id });
  D.txns = D.txns.filter(x => x.id !== id); LS.set('cache', D); render(); toast('Deleted');
}
function closeSheet() { $('modal').className = ''; }

/* ---------------- Stats & budget ---------------- */
function renderStats() {
  $('hdr').innerHTML = monthHeader(false);
  const seg = `<div class="seg">${[['expense', 'Expense'], ['income', 'Income'], ['budget', 'Budget']].map(([k, l]) => `<button class="${statMode === k ? 'on' : ''}" onclick="statMode='${k}';render()">${l}</button>`).join('')}</div>`;
  if (statMode === 'budget') { $('view').innerHTML = seg + budgetHtml(); return; }
  const list = inMonth().filter(t => t.type === statMode);
  const total = list.reduce((s, t) => s + conv(t), 0);
  const byCat = {};
  list.forEach(t => byCat[t.category || 'Uncategorised'] = (byCat[t.category || 'Uncategorised'] || 0) + conv(t));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  let acc = 0;
  const stops = cats.map(([c, v]) => { const a = acc; acc += v / total * 100; return `${catColor(c)} ${a}% ${acc}%`; }).join(',');
  const months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(cur); d.setMonth(d.getMonth() - i); months.push(d); }
  const mv = months.map(d => inMonth(d).filter(t => t.type === statMode).reduce((s, t) => s + conv(t), 0));
  const mMax = Math.max(...mv, 1);
  const col = statMode === 'income' ? 'var(--inc)' : 'var(--exp)';
  $('view').innerHTML = seg + (cats.length ? `
    <div class="card"><div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${stops})"><span><span>Total<b class="num">${fmt(total)}</b></span></span></div>
    </div>
    ${cats.map(([c, v]) => `<div class="row" style="cursor:default"><span class="dot" style="background:${catColor(c)}"></span>
      <div class="grow"><div>${esc(catIcon(c))} ${esc(c)} <span class="sub">${Math.round(v / total * 100)}%</span></div></div>
      <div class="amt num">${fmt(v)}</div></div>`).join('')}</div>`
    : `<div class="empty"><span class="big-ico">📊</span>No ${statMode} this month yet.</div>`) + `
    <h2>Last 6 months</h2>
    <div class="card"><div class="cols">${months.map((d, i) => `<div><em class="num">${mv[i] ? fmt0(mv[i]) : ''}</em>
      <i class="${i === 5 ? 'cur' : ''}" style="height:${mv[i] / mMax * 100}%;background:${col}"></i>
      <small>${d.toLocaleDateString('en-GB', { month: 'short' })}</small></div>`).join('')}</div></div>`;
}
function budgetHtml() {
  const spent = {};
  inMonth().filter(t => t.type === 'expense').forEach(t => spent[t.category] = (spent[t.category] || 0) + conv(t));
  const bs = D.budgets.filter(b => Number(b.monthlyLimit) > 0);
  if (!bs.length) return `<div class="empty"><span class="big-ico">🎯</span>No budgets yet.<br>Set a monthly limit per category to see how you're doing.</div>
    <button class="btn" onclick="openList('budgets')">Set budgets</button>`;
  const L = bs.reduce((s, b) => s + Number(b.monthlyLimit), 0), S = bs.reduce((s, b) => s + (spent[b.category] || 0), 0);
  const now = new Date(), isCur = monthKey(now) === monthKey(cur);
  const dayPct = isCur ? now.getDate() / new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate() : 1;
  const bar = (u, l) => { const p = l ? u / l : 0; return `<div class="bar"><i class="${p > 1 ? 'over' : p > .85 ? 'near' : ''}" style="width:${Math.min(p, 1) * 100}%"></i></div>`; };
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline"><b>This month</b><span class="amt num">${fmt(S)} <span class="sub">/ ${fmt(L)}</span></span></div>
      ${bar(S, L)}<div class="sub" style="margin-top:6px">${L - S >= 0 ? fmt(L - S) + ' left' : fmt(S - L) + ' over budget'}${isCur ? ` · ${Math.round(dayPct * 100)}% of the month gone` : ''}</div></div>
    <div class="card">${bs.map(b => { const u = spent[b.category] || 0, l = Number(b.monthlyLimit); return `<div style="padding:9px 0">
      <div style="display:flex;justify-content:space-between"><span>${esc(catIcon(b.category))} ${esc(b.category)}</span><span class="amt num ${u > l ? 'exp' : ''}">${fmt(u)} <span class="sub">/ ${fmt(l)}</span></span></div>${bar(u, l)}</div>`; }).join('')}</div>
    <button class="btn ghost" onclick="openList('budgets')">Edit budgets</button>`;
}

/* ---------------- Accounts ---------------- */
const rate = c => !c || c === base() ? 1 : (Number((D.settings.rates || {})[c]) || 1);
const accCurrency = n => ((D.accounts.find(a => a.name === n) || {}).currency) || base();
/** Record amount expressed in the account's own currency. */
const inAcc = (t, n) => (t.currency || base()) === accCurrency(n) ? t.amount : conv(t) / rate(accCurrency(n));
function balances() {
  const bal = {};
  D.accounts.forEach(a => bal[a.name] = Number(a.openingBalance) || 0);
  D.txns.forEach(t => {
    if (!t.account) return;
    if (!(t.account in bal)) bal[t.account] = 0;
    if (t.type === 'income') bal[t.account] += inAcc(t, t.account);
    else if (t.type === 'expense') bal[t.account] -= inAcc(t, t.account);
    else { bal[t.account] -= inAcc(t, t.account); if (t.toAccount) bal[t.toAccount] = (bal[t.toAccount] || 0) + inAcc(t, t.toAccount); }
  });
  return bal;
}
function renderAccounts() {
  $('hdr').innerHTML = '<div class="page-title">Accounts</div>';
  const bal = balances();
  const accCur = accCurrency;
  const toBase = n => conv({ amount: bal[n], currency: accCur(n) });
  const groups = {};
  D.accounts.forEach(a => (groups[a.group || 'Other'] = groups[a.group || 'Other'] || []).push(a.name));
  Object.keys(bal).filter(n => !D.accounts.some(a => a.name === n)).forEach(n => (groups.Other = groups.Other || []).push(n));
  const names = Object.keys(bal);
  const assets = names.filter(n => bal[n] > 0).reduce((s, n) => s + toBase(n), 0);
  const debts = names.filter(n => bal[n] < 0).reduce((s, n) => s + toBase(n), 0);
  $('view').innerHTML = `<div class="summary">
      <div><small>Assets</small><b class="inc num">${fmt(assets)}</b></div>
      <div><small>Liabilities</small><b class="exp num">${fmt(-debts)}</b></div>
      <div><small>Net worth</small><b class="num">${fmt(assets + debts)}</b></div></div>
    ${Object.entries(groups).map(([g, ns]) => `<h2>${esc(g)}</h2><div class="card">${ns.map(n => `<div class="row" data-name="${esc(n)}" onclick="search=this.dataset.name;recMode='list';go('records')">
      <div class="grow"><div>${esc(n)}</div></div><div class="amt num ${bal[n] < 0 ? 'exp' : ''}">${fmt(bal[n], accCur(n))}</div></div>`).join('')}</div>`).join('')}
    <button class="btn ghost" onclick="openList('accounts')">Edit accounts</button>
    <button class="btn ghost" onclick="openTxn();setTimeout(()=>setType('transfer'),0)">Transfer between accounts</button>`;
}

/* ---------------- Settings ---------------- */
function renderSettings() {
  $('hdr').innerHTML = '<div class="page-title">Settings</div>';
  const s = D.settings;
  const item = (i, label, sub, on) => `<div class="row" onclick="${on}"><div class="ico">${i}</div><div class="grow"><div>${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="sub">›</span></div>`;
  $('view').innerHTML = `
    <h2>Auto-tracking</h2><div class="card">
      ${item('📧', 'Bank email alerts', s.emailOn === false ? 'Off' : 'Checked every 5 minutes' + (s.lastEmailSync ? ' · last ' + new Date(s.lastEmailSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''), 'openEmail()')}
      ${item('🤖', 'Category rules', `${D.rules.length} rules · e.g. “grab” → Transport`, "openList('rules')")}
      ${item('🧾', 'Recent captures', 'See what was added or skipped, and why', 'openLog()')}
    </div>
    <h2>Lists</h2><div class="card">
      ${item('🏷️', 'Categories', D.categories.length + ' categories', "openList('categories')")}
      ${item('🏦', 'Accounts', 'Names, start balances, and how to match them to alerts', "openList('accounts')")}
      ${item('🎯', 'Budgets', D.budgets.length ? D.budgets.length + ' budgets' : 'Not set', "openList('budgets')")}
    </div>
    <h2>Data</h2><div class="card">
      ${item('💱', 'Currency', `Main: ${esc(base())}${Object.keys(s.rates || {}).length ? ' · rates for ' + Object.keys(s.rates).join(', ') : ''}`, 'openCurrency()')}
      ${item('📥', 'Import from Money Manager', 'Excel (.xls/.xlsx) or CSV export', "$('importFile').click()")}
      ${item('📤', 'Export all records', 'CSV file you can open in Excel', 'exportCsv()')}
      ${item('🔄', 'Refresh', D.txns.length + ' records', 'load()')}
    </div>
    <h2>This device</h2><div class="card">
      ${item('🔌', 'Connection', 'Backend link and secret key', 'openConn()')}
    </div>
    <input type="file" id="importFile" accept=".xls,.xlsx,.csv" style="display:none" onchange="importFile(this.files[0]);this.value=''">`;
}
function openConn() {
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Connection</h3><span style="width:38px"></span></div>
    <label>Backend link (ends in /exec)</label><input id="cUrl" value="${esc(conn.url)}">
    <label>Secret key</label><input id="cKey" value="${esc(conn.key)}" type="password">
    <button class="btn" onclick="saveConn($('cUrl').value,$('cKey').value)">Save and test</button>
    <button class="btn ghost" onclick="copySetupLink()">Copy setup link for another device</button>
    <p class="sub">Open that link once on your phone (or the Home Screen app) and it connects by itself. Keep it private: it contains your key.</p>
    <button class="btn danger" onclick="if(confirm('Disconnect this device? Your data stays in your Google Sheet.')){conn=null;LS.set('conn',null);LS.set('cache',null);D=empty();closeSheet();render()}">Disconnect this device</button>`;
  $('modal').className = 'open';
}
function openEmail() {
  const s = D.settings;
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Bank email alerts</h3><span style="width:38px"></span></div>
    <p class="sub">Your Google script checks Gmail every 5 minutes for bank alert emails and adds them as records to check.</p>
    <div class="seg"><button class="${s.emailOn !== false ? 'on' : ''}" onclick="D.settings.emailOn=true;openEmail()">On</button><button class="${s.emailOn === false ? 'on' : ''}" onclick="D.settings.emailOn=false;openEmail()">Off</button></div>
    <label>Which emails to read (Gmail search)</label><textarea id="eq" rows="4">${esc(s.emailQuery || '')}</textarea>
    <p class="sub">Add a bank's sender with <code>OR from:name</code>. Keep <code>newer_than:3d</code> at the start.</p>
    <button class="btn" onclick="saveEmail()">Save</button>
    <button class="btn ghost" onclick="syncNow()">Check email now</button>`;
  $('modal').className = 'open';
}
async function saveEmail() {
  D.settings = Object.assign(D.settings, await apiSafe('saveSettings', { settings: { emailOn: D.settings.emailOn !== false, emailQuery: $('eq').value.trim() } }));
  closeSheet(); render(); toast('Saved');
}
async function syncNow() {
  toast('Checking email…');
  const r = await apiSafe('syncEmail');
  await load(true);
  toast(r.added ? `Added ${r.added} new payment${r.added > 1 ? 's' : ''}` : `Checked ${r.checked} new email${r.checked === 1 ? '' : 's'}, nothing new to add`);
}
async function openLog() {
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Recent captures</h3><span style="width:38px"></span></div><div class="loading">Loading…</div>`;
  $('modal').className = 'open';
  const rows = await apiSafe('log');
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Recent captures</h3><span style="width:38px"></span></div>
    <p class="sub">If a payment was skipped by mistake, copy its text and send it to Claude in your Finance Tracker project so the reader can learn that format.</p>
    ${rows.length ? rows.map(r => `<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(r.source)}</b><span class="sub">${esc(new Date(r.time).toLocaleString())}</span></div>
      <div class="sub">${esc(r.result)}${r.subject ? ' · ' + esc(r.subject) : ''}</div><pre class="log">${esc(String(r.text).slice(0, 300))}</pre></div>`).join('')
    : '<div class="empty">Nothing captured yet.</div>'}`;
}
function openCurrency() {
  const s = D.settings, rates = Object.entries(s.rates || {});
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>Currency</h3><span style="width:38px"></span></div>
    <label>Main currency symbol</label><input id="cur0" value="${esc(base())}">
    <label>Other currencies (1 unit = how much in your main currency)</label>
    <div class="card list-edit" id="rates">${rates.map(([c, r]) => `<div class="row"><input value="${esc(c)}" style="width:90px;flex:none" class="rc"><input type="number" step="0.0001" value="${esc(r)}" class="rr"></div>`).join('')}
      <div class="row"><input placeholder="e.g. SGD" style="width:90px;flex:none" class="rc"><input type="number" step="0.0001" placeholder="3.30" class="rr"></div></div>
    <p class="sub">Used for totals and charts. Each record still keeps its own currency.</p>
    <button class="btn" onclick="saveCurrency()">Save</button>`;
  $('modal').className = 'open';
}
async function saveCurrency() {
  const rates = {};
  const cs = [...document.querySelectorAll('.rc')], rs = [...document.querySelectorAll('.rr')];
  cs.forEach((c, i) => { const k = c.value.trim().toUpperCase(), v = parseFloat(rs[i].value); if (k && v > 0) rates[k] = v; });
  D.settings = Object.assign(D.settings, await apiSafe('saveSettings', { settings: { currency: $('cur0').value.trim() || 'RM', rates } }));
  LS.set('cache', D); closeSheet(); render(); toast('Saved');
}

/* ---------------- Editable lists ---------------- */
const LISTS = {
  categories: { title: 'Categories', fields: [['icon', 'Icon', 'text', 54], ['name', 'Name', 'text'], ['type', 'Type', ['expense', 'income'], 104]], blank: { icon: '📦', name: '', type: 'expense' }, key: 'name' },
  accounts: { title: 'Accounts', help: '“Match” tells auto-tracking which account a payment belongs to. Put words from the alert or card, comma separated: the bank name and your card’s last 4 digits, e.g. <b>maybank, 1234</b>. Leave Currency empty for your main currency.',
    fields: [['name', 'Name', 'text'], ['group', 'Group', 'text', 84], ['openingBalance', 'Start', 'number', 84], ['currency', 'Cur.', 'text', 56], ['match', 'Match', 'text']], blank: { name: '', group: 'Bank', openingBalance: 0, currency: '', match: '' }, key: 'name' },
  budgets: { title: 'Monthly budgets', fields: [['category', 'Category', 'cats'], ['monthlyLimit', 'Limit', 'number', 110]], blank: { category: '', monthlyLimit: '' }, key: 'category' },
  rules: { title: 'Category rules', help: 'When an auto-added payment’s merchant contains the keyword, it gets this category (and account, if set). Top rule wins.',
    fields: [['keyword', 'Merchant contains', 'text'], ['category', 'Category', 'cats'], ['account', 'Account', 'accts']], blank: { keyword: '', category: '', account: '' }, key: 'keyword' },
};
let draft = [], listName = '';
function openList(name) { listName = name; draft = JSON.parse(JSON.stringify(D[name])); drawListEditor(); $('modal').className = 'open'; }
function drawListEditor() {
  const L = LISTS[listName];
  const input = (f, r, i) => {
    const [k, ph, kind, w] = f, v = r[k] == null ? '' : r[k];
    const st = w ? `style="width:${w}px;flex:none"` : '';
    const on = `onchange="draft[${i}]['${k}']=this.value"`;
    if (Array.isArray(kind)) return `<select ${st} ${on}>${kind.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    if (kind === 'cats' || kind === 'accts') {
      const opts = kind === 'cats' ? D.categories.filter(c => listName !== 'budgets' || c.type === 'expense').map(c => c.name) : D.accounts.map(a => a.name);
      return `<select ${st} ${on}><option value="">${kind === 'accts' ? '(auto)' : 'Pick…'}</option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    return `<input ${st} type="${kind}" ${kind === 'number' ? 'inputmode="decimal" step="0.01"' : ''} value="${esc(v)}" placeholder="${ph}" ${on}>`;
  };
  $('sheet').innerHTML = `<div class="sheet-top"><button class="icon-btn" onclick="closeSheet()">✕</button><h3>${L.title}</h3><span style="width:38px"></span></div>
    ${L.help ? `<p class="sub">${L.help}</p>` : ''}
    <div class="card list-edit" style="overflow-x:auto">${draft.map((r, i) => `<div class="row">${L.fields.map(f => input(f, r, i)).join('')}
      <button class="x" onclick="draft.splice(${i},1);drawListEditor()" aria-label="Remove">✕</button></div>`).join('') || '<div class="empty">Nothing here yet.</div>'}</div>
    <button class="btn ghost" onclick="draft.push(Object.assign({},LISTS[listName].blank));drawListEditor()">+ Add</button>
    <button class="btn" onclick="saveListEditor()">Save</button>`;
}
async function saveListEditor() {
  const L = LISTS[listName], rows = draft.filter(r => String(r[L.key] || '').trim());
  closeSheet();
  D[listName] = await apiSafe('saveList', { list: listName, rows });
  LS.set('cache', D); render(); toast('Saved');
}

/* ---------------- Import / export ---------------- */
function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
}
async function importFile(file) {
  if (!file) return;
  toast('Reading file…');
  try { if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); }
  catch (e) { return toast('Could not load the Excel reader. Check your connection.'); }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const txns = parseImport(rows);
  if (!txns.length) return toast('No records found in that file.');
  if (!confirm(`Import ${txns.length} records?`)) return;
  const newAccts = [...new Set(txns.flatMap(t => [t.account, t.toAccount]).filter(a => a && !D.accounts.some(x => x.name === a)))];
  const newCats = [];
  txns.forEach(t => { if (t.category && t.type !== 'transfer' && !D.categories.some(c => c.name === t.category && c.type === t.type) && !newCats.some(c => c.name === t.category && c.type === t.type)) newCats.push({ name: t.category, type: t.type, icon: '📦' }); });
  toast('Importing…');
  if (newAccts.length) D.accounts = await apiSafe('saveList', { list: 'accounts', rows: D.accounts.concat(newAccts.map(n => ({ name: n, group: 'Imported', openingBalance: 0, currency: '', match: '' }))) });
  if (newCats.length) D.categories = await apiSafe('saveList', { list: 'categories', rows: D.categories.concat(newCats) });
  for (let i = 0; i < txns.length; i += 400) await apiSafe('import', { txns: txns.slice(i, i + 400) });
  await load(true); toast(`Imported ${txns.length} records`);
}
/** Money Manager export (columns found by header name). Also reads this app's own CSV export. */
function parseImport(rows) {
  const hi = rows.findIndex(r => r.some(c => /^(date|period)/i.test(String(c).trim())));
  if (hi < 0) return [];
  const h = rows[hi].map(c => String(c).trim());
  const find = re => h.findIndex(c => re.test(c));
  const iDate = find(/^(date|period)/i), iTime = find(/^time$/i), iAcc = find(/^(accounts?|account)$/i), iCat = find(/^category$/i), iSub = find(/^subcategory$/i);
  const iNote = find(/^note$/i), iDesc = find(/^description$/i), iType = find(/income\/expense|^type$/i), iTo = find(/^toaccount$/i), iCur = find(/^currency$/i);
  let iAmt = find(/^amount$/i); if (iAmt < 0) iAmt = h.findIndex(c => /^[A-Z]{3}$/.test(c));
  const out = [];
  rows.slice(hi + 1).forEach(r => {
    const amount = Math.abs(parseFloat(String(r[iAmt]).replace(/[^\d.-]/g, '')));
    if (!(amount > 0)) return;
    const rawType = String(iType >= 0 ? r[iType] : '').toLowerCase();
    if (rawType.includes('transfer') && rawType.includes('in')) return; // the "out" row already covers this transfer
    const type = rawType.startsWith('inc') ? 'income' : rawType.includes('transfer') ? 'transfer' : 'expense';
    let d = r[iDate], time = '';
    if (d instanceof Date) { time = pad(d.getHours()) + ':' + pad(d.getMinutes()); d = isoDate(d); }
    else {
      const s = String(d).trim(), m = s.match(/(\d{1,2}:\d{2})/); if (m) time = m[1].padStart(5, '0');
      d = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : (() => { const p = new Date(s); return isNaN(p) ? isoDate(new Date()) : isoDate(p); })();
    }
    if (iTime >= 0 && r[iTime]) time = String(r[iTime]).slice(0, 5);
    if (time === '00:00') time = '';
    const cat = String(iCat >= 0 ? r[iCat] : '').trim();
    const c = iCur >= 0 ? String(r[iCur]).trim().toUpperCase() : '';
    out.push({ date: d, time, type, amount, currency: c && c !== 'MYR' && c !== base() ? c : '',
      account: String(iAcc >= 0 ? r[iAcc] : '').trim(),
      toAccount: type === 'transfer' ? String(iTo >= 0 ? r[iTo] : cat).trim() : '',
      category: type === 'transfer' ? '' : cat,
      note: [iNote >= 0 ? r[iNote] : '', iSub >= 0 ? r[iSub] : '', iDesc >= 0 ? r[iDesc] : ''].map(s => String(s).trim()).filter(Boolean).join(' · '),
      source: 'Import', status: 'ok' });
  });
  return out;
}
function exportCsv() {
  const cols = ['date', 'time', 'type', 'amount', 'currency', 'account', 'toAccount', 'category', 'note', 'merchant', 'source'];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [cols.join(',')].concat(D.txns.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(t => cols.map(c => q(t[c])).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = 'money-' + isoDate(new Date()) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- First-run setup ---------------- */
function renderSetup() {
  $('nav').innerHTML = ''; $('tabbar').innerHTML = ''; $('fab').style.display = 'none'; $('hdr').innerHTML = '';
  document.body.classList.add('no-conn');
  $('view').innerHTML = `<div class="setup"><img src="icons/icon-192.png" alt="">
    <h1 style="margin:14px 0 4px">Welcome to Money</h1>
    <p class="sub">Connect to your Google backend once on this device.</p>
    <div class="card">
      <label>Backend link (ends in /exec), or paste your setup link</label><input id="sUrl" placeholder="https://script.google.com/macros/s/…/exec">
      <label>Secret key (from the setup log)</label><input id="sKey" placeholder="32 letters and numbers">
      <button class="btn" onclick="saveConn($('sUrl').value,$('sKey').value)">Connect</button>
    </div></div>`;
}
function copySetupLink() {
  const link = location.origin + location.pathname + '#c=' + encodeURIComponent(btoa(conn.url + '|' + conn.key));
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Setup link copied'), () => prompt('Copy this link:', link));
}
async function saveConn(url, key) {
  url = String(url || '').trim(); key = String(key || '').trim();
  const link = url.match(/#c=([^&\s]+)/); // a pasted setup link carries both
  if (link) { try { [url, key] = atob(decodeURIComponent(link[1])).split('|'); } catch (e) { return toast('That setup link looks broken'); } }
  if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(url)) return toast('The link should end in /exec');
  if (!key) return toast('Enter your secret key');
  const prev = conn;
  conn = { url, key };
  try { await api('ping'); } catch (e) { conn = prev; return toast(e.message === 'Failed to fetch' ? 'Could not reach the backend. Check the link.' : e.message); }
  LS.set('conn', conn); closeSheet(); toast('Connected'); await load(true);
}

/* ---------------- Start ---------------- */
// One-tap setup link: …/#c=<base64 of "url|key">  (the part after # never leaves your device)
(function readSetupLink() {
  const m = location.hash.match(/[#&]c=([^&]+)/);
  if (!m) return;
  try { const [url, key] = atob(decodeURIComponent(m[1])).split('|'); if (url && key) { conn = { url, key }; LS.set('conn', conn); } } catch (e) { /* ignore bad link */ }
  history.replaceState(null, '', location.pathname);
})();
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && conn) load(true); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
if (conn) load(true);
