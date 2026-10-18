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
  const CURRENCIES = ['USD', 'AUD', 'EUR', 'GBP', 'CAD', 'NZD', 'JPY', 'CHF', 'SGD', 'HKD', 'INR', 'BTC', 'XAU'];
  const PRICED = ['BTC', 'XAU'];             // bitcoin and gold (XAU = 1 troy ounce): rates entered as "1 unit = $X"
  const DISPLAY_CURRENCIES = CURRENCIES.filter(c => !PRICED.includes(c));   // totals are shown in a regular currency
  const UNIT = { BTC: '1 BTC', XAU: '1 oz gold' };
  const CUR_LABEL = { BTC: 'BTC (bitcoin)', XAU: 'XAU (gold, troy oz)' };
  const BASE_CUR = 'USD';                    // a holding with no Currency is in US dollars; rates are per 1 USD
  const curOf = c => { const x = String(c || '').trim().toUpperCase(); return CURRENCIES.includes(x) ? x : BASE_CUR; };

  // Buckets are what you see; classes are the finer detail stored in Airtable (they roll up into buckets).
  const BUCKETS = ['Equities', 'Bonds', 'Cash', 'Gold', 'Property', 'Commodities', 'Bitcoin', 'Other'];
  const CLASSES = ['US stocks', 'International stocks', 'Equities', 'US bonds', 'International bonds', 'Bonds',
    'Cash', 'Property', 'Gold', 'Commodities', 'Bitcoin', 'Crypto', 'Other'];
  const CLASS_LABEL = { 'US stocks': 'Equities — US', 'International stocks': 'Equities — International', 'Equities': 'Equities — Global',
    'US bonds': 'Bonds — US', 'International bonds': 'Bonds — International', 'Bonds': 'Bonds — Global', 'Crypto': 'Other crypto' };
  const ALIAS = { 'Real estate': 'Property' };
  const normClass = c => { const x = ALIAS[c] || c; return CLASSES.includes(x) ? x : ''; };
  const BUCKET_OF = { 'US stocks': 'Equities', 'International stocks': 'Equities', 'Equities': 'Equities', 'US bonds': 'Bonds',
    'International bonds': 'Bonds', 'Bonds': 'Bonds', 'Crypto': 'Bitcoin' };
  const bucketOf = c => BUCKET_OF[c] || (BUCKETS.includes(c) ? c : 'Other');
  const REGION_OF = { 'US stocks': 'US', 'International stocks': 'International', 'Equities': 'Global', 'US bonds': 'US', 'International bonds': 'International', 'Bonds': 'Global' };
  const CATEGORY_CLASS = { 'Cash': 'Cash', 'Real estate': 'Property', 'Property': 'Property', 'Crypto': 'Bitcoin', 'Bitcoin': 'Bitcoin', 'Gold': 'Gold' };

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
      monthly: posOrNull(raw && raw.monthly),
      assetClass: normClass(String((raw && raw.assetClass) || '').trim()),
      // Your own label in Airtable's Asset class (e.g. "Superannuation") isn't a bucket, but is kept as written.
      assetClassNote: normClass(String((raw && raw.assetClass) || '').trim()) ? '' : String((raw && (raw.assetClassNote || raw.assetClass)) || '').trim().slice(0, 60),
      currency: curOf(raw && raw.currency),
      ret12: pctOrNull(raw && raw.ret12),
      ret5: pctOrNull(raw && raw.ret5),
      retAsOf: /^\d{4}-\d{2}/.test(String((raw && raw.retAsOf) || '')) ? String(raw.retAsOf).slice(0, 10) : '',
      retSource: String((raw && raw.retSource) || '').trim().slice(0, 60)
    };
  }
  const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
  function rateOrNull(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= -50 && n <= 50 ? n : null; }
  function pctOrNull(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= -100 && n <= 10000 ? n : null; }
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
  if (!DISPLAY_CURRENCIES.includes(prefs.currency)) prefs.currency = 'USD';
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
      rate: r.fields['Expected return %'], monthly: r.fields['Monthly contribution'], assetClass: r.fields['Asset class'],
      currency: r.fields.Currency,
      ret12: r.fields['12-month return %'], ret5: r.fields['5-year return %'],
      retAsOf: r.fields['Return as of'], retSource: r.fields['Return source']
    })
  });
  const toFields = d => ({
    Name: d.name, Kind: d.kind === 'debt' ? 'Debt' : 'Asset', Category: d.category, Value: d.value, Note: d.note,
    'Account type': d.accountType, Fund: d.fund, Owner: d.owner, Ticker: d.ticker, Shares: d.shares,
    'Expected return %': d.rate, 'Monthly contribution': d.monthly, 'Asset class': d.assetClass || d.assetClassNote || null,
    Currency: d.currency && d.currency !== BASE_CUR ? d.currency : null,
    '12-month return %': d.ret12, '5-year return %': d.ret5, 'Return as of': d.retAsOf || null, 'Return source': d.retSource || null
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
  // Each holding's mix by class: fund breakdown (by ticker) > its own Asset class > its category > Other.
  function mixFor(i) {
    if (i.ticker && breakdown[i.ticker]) return breakdown[i.ticker].mix;
    if (i.assetClass) return { [i.assetClass]: 100 };
    if (i.currency === 'XAU') return { Gold: 100 };          // gold held in ounces
    if (i.currency === 'BTC') return { Bitcoin: 100 };       // bitcoin held directly
    return { [CATEGORY_CLASS[i.category] || 'Other']: 100 };
  }
  // The bucket a holding mostly belongs to ('Multi-asset' when no bucket reaches 90%).
  function mainBucket(i) {
    const by = {};
    for (const [c, w] of Object.entries(mixFor(i))) by[bucketOf(c)] = (by[bucketOf(c)] || 0) + w;
    const [top, w] = Object.entries(by).sort((a, b) => b[1] - a[1])[0] || ['Other', 100];
    return w >= 90 ? top : 'Multi-asset';
  }
  let breakdown = {};   // ticker -> { mix: {class: pct}, asOf, source }
  async function atLoadBreakdown() {
    const manual = {}, auto = {};
    let offset = '';
    for (let page = 0; page < 20; page++) {
      const q = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
      const j = await at(`${session.baseId}/${encodeURIComponent('Fund breakdown')}?${q}`);
      for (const r of j.records || []) {
        const f = r.fields || {};
        const t = String(f['Fund ticker'] || '').trim().toUpperCase(), c = normClass(f['Asset class']), w = Number(f['Weight %']);
        if (!TICKER_RE.test(t) || !c || !Number.isFinite(w) || w <= 0) continue;
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
  // ---------- Exchange rates ----------
  // fx[code] = { rate: units per 1 USD, source: 'Auto…' | 'Manual', asOf, id? }. Airtable mode reads the
  // "FX rates" table (the daily sync keeps Auto rows fresh); browser-only mode keeps rates in preferences.
  const FX_TABLE = 'FX rates';
  let fx = {}, fxTableOk = false;
  const fxOk = r => Number.isFinite(r) && r > 0 && r < 1e7;
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  const rateOf = c => { c = curOf(c); return c === BASE_CUR ? 1 : (fx[c] && fxOk(fx[c].rate) ? fx[c].rate : null); };
  const dispCur = () => rateOf(prefs.currency) ? prefs.currency : BASE_CUR;
  const conv = (v, c) => { const from = rateOf(c), to = rateOf(dispCur()); return from && to && v !== null && v !== undefined ? Number(v) / from * to : null; };
  function localFx() {
    const out = {};
    for (const [c, e] of Object.entries((prefs.fx && typeof prefs.fx === 'object') ? prefs.fx : {}))
      if (CURRENCIES.includes(c) && c !== BASE_CUR && e && fxOk(Number(e.rate))) out[c] = { rate: Number(e.rate), source: 'Manual', asOf: String(e.asOf || '').slice(0, 10) };
    return out;
  }
  async function atLoadFx() {
    const out = {};
    const j = await at(`${session.baseId}/${encodeURIComponent(FX_TABLE)}?pageSize=100`);
    for (const r of j.records || []) {
      const f = r.fields || {}, c = String(f.Currency || '').trim().toUpperCase(), each = Number(f['USD each']);
      const rate = Number(f['Per USD']) > 0 ? Number(f['Per USD']) : (each > 0 ? 1 / each : NaN);
      if (!CURRENCIES.includes(c) || c === BASE_CUR || !fxOk(rate) || !REC_RE.test(r.id)) continue;
      const src = String(f.Source || '').slice(0, 60), isManual = /^manual/i.test(src);
      if (out[c] && out[c].source === 'Manual' && !isManual) continue;   // a manual row beats an automatic one
      out[c] = { rate, source: isManual ? 'Manual' : (src || 'Auto'), asOf: String(f['As of'] || '').slice(0, 10), id: r.id };
    }
    return out;
  }
  async function saveFx(changes) {            // [{ code, rate, source }]
    const today = new Date().toISOString().slice(0, 10);
    if (mode !== 'airtable') {
      prefs.fx = prefs.fx && typeof prefs.fx === 'object' ? prefs.fx : {};
      for (const ch of changes) { prefs.fx[ch.code] = { rate: ch.rate, asOf: today }; }
      savePrefs(); fx = localFx(); return;
    }
    for (let k = 0; k < changes.length; k += 10) {
      const records = changes.slice(k, k + 10).map(ch => ({ fields: PRICED.includes(ch.code)
        ? { Currency: ch.code, 'USD each': round(1 / ch.rate, 2), 'Per USD': null, 'As of': today, Source: ch.source }
        : { Currency: ch.code, 'Per USD': ch.rate, 'As of': today, Source: ch.source } }));
      await at(`${session.baseId}/${encodeURIComponent(FX_TABLE)}`, { method: 'PATCH', body: { performUpsert: { fieldsToMergeOn: ['Currency'] }, records, typecast: true } });
    }
    fx = await atLoadFx(); fxTableOk = true;
  }

  async function loadAirtable() {
    items = await atLoadAll();
    try { breakdown = await atLoadBreakdown(); }
    catch (x) { breakdown = {}; }                        // the table is optional; the app works without it
    try { fx = await atLoadFx(); fxTableOk = true; }
    catch (x) { fx = {}; fxTableOk = false; }
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
    session = null; items = []; breakdown = {}; fx = {}; mode = 'locked';
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
  const fmtIn = (n, c) => c === 'BTC'
    ? '₿' + new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(n)
    : c === 'XAU' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(n) + ' oz gold'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
  const fmt = n => fmtIn(n, dispCur());

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
  // Everything below works in the display currency: each holding is converted once here. A holding whose
  // currency has no rate yet counts as 0 and is flagged (noFx) so the page can say so.
  const visible = () => (ownerView ? items.filter(i => i.owner === ownerView) : items).map(i => {
    const v = conv(i.value, i.currency), m = i.monthly === null ? null : conv(i.monthly, i.currency);
    return { ...i, native: i.value, value: v === null ? 0 : v, monthly: v === null ? null : m, noFx: v === null };
  });
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

  const fmtPct = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%';
  // Value-weighted 12-month return over the holdings that have one: { r, n, of }.
  function wRet(list) {
    const has = list.filter(i => i.ret12 !== null && i.ret12 !== undefined && i.value > 0);
    const w = has.reduce((a, i) => a + i.value, 0);
    return { r: w ? has.reduce((a, i) => a + i.value * i.ret12, 0) / w : null, n: has.length, of: list.length };
  }

  function metaLine(i) {
    const sh = i.ticker && i.shares ? `${i.ticker} · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(i.shares)} sh` : i.ticker;
    const priced = i.pricedOn ? `priced ${i.pricedOn}` : '';
    const cat = i.kind === 'asset' ? i.category : '';
    const ret = [i.ret12 !== null && i.ret12 !== undefined ? `12-mo ${fmtPct(i.ret12)}` : '', i.ret5 !== null && i.ret5 !== undefined ? `5-yr ${fmtPct(i.ret5)}/yr` : ''].filter(Boolean).join(', ');
    const bits = [cat, i.accountType, i.fund !== i.name ? i.fund : '', sh, i.owner, priced, ret].filter(Boolean);
    return bits.length ? `<div class="meta">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : '';
  }

  function renderList(kind) {
    const el = $(kind === 'asset' ? 'assets' : 'debts');
    const list = visible().filter(i => i.kind === kind);
    if (!list.length) { el.innerHTML = `<div class="empty">No ${kind}s yet.</div>`; return; }
    const groupOf = kind === 'asset' ? mainBucket : (i => i.category);
    const groups = kind === 'asset' ? ['Multi-asset', ...BUCKETS] : catsFor(kind, list);
    el.innerHTML = groups.map(cat => {
      const g = list.filter(i => groupOf(i) === cat);
      if (!g.length) return '';
      const label = cat === 'Multi-asset' ? 'Multi-asset funds' : cat;
      const gr = kind === 'asset' ? wRet(g) : { r: null };
      const grTxt = gr.r === null ? '' : `<span class="grp-ret" title="12-month return, weighted by value, across ${gr.n} of ${gr.of} holding${gr.of === 1 ? '' : 's'}">12-mo ${esc(fmtPct(gr.r))}</span>`;
      return `<div class="group"><div class="group-head"><span>${esc(label)}</span>${grTxt}<span class="amt">${esc(fmt(sum(g)))}</span></div>` +
        g.map(i => `<div class="row"><div><div class="name">${esc(i.name)}</div>${metaLine(i)}${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}</div>` +
          `<div><div class="amt">${i.noFx ? '—' : esc(fmt(i.value))}</div>${i.currency !== dispCur() ? `<div class="native${i.noFx ? ' warn' : ''}">${esc(fmtIn(i.native, i.currency))}${i.noFx ? ' · no rate' : ''}</div>` : ''}</div><button class="icon-btn" type="button" data-edit="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">✎</button></div>`).join('') +
        `</div>`;
    }).join('');
  }

  function renderMix() { $('assetMix').textContent = ''; }   // superseded by the Returns panel

  // ---------- Returns panel ----------
  // Every asset counts at its value. A holding's 12-month return is its published/synced figure; cash without one
  // earns its interest rate (its Expected return); anything else without a figure counts as 0% and is called out.
  function retOf(i) {
    if (i.ret12 !== null && i.ret12 !== undefined) return { r: i.ret12, how: 'return' };
    if (mainBucket(i) === 'Cash' && i.rate !== null && i.rate !== undefined) return { r: i.rate, how: 'rate' };
    return { r: null, how: 'none' };
  }
  function renderReturns() {
    const sec = $('retSection'), tbl = $('retTable'); tbl.textContent = '';
    const assets = visible().filter(i => i.kind === 'asset' && i.value > 0);
    const total = assets.reduce((a, i) => a + i.value, 0);
    const funds = wRet(assets);
    if (mode === 'locked' || !total || (funds.r === null && !assets.some(i => retOf(i).r !== null))) { sec.hidden = true; return; }
    let pts = 0, missing = 0, rated = 0;
    const groups = {};
    for (const i of assets) {
      const { r, how } = retOf(i), g = mainBucket(i);
      const e = groups[g] || (groups[g] = { v: 0, s: 0, miss: 0, rate: 0 });
      e.v += i.value; e.s += i.value * (r || 0);
      if (how === 'none') { e.miss += i.value; missing += i.value; }
      if (how === 'rate') { e.rate += i.value; rated += i.value; }
      pts += i.value * (r || 0);
    }
    const all = pts / total;
    $('retAll').textContent = fmtPct(all);
    $('retAllSub').textContent = `Weighted by value across all ${assets.length} assets (${fmt(total)}).`;
    $('retFunds').textContent = funds.r === null ? '—' : fmtPct(funds.r);
    const r5 = (() => { const h = assets.filter(i => i.ret5 !== null && i.ret5 !== undefined); const w = h.reduce((a, i) => a + i.value, 0); return w ? h.reduce((a, i) => a + i.value * i.ret5, 0) / w : null; })();
    const cov = assets.filter(i => i.ret12 !== null && i.ret12 !== undefined).reduce((a, i) => a + i.value, 0);
    $('retFundsSub').textContent = funds.r === null ? 'No holdings have a 12-month return yet.'
      : `${funds.n} holdings, ${Math.round(cov / total * 100)}% of assets` + (r5 !== null ? ` · 5-yr ${fmtPct(r5)}/yr` : '') + '.';
    const hr = document.createElement('tr');
    ['Group', 'Share', '12-mo', 'Adds'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const thead = document.createElement('thead'); thead.append(hr); tbl.append(thead);
    const tb = document.createElement('tbody');
    for (const g of ['Multi-asset', ...BUCKETS].filter(g => groups[g]).sort((a, b) => groups[b].v - groups[a].v)) {
      const e = groups[g], tr = document.createElement('tr');
      const ret = e.miss / e.v > 0.95 ? 'no data' : fmtPct(e.s / e.v) + (e.rate ? '*' : '') + (e.miss ? '†' : '');
      [g === 'Multi-asset' ? 'Multi-asset funds' : g, Math.round(e.v / total * 100) + '%', ret, fmtPct(e.s / total).replace('%', ' pts')]
        .forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
      tb.append(tr);
    }
    const tr = document.createElement('tr'); tr.className = 'ret-total';
    ['Total', '100%', fmtPct(all), fmtPct(all).replace('%', ' pts')].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
    tb.append(tr); tbl.append(tb);
    const notes = [];
    if (rated) notes.push('* Cash uses each account’s interest rate (its Expected return).');
    if (missing) {
      const names = Object.entries(groups).filter(([, e]) => e.miss).sort((a, b) => b[1].miss - a[1].miss).map(([g]) => g === 'Multi-asset' ? 'multi-asset' : g.toLowerCase());
      notes.push(`† ${Math.round(missing / total * 100)}% of assets (${names.join(', ')}) have no 12-month figure and count as 0%. Add one in each holding’s edit form; every 1% on them moves the total by ${(missing / total).toFixed(2)} points.`);
    }
    notes.push('Fund performance, not your personal (money-weighted) return. Holdings in other currencies use their own-currency returns.');
    $('retNote').textContent = notes.join(' ');
    sec.hidden = false;
  }

  function renderLookThrough() {
    const sec = $('mixSection'), bar = $('lookBar'), tbl = $('lookTable');
    bar.textContent = ''; tbl.textContent = '';
    const assets = visible().filter(i => i.kind === 'asset');
    if (mode === 'locked' || !assets.length) { sec.hidden = true; return; }
    const exp = Object.fromEntries(CLASSES.map(c => [c, 0]));
    for (const i of assets) for (const [c, w] of Object.entries(mixFor(i))) exp[c] = (exp[c] || 0) + (Number(i.value) || 0) * w / 100;
    const total = Object.values(exp).reduce((a, b) => a + b, 0);
    if (!total) { sec.hidden = true; return; }
    const byBucket = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    for (const [c, v] of Object.entries(exp)) byBucket[bucketOf(c)] += v;
    const b = document.createElement('div'); b.className = 'bar';
    BUCKETS.forEach((bk, ix) => {
      const v = byBucket[bk]; if (v <= 0.005) return;
      const seg = document.createElement('div'); seg.className = 'bk-' + ix; seg.style.width = (v / total * 100) + '%'; seg.title = `${bk} ${(v / total * 100).toFixed(1)}%`; b.append(seg);
      const row = document.createElement('div'); row.className = 'look-row';
      const dot = document.createElement('i'); dot.className = 'bk-' + ix;
      const name = document.createElement('span'); name.textContent = bk;
      const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = fmt(v);
      const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = (v / total * 100).toFixed(1) + '%';
      row.append(dot, name, amt, pct); tbl.append(row);
      // US / International / Global detail for Equities and Bonds
      const subs = CLASSES.filter(c => bucketOf(c) === bk && REGION_OF[c] && exp[c] > 0.005);
      if (subs.length && !(subs.length === 1 && REGION_OF[subs[0]] === 'Global')) for (const c of subs) {
        const sr = document.createElement('div'); sr.className = 'look-row look-sub';
        const sp = document.createElement('i'), sn = document.createElement('span'), sa = document.createElement('span'), sq = document.createElement('span');
        sn.textContent = REGION_OF[c] === 'Global' ? 'Global / unspecified' : REGION_OF[c];
        sa.className = 'amt'; sa.textContent = fmt(exp[c]); sq.className = 'pct'; sq.textContent = (exp[c] / v * 100).toFixed(0) + '% of ' + bk.toLowerCase();
        sr.append(sp, sn, sa, sq); tbl.append(sr);
      }
    });
    bar.append(b);
    const covered = assets.filter(i => i.ticker && breakdown[i.ticker]);
    const unsorted = assets.filter(i => mainBucket(i) === 'Other' && !i.assetClass).length;
    const dates = covered.map(i => breakdown[i.ticker].asOf).filter(Boolean).sort();
    $('mixHint').textContent = (covered.length ? `Looks through ${covered.length} fund holding${covered.length === 1 ? '' : 's'}` : 'By bucket')
      + (dates.length ? ` · compositions as of ${dates[0]}${dates[0] !== dates[dates.length - 1] ? '–' + dates[dates.length - 1] : ''}` : '')
      + (unsorted ? ` · ${unsorted} unsorted: use Tidy up` : '');
    sec.hidden = false;
  }

  // ---------- Projection ----------
  const NO_GROWTH = ['Cash'];
  const P = prefs.proj = Object.assign({ years: 20, ret: 6, infl: 2.5, real: false }, prefs.proj || {});
  const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  // Monthly compounding; contributions/payments at month end. Returns one point per year (0..years).
  function project(list, years, defaultRet, infl, real) {
    const state = list.map(i => {
      const isDebt = i.kind === 'debt';
      const rate = i.rate !== null && i.rate !== undefined ? i.rate : (isDebt ? 0 : (NO_GROWTH.includes(mainBucket(i)) || ['Vehicles', 'Collectibles'].includes(i.category) ? 0 : defaultRet));
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
    $('projNote').textContent = `Assets without their own expected return use ${P.ret}%, except cash and vehicles at 0% (${unset} holding${unset === 1 ? '' : 's'} using a default). Debts grow at their interest rate and shrink by their monthly payment. Returns are compounded monthly and contributions added monthly${P.real ? `; values are shown in today's dollars at ${P.infl}% inflation` : ''}.`;
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
      $('mixSection').hidden = true; $('retSection').hidden = true; $('projSection').hidden = true; $('projTip').hidden = true; $('fxNote').hidden = true;
      [...$('projChart').querySelectorAll('svg')].forEach(n => n.remove()); $('projTable').textContent = ''; $('projHeadline').textContent = '';
      ['assets', 'debts', 'assetMix', 'lookBar', 'lookTable', 'mixHint', 'fName', 'fNote', 'fVal', 'fAcct', 'fFund', 'fOwner', 'fTicker', 'fShares', 'fRate', 'fMonthly', 'fRet12', 'fRet5', 'fRetHint', 'retTable', 'retAll', 'retAllSub', 'retFunds', 'retFundsSub', 'retNote', 'tidyList', 'fxList', 'fxText', 'acctList', 'ownerList', 'fundList']
        .forEach(id => { const el = $(id); if (el.tagName === 'INPUT') el.value = ''; else el.textContent = ''; });
      return;
    }
    const vis = visible();
    const a = sum(vis.filter(i => i.kind === 'asset')), d = sum(vis.filter(i => i.kind === 'debt'));
    $('totAssets').textContent = fmt(a);
    $('totDebts').textContent = fmt(d);
    $('totNet').textContent = fmt(a - d);
    $('tidyBtn').hidden = !items.some(i => i.kind === 'asset');
    renderFxNote(vis);
    renderMix(); renderLookThrough(); renderReturns(); renderProjection(); renderList('asset'); renderList('debt');
  }

  // Generic busy wrapper for form buttons
  async function busy(btn, fn) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }

  function fillClassSelect(sel, value, autoLabel) {
    sel.textContent = '';
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = autoLabel; sel.append(auto);
    for (const bk of BUCKETS) {
      const grp = document.createElement('optgroup'); grp.label = bk;
      for (const c of CLASSES.filter(c => bucketOf(c) === bk)) { const o = document.createElement('option'); o.value = c; o.textContent = CLASS_LABEL[c] || c; grp.append(o); }
      sel.append(grp);
    }
    sel.value = value || '';
  }

  async function updateMany(changes) {        // [{id, d}] — Airtable allows 10 records per request
    if (mode !== 'airtable') { for (const { id, d } of changes) { const i = items.findIndex(x => x.id === id); if (i >= 0) items[i] = { id, ...d }; } saveLocal(); return; }
    for (let k = 0; k < changes.length; k += 10) {
      const chunk = changes.slice(k, k + 10);
      if (chunk.some(c => !REC_RE.test(c.id))) throw new Error('Invalid record');
      const j = await at(tablePath(session), { method: 'PATCH', body: { records: chunk.map(c => ({ id: c.id, fields: toFields(c.d) })), typecast: true } });
      for (const r of j.records || []) { const i = items.findIndex(x => x.id === r.id); if (i >= 0) items[i] = fromRecord(r); }
    }
  }

  // ---------- Tidy up: understand messy entries ----------
  // Well-known tickers → class ('MIXED' = multi-asset fund). Matching is offline; nothing is sent anywhere.
  const KNOWN_T = {};
  const addT = (cls, list) => list.split(' ').forEach(t => { KNOWN_T[t] = cls; });
  addT('US stocks', 'VTI VTSAX VTSMX VITSX VOO VFIAX VFINX SPY IVV SPLG ITOT SCHB SCHX SCHD SCHG SWTSX SWPPX FXAIX FSKAX FZROX QQQ QQQM VUG VTV VIG VYM MGK RSP IWM IWB IWV DIA USCL ESGU SUSA DSI VONE IUSG IUSV');
  addT('International stocks', 'VXUS VTIAX VTSNX VEA VEU VWO VTMGX VFWAX VEMAX IXUS IEFA IEMG EFA EEM SCHF SCHE SWISX FTIHX FZILX FSPSX ACWX');
  addT('Equities', 'VT VTWAX ACWI URTH');
  addT('US bonds', 'BND VBTLX VBMFX AGG SCHZ FXNAX VTIP VTAPX BIV BSV BLV VGIT VGSH VGLT SHY IEF TLT GOVT MUB VTEB SWAGX TIP');
  addT('International bonds', 'BNDX VTABX IAGG');
  addT('Cash', 'VMFXX VMRXX SPAXX FDRXX FZFXX SWVXX SNSXX SGOV BIL');
  addT('Property', 'REZ VNQ VGSLX SCHH IYR XLRE USRT RWR VNQI');
  addT('Gold', 'IAU GLD GLDM SGOL IAUM AAAU BAR');
  addT('Commodities', 'PDBA DBA DBC PDBC GSG COMT BCI SLV USO UNG CPER');
  addT('Bitcoin', 'BTC IBIT FBTC GBTC BITB ARKB HODL BRRR EZBC');
  addT('Crypto', 'ETHA ETHE FETH');
  addT('MIXED', 'VTTSX VFIFX VFFVX VLXVX VTTHX VFORX VTIVX VTHRX VTWNX VTXVX VSCGX VASGX VBIAX AOR AOA AOM');
  // Funds without a ticker that have a breakdown under a code (e.g. superannuation options).
  const FUND_CODES = [[/aware\s*super/i, 'AWARE-HG']];

  const RULES = [
    [/bitcoin|\bbtc\b|satoshi/i, 'Bitcoin', 'mentions bitcoin'],
    [/ethereum|\beth\b|crypto|solana/i, 'Crypto', 'mentions crypto'],
    [/\bgold\b|bullion/i, 'Gold', 'mentions gold'],
    [/silver|platinum|commodit|agricultur|\boil\b|natural gas|\bmetals?\b/i, 'Commodities', 'mentions commodities'],
    [/real estate|\breit|propert|residential|rental|\bhouse\b|\bhome\b|apartment|\bcondo\b|\bland\b/i, 'Property', 'mentions real estate'],
    [/treasur|\bbonds?\b|fixed income|\bcredit\b|\bgilts?\b|\bcds?\b|certificate of deposit/i, 'Bonds', 'mentions bonds'],
    [/\bcash\b|savings|checking|current account|money market|\bdeposit|high[- ]yield|\bbank\b/i, 'Cash', 'looks like a bank or cash balance'],
    [/international|world ex|ex[- ]us|emerging|developed markets|europe|asia|pacific|ftse all/i, 'International stocks', 'mentions international markets'],
    [/s&p|total stock|total market|nasdaq|russell|msci usa|\bdow\b|\bu\.?s\.? (?:stock|equit|large|small|mid)/i, 'US stocks', 'mentions US stock markets'],
    [/\bstocks?\b|equit|\bshares\b|index fund|\betf\b/i, 'Equities', 'mentions stocks or an ETF'],
  ];
  const MIXED_RE = /superannuation|\bsuper\b|401\s*\(?k|\bira\b|pension|target|lifecycle|life ?strategy|balanced|\b20[2-7]\d\b/i;

  function suggest(i) {
    const text = [i.name, i.fund, i.accountType].filter(Boolean).join(' ');
    const all = text + ' ' + (i.category || '');
    let ticker = i.ticker, tickerWhy = '';
    if (!ticker) {
      const m = /MUTF:\s*([A-Z0-9.]{2,6})/i.exec(text);
      if (m) { ticker = m[1].toUpperCase(); tickerWhy = `found "${ticker}" in the name`; }
    }
    if (!ticker) {
      for (const tok of text.split(/[^A-Za-z0-9.]+/)) {
        const T = tok.toUpperCase();
        if (T.length >= 3 && KNOWN_T[T]) { ticker = T; tickerWhy = `found ticker ${T} in the name`; break; }
      }
    }
    if (!ticker) for (const [re, code] of FUND_CODES) if (re.test(all) && breakdown[code]) { ticker = code; tickerWhy = `matched to the ${code} fund breakdown`; break; }
    const pct = mix => Object.entries(mix).map(([c, w]) => [bucketOf(c), w]).reduce((m, [b, w]) => (m[b] = (m[b] || 0) + w, m), {});
    const fmtMix = mix => Object.entries(pct(mix)).sort((a, b) => b[1] - a[1]).map(([b, w]) => `${b} ${w.toFixed(1)}%`).join(', ');
    if (ticker && breakdown[ticker]) return { ticker, cls: '', why: `${tickerWhy ? tickerWhy + '; ' : ''}${ticker} is split using its fund breakdown (${fmtMix(breakdown[ticker].mix)})`, conf: 'high' };
    if (ticker && KNOWN_T[ticker] && KNOWN_T[ticker] !== 'MIXED') return { ticker, cls: KNOWN_T[ticker], why: `${tickerWhy ? tickerWhy + '; ' : ''}${ticker} is a known ${CLASS_LABEL[KNOWN_T[ticker]] || KNOWN_T[ticker]} fund`, conf: 'high' };
    if (ticker && KNOWN_T[ticker] === 'MIXED') return { ticker, cls: '', why: `${ticker} is a multi-asset fund; the daily sync will look up its mix`, conf: 'medium' };
    for (const [re, cls, why] of RULES) if (re.test(all)) {
      if (cls === 'Equities' && MIXED_RE.test(all)) break;
      return { ticker: ticker || '', cls, why: `${tickerWhy ? tickerWhy + '; ' : ''}${why}`, conf: 'medium' };
    }
    if (MIXED_RE.test(all)) return { ticker: ticker || '', cls: '', why: 'looks like a multi-asset retirement fund: add its mix in the Fund breakdown table (or a ticker)', conf: 'low' };
    return { ticker: ticker || '', cls: '', why: "couldn't tell: choose a bucket", conf: 'low' };
  }

  let tidyRows = [];
  function openTidy() {
    const list = $('tidyList'); list.textContent = ''; $('tidyErr').textContent = '';
    tidyRows = items.filter(i => i.kind === 'asset').map(i => ({ item: i, s: suggest(i) }));
    for (const r of tidyRows) {
      const { item: i, s } = r;
      const changes = (s.ticker || '') !== (i.ticker || '') || (s.cls || '') !== (i.assetClass || '');
      const row = document.createElement('div'); row.className = 'tidy-row' + (changes ? '' : ' same');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = changes; cb.setAttribute('aria-label', 'Apply to ' + i.name);
      const body = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 't-name'; nm.textContent = i.name;
      const was = document.createElement('div'); was.className = 't-was';
      was.textContent = `Now: ${i.category || 'no category'} · ticker ${i.ticker || 'none'} · ${i.assetClass ? (CLASS_LABEL[i.assetClass] || i.assetClass) : 'no bucket set'} → shows under ${mainBucket(i) === 'Multi-asset' ? 'Multi-asset funds' : mainBucket(i)}`;
      const inputs = document.createElement('div'); inputs.className = 't-inputs';
      const tk = document.createElement('input'); tk.type = 'text'; tk.value = s.ticker || ''; tk.placeholder = 'Ticker'; tk.maxLength = 12; tk.setAttribute('aria-label', 'Ticker for ' + i.name);
      const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Bucket for ' + i.name);
      fillClassSelect(sel, s.cls, 'Auto (fund breakdown / category)');
      const why = document.createElement('div'); why.className = 't-why' + (s.conf === 'low' ? ' warn' : ''); why.textContent = 'Why: ' + s.why;
      const touch = () => { cb.checked = true; row.classList.remove('same'); countTidy(); };
      tk.addEventListener('input', touch); sel.addEventListener('change', touch); cb.addEventListener('change', countTidy);
      inputs.append(tk, sel); body.append(nm, was, inputs, why); row.append(cb, body); list.append(row);
      Object.assign(r, { cb, tk, sel });
    }
    countTidy();
    $('tidyDlg').showModal();
  }
  function countTidy() { const n = tidyRows.filter(r => r.cb && r.cb.checked).length; $('tidyCount').textContent = `${n} of ${tidyRows.length} selected`; $('tidySave').disabled = !n; }
  $('tidyBtn').onclick = openTidy;
  $('tidySave').onclick = async () => {
    const changes = [];
    for (const r of tidyRows) {
      if (!r.cb.checked) continue;
      const t = r.tk.value.trim().toUpperCase();
      if (t && !TICKER_RE.test(t)) { $('tidyErr').textContent = `"${r.tk.value}" isn't a valid ticker (letters, numbers, dots or dashes).`; return; }
      const { id, ...rest } = r.item;
      changes.push({ id, d: clean({ ...rest, ticker: t, assetClass: r.sel.value }) });
    }
    try { await busy($('tidySave'), () => updateMany(changes)); $('tidyDlg').close(); render(); showBanner(`Saved ${changes.length} holding${changes.length === 1 ? '' : 's'}.`, 'info'); }
    catch (x) { $('tidyErr').textContent = x.message; }
  };

  // ---------- Item dialog ----------
  let editingId = null, editKind = 'asset', retStart = '';
  $('fUse5').onclick = () => { const it = items.find(i => i.id === editingId); if (it && it.ret5 !== null) $('fRate').value = String(Math.round(it.ret5 * 10) / 10); };
  function openItem(kind, item) {
    editKind = kind; editingId = item ? item.id : null;
    $('itemTitle').textContent = (item ? 'Edit ' : 'Add ') + kind;
    const sel = $('fCat'); sel.textContent = '';
    for (const c of catsFor(kind, item ? [item] : [])) { const o = document.createElement('option'); o.textContent = c; sel.append(o); }
    $('fName').value = item ? item.name : '';
    sel.value = item ? item.category : CATS[kind][0];
    $('fVal').value = item ? item.value : '';
    $('fCur').value = item ? item.currency : BASE_CUR;
    $('fNote').value = item ? item.note : '';
    $('fAcct').value = item ? item.accountType : '';
    $('fFund').value = item ? item.fund : '';
    $('fOwner').value = item ? item.owner : (ownerView || '');
    $('fTicker').value = item ? item.ticker : '';
    $('fClassWrap').hidden = kind === 'debt';
    fillClassSelect($('fClass'), item ? item.assetClass : '', item && item.ticker && breakdown[item.ticker] ? `Auto (${item.ticker} fund breakdown)` : 'Auto (from category)');
    $('fShares').value = item && item.shares !== null ? item.shares : '';
    $('fRate').value = item && item.rate !== null ? item.rate : '';
    $('fMonthly').value = item && item.monthly !== null ? item.monthly : '';
    $('fRet12').value = item && item.ret12 !== null ? item.ret12 : '';
    $('fRet5').value = item && item.ret5 !== null ? item.ret5 : '';
    $('fRetWrap').hidden = kind === 'debt';
    retStart = [$('fRet12').value, $('fRet5').value].join('|');
    const auto = item && item.retSource && !/^manual/i.test(item.retSource);
    $('fRetHint').textContent = !item ? 'Holdings with a ticker (or in bitcoin) get these from the daily sync each month. Otherwise, enter them yourself.'
      : /^manual/i.test(item.retSource) ? `Entered by you${item.retAsOf ? ' on ' + item.retAsOf : ''}. The sync leaves these alone.`
        : auto && item.ret12 !== null ? `From ${item.ticker || ({ BTC: 'bitcoin', XAU: 'gold' }[item.currency]) || 'its'}'s price history, to ${item.retAsOf || 'last month-end'} (total return, dividends reinvested). Typing a value keeps yours instead.`
          : auto ? `No price history found for ${item.ticker || 'this holding'}; enter the returns yourself if you know them.`
            : item.ticker || PRICED.includes(item.currency) ? 'The daily sync fills these in monthly. You can also enter them yourself.' : 'Enter the published returns if you know them, e.g. from the fund’s website.';
    const r5 = item && item.ret5 !== null ? item.ret5 : null;
    $('fUse5').hidden = kind === 'debt' || r5 === null || r5 < -50 || r5 > 50;
    if (r5 !== null) $('fUse5').textContent = `Use the 5-year average (${fmtPct(r5)})`;
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
  // Keep the sync's returns unless you change them; a changed value becomes yours (Manual) and the sync leaves it.
  function retFields() {
    const it = editingId ? items.find(i => i.id === editingId) : null;
    const keep = it ? { ret12: it.ret12, ret5: it.ret5, retAsOf: it.retAsOf, retSource: it.retSource } : { ret12: null, ret5: null, retAsOf: '', retSource: '' };
    if (editKind === 'debt' || [$('fRet12').value, $('fRet5').value].join('|') === retStart) return keep;
    const r12 = $('fRet12').value, r5 = $('fRet5').value;
    if (r12 === '' && r5 === '') return { ret12: null, ret5: null, retAsOf: '', retSource: '' };   // cleared: the sync may fill it again
    return { ret12: r12, ret5: r5, retAsOf: new Date().toISOString().slice(0, 10), retSource: 'Manual' };
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
      rate: $('fRate').value, monthly: $('fMonthly').value,
      assetClass: editKind === 'asset' ? $('fClass').value : '',
      currency: $('fCur').value,
      assetClassNote: editingId ? (items.find(i => i.id === editingId) || {}).assetClassNote : '',
      ...retFields()
    });
    if (editKind === 'asset' && (($('fRet12').value !== '' && d.ret12 === null) || ($('fRet5').value !== '' && d.ret5 === null))) { $('itemErr').textContent = 'Returns must be between -100% and 10000%.'; return; }
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
    store.del(VAULT_KEY); session = null; breakdown = {}; mode = 'local'; items = loadLocalItems(); fx = localFx();
    document.querySelectorAll('dialog[open]').forEach(d => d.close()); clearSecrets(); render();
    showBanner('Disconnected. For extra safety, you can also revoke the token at airtable.com/create/tokens.', 'info');
  }
  $('forgetBtn').onclick = disconnect;
  $('disconnectBtn').onclick = disconnect;
  $('lockNowBtn').onclick = () => lock();

  // ---------- Currency ----------
  const cur = $('currency');
  for (const c of CURRENCIES) {
    const o = document.createElement('option'); o.value = c; o.textContent = CUR_LABEL[c] || c; $('fCur').append(o);
    if (DISPLAY_CURRENCIES.includes(c)) { const d = document.createElement('option'); d.textContent = c; cur.append(d); }
  }
  cur.value = prefs.currency;
  cur.onchange = () => { if (DISPLAY_CURRENCIES.includes(cur.value)) { prefs.currency = cur.value; savePrefs(); render(); } };

  // Currencies that need a rate: those your holdings use, plus the display currency.
  const fxNeeded = () => [...new Set([...items.map(i => i.currency), prefs.currency])].filter(c => c !== BASE_CUR).sort((a, b) => CURRENCIES.indexOf(a) - CURRENCIES.indexOf(b));
  const fmtRate = r => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(r);
  const srcLabel = e => !e ? 'Not set yet' : e.source === 'Manual' ? `Set by you${e.asOf ? ' on ' + e.asOf : ''}` : `Daily rate${/ecb/i.test(e.source) ? ' (ECB)' : ''}${e.asOf ? ' · ' + e.asOf : ''}`;
  function renderFxNote(vis) {
    const note = $('fxNote'), need = fxNeeded();
    if (!need.length) { note.hidden = true; return; }
    const missing = need.filter(c => !rateOf(c)), left = vis.filter(i => i.noFx).length;
    note.classList.toggle('warn', missing.length > 0);
    if (missing.length) {
      const bits = [`No ${missing.join(', ')} exchange rate yet`];
      if (left) bits.push(`${left} holding${left === 1 ? '' : 's'} left out of the totals`);
      if (!rateOf(prefs.currency)) bits.push(`showing ${BASE_CUR} instead of ${prefs.currency}`);
      $('fxText').textContent = bits.join(': ') + '.';
    } else {
      const pairs = need.map(c => PRICED.includes(c) ? `${UNIT[c]} = ${fmtIn(1 / rateOf(c), BASE_CUR)}` : `1 ${BASE_CUR} = ${fmtRate(rateOf(c))} ${c}`).join(' · ');
      const dates = need.map(c => fx[c] && fx[c].asOf).filter(Boolean).sort();
      $('fxText').textContent = `Converted to ${dispCur()} at ${pairs}${dates.length ? ` (as of ${dates[0]})` : ''}.`;
    }
    note.hidden = false;
  }

  let fxRows = [];
  function openFx() {
    const list = $('fxList'); list.textContent = ''; $('fxErr').textContent = '';
    fxRows = fxNeeded().map(code => {
      const e = fx[code];
      const row = document.createElement('div'); row.className = 'fx-row';
      const priced = PRICED.includes(code);   // bitcoin: "1 BTC = $X" reads better than "1 USD = 0.0000121 BTC"
      const lab = document.createElement('label'); lab.htmlFor = 'fx-' + code; lab.textContent = priced ? `${UNIT[code]} =` : `1 ${BASE_CUR} =`;
      const inp = document.createElement('input'); inp.id = 'fx-' + code; inp.type = 'number'; inp.step = 'any'; inp.min = '0'; inp.inputMode = 'decimal';
      inp.value = e ? String(priced ? round(1 / e.rate, 2) : e.rate) : ''; inp.placeholder = 'e.g. ' + ({ AUD: '1.55', EUR: '0.92', GBP: '0.78', CAD: '1.38', NZD: '1.70', JPY: '150', BTC: '80000', XAU: '4000' }[code] || '1.00');
      const unit = document.createElement('span'); unit.textContent = priced ? BASE_CUR : code;
      const meta = document.createElement('div'); meta.className = 'fx-meta' + (e ? '' : ' warn'); meta.textContent = srcLabel(e);
      const r = { code, inp, start: inp.value, reset: false, priced };
      if (e && e.source === 'Manual' && mode === 'airtable') {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn'; b.textContent = 'Use the daily rate instead';
        b.onclick = () => { r.reset = true; meta.textContent = 'Will switch back to the daily rate at the next sync'; b.remove(); };
        meta.append(' · ', b);
      }
      row.append(lab, inp, unit, meta); list.append(row);
      return r;
    });
    if (!fxRows.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `All your holdings are in ${BASE_CUR}. Set a holding's currency in its edit form.`; list.append(p); }
    $('fxSub').hidden = !fxRows.length;
    $('fxSave').hidden = !fxRows.length;
    $('fxDlg').showModal();
  }
  $('fxBtn').onclick = openFx;
  $('fxForm').addEventListener('submit', async e => {
    e.preventDefault();
    const changes = [];
    for (const r of fxRows) {
      const t = r.inp.value.trim();
      const toRate = n => r.priced ? (n > 0 ? 1 / n : NaN) : n;
      if (r.reset && t === r.start) { changes.push({ code: r.code, rate: toRate(Number(t)), source: 'Auto' }); continue; }
      if (t === r.start) continue;
      const n = toRate(Number(t));
      if (!fxOk(n)) { $('fxErr').textContent = r.priced ? `Enter what ${UNIT[r.code].replace('1 ', 'one ')} is worth in ${BASE_CUR}.` : `Enter how many ${r.code} one ${BASE_CUR} buys, e.g. 1.55.`; r.inp.focus(); return; }
      changes.push({ code: r.code, rate: n, source: 'Manual' });
    }
    if (!changes.length) { $('fxDlg').close(); return; }
    try {
      await busy($('fxSave'), () => saveFx(changes));
      $('fxDlg').close(); render(); showBanner('Exchange rates saved.', 'info');
    } catch (x) {
      $('fxErr').textContent = /404|not found/i.test(x.message) ? `Your base has no "${FX_TABLE}" table yet (see the README).` : x.message;
    }
  });

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
  if (mode === 'local') fx = localFx();
  if (!window.crypto || !crypto.subtle) showBanner('This browser lacks the secure encryption features Holdings needs for Airtable. Make sure you’re on the https:// address.');
  render();
  if (mode === 'locked') openUnlock();
})();
