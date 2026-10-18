'use strict';
(() => {
  // Refuse to run inside a frame (clickjacking protection; GitHub Pages can't send frame headers).
  if (window.top !== window.self) { document.documentElement.textContent = ''; return; }

  // ---------- Constants ----------
  const LOCAL_KEY = 'holdings.v1';          // browser-only data (when not using Airtable)
  const PREF_KEY = 'holdings.prefs';        // non-sensitive preferences
  const VAULT_KEY = 'holdings.airtable.v1'; // encrypted Airtable credentials
  const AUTO_LOCK_MS = 15 * 60 * 1000;      // lock after 15 minutes of inactivity
  const PBKDF2_ITER = 600000;
  const MIN_PASS = 12;
  const AT_API = 'https://api.airtable.com/v0/';

  const CATS = {
    asset: ['Cash', 'Investments', 'Retirement', 'Real estate', 'Vehicles', 'Crypto', 'Collectibles', 'Other'],
    debt: ['Mortgage', 'Auto loan', 'Student loan', 'Credit card', 'Personal loan', 'Other']
  };
  const COLORS = ['#2f5d50', '#c8963e', '#5b7fa6', '#a65b7f', '#6e9c4f', '#8a6fbf', '#c46a4a', '#7a7a7a'];
  const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'INR'];

  // ---------- Helpers ----------
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  const sum = list => list.reduce((a, i) => a + (Number(i.value) || 0), 0);

  // Normalise any item (from a form, an import file, or Airtable) into a safe shape.
  function clean(raw) {
    const kind = raw && raw.kind === 'debt' ? 'debt' : 'asset';
    const value = Number(raw && raw.value);
    return {
      name: String((raw && raw.name) || '').trim().slice(0, 120) || 'Untitled',
      kind,
      category: String((raw && raw.category) || 'Other').trim().slice(0, 60) || 'Other',
      value: Number.isFinite(value) && value >= 0 ? Math.min(value, 1e12) : 0,
      accountType: String((raw && raw.accountType) || '').trim().slice(0, 80),
      fund: String((raw && raw.fund) || '').trim().slice(0, 120),
      owner: String((raw && raw.owner) || '').trim().slice(0, 80),
      note: String((raw && raw.note) || '').trim().slice(0, 300),
      ticker: TICKER_RE.test(String((raw && raw.ticker) || '').trim().toUpperCase()) ? String(raw.ticker).trim().toUpperCase() : '',
      shares: posOrNull(raw && raw.shares),
      price: posOrNull(raw && raw.price),
      pricedOn: /^\d{4}-\d{2}-\d{2}/.test(String((raw && raw.pricedOn) || '')) ? String(raw.pricedOn).slice(0, 10) : '',
      rate: rateOrNull(raw && raw.rate),
      monthly: posOrNull(raw && raw.monthly)
    };
  }
  const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
  function rateOrNull(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= -50 && n <= 50 ? n : null; }
  function posOrNull(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

  // Suggestions offered in the Account type / Owner inputs (you can still type anything).
  const ACCOUNT_TYPES = ['401(k)', 'Roth 401(k)', '403(b)', '457(b)', 'Traditional IRA', 'Roth IRA', 'SEP IRA', 'HSA', '529 plan',
    'Taxable brokerage', 'Checking', 'Savings', 'High-yield savings', 'CD', 'Money market', 'Pension', 'Crypto wallet',
    'Primary residence', 'Rental property', 'Mortgage', 'HELOC', 'Credit card', 'Auto loan', 'Student loan'];
  const OWNERS = ['Myself', 'Partner', 'Joint'];

  // ---------- Crypto (Web Crypto: PBKDF2-SHA256 → AES-256-GCM) ----------
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(obj, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, PBKDF2_ITER);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }
  async function unseal(box, pass) {
    const iter = Number(box.iter);
    if (box.v !== 1 || !Number.isInteger(iter) || iter < 100000) throw new Error('bad vault');
    const key = await deriveKey(pass, unb64(box.salt), iter);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(td.decode(pt));
  }

  // ---------- State ----------
  const oldLocal = parse(store.get(LOCAL_KEY));
  let prefs = parse(store.get(PREF_KEY)) || { currency: (oldLocal && oldLocal.currency) || 'USD' };
  if (!CURRENCIES.includes(prefs.currency)) prefs.currency = 'USD';
  let mode = parse(store.get(VAULT_KEY)) ? 'locked' : 'local'; // 'local' | 'locked' | 'airtable'
  let session = null; // { token, baseId, table } — kept in memory only while unlocked
  let items = mode === 'local' ? loadLocalItems() : [];
  let lastActivity = Date.now();
  let failedUnlocks = 0;

  function loadLocalItems() {
    const s = parse(store.get(LOCAL_KEY));
    return s && Array.isArray(s.items) ? s.items.map(i => ({ id: String(i.id || uid()), ...clean(i) })) : [];
  }
  function saveLocal() { store.set(LOCAL_KEY, JSON.stringify({ items })); }
  function savePrefs() { store.set(PREF_KEY, JSON.stringify(prefs)); }

  // ---------- Airtable client ----------
  const BASE_RE = /^app[A-Za-z0-9]{14}$/;
  const REC_RE = /^rec[A-Za-z0-9]{14}$/;
  const TOKEN_RE = /^pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{20,100}$/;
  let queue = Promise.resolve();

  const tablePath = s => `${s.baseId}/${encodeURIComponent(s.table)}`;

  // All requests are serialised (Airtable allows ~5 requests/second per base) and retried on 429.
  function at(path, opts = {}) {
    const run = async () => {
      const s = session;
      if (!s) throw new Error('Locked');
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(AT_API + path, {
          method: opts.method || 'GET',
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          headers: { 'Authorization': 'Bearer ' + s.token, 'Content-Type': 'application/json' },
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
        });
        if (res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
        if (!res.ok) {
          let detail = '';
          try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || j.error || ''; } catch (e) { }
          const hint = res.status === 401 ? ' (the token is invalid or revoked)'
            : res.status === 403 ? ' (the token lacks access to this base)'
              : res.status === 404 ? ' (base or table not found)'
                : res.status === 422 ? ' (check the table’s field names in the README)' : '';
          throw new Error(`Airtable error ${res.status}${hint}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
        }
        return res.status === 204 ? null : res.json();
      }
      throw new Error('Airtable is rate-limiting requests. Please try again in a minute.');
    };
    const p = queue.then(run, run);
    queue = p.catch(() => { });
    return p;
  }

  const fromRecord = r => ({
    id: r.id,
    ...clean({
      name: r.fields.Name, kind: /^debt$/i.test(String(r.fields.Kind || '')) ? 'debt' : 'asset',
      category: r.fields.Category, value: r.fields.Value, note: r.fields.Note,
      accountType: r.fields['Account type'], fund: r.fields.Fund, owner: r.fields.Owner,
      ticker: r.fields.Ticker, shares: r.fields.Shares, price: r.fields.Price, pricedOn: r.fields['Priced on'],
      rate: r.fields['Expected return %'], monthly: r.fields['Monthly contribution']
    })
  });
  const toFields = d => ({
    Name: d.name, Kind: d.kind === 'debt' ? 'Debt' : 'Asset', Category: d.category, Value: d.value, Note: d.note,
    'Account type': d.accountType, Fund: d.fund, Owner: d.owner, Ticker: d.ticker, Shares: d.shares,
    'Expected return %': d.rate, 'Monthly contribution': d.monthly
  });

  async function atLoadAll() {
    const out = []; let offset = '';
    for (let page = 0; page < 100; page++) {
      const q = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
      const j = await at(`${tablePath(session)}?${q}`);
      for (const r of j.records || []) if (REC_RE.test(r.id) && r.fields) out.push(fromRecord(r));
      if (!j.offset) break;
      offset = String(j.offset);
    }
    return out;
  }
  // ---------- Fund breakdown (written by the daily sync; the app only reads it) ----------
  const CLASSES = ['US stocks', 'International stocks', 'US bonds', 'International bonds', 'Cash', 'Real estate', 'Crypto', 'Other'];
  const CLASS_COLORS = ['#2f5d50', '#5b7fa6', '#c8963e', '#a6825b', '#6e9c4f', '#a65b7f', '#8a6fbf', '#7a7a7a'];
  const CATEGORY_CLASS = { 'Cash': 'Cash', 'Real estate': 'Real estate', 'Crypto': 'Crypto' };
  let breakdown = {};   // ticker -> { mix: {class: pct}, asOf, source }
  async function atLoadBreakdown() {
    const manual = {}, auto = {};
    let offset = '';
    for (let page = 0; page < 20; page++) {
      const q = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
      const j = await at(`${session.baseId}/${encodeURIComponent('Fund breakdown')}?${q}`);
      for (const r of j.records || []) {
        const f = r.fields || {};
        const t = String(f['Fund ticker'] || '').trim().toUpperCase(), c = f['Asset class'], w = Number(f['Weight %']);
        if (!TICKER_RE.test(t) || !CLASSES.includes(c) || !Number.isFinite(w) || w <= 0) continue;
        const bucket = String(f.Source || '').startsWith('Auto') ? auto : manual;
        const e = bucket[t] || (bucket[t] = { mix: {}, asOf: '', source: String(f.Source || '').slice(0, 80) });
        e.mix[c] = (e.mix[c] || 0) + w;
        const d = String(f['As of'] || '').slice(0, 10);
        if (d > e.asOf) e.asOf = d;
      }
      if (!j.offset) break;
      offset = String(j.offset);
    }
    const out = {};
    for (const [t, e] of Object.entries(auto)) out[t] = e;
    for (const [t, e] of Object.entries(manual)) {      // manual rows win; shortfall from 100% counts as Other
      const total = Object.values(e.mix).reduce((a, b) => a + b, 0);
      if (total < 100) e.mix.Other = (e.mix.Other || 0) + (100 - total);
      out[t] = e;
    }
    for (const e of Object.values(out)) {               // normalise to 100%
      const total = Object.values(e.mix).reduce((a, b) => a + b, 0);
      for (const c of Object.keys(e.mix)) e.mix[c] = e.mix[c] * 100 / total;
    }
    return out;
  }
  async function loadAirtable() {
    items = await atLoadAll();
    try { breakdown = await atLoadBreakdown(); }
    catch (x) { breakdown = {}; }                        // the table is optional; the app works without it
  }

  async function atCreateMany(list) {
    const created = [];
    for (let i = 0; i < list.length; i += 10) {
      const j = await at(tablePath(session), { method: 'POST', body: { records: list.slice(i, i + 10).map(d => ({ fields: toFields(d) })), typecast: true } });
      for (const r of j.records || []) created.push(fromRecord(r));
    }
    return created;
  }

  // ---------- Data operations (work in both modes) ----------
  async function addItem(d) {
    if (mode === 'airtable') items.push(...await atCreateMany([d]));
    else { items.push({ id: uid(), ...d }); saveLocal(); }
  }
  async function updateItem(id, d) {
    if (mode === 'airtable') {
      if (!REC_RE.test(id)) throw new Error('Invalid record');
      const r = await at(`${tablePath(session)}/${id}`, { method: 'PATCH', body: { fields: toFields(d), typecast: true } });
      const i = items.findIndex(x => x.id === id); if (i >= 0) items[i] = fromRecord(r);
    } else {
      const i = items.findIndex(x => x.id === id); if (i >= 0) items[i] = { id, ...d };
      saveLocal();
    }
  }
  async function removeItem(id) {
    if (mode === 'airtable') {
      if (!REC_RE.test(id)) throw new Error('Invalid record');
      await at(`${tablePath(session)}/${id}`, { method: 'DELETE' });
    }
    items = items.filter(x => x.id !== id);
    if (mode === 'local') saveLocal();
  }

  // ---------- Lock / unlock ----------
  function lock(reason) {
    if (mode !== 'airtable') return;
    session = null; items = []; breakdown = {}; mode = 'locked';
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    clearSecrets();
    render();
    if (reason) showBanner(reason, 'info');
  }
  function clearSecrets() { ['cToken', 'cPass', 'cPass2', 'uPass'].forEach(id => { $(id).value = ''; }); }

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
  setInterval(() => { if (mode === 'airtable' && Date.now() - lastActivity > AUTO_LOCK_MS) lock('Locked after 15 minutes of inactivity.'); }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mode === 'airtable' && Date.now() - lastActivity > AUTO_LOCK_MS) lock('Locked after 15 minutes of inactivity.');
  });

  // ---------- Rendering ----------
  const fmt = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: prefs.currency, maximumFractionDigits: 0 }).format(n);

  function showBanner(text, kind = 'err') {
    $('bannerText').textContent = text;
    $('banner').className = 'banner ' + kind;
    $('banner').hidden = false;
  }
  $('bannerClose').onclick = () => { $('banner').hidden = true; };

  function catsFor(kind, list) {
    const extra = [...new Set(list.map(i => i.category))].filter(c => !CATS[kind].includes(c));
    return [...CATS[kind].filter(c => c !== 'Other'), ...extra, 'Other'];
  }

  // Owner filter (kept in memory only, so no names are written to this device)
  let ownerView = '';
  const ownersInUse = () => [...new Set(items.map(i => i.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const visible = () => ownerView ? items.filter(i => i.owner === ownerView) : items;
  function renderOwnerFilter() {
    const sel = $('ownerFilter'), owners = ownersInUse();
    if (!owners.includes(ownerView)) ownerView = '';
    sel.textContent = '';
    sel.hidden = mode === 'locked' || owners.length === 0;
    if (sel.hidden) return;
    const all = document.createElement('option'); all.value = ''; all.textContent = 'Everyone'; sel.append(all);
    for (const o of owners) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; sel.append(opt); }
    sel.value = ownerView;
  }
  $('ownerFilter').onchange = () => { ownerView = $('ownerFilter').value; render(); };

  function fillDatalist(id, base, used) {
    const dl = $(id); dl.textContent = '';
    for (const v of [...new Set([...used, ...base])]) { const o = document.createElement('option'); o.value = v; dl.append(o); }
  }

  function metaLine(i) {
    const sh = i.ticker && i.shares ? `${i.ticker} · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(i.shares)} sh` : i.ticker;
    const priced = i.pricedOn ? `priced ${i.pricedOn}` : '';
    const bits = [i.accountType, i.fund, sh, i.owner, priced].filter(Boolean);
    return bits.length ? `<div class="meta">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : '';
  }

  function renderList(kind) {
    const el = $(kind === 'asset' ? 'assets' : 'debts');
    const list = visible().filter(i => i.kind === kind);
    if (!list.length) { el.innerHTML = `<div class="empty">No ${kind}s yet.</div>`; return; }
    el.innerHTML = catsFor(kind, list).map(cat => {
      const g = list.filter(i => i.category === cat);
      if (!g.length) return '';
      return `<div class="group"><div class="group-head"><span>${esc(cat)}</span><span class="amt">${esc(fmt(sum(g)))}</span></div>` +
        g.map(i => `<div class="row"><div><div class="name">${esc(i.name)}</div>${metaLine(i)}${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}</div>` +
          `<div class="amt">${esc(fmt(i.value))}</div><button class="icon-btn" type="button" data-edit="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">✎</button></div>`).join('') +
        `</div>`;
    }).join('');
  }

  function renderMix() {
    const el = $('assetMix'); el.textContent = '';
    const assets = visible().filter(i => i.kind === 'asset'), total = sum(assets);
    if (!total) return;
    const parts = catsFor('asset', assets).map((c, ix) => ({ c, v: sum(assets.filter(a => a.category === c)), col: COLORS[ix % COLORS.length] })).filter(p => p.v > 0);
    const bar = document.createElement('div'); bar.className = 'bar';
    const legend = document.createElement('div'); legend.className = 'legend';
    for (const p of parts) {
      const seg = document.createElement('div');
      seg.style.width = (p.v / total * 100) + '%'; seg.style.background = p.col; seg.title = p.c;
      bar.append(seg);
      const span = document.createElement('span'), dot = document.createElement('i');
      dot.style.background = p.col;
      span.append(dot, `${p.c} ${Math.round(p.v / total * 100)}%`);
      legend.append(span);
    }
    el.append(bar, legend);
  }

  function renderLookThrough() {
    const sec = $('mixSection'), bar = $('lookBar'), tbl = $('lookTable');
    bar.textContent = ''; tbl.textContent = '';
    const assets = visible().filter(i => i.kind === 'asset');
    const covered = assets.filter(i => i.ticker && breakdown[i.ticker]);
    if (mode === 'locked' || !covered.length) { sec.hidden = true; return; }
    const exp = Object.fromEntries(CLASSES.map(c => [c, 0]));
    for (const i of assets) {
      const mix = i.ticker && breakdown[i.ticker] ? breakdown[i.ticker].mix : { [CATEGORY_CLASS[i.category] || 'Other']: 100 };
      for (const [c, w] of Object.entries(mix)) exp[c] += (Number(i.value) || 0) * w / 100;
    }
    const total = Object.values(exp).reduce((a, b) => a + b, 0);
    if (!total) { sec.hidden = true; return; }
    const parts = CLASSES.map((c, ix) => ({ c, v: exp[c], col: CLASS_COLORS[ix] })).filter(p => p.v > 0.005);
    const b = document.createElement('div'); b.className = 'bar';
    for (const p of parts) {
      const seg = document.createElement('div'); seg.style.width = (p.v / total * 100) + '%'; seg.style.background = p.col; seg.title = p.c; b.append(seg);
      const row = document.createElement('div'); row.className = 'look-row';
      const dot = document.createElement('i'); dot.style.background = p.col;
      const name = document.createElement('span'); name.textContent = p.c;
      const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = fmt(p.v);
      const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = (p.v / total * 100).toFixed(1) + '%';
      row.append(dot, name, amt, pct); tbl.append(row);
    }
    bar.append(b);
    const dates = covered.map(i => breakdown[i.ticker].asOf).filter(Boolean).sort();
    $('mixHint').textContent = `Looks through ${covered.length} fund holding${covered.length === 1 ? '' : 's'}` + (dates.length ? ` · compositions as of ${dates[0]}${dates[0] !== dates[dates.length - 1] ? '–' + dates[dates.length - 1] : ''}` : '');
    sec.hidden = false;
  }

  // ---------- Projection ----------
  const GROWTH_CATS = ['Investments', 'Retirement', 'Crypto', 'Other'];
  const P = prefs.proj = Object.assign({ years: 20, ret: 6, infl: 2.5, real: false }, prefs.proj || {});
  const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  // Monthly compounding; contributions/payments at month end. Returns one point per year (0..years).
  function project(list, years, defaultRet, infl, real) {
    const state = list.map(i => {
      const isDebt = i.kind === 'debt';
      const rate = i.rate !== null && i.rate !== undefined ? i.rate : (isDebt ? 0 : (GROWTH_CATS.includes(i.category) ? defaultRet : 0));
      return { isDebt, b: Number(i.value) || 0, rm: Math.pow(1 + rate / 100, 1 / 12) - 1, c: Number(i.monthly) || 0 };
    });
    const start = state.reduce((a, s) => a + (s.isDebt ? -s.b : s.b), 0);
    const pts = []; let added = 0;
    for (let m = 0; m <= years * 12; m++) {
      if (m > 0) for (const s of state) {
        if (s.isDebt) { const owed = s.b * (1 + s.rm); const pay = Math.min(s.c, owed); s.b = owed - pay; added += pay; }
        else { s.b = s.b * (1 + s.rm) + s.c; added += s.c; }
      }
      if (m % 12 === 0) {
        const nw = state.reduce((a, s) => a + (s.isDebt ? -s.b : s.b), 0);
        const defl = real ? Math.pow(1 + infl / 100, m / 12) : 1;
        pts.push({ year: m / 12, nw: nw / defl, base: (start + added) / defl,
          assets: state.reduce((a, s) => a + (s.isDebt ? 0 : s.b), 0) / defl, debts: state.reduce((a, s) => a + (s.isDebt ? s.b : 0), 0) / defl });
      }
    }
    return pts;
  }

  const fmtShort = n => { const a = Math.abs(n), sgn = n < 0 ? '-' : '';
    const sym = fmt(0).replace(/[\d.,\s0]/g, '') || '';
    if (a >= 1e9) return sgn + sym + (a / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return sgn + sym + (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return sgn + sym + Math.round(a / 1e3) + 'K';
    return sgn + sym + Math.round(a); };

  const SVG = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => { const e = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.append(e); return e; };

  function niceStep(range) { const raw = range / 4, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / mag; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag; }

  function renderProjection() {
    const sec = $('projSection'), chart = $('projChart'), tip = $('projTip');
    [...chart.querySelectorAll('svg')].forEach(n => n.remove()); $('projTable').textContent = ''; $('projHeadline').textContent = '';
    const list = visible();
    if (mode === 'locked' || !list.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('pYears').value = P.years; $('pReturn').value = P.ret; $('pInfl').value = P.infl; $('pReal').checked = P.real;
    const pts = project(list, P.years, P.ret, P.infl, P.real);
    const end = pts[pts.length - 1];
    const growth = end.nw - end.base;
    const h = $('projHeadline'); h.textContent = '';
    const strong = document.createElement('strong'); strong.textContent = fmt(end.nw);
    h.append(`In ${P.years} year${P.years === 1 ? '' : 's'}: `, strong, ` net worth${P.real ? ' in today\u2019s dollars' : ''}, including ${fmt(growth)} of growth.`);

    // Chart geometry
    const W = Math.max(300, Math.round(chart.clientWidth || 640)), narrow = W < 520;
    const H = narrow ? 210 : 250, L = narrow ? 46 : 54, R = narrow ? 50 : 64, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const vals = pts.flatMap(p => [p.nw, p.base]);
    let lo = Math.min(0, ...vals), hi = Math.max(...vals); if (hi === lo) hi = lo + 1;
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = yr => L + (P.years ? yr / P.years : 0) * pw, y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Projected net worth over ${P.years} years; see the table below for values.` });
    for (let v = lo; v <= hi + step / 2; v += step) {
      el('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }, svg);
      const t = el('text', { class: 'axis-t', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg); t.textContent = fmtShort(v);
    }
    const xStep = P.years <= (narrow ? 6 : 10) ? 1 : P.years <= 20 ? 5 : 10;
    for (let yr = 0; yr <= P.years; yr += xStep) { const t = el('text', { class: 'axis-t', x: x(yr), y: H - 6, 'text-anchor': 'middle' }, svg); t.textContent = yr === 0 ? 'Now' : 'Y' + yr; }
    const path = key => pts.map((p, i) => (i ? 'L' : 'M') + x(p.year).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');
    el('path', { class: 'l-base', d: path('base') }, svg);
    el('path', { class: 'l-nw', d: path('nw') }, svg);
    // direct labels at line ends (nudged apart if they collide)
    let yN = y(end.nw), yB = y(end.base); if (Math.abs(yN - yB) < 14) { const mid = (yN + yB) / 2; yN = mid - 7 * Math.sign(yB - yN || 1); yB = mid + 7 * Math.sign(yB - yN || 1); }
    el('text', { class: 'lbl', x: L + pw + 8, y: yN + 4 }, svg).textContent = fmtShort(end.nw);
    el('text', { class: 'lbl', x: L + pw + 8, y: yB + 4 }, svg).textContent = fmtShort(end.base);
    // hover layer
    const cross = el('line', { class: 'cross', y1: T, y2: T + ph, visibility: 'hidden' }, svg);
    const dN = el('circle', { class: 'dot-nw', r: 5, visibility: 'hidden' }, svg), dB = el('circle', { class: 'dot-base', r: 5, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }, svg);
    const show = evt => {
      const r = svg.getBoundingClientRect(); const px = (evt.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - L) / pw * P.years))); const p = pts[i];
      for (const [n, attr] of [[cross, ['x1', 'x2']]]) attr.forEach(a => n.setAttribute(a, x(p.year)));
      dN.setAttribute('cx', x(p.year)); dN.setAttribute('cy', y(p.nw)); dB.setAttribute('cx', x(p.year)); dB.setAttribute('cy', y(p.base));
      [cross, dN, dB].forEach(n => n.setAttribute('visibility', 'visible'));
      tip.textContent = '';
      const head = document.createElement('div'); head.textContent = p.year === 0 ? 'Now' : `Year ${p.year}`; tip.append(head);
      for (const [cls, label, v] of [['sw-nw', 'Net worth', p.nw], ['sw-base', 'Without growth', p.base]]) {
        const row = document.createElement('div'); const sw = document.createElement('i'); sw.className = cls;
        const b = document.createElement('b'); b.textContent = fmt(v); row.append(sw, label + ' ', b); tip.append(row);
      }
      tip.hidden = false;
      const left = x(p.year) / W * r.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
    };
    const hide = () => { [cross, dN, dB].forEach(n => n.setAttribute('visibility', 'hidden')); tip.hidden = true; };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hide);
    chart.prepend(svg);

    // milestone table
    const marks = [...new Set([1, 5, 10, 15, 20, 25, 30, 40, 50].filter(yv => yv <= P.years).concat([P.years]))].sort((a, b) => a - b);
    const tbl = $('projTable');
    const hr = document.createElement('tr'); ['Year', 'Assets', 'Debts', 'Net worth', 'Growth'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const thead = document.createElement('thead'); thead.append(hr); tbl.append(thead);
    const tb = document.createElement('tbody');
    for (const yv of marks) { const p = pts[yv]; const tr = document.createElement('tr');
      [String(yv), fmt(p.assets), fmt(p.debts), fmt(p.nw), fmt(p.nw - p.base)].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); }); tb.append(tr); }
    tbl.append(tb);
    const unset = list.filter(i => i.kind === 'asset' && (i.rate === null || i.rate === undefined)).length;
    $('projNote').textContent = `Assets without their own expected return use ${P.ret}% if they're investments, retirement, crypto or other, and 0% otherwise (${unset} holding${unset === 1 ? '' : 's'} using a default). Debts grow at their interest rate and shrink by their monthly payment. Returns are compounded monthly and contributions added monthly${P.real ? `; values are shown in today's dollars at ${P.infl}% inflation` : ''}.`;
  }
  const onProj = () => { P.years = Math.round(clampNum($('pYears').value, 1, 50, 20)); P.ret = clampNum($('pReturn').value, -20, 30, 6); P.infl = clampNum($('pInfl').value, 0, 20, 2.5); P.real = $('pReal').checked; savePrefs(); renderProjection(); };
  ['pYears', 'pReturn', 'pInfl'].forEach(id => $(id).addEventListener('change', onProj));
  let resizeT = 0, lastW = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { const w = $('projChart').clientWidth; if (w && w !== lastW && mode !== 'locked') { lastW = w; renderProjection(); } }, 150); }); $('pReal').addEventListener('change', onProj);

  function render() {
    const locked = mode === 'locked';
    $('lockCard').hidden = !locked;
    $('content').hidden = locked;
    $('exportBtn').disabled = locked;
    $('importBtn').disabled = locked;
    $('connDot').className = 'dot' + (mode === 'airtable' ? ' on' : '');
    $('connLabel').textContent = mode === 'airtable' ? 'Airtable' : locked ? 'Unlock' : 'Connect Airtable';
    $('foot').textContent = mode === 'local'
      ? 'Your data is stored only in this browser. Connect Airtable to sync it across devices, or use Export to back it up.'
      : 'Your data is stored in Airtable. Your token is encrypted on this device, and the app locks after 15 minutes of inactivity.';
    renderOwnerFilter();
    if (locked) {
      ownerView = '';
      ['totAssets', 'totDebts', 'totNet'].forEach(id => { $(id).textContent = '—'; });
      $('mixSection').hidden = true; $('projSection').hidden = true; $('projTip').hidden = true;
      [...$('projChart').querySelectorAll('svg')].forEach(n => n.remove()); $('projTable').textContent = ''; $('projHeadline').textContent = '';
      ['assets', 'debts', 'assetMix', 'lookBar', 'lookTable', 'mixHint', 'fName', 'fNote', 'fVal', 'fAcct', 'fFund', 'fOwner', 'fTicker', 'fShares', 'fRate', 'fMonthly', 'acctList', 'ownerList', 'fundList']
        .forEach(id => { const el = $(id); if (el.tagName === 'INPUT') el.value = ''; else el.textContent = ''; });
      return;
    }
    const vis = visible();
    const a = sum(vis.filter(i => i.kind === 'asset')), d = sum(vis.filter(i => i.kind === 'debt'));
    $('totAssets').textContent = fmt(a);
    $('totDebts').textContent = fmt(d);
    $('totNet').textContent = fmt(a - d);
    renderMix(); renderLookThrough(); renderProjection(); renderList('asset'); renderList('debt');
  }

  // Generic busy wrapper for form buttons
  async function busy(btn, fn) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------- Item dialog ----------
  let editingId = null, editKind = 'asset';
  function openItem(kind, item) {
    editKind = kind; editingId = item ? item.id : null;
    $('itemTitle').textContent = (item ? 'Edit ' : 'Add ') + kind;
    const sel = $('fCat'); sel.textContent = '';
    for (const c of catsFor(kind, item ? [item] : [])) { const o = document.createElement('option'); o.textContent = c; sel.append(o); }
    $('fName').value = item ? item.name : '';
    sel.value = item ? item.category : CATS[kind][0];
    $('fVal').value = item ? item.value : '';
    $('fNote').value = item ? item.note : '';
    $('fAcct').value = item ? item.accountType : '';
    $('fFund').value = item ? item.fund : '';
    $('fOwner').value = item ? item.owner : (ownerView || '');
    $('fTicker').value = item ? item.ticker : '';
    $('fShares').value = item && item.shares !== null ? item.shares : '';
    $('fRate').value = item && item.rate !== null ? item.rate : '';
    $('fMonthly').value = item && item.monthly !== null ? item.monthly : '';
    $('fRateLabel').textContent = kind === 'debt' ? 'Interest rate % / yr' : 'Expected return % / yr';
    $('fMonthlyLabel').textContent = kind === 'debt' ? 'Monthly payment' : 'Monthly contribution';
    $('fRate').placeholder = kind === 'debt' ? '0' : 'Uses default';
    fillDatalist('acctList', ACCOUNT_TYPES, items.map(i => i.accountType).filter(Boolean));
    fillDatalist('ownerList', OWNERS, ownersInUse());
    fillDatalist('fundList', [], items.map(i => i.fund).filter(Boolean));
    $('itemDel').hidden = !item;
    $('itemErr').textContent = '';
    $('itemDlg').showModal();
  }
  $('itemForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('fName').value.trim()) { $('itemErr').textContent = 'Please enter a name.'; return; }
    const v = Number($('fVal').value);
    if ($('fVal').value === '' || !Number.isFinite(v) || v < 0) { $('itemErr').textContent = 'Please enter a value of 0 or more.'; return; }
    const d = clean({
      name: $('fName').value, kind: editKind, category: $('fCat').value, value: v, note: $('fNote').value,
      accountType: $('fAcct').value, fund: $('fFund').value, owner: $('fOwner').value,
      ticker: $('fTicker').value, shares: $('fShares').value,
      rate: $('fRate').value, monthly: $('fMonthly').value
    });
    if ($('fRate').value !== '' && d.rate === null) { $('itemErr').textContent = 'Enter a rate between -50% and 50%.'; return; }
    if ($('fTicker').value.trim() && !d.ticker) { $('itemErr').textContent = 'Tickers are letters/numbers only, e.g. VTTSX.'; return; }
    try {
      await busy($('itemSave'), () => editingId ? updateItem(editingId, d) : addItem(d));
      $('itemDlg').close(); render();
    } catch (err) { $('itemErr').textContent = err.message; }
  });
  $('itemDel').onclick = async () => {
    const it = items.find(i => i.id === editingId);
    if (!it || !confirm(`Delete “${it.name}”?`)) return;
    try { await busy($('itemDel'), () => removeItem(it.id)); $('itemDlg').close(); render(); }
    catch (err) { $('itemErr').textContent = err.message; }
  };

  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    const close = t.closest('[data-close]'); if (close) { close.closest('dialog').close(); clearSecrets(); return; }
    const add = t.closest('[data-add]'); if (add) { openItem(add.dataset.add); return; }
    const ed = t.closest('[data-edit]'); if (ed) { const it = items.find(i => i.id === ed.dataset.edit); if (it) openItem(it.kind, it); }
  });

  // ---------- Connect / unlock / disconnect ----------
  $('connBtn').onclick = () => {
    if (mode === 'local') {
      const n = items.length;
      $('cUploadRow').hidden = n === 0; $('cUploadN').textContent = n;
      $('connectErr').textContent = '';
      $('connectDlg').showModal();
    } else if (mode === 'locked') openUnlock();
    else {
      $('connInfo').textContent = `Base ${session.baseId}, table “${session.table}”. Locks automatically after 15 minutes of inactivity.`;
      $('connMenu').showModal();
    }
  };
  $('lockUnlockBtn').onclick = () => openUnlock();
  function openUnlock() { $('unlockErr').textContent = ''; $('uPass').value = ''; $('unlockDlg').showModal(); }

  $('connectForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = m => { $('connectErr').textContent = m; };
    const baseId = $('cBase').value.trim(), table = $('cTable').value.trim(), token = $('cToken').value.trim();
    const pass = $('cPass').value, pass2 = $('cPass2').value;
    if (!BASE_RE.test(baseId)) return err('The base ID should look like app followed by 14 letters or numbers.');
    if (!table) return err('Enter the table name.');
    if (!TOKEN_RE.test(token)) return err('That doesn’t look like an Airtable personal access token (it starts with “pat”).');
    if (pass.length < MIN_PASS) return err(`Use a passphrase of at least ${MIN_PASS} characters.`);
    if (pass !== pass2) return err('The passphrases don’t match.');
    if (pass === token) return err('Your passphrase must be different from the token.');
    const upload = !$('cUploadRow').hidden && $('cUpload').checked ? items.map(clean) : [];
    try {
      await busy($('connectSave'), async () => {
        session = { token, baseId, table };
        const prevMode = mode; mode = 'airtable';
        try {
          await at(`${tablePath(session)}?pageSize=1`); // verify token, base and table
          const box = await seal(session, pass);
          if (!store.set(VAULT_KEY, JSON.stringify(box))) throw new Error('This browser blocked local storage, so the connection can’t be saved.');
          if (upload.length) { await atCreateMany(upload); store.del(LOCAL_KEY); }
          await loadAirtable();
        } catch (x) { session = null; mode = prevMode; throw x; }
      });
      $('connectDlg').close(); clearSecrets(); lastActivity = Date.now(); render();
      showBanner('Connected to Airtable. Remember your passphrase: it can’t be recovered, though you can always reconnect with a new token.', 'info');
    } catch (x) { err(x.message); }
  });

  $('unlockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const box = parse(store.get(VAULT_KEY));
    if (!box) { mode = 'local'; items = loadLocalItems(); $('unlockDlg').close(); render(); return; }
    try {
      await busy($('unlockSave'), async () => {
        if (failedUnlocks >= 3) await sleep(Math.min(30000, 1000 * 2 ** (failedUnlocks - 2)));
        let creds;
        try { creds = await unseal(box, $('uPass').value); }
        catch (x) { failedUnlocks++; throw new Error('Wrong passphrase.'); }
        if (!creds || !BASE_RE.test(creds.baseId) || !TOKEN_RE.test(creds.token)) throw new Error('Saved connection is damaged. Disconnect and reconnect.');
        session = { token: creds.token, baseId: creds.baseId, table: String(creds.table || 'Items') };
        mode = 'airtable';
        try { await loadAirtable(); } catch (x) { session = null; mode = 'locked'; throw x; }
      });
      failedUnlocks = 0; $('unlockDlg').close(); clearSecrets(); lastActivity = Date.now(); $('banner').hidden = true; render();
    } catch (x) { $('unlockErr').textContent = x.message; }
  });

  function disconnect() {
    if (!confirm('Disconnect Airtable on this device? Your data stays in Airtable, and the encrypted token is erased from this browser. You can reconnect anytime with a token.')) return;
    store.del(VAULT_KEY); session = null; breakdown = {}; mode = 'local'; items = loadLocalItems();
    document.querySelectorAll('dialog[open]').forEach(d => d.close()); clearSecrets(); render();
    showBanner('Disconnected. For extra safety, you can also revoke the token at airtable.com/create/tokens.', 'info');
  }
  $('forgetBtn').onclick = disconnect;
  $('disconnectBtn').onclick = disconnect;
  $('lockNowBtn').onclick = () => lock();

  // ---------- Currency ----------
  const cur = $('currency');
  for (const c of CURRENCIES) { const o = document.createElement('option'); o.textContent = c; cur.append(o); }
  cur.value = prefs.currency;
  cur.onchange = () => { if (CURRENCIES.includes(cur.value)) { prefs.currency = cur.value; savePrefs(); render(); } };

  // ---------- Export / import ----------
  $('exportBtn').onclick = () => {
    if (mode === 'locked') return;
    if (!confirm('The backup file will contain your balances unencrypted. Keep it somewhere safe. Continue?')) return;
    const data = { app: 'holdings', version: 2, exported: new Date().toISOString(), items: items.map(({ id, ...rest }) => rest) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `holdings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('importBtn').onclick = () => { if (mode !== 'locked') $('importFile').click(); };
  $('importFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return showBanner('That file is too large to be a Holdings backup.');
    let list;
    try { const s = JSON.parse(await f.text()); if (!Array.isArray(s.items) || s.items.length > 5000) throw 0; list = s.items.map(clean); }
    catch (x) { return showBanner('That file isn’t a valid Holdings backup.'); }
    try {
      if (mode === 'airtable') {
        if (!confirm(`Add ${list.length} items to Airtable?`)) return;
        showBanner(`Uploading ${list.length} items…`, 'info');
        items.push(...await atCreateMany(list));
        showBanner(`Added ${list.length} items to Airtable.`, 'info');
      } else {
        if (!confirm('Replace the data in this browser with this file?')) return;
        items = list.map(d => ({ id: uid(), ...d })); saveLocal();
      }
      render();
    } catch (x) { showBanner(x.message); render(); }
  };

  // ---------- Start ----------
  if (!window.crypto || !crypto.subtle) showBanner('This browser lacks the secure encryption features Holdings needs for Airtable. Make sure you’re on the https:// address.');
  render();
  if (mode === 'locked') openUnlock();
})();
