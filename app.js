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
      institution: String((raw && raw.institution) || '').trim().slice(0, 80),
      // debts: remaining term (to work out a payment) and a date the balance is forgiven regardless (e.g. a student loan)
      yearsLeft: (v => v !== null && v <= 100 ? v : null)(posOrNull(raw && raw.yearsLeft)),
      writeOff: (m => m ? m[1] + (m[2] ? '-' + m[2].padStart(2, '0') : '') : '')(/^\s*(\d{4})(?:[-\/.](\d{1,2}))?/.exec(String((raw && raw.writeOff) || ''))),
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
  let expenses = mode === 'local' ? loadLocalExpenses() : [];   // monthly living expenses
  let asides = mode === 'local' ? loadLocalAsides() : [];       // cash earmarked for goals (business capital, a deposit…)
  let lastActivity = Date.now();
  let failedUnlocks = 0;

  function loadLocalItems() {
    const s = parse(store.get(LOCAL_KEY));
    return s && Array.isArray(s.items) ? s.items.map(i => ({ id: String(i.id || uid()), ...clean(i) })) : [];
  }
  function loadLocalExpenses() {
    const s = parse(store.get(LOCAL_KEY));
    return s && Array.isArray(s.expenses) ? s.expenses.map(e => ({ id: String(e.id || uid()), ...cleanExp(e) })) : [];
  }
  function loadLocalAsides() {
    const s = parse(store.get(LOCAL_KEY));
    return s && Array.isArray(s.asides) ? s.asides.map(a => ({ id: String(a.id || uid()), ...cleanAside(a) })) : [];
  }
  function saveLocal() { store.set(LOCAL_KEY, JSON.stringify({ items, expenses, asides })); }
  function cleanAside(raw) {
    return {
      name: String((raw && raw.name) || '').trim().slice(0, 120) || 'Set-aside',
      amount: posOrNull(raw && raw.amount),
      currency: (c => PRICED.includes(c) ? BASE_CUR : c)(curOf(raw && raw.currency)),
      note: String((raw && raw.note) || '').trim().slice(0, 300)
    };
  }

  // A monthly living expense. Amount is per month in its currency; essential = needed even in an emergency.
  const EXP_CATS = ['Housing', 'Utilities', 'Groceries', 'Transport', 'Insurance', 'Health', 'Debt payments', 'Childcare & education', 'Phone & internet', 'Subscriptions', 'Dining & entertainment', 'Travel', 'Other'];
  function cleanExp(raw) {
    const ess = raw && raw.essential;
    return {
      name: String((raw && raw.name) || '').trim().slice(0, 120) || 'Expense',
      amount: posOrNull(raw && raw.amount),
      currency: (c => PRICED.includes(c) ? BASE_CUR : c)(curOf(raw && raw.currency)),
      category: String((raw && raw.category) || 'Other').trim().slice(0, 60) || 'Other',
      essential: ess === true || /^(true|yes|y|1|essential)$/i.test(String(ess || '').trim()),
      owner: String((raw && raw.owner) || '').trim().slice(0, 80),
      note: String((raw && raw.note) || '').trim().slice(0, 300)
    };
  }
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

  // Field names are matched without regard to case ("Written Off" works as "Written off"); writes use the spelling
  // your base actually has once we've seen it.
  const fieldNames = {};            // lower-case name -> the name as spelled in your base
  const FIELD_ALIASES = { 'written off': ['Written Off', 'Written-off', 'Write off', 'Write-off'], 'years left': ['Years Left'] };
  const caseless = r => {
    const f = r.fields || {}, low = {};
    for (const k of Object.keys(f)) { low[k.toLowerCase()] = f[k]; fieldNames[k.toLowerCase()] = k; }
    return new Proxy(f, { get: (t, k) => typeof k === 'string' && !(k in t) ? low[k.toLowerCase()] : t[k] });
  };
  const fromRecord = r => (r = { ...r, fields: caseless(r) }, {
    id: r.id,
    ...clean({
      name: r.fields.Name, kind: /^debt$/i.test(String(r.fields.Kind || '')) ? 'debt' : 'asset',
      category: r.fields.Category, value: r.fields.Value, note: r.fields.Note,
      accountType: r.fields['Account type'], fund: r.fields.Fund, owner: r.fields.Owner,
      ticker: r.fields.Ticker, shares: r.fields.Shares, price: r.fields.Price, pricedOn: r.fields['Priced on'],
      rate: r.fields['Expected return %'], monthly: r.fields['Monthly contribution'], assetClass: r.fields['Asset class'],
      currency: r.fields.Currency, institution: r.fields.Institution, yearsLeft: r.fields['Years left'], writeOff: r.fields['Written off'],
      ret12: r.fields['12-month return %'], ret5: r.fields['5-year return %'],
      retAsOf: r.fields['Return as of'], retSource: r.fields['Return source']
    })
  });
  // Optional columns your Items table may not have yet. If Airtable reports one as unknown, we stop sending it,
  // retry the save, and tell you which column to add (see itemsWrite).
  const OPTIONAL_FIELDS = ['Institution', 'Years left', 'Written off'];
  const missingFields = new Set();
  const toFields = d => {
    const f = toFieldsAll(d);
    if (!f.Institution) delete f.Institution;
    if (d.kind !== 'debt') { delete f['Years left']; delete f['Written off']; }
    for (const k of missingFields) delete f[k];
    for (const k of Object.keys(f)) { const real = fieldNames[k.toLowerCase()]; if (real && real !== k) { f[real] = f[k]; delete f[k]; } }
    return f;
  };
  async function itemsWrite(fn) {
    try { return await fn(); }
    catch (x) {
      const m = /Unknown field name: "([^"]+)"/i.exec(x.message || '');
      const base = m && OPTIONAL_FIELDS.find(o => o.toLowerCase() === m[1].toLowerCase());
      if (!m || !base || missingFields.has(base)) throw x;
      // try the other common spellings before giving up on the column
      const tried = fieldNames['~tried:' + base] || [], next = (FIELD_ALIASES[base.toLowerCase()] || []).find(a => a !== m[1] && !tried.includes(a));
      if (next) { fieldNames['~tried:' + base] = [...tried, m[1]]; fieldNames[base.toLowerCase()] = next; return itemsWrite(fn); }
      fieldNames[base.toLowerCase()] = base;
      missingFields.add(base); m[1] = base;
      const out = await fn();
      showBanner(`Saved, except "${m[1]}": add a single-line text field named “${m[1]}” to your Items table in Airtable so it can be stored.`, 'info');
      return out;
    }
  }
  const toFieldsAll = d => ({
    Name: d.name, Kind: d.kind === 'debt' ? 'Debt' : 'Asset', Category: d.category, Value: d.value, Note: d.note,
    'Account type': d.accountType, Fund: d.fund, Owner: d.owner, Ticker: d.ticker, Shares: d.shares,
    'Expected return %': d.rate, 'Monthly contribution': d.monthly, 'Asset class': d.assetClass || d.assetClassNote || null,
    Currency: d.currency && d.currency !== BASE_CUR ? d.currency : null, Institution: d.institution || null,
    'Years left': d.yearsLeft, 'Written off': d.writeOff || null,
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

  // ---------- Expenses table ----------
  const EXP_TABLE = 'Expenses';
  let expTableOk = false;
  const expPath = () => `${session.baseId}/${encodeURIComponent(EXP_TABLE)}`;
  const fromExpRecord = r => ({ id: r.id, ...cleanExp({ name: r.fields.Name, amount: r.fields['Monthly amount'], currency: r.fields.Currency,
    category: r.fields.Category, essential: r.fields.Essential, owner: r.fields.Owner, note: r.fields.Note }) });
  const toExpFields = d => ({ Name: d.name, 'Monthly amount': d.amount, Currency: d.currency !== BASE_CUR ? d.currency : null,
    Category: d.category, Essential: !!d.essential, Owner: d.owner || null, Note: d.note || null });
  async function atLoadExpenses() {
    const out = []; let offset = '';
    for (let page = 0; page < 20; page++) {
      const j = await at(`${expPath()}?pageSize=100${offset ? '&offset=' + encodeURIComponent(offset) : ''}`);
      for (const r of j.records || []) if (REC_RE.test(r.id) && r.fields) out.push(fromExpRecord(r));
      if (!j.offset) break;
      offset = String(j.offset);
    }
    return out;
  }
  async function addExpense(d) {
    if (mode === 'airtable') {
      const j = await at(expPath(), { method: 'POST', body: { records: [{ fields: toExpFields(d) }], typecast: true } });
      expenses.push(...(j.records || []).map(fromExpRecord));
    } else { expenses.push({ id: uid(), ...d }); saveLocal(); }
  }
  async function updateExpense(id, d) {
    if (mode === 'airtable') {
      if (!REC_RE.test(id)) throw new Error('Invalid record');
      const r = await at(`${expPath()}/${id}`, { method: 'PATCH', body: { fields: toExpFields(d), typecast: true } });
      const k = expenses.findIndex(x => x.id === id); if (k >= 0) expenses[k] = fromExpRecord(r);
    } else { const k = expenses.findIndex(x => x.id === id); if (k >= 0) expenses[k] = { id, ...d }; saveLocal(); }
  }
  async function removeExpense(id) {
    if (mode === 'airtable') { if (!REC_RE.test(id)) throw new Error('Invalid record'); await at(`${expPath()}/${id}`, { method: 'DELETE' }); }
    expenses = expenses.filter(x => x.id !== id);
    if (mode === 'local') saveLocal();
  }

  // ---------- Set-asides table ----------
  const ASIDE_TABLE = 'Set-asides';
  let asideTableOk = false;
  const asidePath = () => `${session.baseId}/${encodeURIComponent(ASIDE_TABLE)}`;
  const fromAsideRecord = r => ({ id: r.id, ...cleanAside({ name: r.fields.Name, amount: r.fields.Amount, currency: r.fields.Currency, note: r.fields.Note }) });
  const toAsideFields = d => ({ Name: d.name, Amount: d.amount, Currency: d.currency !== BASE_CUR ? d.currency : null, Note: d.note || null });
  async function atLoadAsides() {
    const j = await at(`${asidePath()}?pageSize=100`);
    return (j.records || []).filter(r => REC_RE.test(r.id) && r.fields).map(fromAsideRecord);
  }
  async function saveAside(id, d) {
    if (mode === 'airtable') {
      if (id) {
        if (!REC_RE.test(id)) throw new Error('Invalid record');
        const r = await at(`${asidePath()}/${id}`, { method: 'PATCH', body: { fields: toAsideFields(d), typecast: true } });
        const k = asides.findIndex(x => x.id === id); if (k >= 0) asides[k] = fromAsideRecord(r);
      } else {
        const j = await at(asidePath(), { method: 'POST', body: { records: [{ fields: toAsideFields(d) }], typecast: true } });
        asides.push(...(j.records || []).map(fromAsideRecord));
      }
    } else {
      if (id) { const k = asides.findIndex(x => x.id === id); if (k >= 0) asides[k] = { id, ...d }; } else asides.push({ id: uid(), ...d });
      saveLocal();
    }
  }
  async function removeAside(id) {
    if (mode === 'airtable') { if (!REC_RE.test(id)) throw new Error('Invalid record'); await at(`${asidePath()}/${id}`, { method: 'DELETE' }); }
    asides = asides.filter(x => x.id !== id);
    if (mode === 'local') saveLocal();
  }

  async function loadAirtable() {
    items = await atLoadAll();
    try { breakdown = await atLoadBreakdown(); }
    catch (x) { breakdown = {}; }                        // the table is optional; the app works without it
    try { asides = await atLoadAsides(); asideTableOk = true; }
    catch (x) { asides = []; asideTableOk = false; }
    try { expenses = await atLoadExpenses(); expTableOk = true; }
    catch (x) { expenses = []; expTableOk = false; }
    try { fx = await atLoadFx(); fxTableOk = true; }
    catch (x) { fx = {}; fxTableOk = false; }
    try { nwHistory = await atLoadHistory(); } catch (x) { nwHistory = []; }
    try { macroData = await atLoadMacro(); } catch (x) { macroData = {}; }
    await loadScenarios();
  }

  async function atCreateMany(list) {
    const created = [];
    for (let i = 0; i < list.length; i += 10) {
      const j = await itemsWrite(() => at(tablePath(session), { method: 'POST', body: { records: list.slice(i, i + 10).map(d => ({ fields: toFields(d) })), typecast: true } }));
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
      const r = await itemsWrite(() => at(`${tablePath(session)}/${id}`, { method: 'PATCH', body: { fields: toFields(d), typecast: true } }));
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
    session = null; items = []; expenses = []; asides = []; scenarios = []; scSel = 'asis'; scDirty = false; nwHistory = []; macroData = {}; balancedCache = null; breakdown = {}; fx = {}; mode = 'locked';
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
    const bits = [cat, i.accountType, i.fund !== i.name ? i.fund : '', sh, i.owner, priced, ret, planText(i)].filter(Boolean);
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

  function renderDebtPlan() {
    const el = $('debtPlan'), debts = visible().filter(i => i.kind === 'debt' && i.value > 0);
    if (!debts.length) { el.textContent = ''; return; }
    const plans = debts.map(i => ({ i, p: debtPlan(i) }));
    const stuck = plans.filter(x => x.p.end === null), last = Math.max(...plans.filter(x => x.p.end !== null).map(x => x.p.end), -1);
    const forgiven = plans.filter(x => x.p.forgiven > 0.5).map(x => `${x.i.name} (~${fmtIn(x.p.forgiven, x.i.currency)})`);
    el.textContent = (last >= 0 ? `Debt-free by ${monthLabel(last)}${stuck.length ? `, except ${stuck.map(x => x.i.name).join(', ')}` : ''}.` : 'Add payments, years left or a write-off date to see when your debts end.')
      + (forgiven.length ? ` Written off along the way: ${forgiven.join(', ')}.` : '') + (stuck.length && last >= 0 ? ' Add a payment, years left or write-off date for the rest.' : '');
  }

  function renderMix() { $('assetMix').textContent = ''; }   // superseded by the Returns panel

  // ---------- Macro exposure: by country and by currency ----------
  // Look-through, net of debts. Each holding is split by its asset classes (fund breakdown > Asset class > category),
  // then each class is placed in a country and a currency:
  //  - US stocks/bonds: United States, USD.
  //  - International stocks: the world market minus the fund's home country (approximate index weights), in those
  //    countries' currencies (assumed unhedged). International bonds: same countries, but in the fund's own currency
  //    (international bond funds are usually currency-hedged).
  //  - Unspecified shares/bonds: in a US fund, the whole world market; in a non-US fund, its home market.
  //  - Cash, property and "other": the holding's home country and currency. Gold and bitcoin are stateless: their own
  //    "currencies" (XAU, BTC). Commodities: global, priced in USD. Debts subtract in their own country and currency.
  const WORLD = { 'United States': 64, 'Japan': 5, 'United Kingdom': 3.5, 'Eurozone': 7.5, 'Canada': 3, 'Switzerland': 2.3,
    'Australia': 1.8, 'China': 2.5, 'Taiwan': 2, 'India': 2, 'Other countries': 6.4 };   // ≈ global stock market weights
  const COUNTRY_CUR = { 'United States': 'USD', 'Japan': 'JPY', 'United Kingdom': 'GBP', 'Eurozone': 'EUR', 'Canada': 'CAD',
    'Switzerland': 'CHF', 'Australia': 'AUD', 'China': 'CNY', 'Taiwan': 'TWD', 'India': 'INR', 'Other countries': 'Other',
    'New Zealand': 'NZD', 'Singapore': 'SGD', 'Hong Kong': 'HKD' };
  const HOME_OF = { USD: 'United States', AUD: 'Australia', GBP: 'United Kingdom', EUR: 'Eurozone', CAD: 'Canada', NZD: 'New Zealand',
    JPY: 'Japan', CHF: 'Switzerland', SGD: 'Singapore', HKD: 'Hong Kong', INR: 'India' };
  const CUR_NAME = { USD: 'US dollar', AUD: 'Australian dollar', GBP: 'British pound', EUR: 'Euro', CAD: 'Canadian dollar', NZD: 'NZ dollar',
    JPY: 'Japanese yen', CHF: 'Swiss franc', SGD: 'Singapore dollar', HKD: 'Hong Kong dollar', INR: 'Indian rupee', CNY: 'Chinese yuan',
    TWD: 'Taiwan dollar', XAU: 'Gold', BTC: 'Bitcoin', Other: 'Other currencies' };
  function worldExcept(home) {
    const m = { ...WORLD }; delete m[home];
    const t = Object.values(m).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(m).map(([k, w]) => [k, w / t]));
  }
  const curMix = countries => { const out = {}; for (const [k, w] of Object.entries(countries)) { const c = COUNTRY_CUR[k] || 'Other'; out[c] = (out[c] || 0) + w; } return out; };
  function exposures(list) {
    const country = {}, currency = {};
    const add = (map, k, v) => { const e = map[k] || (map[k] = { assets: 0, debts: 0 }); if (v >= 0) e.assets += v; else e.debts -= v; };
    for (const i of list) {
      if (!(i.value > 0)) continue;
      const cur = i.currency, home = HOME_OF[cur] || 'Global';
      if (i.kind === 'debt') { add(country, home, -i.value); add(currency, PRICED.includes(cur) ? cur : cur, -i.value); continue; }
      for (const [cls, w] of Object.entries(mixFor(i))) {
        const v = i.value * w / 100;
        let ctry, curr;
        if (cls === 'US stocks' || cls === 'US bonds') { ctry = { 'United States': 1 }; curr = { USD: 1 }; }
        else if (cls === 'International stocks') { ctry = worldExcept(cur === 'USD' ? 'United States' : home); curr = curMix(ctry); }
        else if (cls === 'International bonds') { ctry = worldExcept(cur === 'USD' ? 'United States' : home); curr = { [cur]: 1 }; }
        else if (cls === 'Equities' || cls === 'Bonds') {
          if (cur === 'USD' || !HOME_OF[cur]) { const wm = Object.fromEntries(Object.entries(WORLD).map(([k, x]) => [k, x / 100])); ctry = wm; curr = cls === 'Equities' ? curMix(wm) : { USD: 1 }; }
          else { ctry = { [home]: 1 }; curr = { [cur]: 1 }; }
        }
        else if (cls === 'Gold') { ctry = { 'Global: gold': 1 }; curr = { XAU: 1 }; }
        else if (cls === 'Bitcoin' || cls === 'Crypto') { ctry = { 'Global: crypto': 1 }; curr = { BTC: 1 }; }
        else if (cls === 'Commodities') { ctry = { 'Global: commodities': 1 }; curr = { USD: 1 }; }
        else { ctry = { [home]: 1 }; curr = { [PRICED.includes(cur) ? cur : cur]: 1 }; }   // cash, property, other
        for (const [k, f] of Object.entries(ctry)) add(country, k, v * f);
        for (const [k, f] of Object.entries(curr)) add(currency, k, v * f);
      }
    }
    return { country, currency };
  }
  function drawExposure(el, map, nw, labelOf, title) {
    el.textContent = '';
    const rows = Object.entries(map).map(([k, e]) => ({ k, net: e.assets - e.debts, ...e })).filter(r => Math.abs(r.net) > 0.5 || r.assets > 0.5)
      .sort((a, b) => b.net - a.net);
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.net)), 1), hasNeg = rows.some(r => r.net < 0);
    const posMax = Math.max(0, ...rows.map(r => r.net)), negMax = Math.max(0, ...rows.map(r => -r.net));
    const zero = hasNeg ? negMax / (posMax + negMax) * 100 : 0;
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'xp-row';
      row.title = `${[].concat(labelOf(r.k)).join(' ')}: assets ${fmt(r.assets)}${r.debts ? `, debts ${fmt(r.debts)}` : ''}, net ${fmt(r.net)}`;
      const name = document.createElement('span'); name.className = 'xp-name';
      const [main, sub] = [].concat(labelOf(r.k)); name.textContent = main;
      if (sub) { const sm = document.createElement('small'); sm.textContent = ' ' + sub; name.append(sm); }
      const track = document.createElement('span'); track.className = 'xp-track';
      const bar = document.createElement('i'); bar.className = r.net < 0 ? 'xp-neg' : 'xp-pos';
      const span = (posMax + negMax) || maxAbs, w = Math.abs(r.net) / span * 100;
      bar.style.width = w + '%'; bar.style.left = (r.net < 0 ? zero - w : zero) + '%';
      if (hasNeg) { const z = document.createElement('b'); z.className = 'xp-zero'; z.style.left = zero + '%'; track.append(z); }
      track.append(bar);
      const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = fmt(r.net);
      const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = nw > 0 ? Math.round(r.net / nw * 100) + '%' : '';
      row.append(name, track, amt, pct); el.append(row);
    }
    el.setAttribute('aria-label', title + ': ' + rows.map(r => `${[].concat(labelOf(r.k)).join(' ')} ${nw > 0 ? Math.round(r.net / nw * 100) + '%' : fmt(r.net)}`).join(', '));
    return rows;
  }
  function renderExposure() {
    const sec = $('xpSection'); if (mode === 'locked') { sec.hidden = true; return; }
    const list = visible().filter(i => !i.noFx);
    const { country, currency } = exposures(list);
    const nw = list.reduce((a, i) => a + (i.kind === 'debt' ? -i.value : i.value), 0);
    if (!list.some(i => i.kind === 'asset' && i.value > 0)) { sec.hidden = true; return; }
    sec.hidden = false;
    const SHORT = { 'United States': 'US', 'United Kingdom': 'UK', 'Other countries': 'Other countries' };
    const crow = drawExposure($('xpCountry'), country, nw, k => SHORT[k] || k, 'Net worth by country');
    const xrow = drawExposure($('xpCurrency'), currency, nw, k => k === 'Other' ? 'Other' : [k, CUR_NAME[k] || ''], 'Net worth by currency');
    // headline facts
    const topC = crow[0], foreign = crow.filter(r => !r.k.startsWith('Global')).length;
    $('xpCountryNote').textContent = topC && nw > 0 ? `${Math.round(topC.net / nw * 100)}% of your net worth is tied to ${SHORT[topC.k] || topC.k}, across ${foreign} countr${foreign === 1 ? 'y' : 'ies'}.` : '';
    // spending vs holdings currency mismatch (from the Expenses table)
    const spend = {}; let spendT = 0;
    for (const e of expView()) if (e.monthly) { spend[e.currency] = (spend[e.currency] || 0) + e.monthly; spendT += e.monthly; }
    if (!spendT) { spend[dispCur()] = 1; spendT = 1; }
    const spendTxt = Object.entries(spend).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${Math.round(v / spendT * 100)}% ${c}`).join(', ');
    const outside = xrow.filter(r => !spend[r.k]).reduce((a, r) => a + r.net, 0);
    $('xpSpend').textContent = nw > 0 ? `You spend in ${spendTxt}${expView().some(e => e.monthly) ? '' : ' (your display currency; add expenses to refine)'}. ${Math.round(outside / nw * 100)}% of your net worth sits in other currencies or in gold and bitcoin, so exchange-rate moves change what it buys for you.` : '';
    const intl = list.some(i => i.kind === 'asset' && Object.keys(mixFor(i)).some(c => c.startsWith('International') || c === 'Equities'));
    $('xpNote').textContent = 'Look-through estimates, net of debts.' + (intl ? ' International and global shares are split using approximate world stock-market weights, assumed unhedged; international bonds are assumed hedged to the fund’s currency.' : '') + ' Unspecified shares in a non-US fund (e.g. Aware Super’s) are counted as its home market.';
  }

  // ---------- Counterparty risk ----------
  // Who would you be exposed to if an institution failed? Each asset is assigned to an institution (its Institution
  // field, or a guess from its name / account / fund / note), then classified:
  //  - insured: bank deposits within the deposit-insurance limit (FDIC US$250k, FCS A$250k, FSCS £120k per depositor
  //    per bank; joint accounts count twice);
  //  - segregated: assets a broker, retirement plan or super fund holds for you in custody or trust (not lent to the
  //    institution; SIPC adds up to US$500k cover if a US broker fails with assets missing);
  //  - uninsured: deposits above the limit, and anything at a crypto exchange;
  //  - held directly: property, physical gold, self-custodied bitcoin.
  const INST = [
    // US banks (FDIC)
    { re: /ivy\s*bank/i, name: 'Ivy Bank', kind: 'bank' }, { re: /\bsofi\b/i, name: 'SoFi Bank', kind: 'bank' },
    { re: /\bamex\b|american express/i, name: 'American Express', kind: 'bank' }, { re: /\bchase\b|jp\s*morgan/i, name: 'Chase', kind: 'bank' },
    { re: /bank of america|\bbofa\b/i, name: 'Bank of America', kind: 'bank' }, { re: /wells\s*fargo/i, name: 'Wells Fargo', kind: 'bank' },
    { re: /\bciti(bank)?\b/i, name: 'Citi', kind: 'bank' }, { re: /capital\s*one/i, name: 'Capital One', kind: 'bank' },
    { re: /\bally\b/i, name: 'Ally', kind: 'bank' }, { re: /\bmarcus\b|goldman/i, name: 'Marcus (Goldman Sachs)', kind: 'bank' },
    { re: /\bdiscover\b/i, name: 'Discover', kind: 'bank' }, { re: /\bbarclays\b/i, name: 'Barclays', kind: 'bank' },
    { re: /\bhsbc\b/i, name: 'HSBC', kind: 'bank' }, { re: /\bwise\b/i, name: 'Wise', kind: 'emoney' },
    // US brokers & plan recordkeepers
    { re: /vanguard/i, name: 'Vanguard', kind: 'broker' }, { re: /fidelity/i, name: 'Fidelity', kind: 'broker' },
    { re: /schwab/i, name: 'Schwab', kind: 'broker' }, { re: /e\*?\s*trade/i, name: 'E*Trade', kind: 'broker' },
    { re: /robinhood/i, name: 'Robinhood', kind: 'broker' }, { re: /interactive brokers|\bibkr\b/i, name: 'Interactive Brokers', kind: 'broker' },
    { re: /merrill/i, name: 'Merrill', kind: 'broker' }, { re: /empower/i, name: 'Empower', kind: 'plan' },
    { re: /principal/i, name: 'Principal', kind: 'plan' }, { re: /\bvoya\b/i, name: 'Voya', kind: 'plan' }, { re: /\btiaa\b/i, name: 'TIAA', kind: 'plan' },
    // Australia
    { re: /\bnab\b|national australia/i, name: 'NAB', kind: 'bank' }, { re: /\bcba\b|commonwealth bank|commbank/i, name: 'Commonwealth Bank', kind: 'bank' },
    { re: /westpac/i, name: 'Westpac', kind: 'bank' }, { re: /\banz\b/i, name: 'ANZ', kind: 'bank' }, { re: /macquarie/i, name: 'Macquarie', kind: 'bank' },
    { re: /\bing\b/i, name: 'ING', kind: 'bank' }, { re: /\bubank\b/i, name: 'ubank', kind: 'bank' },
    { re: /aware\s*super/i, name: 'Aware Super', kind: 'super' }, { re: /australian\s*super/i, name: 'AustralianSuper', kind: 'super' },
    { re: /hostplus/i, name: 'Hostplus', kind: 'super' }, { re: /unisuper/i, name: 'UniSuper', kind: 'super' }, { re: /\brest\b super/i, name: 'Rest', kind: 'super' },
    // UK
    { re: /lloyds/i, name: 'Lloyds', kind: 'bank' }, { re: /monzo/i, name: 'Monzo', kind: 'bank' }, { re: /nationwide/i, name: 'Nationwide', kind: 'bank' },
    { re: /hargreaves/i, name: 'Hargreaves Lansdown', kind: 'broker' },
    // crypto
    { re: /coinbase/i, name: 'Coinbase', kind: 'crypto' }, { re: /kraken/i, name: 'Kraken', kind: 'crypto' }, { re: /binance/i, name: 'Binance', kind: 'crypto' },
  ];
  const DEPOSIT_LIMIT = { USD: { amt: 250000, cur: 'USD', scheme: 'FDIC' }, AUD: { amt: 250000, cur: 'AUD', scheme: 'FCS' }, GBP: { amt: 120000, cur: 'GBP', scheme: 'FSCS' } };
  // Which institution holds this asset, and how it's protected.
  function institutionOf(i) {
    const direct = (mainBucket(i) === 'Property' && !i.ticker) || PRICED.includes(i.currency) || /^owned$/i.test(i.category || '');
    const byName = n => INST.find(x => x.re.test(n));
    if (/^\s*(own|owned|self|myself|me|held directly|self[- ]?custody|home|cold wallet)\s*$/i.test(i.institution || '')) return { name: 'Held directly', kind: 'direct', guessed: false };
    let name = i.institution, guessed = false, known = name ? byName(name) : null;
    if (!name) {
      if (direct) return { name: 'Held directly', kind: 'direct', guessed: false };
      const hit = [i.accountType, i.name, i.fund, i.note].map(t => t && byName(t)).find(Boolean);
      if (hit) { name = hit.name; known = hit; guessed = true; }
    }
    if (!name) return { name: 'Institution not set', kind: 'unknown', guessed: false };
    const cash = mainBucket(i) === 'Cash';
    let kind = known ? known.kind : (cash ? 'bank' : /retire|401|ira|pension|super/i.test([i.category, i.accountType].join(' ')) ? 'plan' : 'broker');
    if (kind === 'broker' && /retire|401|403|457/i.test([i.category, i.accountType].join(' ')) && i.currency !== 'AUD') kind = 'plan';
    return { name: known && !i.institution ? known.name : name, kind, guessed };
  }
  const KIND_LABEL = { bank: 'Bank deposits', broker: 'Brokerage (custody)', plan: 'Retirement plan (trust)', super: 'Super fund (trust)',
    crypto: 'Crypto exchange', emoney: 'E-money (safeguarded)', direct: 'You hold it', unknown: 'Add an institution' };
  function counterparty(list) {
    const inst = {};
    for (const i of list) {
      if (i.kind !== 'asset' || !(i.value > 0)) continue;
      const g = institutionOf(i);
      const e = inst[g.name] || (inst[g.name] = { name: g.name, kinds: new Set(), guessed: false, total: 0, insured: 0, segregated: 0, uninsured: 0, direct: 0, deposits: {}, n: 0 });
      e.kinds.add(g.kind); e.guessed = e.guessed || g.guessed; e.total += i.value; e.n++;
      if (g.kind === 'bank') {
        const owner = i.owner || 'Myself', key = i.currency + '|' + owner;
        (e.deposits[key] = e.deposits[key] || { cur: i.currency, owner, v: 0 }).v += i.value;
      } else if (g.kind === 'broker' || g.kind === 'plan' || g.kind === 'super' || g.kind === 'emoney') e.segregated += i.value;
      else if (g.kind === 'crypto') e.uninsured += i.value;
      else e.direct += i.value;   // held directly or institution not set
    }
    for (const e of Object.values(inst)) {
      e.limits = [];
      for (const d of Object.values(e.deposits)) {
        const L = DEPOSIT_LIMIT[d.cur];
        if (!L) { e.uninsured += d.v; continue; }
        const lim = conv(L.amt, L.cur) * (/^joint$/i.test(d.owner) ? 2 : 1);
        const ins = Math.min(d.v, lim || 0); e.insured += ins; e.uninsured += d.v - ins;
        e.limits.push(`${L.scheme} ${fmtIn(L.amt * (/^joint$/i.test(d.owner) ? 2 : 1), L.cur)}${/^joint$/i.test(d.owner) ? ' (joint)' : ''}`);
      }
    }
    return Object.values(inst).sort((a, b) => b.total - a.total);
  }
  function renderCounterparty() {
    const sec = $('cpSection'), el = $('cpList');
    if (mode === 'locked') { sec.hidden = true; return; }
    const list = visible().filter(i => !i.noFx);
    const rows = counterparty(list), total = rows.reduce((a, r) => a + r.total, 0);
    if (!rows.length || !total) { sec.hidden = true; return; }
    sec.hidden = false; el.textContent = '';
    const max = Math.max(...rows.map(r => r.total));
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'cp-row';
      const head = document.createElement('div'); head.className = 'cp-head';
      const nm = document.createElement('span'); nm.className = 'cp-name'; nm.textContent = r.name + (r.guessed ? ' *' : '');
      const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = fmt(r.total);
      const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = Math.round(r.total / total * 100) + '%';
      head.append(nm, amt, pct);
      const bar = document.createElement('div'); bar.className = 'cp-bar'; bar.style.width = Math.max(2, r.total / max * 100) + '%';
      for (const [cls, v, lab] of [['cp-ins', r.insured, 'Insured'], ['cp-seg', r.segregated, 'Held in custody/trust'], ['cp-un', r.uninsured, 'Uninsured'], ['cp-dir', r.direct, r.name === 'Institution not set' ? 'Institution not set' : 'Held directly']]) {
        if (v <= 0.5) continue;
        const seg = document.createElement('i'); seg.className = cls; seg.style.width = (v / r.total * 100) + '%'; seg.title = `${lab}: ${fmt(v)}`; bar.append(seg);
      }
      const meta = document.createElement('div'); meta.className = 'cp-meta';
      const kinds = [...r.kinds].map(k => KIND_LABEL[k]);
      const bits = [kinds.join(' + ')];
      if (r.limits.length) bits.push([...new Set(r.limits)].join(', ') + ' cover');
      if (r.uninsured > 0.5) bits.push(`${fmt(r.uninsured)} uninsured`);
      if (r.kinds.has('broker') && r.segregated) bits.push('SIPC up to $500k if the broker fails');
      if (r.name === 'Institution not set') bits.push(`${r.n} holding${r.n === 1 ? '' : 's'}: set Institution in the edit form`);
      meta.textContent = bits.join(' · ');
      if (r.uninsured > 0.5) meta.classList.add('warn-text');
      row.append(head, bar, meta); el.append(row);
    }
    const unins = rows.reduce((a, r) => a + (r.kinds.has('crypto') ? 0 : r.uninsured), 0), uninsBanks = rows.filter(r => r.kinds.has('bank') && r.uninsured > 0.5);
    const top = rows.find(r => r.name !== 'Held directly' && r.name !== 'Institution not set');
    $('cpUninsured').textContent = fmt(unins);
    $('cpUninsuredSub').textContent = unins > 0.5 ? `Bank deposits above the insurance limit at ${uninsBanks.map(r => r.name).join(', ')}.` : 'All your bank deposits are within their insurance limits.';
    $('cpTop').textContent = top ? Math.round(top.total / total * 100) + '%' : '—';
    $('cpTopSub').textContent = top ? `${top.name} is your largest single institution (${fmt(top.total)}).` : '';
    const guessed = rows.some(r => r.guessed);
    $('cpNote').textContent = (guessed ? '* Institution guessed from the holding’s name or account; set it in the edit form to confirm. ' : '') +
      'Limits are per depositor, per bank, per ownership category (joint accounts count as two depositors). Brokerage, 401(k) and super assets are held for you in custody or trust, so they aren’t a loan to the institution. Check each bank is a member of its scheme. A guide, not legal advice.';
  }

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

  // ---------- Emergency fund ----------
  // Months of cover = emergency-fund holdings ÷ monthly spending, both in the display currency. By default the fund
  // is every holding in the Cash bucket; you can pick holdings instead (kept in this browser's preferences).
  const EF = prefs.ef = Object.assign({ mode: 'cash', ids: [] }, prefs.ef || {});
  const efHoldings = () => {
    const assets = visible().filter(i => i.kind === 'asset');
    return EF.mode === 'custom' ? assets.filter(i => EF.ids.includes(i.id)) : assets.filter(i => mainBucket(i) === 'Cash');
  };
  const expView = () => expenses.map(e => { const v = e.amount === null ? null : conv(e.amount, e.currency); return { ...e, monthly: v, noFx: e.amount !== null && v === null }; });
  const fmtMonths = m => m >= 100 ? '99+' : (m >= 10 ? Math.round(m).toString() : m.toFixed(1));

  function renderEmergency() {
    const sec = $('efSection'); if (mode === 'locked') { sec.hidden = true; return; }
    sec.hidden = false;
    const fund = efHoldings(), cashTotal = fund.reduce((a, i) => a + i.value, 0);
    const av = asides.map(a => ({ ...a, v: a.amount === null ? null : conv(a.amount, a.currency) }));
    const setAside = av.reduce((t, a) => t + (a.v || 0), 0);
    const fundTotal = Math.max(0, cashTotal - setAside);
    renderAsides(av, cashTotal, setAside, fundTotal);
    const ex = expView(), set = ex.filter(e => e.monthly !== null);
    const essential = set.filter(e => e.essential).reduce((a, e) => a + e.monthly, 0), all = set.reduce((a, e) => a + e.monthly, 0);
    const base = essential || all, m = base ? fundTotal / base : null;
    $('efMonths').textContent = m === null ? '—' : fmtMonths(m);
    $('efUnit').textContent = m === null ? '' : (m === 1 ? ' month' : ' months');
    $('efSub').textContent = !ex.length ? 'Add your monthly living expenses below to see how long your emergency fund lasts.'
      : !base ? 'Enter amounts for your expenses to see your months of cover.'
        : `${fmt(fundTotal)} emergency fund ÷ ${fmt(base)}/month of ${essential ? 'essential' : 'total'} spending.`;
    $('efAll').textContent = essential && all > essential ? `${fmtMonths(fundTotal / all)} months if you keep all spending (${fmt(all)}/month).` : '';
    // meter: 0–12 months, marks at 3 and 6 (a common guideline)
    const bar = $('efBar'); bar.textContent = '';
    if (m !== null) {
      const fill = document.createElement('div'); fill.className = 'ef-fill'; fill.style.width = Math.min(100, m / 12 * 100) + '%'; bar.append(fill);
      for (const t of [3, 6]) { const k = document.createElement('i'); k.className = 'ef-tick'; k.style.left = (t / 12 * 100) + '%'; k.title = t + ' months'; bar.append(k); }
    }
    $('efScale').hidden = m === null;
    $('efVerdict').textContent = m === null ? '' : m < 3 ? 'Below the common 3–6 month guideline.' : m <= 6 ? 'Within the common 3–6 month guideline.' : 'Above the common 3–6 month guideline.';
    $('efFundInfo').textContent = (EF.mode === 'custom' ? `Counting ${fund.length} chosen holding${fund.length === 1 ? '' : 's'}` : `Counting your ${fund.length} cash holding${fund.length === 1 ? '' : 's'}`) + (ownerView ? ` for ${ownerView}` : '') + '. ';
    // expense list grouped by category
    const el = $('efList');
    if (mode === 'airtable' && !expTableOk) { el.innerHTML = `<div class="empty">Your base has no “${esc(EXP_TABLE)}” table yet (see the README).</div>`; return; }
    if (!ex.length) { el.innerHTML = '<div class="empty">No expenses yet.</div>'; return; }
    const cats = [...EXP_CATS.filter(c => ex.some(e => e.category === c)), ...[...new Set(ex.map(e => e.category))].filter(c => !EXP_CATS.includes(c))];
    el.innerHTML = cats.map(c => {
      const g = ex.filter(e => e.category === c), sumG = g.reduce((a, e) => a + (e.monthly || 0), 0);
      return `<div class="group"><div class="group-head"><span>${esc(c)}</span><span class="amt">${esc(fmt(sumG))}/mo</span></div>` +
        g.map(e => `<div class="row"><div><div class="name">${esc(e.name)}${e.essential ? ' <span class="tag">Essential</span>' : ''}</div>` +
          `${[e.owner, e.note].filter(Boolean).length ? `<div class="meta">${[e.owner, e.note].filter(Boolean).map(b => `<span>${esc(b)}</span>`).join('')}</div>` : ''}</div>` +
          `<div><div class="amt">${e.amount === null ? '<span class="muted">not set</span>' : e.noFx ? '—' : esc(fmt(e.monthly))}</div>` +
          `${e.amount !== null && e.currency !== dispCur() ? `<div class="native${e.noFx ? ' warn' : ''}">${esc(fmtIn(e.amount, e.currency))}${e.noFx ? ' · no rate' : ''}</div>` : ''}</div>` +
          `<button class="icon-btn" type="button" data-exp="${esc(e.id)}" aria-label="Edit ${esc(e.name)}">✎</button></div>`).join('') + '</div>';
    }).join('');
  }

  // expense dialog
  let editingExp = null;
  function openExpense(e) {
    editingExp = e ? e.id : null;
    $('expTitle').textContent = e ? 'Edit expense' : 'Add expense';
    const cat = $('eCat'); cat.textContent = '';
    for (const c of [...new Set([...EXP_CATS, ...(e && !EXP_CATS.includes(e.category) ? [e.category] : [])])]) { const o = document.createElement('option'); o.textContent = c; cat.append(o); }
    $('eName').value = e ? e.name : ''; cat.value = e ? e.category : 'Housing';
    $('eAmt').value = e && e.amount !== null ? e.amount : ''; $('eCur').value = e ? e.currency : (dispCur());
    $('eEss').checked = e ? e.essential : true; $('eOwner').value = e ? e.owner : ''; $('eNote').value = e ? e.note : '';
    $('expDel').hidden = !e; $('expErr').textContent = '';
    $('expDlg').showModal();
  }
  $('expAdd').onclick = () => {
    if (mode === 'airtable' && !expTableOk) return showBanner(`Your base has no “${EXP_TABLE}” table yet (see the README).`);
    openExpense(null);
  };
  $('expForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!$('eName').value.trim()) { $('expErr').textContent = 'Please enter a name.'; return; }
    if ($('eAmt').value !== '' && posOrNull($('eAmt').value) === null) { $('expErr').textContent = 'Enter a monthly amount of 0 or more.'; return; }
    const d = cleanExp({ name: $('eName').value, amount: $('eAmt').value, currency: $('eCur').value, category: $('eCat').value,
      essential: $('eEss').checked, owner: $('eOwner').value, note: $('eNote').value });
    try { await busy($('expSave'), () => editingExp ? updateExpense(editingExp, d) : addExpense(d)); $('expDlg').close(); render(); }
    catch (x) { $('expErr').textContent = x.message; }
  });
  $('expDel').onclick = async () => {
    const e = expenses.find(x => x.id === editingExp);
    if (!e || !confirm(`Delete “${e.name}”?`)) return;
    try { await busy($('expDel'), () => removeExpense(e.id)); $('expDlg').close(); render(); }
    catch (x) { $('expErr').textContent = x.message; }
  };
  // choose which holdings count as the emergency fund
  function openEfPick() {
    const list = $('efPickList'); list.textContent = '';
    const assets = items.filter(i => i.kind === 'asset').map(i => visible().find(v => v.id === i.id) || i);
    const chosen = EF.mode === 'custom' ? EF.ids : assets.filter(i => mainBucket(i) === 'Cash').map(i => i.id);
    for (const i of assets) {
      const row = document.createElement('label'); row.className = 'check';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = i.id; cb.checked = chosen.includes(i.id);
      const t = document.createElement('span'); t.textContent = `${i.name} · ${mainBucket(i)}${i.value ? ' · ' + fmt(i.value) : ''}`;
      row.append(cb, t); list.append(row);
    }
    $('efPickDlg').showModal();
  }
  $('efPick').onclick = openEfPick;
  $('efPickCash').onclick = () => { EF.mode = 'cash'; EF.ids = []; savePrefs(); $('efPickDlg').close(); render(); };
  $('efPickSave').onclick = () => { EF.mode = 'custom'; EF.ids = [...$('efPickList').querySelectorAll('input:checked')].map(c => c.value); savePrefs(); $('efPickDlg').close(); render(); };

  // Set-asides: Total cash − earmarked amounts = the emergency fund.
  function renderAsides(av, cashTotal, setAside, fundTotal) {
    const el = $('efCalc'); el.textContent = '';
    if (!av.length) { $('efCalc').hidden = true; return; }
    $('efCalc').hidden = false;
    const line = (label, amount, cls, id, sub) => {
      const r = document.createElement('div'); r.className = 'ef-line ' + (cls || '');
      const n = document.createElement('span'); n.textContent = label;
      if (sub) { const sm = document.createElement('small'); sm.textContent = ' ' + sub; n.append(sm); }
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = amount;
      r.append(n, a);
      if (id) { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.dataset.aside = id; b.setAttribute('aria-label', 'Edit ' + label); b.textContent = '✎'; r.append(b); }
      else r.append(document.createElement('span'));
      el.append(r);
    };
    line('Total cash', fmt(cashTotal), 'ef-total');
    for (const a of av) line(a.name, a.v === null ? (a.amount === null ? 'not set' : 'no rate') : '−' + fmt(a.v), 'ef-minus', a.id,
      a.amount !== null && a.currency !== dispCur() ? fmtIn(a.amount, a.currency) : (a.note || ''));
    line('Emergency fund', fmt(fundTotal), 'ef-result');
    if (setAside > cashTotal) { const w = document.createElement('p'); w.className = 'hint warn-text'; w.textContent = `Your set-asides are ${fmt(setAside - cashTotal)} more than your cash, so there’s no emergency fund left.`; el.append(w); }
  }
  let editingAside = null;
  function openAside(a) {
    if (mode === 'airtable' && !asideTableOk) return showBanner(`Your base has no “${ASIDE_TABLE}” table yet (see the README).`);
    editingAside = a ? a.id : null;
    $('asTitle').textContent = a ? 'Edit set-aside' : 'Set aside cash';
    $('asName').value = a ? a.name : ''; $('asAmt').value = a && a.amount !== null ? a.amount : '';
    $('asCur').value = a ? a.currency : dispCur(); $('asNote').value = a ? a.note : '';
    $('asDel').hidden = !a; $('asErr').textContent = '';
    $('asideDlg').showModal();
  }
  $('asAdd').onclick = () => openAside(null);
  $('asideForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!$('asName').value.trim()) { $('asErr').textContent = 'Please enter a name, e.g. Business capital.'; return; }
    if ($('asAmt').value !== '' && posOrNull($('asAmt').value) === null) { $('asErr').textContent = 'Enter an amount of 0 or more.'; return; }
    const d = cleanAside({ name: $('asName').value, amount: $('asAmt').value, currency: $('asCur').value, note: $('asNote').value });
    try { await busy($('asSave'), () => saveAside(editingAside, d)); $('asideDlg').close(); render(); }
    catch (x) { $('asErr').textContent = x.message; }
  });
  $('asDel').onclick = async () => {
    const a = asides.find(x => x.id === editingAside);
    if (!a || !confirm(`Delete “${a.name}”?`)) return;
    try { await busy($('asDel'), () => removeAside(a.id)); $('asideDlg').close(); render(); }
    catch (x) { $('asErr').textContent = x.message; }
  };

  // ---------- Projection ----------
  const NO_GROWTH = ['Cash'];
  const P = prefs.proj = Object.assign({ years: 20, ret: 6, infl: 2.5, real: false }, prefs.proj || {});
  const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  // ---------- Debt paydown ----------
  // A debt grows at its interest rate (its "Expected return %") and shrinks by its monthly payment. With no payment
  // but a "Years left", the payment is the one that clears it in that time. A "Written off" date (YYYY or YYYY-MM)
  // forgives whatever is left then, regardless — e.g. a UK student loan.
  const monthsUntil = ym => { if (!ym) return null; const [y, m] = ym.split('-').map(Number); const d = new Date(); return Math.max(0, (y - d.getFullYear()) * 12 + ((m || 1) - (d.getMonth() + 1))); };
  const monthLabel = k => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + k); return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
  function debtTerms(i, b, monthly) {
    const rate = i.rate !== null && i.rate !== undefined ? i.rate : 0, rm = Math.pow(1 + rate / 100, 1 / 12) - 1;
    let pay = monthly !== null && monthly !== undefined ? Number(monthly) : null, calc = false;
    if (pay === null && i.yearsLeft) { const n = Math.max(1, Math.round(i.yearsLeft * 12)); pay = rm ? b * rm / (1 - Math.pow(1 + rm, -n)) : b / n; calc = true; }
    return { rm, pay: pay || 0, calc, wo: monthsUntil(i.writeOff) };
  }
  // Month-by-month plan in the debt's own currency.
  function debtPlan(i) {
    const b0 = Number(i.native !== undefined ? i.native : i.value) || 0;
    const t = debtTerms(i, b0, i.monthly === null ? null : (i.native !== undefined && i.value ? i.monthly * b0 / i.value : i.monthly));
    let b = b0, interest = 0, paid = 0;
    for (let m = 1; m <= 1200; m++) {
      if (t.wo !== null && m > t.wo) return { end: t.wo, how: 'written off', forgiven: b, interest, paid, pay: t.pay, calc: t.calc };
      const owed = b * (1 + t.rm); interest += owed - b; const p = Math.min(t.pay, owed); b = owed - p; paid += p;
      if (b <= 0.005) return { end: m, how: 'paid off', forgiven: 0, interest, paid, pay: t.pay, calc: t.calc };
      if (m === 24 && b >= b0 && t.wo === null) return { end: null, how: 'growing', forgiven: 0, interest, paid, pay: t.pay, calc: t.calc };
    }
    return { end: null, how: 'not within 100 years', forgiven: 0, interest, paid, pay: t.pay, calc: t.calc };
  }
  function planText(i) {
    if (i.kind !== 'debt' || !(Number(i.native !== undefined ? i.native : i.value) > 0)) return '';
    const p = debtPlan(i), c = i.currency, f = n => fmtIn(n, c);
    if (p.how === 'growing') return p.pay ? 'Payment doesn’t cover the interest' : 'No payment or end date set';
    if (p.end === null) return 'Not paid off within 100 years';
    const when = monthLabel(p.end);
    const pay = p.calc ? ` at ${f(p.pay)}/mo` : '';
    return p.how === 'written off' ? `Written off ${when}${p.forgiven > 0.5 ? ` · ~${f(p.forgiven)} forgiven` : ''}${pay}` : `Paid off ${when}${pay}${p.interest > 0.5 ? ` · ${f(p.interest)} interest` : ''}`;
  }

  // Monthly compounding; contributions/payments at month end. Returns one point per year (0..years).
  function project(list, years, defaultRet, infl, real) {
    const state = list.map(i => {
      const isDebt = i.kind === 'debt';
      const rate = i.rate !== null && i.rate !== undefined ? i.rate : (isDebt ? 0 : (NO_GROWTH.includes(mainBucket(i)) || ['Vehicles', 'Collectibles'].includes(i.category) ? 0 : defaultRet));
      if (isDebt) { const t = debtTerms(i, Number(i.value) || 0, i.monthly); return { isDebt, b: Number(i.value) || 0, rm: t.rm, c: t.pay, wo: t.wo }; }
      return { isDebt, b: Number(i.value) || 0, rm: Math.pow(1 + rate / 100, 1 / 12) - 1, c: Number(i.monthly) || 0 };
    });
    const start = state.reduce((a, s) => a + (s.isDebt ? -s.b : s.b), 0);
    const pts = []; let added = 0;
    for (let m = 0; m <= years * 12; m++) {
      if (m > 0) for (const s of state) {
        if (s.isDebt) {
          if (s.wo !== null && m > s.wo) { s.b = 0; continue; }          // written off
          const owed = s.b * (1 + s.rm); const pay = Math.min(s.c, owed); s.b = owed - pay; added += pay;
        }
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
    $('scView').hidden = true; $('plView').hidden = true; $('mcView').hidden = true; $('sfView').hidden = true; $('tabs').hidden = locked;
    if (locked) {
      ownerView = '';
      ['totAssets', 'totDebts', 'totNet'].forEach(id => { $(id).textContent = '—'; });
      $('mixSection').hidden = true; $('hsSection').hidden = true; $('rkSection').hidden = true; $('xpSection').hidden = true; $('cpSection').hidden = true; $('retSection').hidden = true; $('efSection').hidden = true; $('projSection').hidden = true; $('projTip').hidden = true; $('fxNote').hidden = true;
      [...$('projChart').querySelectorAll('svg')].forEach(n => n.remove()); $('projTable').textContent = ''; $('projHeadline').textContent = '';
      ['assets', 'debts', 'assetMix', 'lookBar', 'lookTable', 'mixHint', 'fName', 'fNote', 'fVal', 'fAcct', 'fFund', 'fOwner', 'fTicker', 'fShares', 'fRate', 'fMonthly', 'fYears', 'fWO', 'debtPlan', 'fRet12', 'fRet5', 'fRetHint', 'hsChange', 'hsChangeSub', 'hsContrib', 'hsContribSub', 'hsGrowth', 'hsGrowthSub', 'hsNote', 'hsRange', 'taTable', 'taPlan', 'taBase', 'taSum', 'taRisk', 'fiNum', 'fiNumSub', 'fiProg', 'fiProgSub', 'fiWhen', 'fiWhenSub', 'fiVerdict', 'fiBar', 'glList', 'cmList', 'rkVerdict', 'rkProfile', 'rkProfileSub', 'rkVar', 'rkVarSub', 'rkDiv', 'rkDivSub', 'rkBars', 'rkLegend', 'rkRiskNote', 'rkStress', 'rkScore', 'cpList', 'cpUninsured', 'cpUninsuredSub', 'cpTop', 'cpTopSub', 'cpNote', 'fInst', 'instList', 'xpCountry', 'xpCurrency', 'xpCountryNote', 'xpSpend', 'xpNote', 'retTable', 'retAll', 'retAllSub', 'retFunds', 'retFundsSub', 'retNote', 'efList', 'efCalc', 'asName', 'asAmt', 'asNote', 'efMonths', 'efUnit', 'efSub', 'efAll', 'efBar', 'efVerdict', 'efFundInfo', 'efPickList', 'eName', 'eAmt', 'eOwner', 'eNote', 'tidyList', 'fxList', 'fxText', 'acctList', 'ownerList', 'fundList']
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
    showView();
    recordLocalSnapshot(); renderHistory();
    renderMix(); renderLookThrough(); renderRisk(); renderExposure(); renderCounterparty(); renderReturns(); renderEmergency(); renderProjection(); renderList('asset'); renderList('debt'); renderDebtPlan();
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
      const j = await itemsWrite(() => at(tablePath(session), { method: 'PATCH', body: { records: chunk.map(c => ({ id: c.id, fields: toFields(c.d) })), typecast: true } }));
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
    $('fInst').value = item ? item.institution : '';
    { const g = item ? institutionOf(item) : null; $('fInst').placeholder = g && g.guessed ? `Looks like ${g.name}` : 'e.g. Vanguard, Fidelity, Chase'; }
    $('fOwner').value = item ? item.owner : (ownerView || '');
    $('fTicker').value = item ? item.ticker : '';
    $('fClassWrap').hidden = kind === 'debt';
    fillClassSelect($('fClass'), item ? item.assetClass : '', item && item.ticker && breakdown[item.ticker] ? `Auto (${item.ticker} fund breakdown)` : 'Auto (from category)');
    $('fShares').value = item && item.shares !== null ? item.shares : '';
    $('fRate').value = item && item.rate !== null ? item.rate : '';
    $('fMonthly').value = item && item.monthly !== null ? item.monthly : '';
    $('fDebtWrap').hidden = kind !== 'debt';
    $('fYears').value = item && item.yearsLeft !== null ? item.yearsLeft : '';
    $('fWO').value = item ? item.writeOff : '';
    $('fMonthly').placeholder = kind === 'debt' ? 'Blank = work out from years left' : '0';
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
    fillDatalist('instList', INST.map(x => x.name), items.map(i => i.institution).filter(Boolean));
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
      accountType: $('fAcct').value, fund: $('fFund').value, owner: $('fOwner').value, institution: $('fInst').value,
      ticker: $('fTicker').value, shares: $('fShares').value,
      rate: $('fRate').value, monthly: $('fMonthly').value,
      yearsLeft: editKind === 'debt' ? $('fYears').value : '', writeOff: editKind === 'debt' ? $('fWO').value : '',
      assetClass: editKind === 'asset' ? $('fClass').value : '',
      currency: $('fCur').value,
      assetClassNote: editingId ? (items.find(i => i.id === editingId) || {}).assetClassNote : '',
      ...retFields()
    });
    if (editKind === 'asset' && (($('fRet12').value !== '' && d.ret12 === null) || ($('fRet5').value !== '' && d.ret5 === null))) { $('itemErr').textContent = 'Returns must be between -100% and 10000%.'; return; }
    if (editKind === 'debt' && $('fWO').value.trim() && !d.writeOff) { $('itemErr').textContent = 'Enter the write-off date as a year (2039) or year-month (2039-04).'; return; }
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
    const as = t.closest('[data-aside]'); if (as) { const a = asides.find(x => x.id === as.dataset.aside); if (a) openAside(a); return; }
    const ex = t.closest('[data-exp]'); if (ex) { const e = expenses.find(x => x.id === ex.dataset.exp); if (e) openExpense(e); return; }
    const ed = t.closest('[data-edit]'); if (ed) { const it = items.find(i => i.id === ed.dataset.edit); if (it) openItem(it.kind, it); }
  });

  // ---------- Connect / unlock / disconnect ----------
  $('connBtn').onclick = () => {
    if (mode === 'local') {
      const n = items.length + expenses.length + asides.length;
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
    const uploadExp = !$('cUploadRow').hidden && $('cUpload').checked ? expenses.map(cleanExp) : [];
    const uploadAside = !$('cUploadRow').hidden && $('cUpload').checked ? asides.map(cleanAside) : [];
    try {
      await busy($('connectSave'), async () => {
        session = { token, baseId, table };
        const prevMode = mode; mode = 'airtable';
        try {
          await at(`${tablePath(session)}?pageSize=1`); // verify token, base and table
          const box = await seal(session, pass);
          if (!store.set(VAULT_KEY, JSON.stringify(box))) throw new Error('This browser blocked local storage, so the connection can’t be saved.');
          if (upload.length) await atCreateMany(upload);
          for (let k = 0; k < uploadExp.length; k += 10) await at(expPath(), { method: 'POST', body: { records: uploadExp.slice(k, k + 10).map(d => ({ fields: toExpFields(d) })), typecast: true } });
          if (uploadAside.length) await at(asidePath(), { method: 'POST', body: { records: uploadAside.slice(0, 10).map(d => ({ fields: toAsideFields(d) })), typecast: true } });
          if (upload.length || uploadExp.length || uploadAside.length) store.del(LOCAL_KEY);
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
    if (!box) { mode = 'local'; items = loadLocalItems(); expenses = loadLocalExpenses(); asides = loadLocalAsides(); $('unlockDlg').close(); render(); return; }
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
    store.del(VAULT_KEY); session = null; breakdown = {}; mode = 'local'; items = loadLocalItems(); expenses = loadLocalExpenses(); asides = loadLocalAsides(); fx = localFx(); loadScenarios();
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
    if (!PRICED.includes(c)) { const x = document.createElement('option'); x.value = c; x.textContent = c; $('eCur').append(x); $('asCur').append(x.cloneNode(true)); }
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
    const data = { app: 'holdings', version: 2, exported: new Date().toISOString(), items: items.map(({ id, ...rest }) => rest), expenses: expenses.map(({ id, ...rest }) => rest), asides: asides.map(({ id, ...rest }) => rest) };
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
    let list, expList = [], asideList = [];
    try {
      const s = JSON.parse(await f.text()); if (!Array.isArray(s.items) || s.items.length > 5000) throw 0; list = s.items.map(clean);
      if (Array.isArray(s.expenses) && s.expenses.length <= 2000) expList = s.expenses.map(cleanExp);
      if (Array.isArray(s.asides) && s.asides.length <= 200) asideList = s.asides.map(cleanAside);
    }
    catch (x) { return showBanner('That file isn’t a valid Holdings backup.'); }
    try {
      if (mode === 'airtable') {
        if (!confirm(`Add ${list.length} items to Airtable?`)) return;
        showBanner(`Uploading ${list.length} items…`, 'info');
        items.push(...await atCreateMany(list));
        for (const d of expList) await addExpense(d);
        for (const d of asideList) await saveAside(null, d);
        showBanner(`Added ${list.length} items${expList.length ? ` and ${expList.length} expenses` : ''} to Airtable.`, 'info');
      } else {
        if (!confirm('Replace the data in this browser with this file?')) return;
        items = list.map(d => ({ id: uid(), ...d })); expenses = expList.map(d => ({ id: uid(), ...d })); asides = asideList.map(d => ({ id: uid(), ...d })); saveLocal();
      }
      render();
    } catch (x) { showBanner(x.message); render(); }
  };

  // =====================================================================================================
  // ---------- Scenarios: model allocations, glide paths and return assumptions over time ----------
  // A scenario takes your investable assets (look-through, by bucket), moves them to a target mix, then
  // shifts that mix from a start allocation to an end allocation over a glide period, rebalancing yearly.
  // Each bucket grows at an assumed return; contributions are added in the target mix. Property can be
  // kept as is (illiquid, not rebalanced). Debts follow the same paydown model as the projection.
  // A Monte Carlo run (fixed seed) gives a 10th–90th percentile range using assumed volatilities and
  // correlations. Everything is an assumption, not a forecast.
  const SC_DEFAULTS = {   // long-run nominal assumptions: [return %, volatility %]
    Equities: [7, 16], Bonds: [4, 6], Cash: [3, 1], Gold: [4, 15], Property: [4, 10], Commodities: [3, 18], Bitcoin: [8, 60], Other: [4, 10]
  };
  const SC_CORR = (() => {        // simple correlation assumptions between buckets (others 0)
    const pairs = { 'Equities|Bonds': 0.1, 'Equities|Property': 0.5, 'Equities|Commodities': 0.3, 'Equities|Bitcoin': 0.3, 'Equities|Other': 0.5,
      'Bonds|Gold': 0.2, 'Bonds|Property': 0.2, 'Gold|Commodities': 0.3, 'Property|Other': 0.3 };
    return (a, b) => a === b ? 1 : (pairs[a + '|' + b] ?? pairs[b + '|' + a] ?? 0);
  })();
  const SC_PRESETS = {
    current: { name: 'Current mix, rebalanced', alloc: null },
    growth: { name: 'Growth 90/10', alloc: { Equities: 90, Bonds: 10 } },
    balanced: { name: 'Balanced 60/40', alloc: { Equities: 60, Bonds: 40 } },
    conservative: { name: 'Conservative 40/60', alloc: { Equities: 40, Bonds: 50, Cash: 10 } },
    glide: { name: 'Glide 90/10 → 50/50', alloc: { Equities: 90, Bonds: 10 }, end: { Equities: 50, Bonds: 40, Cash: 10 }, glide: 20 },
    permanent: { name: 'Permanent portfolio', alloc: { Equities: 25, Bonds: 25, Cash: 25, Gold: 25 } },
    realassets: { name: 'Real assets tilt', alloc: { Equities: 55, Bonds: 15, Gold: 15, Commodities: 5, Bitcoin: 5, Cash: 5 } }
  };
  const SC_KEY = 'holdings.scenarios';      // used only when there's no Scenarios table (browser-only)
  let scenarios = [], scTableOk = false, scSel = 'asis', scDirty = false;
  const clampPct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1000, Math.max(-100, n)) : d; };
  function cleanScenario(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const alloc = o => Object.fromEntries(BUCKETS.map(b => [b, Math.max(0, Math.min(100, Number((o || {})[b]) || 0))]));
    const asm = Object.fromEntries(BUCKETS.map(b => {
      const a = (r.assume || {})[b] || [];
      return [b, [clampPct(a[0], SC_DEFAULTS[b][0]), Math.max(0, Math.min(200, Number.isFinite(Number(a[1])) ? Number(a[1]) : SC_DEFAULTS[b][1]))]];
    }));
    return {
      name: String(r.name || 'Scenario').trim().slice(0, 60) || 'Scenario',
      start: alloc(r.start), end: alloc(r.end || r.start), glide: Math.max(0, Math.min(50, Math.round(Number(r.glide) || 0))),
      assume: asm, monthly: r.monthly === null || r.monthly === undefined || r.monthly === '' ? null : Math.max(0, Number(r.monthly) || 0),
      growth: Math.max(-20, Math.min(30, Number(r.growth) || 0)), rebalance: r.rebalance !== false, holdProperty: r.holdProperty !== false
    };
  }
  // storage: Airtable "Scenarios" table (Name + Config JSON), or this browser
  const scPath = () => `${session.baseId}/${encodeURIComponent('Scenarios')}`;
  async function loadScenarios() {
    if (mode === 'airtable') {
      try {
        const j = await at(`${scPath()}?pageSize=100`); scTableOk = true;
        scenarios = (j.records || []).filter(r => REC_RE.test(r.id)).map(r => { let c = {}; try { c = JSON.parse(r.fields.Config || '{}'); } catch (x) { } return { id: r.id, ...cleanScenario({ ...c, name: r.fields.Name || c.name }) }; });
        for (const k of Object.keys(scSaved)) delete scSaved[k];
        for (const x of scenarios) scSaved[x.id] = JSON.parse(JSON.stringify(scConfig(x)));
        return;
      } catch (x) { scTableOk = false; }
    }
    const loc = parse(store.get(SC_KEY));
    scenarios = Array.isArray(loc) ? loc.map(s => ({ id: String(s.id || uid()), ...cleanScenario(s) })) : [];
    for (const k of Object.keys(scSaved)) delete scSaved[k];
    for (const x of scenarios) scSaved[x.id] = JSON.parse(JSON.stringify(scConfig(x)));
  }
  const scConfig = sc => { const { id, _tmp, ...cfg } = sc; return cfg; };
  const scPersistLocal = () => store.set(SC_KEY, JSON.stringify(scenarios.filter(x => x.id && !x._tmp).map(x => ({ ...scSaved[x.id] || scConfig(x), id: x.id }))));
  const scSaved = {};   // id -> config as last saved (or loaded), so "discard" can restore it
  async function saveScenario(sc) {
    const id = sc.id, cfg = scConfig(sc);
    if (mode === 'airtable' && scTableOk) {
      const fields = { Name: cfg.name, Config: JSON.stringify(cfg) };
      if (id && REC_RE.test(id)) await at(`${scPath()}/${id}`, { method: 'PATCH', body: { fields, typecast: true } });
      else { const j = await at(scPath(), { method: 'POST', body: { records: [{ fields }], typecast: true } }); const r = (j.records || [])[0]; if (r) { sc.id = r.id; delete sc._tmp; scSaved[r.id] = JSON.parse(JSON.stringify(cfg)); return r.id; } }
      scSaved[id] = JSON.parse(JSON.stringify(cfg));
      return id;
    }
    if (!sc.id) sc.id = uid();
    delete sc._tmp; scSaved[sc.id] = JSON.parse(JSON.stringify(cfg));
    scPersistLocal();
    return sc.id;
  }
  async function deleteScenario(id) {
    if (mode === 'airtable' && scTableOk && REC_RE.test(id)) await at(`${scPath()}/${id}`, { method: 'DELETE' });
    scenarios = scenarios.filter(s => s.id !== id); delete scSaved[id];
    if (!(mode === 'airtable' && scTableOk)) scPersistLocal();
  }

  // Today's investable assets by bucket (display currency), plus property held directly.
  function scStart() {
    const by = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    let monthly = 0;
    for (const i of visible()) {
      if (i.kind !== 'asset' || !(i.value > 0)) continue;
      for (const [c, w] of Object.entries(mixFor(i))) by[bucketOf(c)] += i.value * w / 100;
      monthly += Number(i.monthly) || 0;
    }
    return { by, monthly, total: Object.values(by).reduce((a, b) => a + b, 0) };
  }
  // Target weights at a given year, normalised over the buckets being rebalanced (property is left out when it's
  // held as is, so a stray property weight can't make money disappear at each rebalance).
  const weightsAt = (sc, yr, now) => {
    const liq = Object.keys(now), f = sc.glide ? Math.min(1, yr / sc.glide) : 1, a = sc.start, b = sc.end;
    const w = Object.fromEntries(liq.map(k => [k, (a[k] || 0) + ((b[k] || 0) - (a[k] || 0)) * f]));
    const t = liq.reduce((x, k) => x + w[k], 0);
    return t > 0 ? Object.fromEntries(liq.map(k => [k, w[k] / t])) : now;
  };
  function debtSeries(years, real, infl) {
    const debts = visible().filter(i => i.kind === 'debt');
    return debts.length ? project(debts, years, 0, infl, real).map(p => p.debts) : Array(years + 1).fill(0);
  }
  // Deterministic run: monthly growth, yearly rebalance, contributions in the target mix.
  function runScenario(sc, years, real, infl, debts) {
    const S = scStart(), liq = BUCKETS.filter(b => !(sc.holdProperty && b === 'Property'));
    const liqTotal = liq.reduce((a, b) => a + S.by[b], 0), now = Object.fromEntries(liq.map(b => [b, liqTotal ? S.by[b] / liqTotal : 0]));
    let v = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    const w0 = sc.rebalance ? weightsAt(sc, 0, now) : now;
    for (const b of liq) v[b] = sc.rebalance ? liqTotal * (w0[b] || 0) : S.by[b];
    if (sc.holdProperty) v.Property = S.by.Property;
    const rm = Object.fromEntries(BUCKETS.map(b => [b, Math.pow(1 + sc.assume[b][0] / 100, 1 / 12) - 1]));
    const base = sc.monthly === null ? S.monthly : sc.monthly;
    const out = []; let added = 0;
    const snap = (yr) => {
      const assets = Object.values(v).reduce((a, b) => a + b, 0), defl = real ? Math.pow(1 + infl / 100, yr) : 1;
      out.push({ year: yr, assets: assets / defl, nw: (assets / defl) - (debts[yr] || 0), alloc: Object.fromEntries(BUCKETS.map(b => [b, assets ? v[b] / assets : 0])), added: added / defl });
    };
    snap(0);
    for (let m = 1; m <= years * 12; m++) {
      const yr = m / 12, w = sc.rebalance ? weightsAt(sc, Math.floor((m - 1) / 12) + 1, now) : now;
      for (const b of BUCKETS) v[b] *= 1 + rm[b];
      const c = base * Math.pow(1 + sc.growth / 100, Math.floor((m - 1) / 12)); added += c;
      for (const b of liq) v[b] += c * (w[b] || 0);
      if (m % 12 === 0) {
        if (sc.rebalance) { const t = liq.reduce((a, b) => a + v[b], 0); for (const b of liq) v[b] = t * (w[b] || 0); }
        snap(yr);
      }
    }
    return out;
  }
  // Monte Carlo: yearly correlated lognormal returns per bucket; returns 10th/50th/90th percentile net worth by year.
  function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function cholesky(M) {
    const n = M.length, L = M.map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = M[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j][j];
    }
    return L;
  }
  const SC_L = cholesky(BUCKETS.map(a => BUCKETS.map(b => SC_CORR(a, b))));
  function monteCarlo(sc, years, real, infl, debts, sims = 400) {
    const S = scStart(), liq = BUCKETS.filter(b => !(sc.holdProperty && b === 'Property'));
    const liqTotal = liq.reduce((a, b) => a + S.by[b], 0), now = Object.fromEntries(liq.map(b => [b, liqTotal ? S.by[b] / liqTotal : 0]));
    const params = BUCKETS.map(b => { const m = sc.assume[b][0] / 100, s = sc.assume[b][1] / 100, s2 = Math.log(1 + (s * s) / ((1 + m) * (1 + m))); return [Math.log(1 + m) - s2 / 2, Math.sqrt(s2)]; });
    const rnd = mulberry(12345); const gauss = () => { let u = 0, w = 0; while (!u) u = rnd(); while (!w) w = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
    const base = sc.monthly === null ? S.monthly : sc.monthly;
    const byYear = Array.from({ length: years + 1 }, () => []);
    for (let k = 0; k < sims; k++) {
      const v = Object.fromEntries(BUCKETS.map(b => [b, 0])), w0 = sc.rebalance ? weightsAt(sc, 0, now) : now;
      for (const b of liq) v[b] = sc.rebalance ? liqTotal * (w0[b] || 0) : S.by[b];
      if (sc.holdProperty) v.Property = S.by.Property;
      byYear[0].push(Object.values(v).reduce((a, b) => a + b, 0) - (debts[0] || 0));
      for (let y = 1; y <= years; y++) {
        const z = BUCKETS.map(() => gauss()), e = SC_L.map(row => row.reduce((a, l, j) => a + l * z[j], 0));
        const G = BUCKETS.map((b, i) => Math.exp(params[i][0] + params[i][1] * e[i]));
        BUCKETS.forEach((b, i) => { v[b] *= G[i]; });
        const w = sc.rebalance ? weightsAt(sc, y, now) : now, c = 12 * base * Math.pow(1 + sc.growth / 100, y - 1);
        for (const b of liq) v[b] += c * (w[b] || 0) * Math.sqrt(G[BUCKETS.indexOf(b)]);   // paid in through the year
        if (sc.rebalance) { const t = liq.reduce((a, b) => a + v[b], 0); for (const b of liq) v[b] = t * (w[b] || 0); }
        const defl = real ? Math.pow(1 + infl / 100, y) : 1;
        byYear[y].push(Object.values(v).reduce((a, b) => a + b, 0) / defl - (debts[y] || 0));
      }
    }
    const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
    return byYear.map((a, y) => ({ year: y, p10: q(a, 0.1), p50: q(a, 0.5), p90: q(a, 0.9) }));
  }
  const blendRet = (sc, alloc) => BUCKETS.reduce((a, b) => a + (alloc[b] || 0) * sc.assume[b][0], 0);

  // ---- view switching (Overview | Scenarios) ----
  function showView() {
    const sc = location.hash === '#scenarios' && mode !== 'locked', pl = location.hash === '#plan' && mode !== 'locked', mc = location.hash === '#macro' && mode !== 'locked', sf = location.hash === '#savings' && mode !== 'locked';
    $('content').hidden = mode === 'locked' || sc || pl || mc || sf; $('scView').hidden = !sc; $('plView').hidden = !pl; $('mcView').hidden = !mc; $('sfView').hidden = !sf;
    for (const [id, on] of [['tabOverview', !sc && !pl && !mc && !sf], ['tabScen', sc], ['tabPlan', pl], ['tabSf', sf], ['tabMacro', mc]]) { $(id).classList.toggle('on', on); $(id).setAttribute('aria-current', on ? 'page' : 'false'); }
    if (sf) renderSf();
    if (sc) renderScenarios();
    if (pl) renderPlan();
    if (mc) renderMacro();
  }
  window.addEventListener('hashchange', showView);

  // ---- scenario editor + results ----
  function newScenario(presetKey) {
    const p = SC_PRESETS[presetKey] || SC_PRESETS.current, S = scStart();
    let start;
    if (p.alloc) start = { ...p.alloc };
    else { const liq = BUCKETS.filter(b => b !== 'Property'), t = liq.reduce((a, b) => a + S.by[b], 0); start = Object.fromEntries(liq.map(b => [b, t ? Math.round(S.by[b] / t * 1000) / 10 : 0])); }
    const assume = Object.fromEntries(BUCKETS.map(b => [b, SC_DEFAULTS[b].slice()]));
    return cleanScenario({ name: p.name, start, end: p.end || start, glide: p.glide || 0, assume, monthly: null, growth: 0, rebalance: true, holdProperty: true });
  }
  const scCur = () => scenarios.find(s => (s.id || s._tmp) === scSel);
  // throw away unsaved edits: a new scenario disappears, a saved one goes back to its saved settings
  function scDiscard() {
    const s = scCur(); scDirty = false; if (!s) return;
    if (!s.id || !scSaved[s.id]) { scenarios = scenarios.filter(x => x !== s); return; }
    const k = scenarios.indexOf(s); scenarios[k] = { id: s.id, ...cleanScenario(JSON.parse(JSON.stringify(scSaved[s.id]))) };
  }
  function renderScenarioTabs() {
    const el = $('scTabs'); el.textContent = '';
    const mk = (key, label, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (scSel === key ? ' on' : '') + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = () => { if (key === scSel) return; if (scDirty && !confirm('Discard unsaved changes to this scenario?')) return; if (scDirty) scDiscard(); scSel = key; renderScenarios(); }; el.append(b); };
    mk('asis', 'As is (your holdings)');
    scenarios.forEach((s, k) => { if (!s.id && !s._tmp) s._tmp = 'tmp' + k; mk(s.id || s._tmp, s.name, 'ln-chip-' + (k % 5)); });
  }
  function renderEditor() {
    const sc = scCur(), box = $('scEditor');
    box.hidden = !sc; $('scAsis').hidden = !!sc;
    if (!sc) return;
    const S = scStart(), liq = BUCKETS.filter(b => !(sc.holdProperty && b === 'Property'));
    const liqT = liq.reduce((a, b) => a + S.by[b], 0);
    $('scName').value = sc.name; $('scGlide').value = sc.glide; $('scMonthly').value = sc.monthly === null ? '' : sc.monthly;
    $('scMonthly').placeholder = fmt(S.monthly); $('scMonthly').title = `Blank = your current contributions (${fmt(S.monthly)}/month)`; $('scGrowth').value = sc.growth;
    $('scRebal').checked = sc.rebalance; $('scHold').checked = sc.holdProperty;
    const tb = $('scAlloc'); tb.textContent = '';
    const head = document.createElement('tr');
    ['Bucket', 'Now', 'Start %', 'End %', 'Return %', 'Volatility %'].forEach(t => { const th = document.createElement('th'); th.textContent = t; head.append(th); });
    const thead = document.createElement('thead'); thead.append(head); tb.append(thead);
    const body = document.createElement('tbody');
    BUCKETS.forEach((b, ix) => {
      const tr = document.createElement('tr'), isProp = sc.holdProperty && b === 'Property';
      const name = document.createElement('td'); const dot = document.createElement('i'); dot.className = 'bk-' + ix + ' sc-dot'; name.append(dot, b);
      const now = document.createElement('td'); now.textContent = isProp ? fmt(S.by[b]) : (liqT ? Math.round(S.by[b] / liqT * 100) + '%' : '—');
      tr.append(name, now);
      for (const [key, idx] of [['start'], ['end'], ['ret', 0], ['vol', 1]]) {
        const td = document.createElement('td'), inp = document.createElement('input');
        inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.setAttribute('aria-label', `${b} ${key}`);
        if (key === 'start' || key === 'end') {
          if (isProp) { td.textContent = 'held as is'; td.className = 'muted'; tr.append(td); continue; }
          inp.value = sc[key][b] || 0; inp.min = 0; inp.max = 100;
          inp.oninput = () => { sc[key][b] = Math.max(0, Math.min(100, Number(inp.value) || 0)); if (key === 'start' && !sc.glide) sc.end[b] = sc.start[b]; scDirty = true; scSums(); scRun(); };
          if (key === 'end') inp.disabled = !sc.glide;
        } else {
          inp.value = sc.assume[b][idx];
          inp.oninput = () => { const n = Number(inp.value); if (Number.isFinite(n)) { sc.assume[b][idx] = n; scDirty = true; scRun(); } };
        }
        td.append(inp); tr.append(td);
      }
      body.append(tr);
    });
    const sumRow = document.createElement('tr'); sumRow.className = 'sc-sum';
    ['Total', '100%', '', '', '', ''].forEach((t, k) => { const td = document.createElement('td'); td.textContent = t; if (k === 2) td.id = 'scSumStart'; if (k === 3) td.id = 'scSumEnd'; sumRow.append(td); });
    body.append(sumRow); tb.append(body);
    scSums();
  }
  function scSums() {
    const sc = scCur(); if (!sc) return;
    const liq = BUCKETS.filter(b => !(sc.holdProperty && b === 'Property'));
    for (const [k, id] of [['start', 'scSumStart'], ['end', 'scSumEnd']]) {
      const t = liq.reduce((a, b) => a + (sc[k][b] || 0), 0), el = $(id);
      el.textContent = Math.round(t * 10) / 10 + '%'; el.classList.toggle('warn-text', Math.abs(t - 100) > 0.05);
    }
    const t = liq.reduce((a, b) => a + (sc.start[b] || 0), 0);
    $('scWarn').textContent = Math.abs(t - 100) > 0.05 ? `Start allocation adds up to ${Math.round(t * 10) / 10}%; it’s scaled to 100% when modelling.` : '';
  }
  // results: comparison chart, table, range for the selected scenario, allocation over time
  function scRun() {
    const years = P.years, real = P.real, infl = P.infl, debts = debtSeries(years, real, infl);
    const asis = project(visible(), years, P.ret, infl, real).map(p => ({ year: p.year, nw: p.nw }));
    const runs = scenarios.map((s, k) => ({ s, k, pts: runScenario(s, years, real, infl, debts) }));
    const sel = scCur(), selRun = sel ? runs.find(r => r.s === sel) : null;
    const series = [{ label: 'As is', cls: 'ln-asis', pts: asis }, ...runs.map(r => ({ label: r.s.name, cls: 'ln-' + (r.k % 5), pts: r.pts, sel: r.s === sel }))];
    const mc = sel ? monteCarlo(sel, years, real, infl, debts) : null;
    scChart($('scChart'), series, mc, years);
    // table
    const tbl = $('scTable'); tbl.textContent = '';
    const hr = document.createElement('tr');
    ['Scenario', `In ${years} yrs`, 'vs as is', 'Expected return', 'Range (10–90%)', 'Volatility', 'Worst stress'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody'), asisEnd = asis[asis.length - 1].nw;
    const debtNow = visible().filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx).reduce((a, i) => a + i.value, 0);
    const riskCells = M => { if (!M || M.volNW === null) return ['—', '—']; const w = Math.min(...M.stress.map(t => t.loss)); return [(M.volNW * 100).toFixed(1) + '%', w < 0 ? '−' + Math.round(-w / M.nw * 100) + '%' : '0%']; };
    const row = (cls, label, end, ret, range, isSel, M) => {
      const tr = document.createElement('tr'); if (isSel) tr.className = 'on';
      const n = document.createElement('td'); const sw = document.createElement('i'); sw.className = 'sw ' + cls; n.append(sw, label); tr.append(n);
      [fmt(end), cls === 'ln-asis' ? '—' : (end >= asisEnd ? '+' : '−') + fmt(Math.abs(end - asisEnd)), ret, range, ...riskCells(M)].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
      tb.append(tr);
    };
    row('ln-asis', 'As is', asisEnd, 'your holdings’ own rates', '—', !sel, riskModel(bucketValues(visible()), debtNow));
    for (const r of runs) {
      const a0 = r.pts[0].alloc, a1 = r.pts[r.pts.length - 1].alloc;
      const r0 = blendRet(r.s, a0), r1 = blendRet(r.s, a1);
      const mcr = r.s === sel ? mc[years] : null;
      row('ln-' + (r.k % 5), r.s.name, r.pts[years].nw, Math.abs(r0 - r1) < 0.05 ? r0.toFixed(1) + '%' : `${r0.toFixed(1)}% → ${r1.toFixed(1)}%`, mcr ? `${fmtShort(mcr.p10)} – ${fmtShort(mcr.p90)}` : 'select to see', r.s === sel,
        riskModel(Object.fromEntries(BUCKETS.map(b => [b, (a0[b] || 0) * r.pts[0].assets])), debtNow, r.s.assume));
    }
    tbl.append(tb);
    // allocation over time for the selected scenario
    const ab = $('scAllocBars'); ab.textContent = '';
    $('scAllocWrap').hidden = !selRun;
    if (selRun) {
      const marks = [...new Set([0, 5, 10, 15, 20, 25, 30, 40, 50].filter(y => y <= years).concat([years]))];
      for (const y of marks) {
        const p = selRun.pts[y], r = document.createElement('div'); r.className = 'sc-arow';
        const lab = document.createElement('span'); lab.textContent = y === 0 ? 'Start' : 'Y' + y;
        const bar = document.createElement('span'); bar.className = 'sc-abar';
        BUCKETS.forEach((b, ix) => { const w = p.alloc[b]; if (w < 0.002) return; const seg = document.createElement('i'); seg.className = 'bk-' + ix; seg.style.width = (w * 100) + '%'; seg.title = `${b} ${(w * 100).toFixed(1)}% · ${fmt(p.assets * w)}`; bar.append(seg); });
        const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = fmtShort(p.assets);
        r.append(lab, bar, amt); ab.append(r);
      }
      const lg = $('scAllocLegend'); lg.textContent = '';
      BUCKETS.forEach((b, ix) => { if (!selRun.pts.some(p => p.alloc[b] > 0.002)) return; const s = document.createElement('span'); const d = document.createElement('i'); d.className = 'bk-' + ix; s.append(d, b); lg.append(s); });
    }
    $('scRangeNote').textContent = sel ? `Shaded band: 10th–90th percentile of ${400} simulated paths for “${sel.name}”, using the volatilities above and simple correlations between buckets.` : 'Select a scenario to see its range of outcomes.';
    $('scNote').textContent = `${real ? `In today’s money at ${infl}% inflation. ` : ''}Debts follow your paydown settings. Scenarios start from your current investable assets (look-through by bucket)${sel && sel.holdProperty ? '; property is held as is and not rebalanced' : ''}, move to the start mix, glide to the end mix, and rebalance yearly. Returns and volatilities are assumptions, not forecasts.`;
  }
  // multi-line chart with an optional percentile band and a hover layer
  function scChart(chart, series, band, years) {
    [...chart.querySelectorAll('svg')].forEach(n => n.remove());
    const tip = $('scTip'); tip.hidden = true;
    const W = Math.max(300, Math.round(chart.clientWidth || 640)), narrow = W < 520;
    const H = narrow ? 230 : 280, L = narrow ? 46 : 56, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const vals = series.flatMap(s => s.pts.map(p => p.nw)).concat(band ? band.flatMap(b => [b.p10, b.p90]) : []);
    let lo = Math.min(0, ...vals), hi = Math.max(...vals); if (hi === lo) hi = lo + 1;
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = yr => L + (years ? yr / years : 0) * pw, y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Projected net worth by scenario over ${years} years; the table below has the values.` });
    for (let v = lo; v <= hi + step / 2; v += step) { el('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }, svg); el('text', { class: 'axis-t', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtShort(v); }
    const xStep = years <= (narrow ? 6 : 10) ? 1 : years <= 20 ? 5 : 10;
    for (let yr = 0; yr <= years; yr += xStep) el('text', { class: 'axis-t', x: x(yr), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = yr === 0 ? 'Now' : 'Y' + yr;
    if (band) {
      const sel = series.find(s => s.sel);
      const d = band.map((b, i) => (i ? 'L' : 'M') + x(b.year).toFixed(1) + ' ' + y(b.p90).toFixed(1)).join(' ') + ' ' + band.slice().reverse().map(b => 'L' + x(b.year).toFixed(1) + ' ' + y(b.p10).toFixed(1)).join(' ') + ' Z';
      el('path', { class: 'sc-band ' + (sel ? sel.cls : ''), d }, svg);
    }
    for (const s of series) el('path', { class: 'sc-line ' + s.cls + (s.sel ? ' sel' : ''), d: s.pts.map((p, i) => (i ? 'L' : 'M') + x(p.year).toFixed(1) + ' ' + y(p.nw).toFixed(1)).join(' ') }, svg);
    const cross = el('line', { class: 'cross', y1: T, y2: T + ph, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }, svg);
    const show = evt => {
      const r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(years, Math.round((px - L) / pw * years)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      const h = document.createElement('div'); h.textContent = i === 0 ? 'Now' : `Year ${i}`; tip.append(h);
      for (const s of series.slice().sort((a, b) => b.pts[i].nw - a.pts[i].nw)) { const row = document.createElement('div'); const sw = document.createElement('i'); sw.className = 'sw ' + s.cls; const b = document.createElement('b'); b.textContent = fmt(s.pts[i].nw); row.append(sw, s.label + ' ', b); tip.append(row); }
      if (band) { const row = document.createElement('div'); row.className = 'muted'; row.textContent = `Range: ${fmtShort(band[i].p10)} – ${fmtShort(band[i].p90)}`; tip.append(row); }
      tip.hidden = false; const left = x(i) / W * r.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    chart.prepend(svg);
    const lg = $('scLegend'); lg.textContent = '';
    for (const s of series) { const sp = document.createElement('span'); const sw = document.createElement('i'); sw.className = 'sw ' + s.cls; sp.append(sw, s.label); lg.append(sp); }
  }
  function renderScenarios() {
    if (mode === 'locked') return;
    $('scYears').value = P.years; $('scInfl').value = P.infl; $('scReal').checked = P.real;
    if (scSel !== 'asis' && !scCur()) scSel = 'asis';
    renderScenarioTabs(); renderEditor(); scRun();
    renderMoves();
    $('scStore').textContent = mode === 'airtable' ? (scTableOk ? 'Scenarios are saved to your Airtable “Scenarios” table.' : 'Scenarios are saved in this browser. Add a “Scenarios” table (Name, Config) to your base to sync them.') : 'Scenarios are saved in this browser.';
    $('scDel').hidden = $('scDup').hidden = $('scSave').hidden = !scCur();
  }
  // controls
  $('scNew').onclick = () => {
    if (scDirty && scCur() && !confirm('Discard unsaved changes to this scenario?')) return;
    if (scDirty) scDiscard();
    const sc = newScenario($('scPreset').value); sc._tmp = 'tmp' + Date.now(); scenarios.push(sc); scSel = sc._tmp; scDirty = true; renderScenarios();
    if (scenarios.length > 5) showBanner('Up to 5 scenarios get their own colour; more will reuse colours.', 'info');
  };
  $('scDup').onclick = () => { const s = scCur(); if (!s) return; const c = cleanScenario(JSON.parse(JSON.stringify({ ...s, name: s.name + ' (copy)' }))); c._tmp = 'tmp' + Date.now(); scenarios.push(c); scSel = c._tmp; scDirty = true; renderScenarios(); };
  $('scDel').onclick = async () => {
    const s = scCur(); if (!s || !confirm(`Delete the scenario “${s.name}”?`)) return;
    try { if (s.id) await deleteScenario(s.id); else scenarios = scenarios.filter(x => x !== s); scSel = 'asis'; scDirty = false; renderScenarios(); }
    catch (x) { showBanner(x.message); }
  };
  $('scSave').onclick = async () => {
    const s = scCur(); if (!s) return;
    s.name = $('scName').value.trim().slice(0, 60) || 'Scenario';
    try {
      const id = await busy($('scSave'), () => saveScenario(s));
      scSel = id || s.id || scSel; scDirty = false;
      renderScenarios(); showBanner('Scenario saved.', 'info');
    } catch (x) { showBanner(x.message); }
  };
  $('scName').oninput = () => { const s = scCur(); if (s) { s.name = $('scName').value; scDirty = true; renderScenarioTabs(); } };
  $('scGlide').onchange = () => { const s = scCur(); if (!s) return; s.glide = Math.max(0, Math.min(50, Math.round(Number($('scGlide').value) || 0))); if (!s.glide) s.end = { ...s.start }; scDirty = true; renderEditor(); scRun(); };
  $('scMonthly').oninput = () => { const s = scCur(); if (!s) return; s.monthly = $('scMonthly').value === '' ? null : Math.max(0, Number($('scMonthly').value) || 0); scDirty = true; scRun(); };
  $('scGrowth').oninput = () => { const s = scCur(); if (!s) return; s.growth = Math.max(-20, Math.min(30, Number($('scGrowth').value) || 0)); scDirty = true; scRun(); };
  $('scRebal').onchange = () => { const s = scCur(); if (s) { s.rebalance = $('scRebal').checked; scDirty = true; scRun(); } };
  $('scHold').onchange = () => {
    const s = scCur(); if (!s) return;
    s.holdProperty = $('scHold').checked;
    if (!s.holdProperty) {
      // property joins the rebalanced mix at its current share, so unticking doesn't silently sell it
      const S = scStart(), share = S.total ? Math.round(S.by.Property / S.total * 1000) / 10 : 0;
      for (const k of ['start', 'end']) {
        const others = BUCKETS.filter(b => b !== 'Property'), t = others.reduce((a, b) => a + (s[k][b] || 0), 0);
        for (const b of others) s[k][b] = t ? Math.round((s[k][b] || 0) / t * (100 - share) * 10) / 10 : 0;
        s[k].Property = share;
      }
    } else { s.start.Property = 0; s.end.Property = 0; }
    scDirty = true; renderEditor(); scRun();
  };
  $('scReset').onclick = () => { const s = scCur(); if (!s) return; s.assume = Object.fromEntries(BUCKETS.map(b => [b, SC_DEFAULTS[b].slice()])); scDirty = true; renderEditor(); scRun(); };
  const onScShared = () => { P.years = Math.round(clampNum($('scYears').value, 1, 50, 20)); P.infl = clampNum($('scInfl').value, 0, 20, 2.5); P.real = $('scReal').checked; savePrefs(); scRun(); };
  ['scYears', 'scInfl'].forEach(id => $(id).addEventListener('change', onScShared)); $('scReal').addEventListener('change', onScShared);
  let scResizeT = 0;
  window.addEventListener('resize', () => { if (!$('scView').hidden) { clearTimeout(scResizeT); scResizeT = setTimeout(scRun, 150); } });
  window.addEventListener('beforeunload', e => { if (scDirty && !$('scView').hidden) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- Risk & diversification ----------
  // An allocator's view of the whole balance sheet. Market risk comes from the look-through mix by bucket, with the
  // long-run return / volatility / correlation assumptions used by Scenarios: ex-ante volatility, a parametric
  // 1-in-20 bad year (95% VaR and expected shortfall), each bucket's share of total risk (Euler risk contributions),
  // the effective number of independent bets (inverse HHI of risk shares) and the diversification ratio.
  // Debts are fixed in value, so net worth is more volatile than assets by assets ÷ net worth (leverage).
  // Historical stress tests apply approximate peak-to-trough moves by bucket. A scorecard checks the common
  // institutional limits: concentration, speculative assets, liquidity, leverage, currency, counterparty, tail loss.
  const STRESS = [
    { name: '2008 financial crisis', sub: 'Oct 2007 – Mar 2009, peak to trough (bitcoin didn’t exist: −75% assumed)', s: { Equities: -50, Bonds: 6, Cash: 2, Gold: 20, Property: -25, Commodities: -55, Bitcoin: -75, Other: -30 } },
    { name: '2020 Covid crash', sub: 'Feb – Mar 2020', s: { Equities: -34, Bonds: 1, Cash: 0, Gold: -3, Property: -10, Commodities: -30, Bitcoin: -50, Other: -20 } },
    { name: '2022 inflation shock', sub: 'Calendar 2022: stocks and bonds fell together', s: { Equities: -18, Bonds: -13, Cash: 1.5, Gold: 0, Property: -10, Commodities: 16, Bitcoin: -64, Other: -10 } },
    { name: 'Stagflation', sub: 'Hypothetical 1970s-style year', s: { Equities: -25, Bonds: -10, Cash: 5, Gold: 30, Property: -5, Commodities: 25, Bitcoin: -50, Other: -10 } },
    { name: 'Crypto winter', sub: 'Bitcoin −75%, everything else flat', s: { Bitcoin: -75 } }
  ];
  const Z95 = 1.645, ES95 = 2.063;           // normal quantile and expected-shortfall multiplier at 95%
  function riskModel(by, debts, assume) {
    const asm = assume || SC_DEFAULTS;
    const A = BUCKETS.reduce((a, b) => a + Math.max(0, by[b] || 0), 0);
    if (!(A > 0)) return null;
    const w = Object.fromEntries(BUCKETS.map(b => [b, Math.max(0, by[b] || 0) / A]));
    const sig = b => asm[b][1] / 100;
    const cw = Object.fromEntries(BUCKETS.map(i => [i, BUCKETS.reduce((a, j) => a + w[j] * sig(i) * sig(j) * SC_CORR(i, j), 0)]));
    const v = BUCKETS.reduce((a, i) => a + w[i] * cw[i], 0), vol = Math.sqrt(v);
    const mu = BUCKETS.reduce((a, b) => a + w[b] * asm[b][0] / 100, 0);
    const rc = Object.fromEntries(BUCKETS.map(b => [b, v ? w[b] * cw[b] / v : 0]));
    const rcs = Object.values(rc).filter(x => x > 0), bets = rcs.length ? 1 / rcs.reduce((a, x) => a + x * x, 0) : 0;
    const capN = 1 / BUCKETS.reduce((a, b) => a + w[b] * w[b], 0);
    const dr = vol ? BUCKETS.reduce((a, b) => a + w[b] * sig(b), 0) / vol : 1;
    const nw = A - (debts || 0), lev = nw > 0 ? A / nw : Infinity;
    const stress = STRESS.map(t => ({ ...t, loss: BUCKETS.reduce((a, b) => a + (by[b] || 0) * (t.s[b] || 0) / 100, 0) }));
    return { A, nw, w, vol, mu, rc, bets, capN, dr, lev, volNW: nw > 0 ? vol * lev : null,
      var95: (Z95 * vol - mu) * A, es95: (ES95 * vol - mu) * A, stress };
  }
  // the stock/bond mix with the same volatility (using the same assumptions)
  function equivMix(vol) {
    const s = e => Math.sqrt(e * e * .16 * .16 + (1 - e) * (1 - e) * .06 * .06 + 2 * e * (1 - e) * SC_CORR('Equities', 'Bonds') * .16 * .06);
    if (vol <= s(0)) return 'less volatile than an all-bond portfolio';
    if (vol > s(1)) return `about ${(vol / s(1)).toFixed(1)}× as volatile as an all-stock portfolio`;
    let lo = 0, hi = 1; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (s(m) < vol) lo = m; else hi = m; }
    const e = Math.round(lo * 20) * 5; return `similar to a ${e}/${100 - e} stock/bond portfolio`;
  }
  const profileOf = v => v < 0.05 ? 'Conservative' : v < 0.09 ? 'Moderate' : v < 0.13 ? 'Growth' : 'Aggressive';
  const LOCKED_RE = /401|403|457|ira\b|pension|super|hsa|retire|kiwisaver|sipp|tsp/i;
  function liquidityOf(i) {
    const b = mainBucket(i);
    if (['Vehicles', 'Collectibles', 'Business'].includes(i.category) || (b === 'Property' && !i.ticker)) return 'illiquid';
    if (i.category === 'Retirement' || LOCKED_RE.test(i.accountType || '') || LOCKED_RE.test(i.category || '')) return 'locked';
    return 'liquid';
  }
  const singleAsset = i => (mainBucket(i) === 'Property' && !i.ticker) || PRICED.includes(i.currency) || ['Vehicles', 'Collectibles', 'Business'].includes(i.category);
  function bucketValues(list) {
    const by = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    for (const i of list) if (i.kind === 'asset' && i.value > 0 && !i.noFx) for (const [c, w] of Object.entries(mixFor(i))) by[bucketOf(c)] += i.value * w / 100;
    return by;
  }
  function assessRisk(vis) {
    const assets = vis.filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx), debts = vis.filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx);
    const A = assets.reduce((a, i) => a + i.value, 0), D = debts.reduce((a, i) => a + i.value, 0);
    const M = riskModel(bucketValues(vis), D); if (!M) return null;
    const nw = A - D, checks = [];
    const st = (v, g, w) => v <= g ? 'good' : v <= w ? 'warning' : 'serious';
    const pctA = v => Math.round(v / A * 100) + '%';
    // 1. diversification of risk
    const top = BUCKETS.slice().sort((a, b) => M.rc[b] - M.rc[a])[0];
    checks.push({ k: 'div', name: 'Sources of risk', status: M.bets >= 3 ? 'good' : M.bets >= 2 ? 'warning' : 'serious',
      find: `About ${M.bets.toFixed(1)} independent bets; ${top.toLowerCase()} drive ${Math.round(M.rc[top] * 100)}% of your risk.`,
      rule: 'Spread risk across several sources that don’t move together, so no single one decides your outcome.' });
    // 2. single-asset concentration
    const singles = assets.filter(singleAsset).sort((a, b) => b.value - a.value), big = singles[0];
    const bigP = big ? big.value / A : 0;
    checks.push({ k: 'single', name: 'Single-asset concentration', status: st(bigP, 0.10, 0.25),
      find: big && bigP >= 0.05 ? `${big.name} is ${pctA(big.value)} of assets${singles.filter(i => i.value / A >= 0.10).length > 1 ? `; ${singles.filter(i => i.value / A >= 0.10).length} single assets are over 10%` : ''}.` : 'No single property, coin or other individual asset is over 5% of assets.',
      rule: 'Common limit: no one asset above 10–20%. Diversified funds don’t count; a single property or coin does.' });
    // 3. speculative assets
    const btc = M.w.Bitcoin;
    checks.push({ k: 'spec', name: 'Speculative assets', status: st(btc, 0.05, 0.10),
      find: btc > 0.0005 ? `Bitcoin is ${(btc * 100).toFixed(1)}% of assets and ${Math.round(M.rc.Bitcoin * 100)}% of risk.` : 'No crypto.',
      rule: 'Institutions that hold crypto usually cap it at 1–5% and size it so a 75% fall is survivable.' });
    // 4. liquidity
    const liq = { liquid: 0, locked: 0, illiquid: 0 }; for (const i of assets) liq[liquidityOf(i)] += i.value;
    const lp = liq.liquid / A;
    checks.push({ k: 'liq', name: 'Liquidity', status: lp >= 0.25 ? 'good' : lp >= 0.10 ? 'warning' : 'serious',
      find: `${pctA(liq.liquid)} available within days, ${pctA(liq.locked)} in retirement accounts, ${pctA(liq.illiquid)} illiquid (property and similar).`,
      rule: 'Keep enough accessible that you’re never forced to sell at a bad time or pay early-withdrawal penalties.' });
    // 5. leverage
    const dr = D / A;
    checks.push({ k: 'lev', name: 'Leverage', status: nw <= 0 ? 'serious' : st(dr, 0.30, 0.50),
      find: D ? `Debts are ${pctA(D)} of assets, so net worth moves ${nw > 0 ? M.lev.toFixed(2) + '×' : 'more than'} as much as your assets.` : 'No debts.',
      rule: 'Debt magnifies every gain and loss. Under 30% of assets is conservative; over 50% leaves little room for a fall.' });
    // 6. currency match (spending vs holdings)
    const xp = exposures(vis).currency, spend = {}; let spT = 0;
    for (const e of expView()) if (e.monthly) { spend[e.currency] = (spend[e.currency] || 0) + e.monthly; spT += e.monthly; }
    if (!spT) spend[dispCur()] = 1;
    const outside = Object.entries(xp).filter(([c]) => !spend[c]).reduce((a, [, e]) => a + e.assets - e.debts, 0);
    const op = nw > 0 ? Math.max(0, outside) / nw : 0;
    const big2 = Object.entries(xp).map(([c, e]) => [c, e.assets - e.debts]).filter(([c]) => !spend[c]).sort((a, b) => b[1] - a[1]).slice(0, 2).filter(([, v]) => v > 0).map(([c]) => c === 'XAU' ? 'gold' : c === 'BTC' ? 'bitcoin' : c);
    checks.push({ k: 'fx', name: 'Currency match', status: st(op, 0.30, 0.60),
      find: `${Math.round(op * 100)}% of net worth is outside the currency you spend in (${Object.keys(spend).join(', ')})${big2.length ? `, mainly ${big2.join(' and ')}` : ''}.`,
      rule: 'Match assets to future spending. Holding other currencies is fine if you’ll live there; otherwise it’s an extra bet.' });
    // 7. counterparty (bank deposits above insurance limits)
    const cp = counterparty(vis); let unins = 0;
    for (const e of cp) { const dep = Object.values(e.deposits).reduce((a, d) => a + d.v, 0); unins += Math.max(0, dep - e.insured); }
    checks.push({ k: 'cp', name: 'Counterparty', status: unins < 1 ? 'good' : unins / A <= 0.05 ? 'warning' : 'serious',
      find: unins < 1 ? 'All bank deposits are within deposit-insurance limits.' : `${fmt(unins)} of bank deposits is above insurance limits (${pctA(unins)} of assets).`,
      rule: 'Keep deposits within each bank’s insurance limit; spread larger balances or use Treasury bills or money-market funds.' });
    // 8. tail loss
    const worst = M.stress.slice().sort((a, b) => a.loss - b.loss)[0], wl = nw > 0 ? -worst.loss / nw : 0;
    checks.push({ k: 'tail', name: 'Tail loss', status: worst.loss >= 0 ? 'good' : st(wl, 0.20, 0.35),
      find: worst.loss < 0 ? `Worst stress test (${worst.name}) would cost ${fmt(-worst.loss)}, ${Math.round(wl * 100)}% of net worth.` : 'None of the stress tests reduce your net worth.',
      rule: 'Know your worst plausible loss and make sure you could live through it without selling. Under 20% of net worth is cautious; over 35% is a deep hole.' });
    // 9. emergency reserve
    const ef = (() => { const ex = expView().filter(e => e.monthly !== null), ess = ex.filter(e => e.essential).reduce((a, e) => a + e.monthly, 0); const base = ess || ex.reduce((a, e) => a + e.monthly, 0); if (!base) return null;
      const set = asides.reduce((t, a) => t + (a.amount === null ? 0 : (conv(a.amount, a.currency) || 0)), 0); return Math.max(0, efHoldings().reduce((a, i) => a + i.value, 0) - set) / base; })();
    checks.push({ k: 'ef', name: 'Emergency reserve', status: ef === null ? 'info' : ef >= 6 ? 'good' : ef >= 3 ? 'warning' : 'serious',
      find: ef === null ? 'Add monthly expenses to check this.' : `${fmtMonths(ef)} months of spending in cash after set-asides.`,
      rule: '3–6 months is the usual guideline; more if your income is variable or you’re supporting others.' });
    return { M, checks, A, D, nw, liq, worst, top };
  }
  const RK_ICON = { good: '✓', warning: '!', serious: '✕', info: '–' }, RK_WORD = { good: 'OK', warning: 'Watch', serious: 'Concern', info: 'Not set' };
  function renderRisk() {
    const sec = $('rkSection');
    const R = mode === 'locked' ? null : assessRisk(visible());
    if (!R) { sec.hidden = true; return; }
    sec.hidden = false;
    const { M, checks } = R, volNW = M.volNW;
    $('rkProfile').textContent = volNW === null ? '—' : profileOf(volNW);
    $('rkProfileSub').textContent = volNW === null ? 'Net worth is zero or negative.' : `Net worth volatility about ${(volNW * 100).toFixed(1)}% a year, ${equivMix(volNW)}.`;
    $('rkVar').textContent = M.var95 > 0 ? '−' + fmt(M.var95) : 'Small';
    $('rkVarSub').textContent = M.var95 > 0 ? `${R.nw > 0 ? Math.round(M.var95 / R.nw * 100) + '% of net worth. ' : ''}In the worst 5% of years the average loss is about ${fmt(M.es95)}.` : 'Your expected return outweighs a 1-in-20 fall.';
    $('rkDiv').textContent = M.bets.toFixed(1) + ' bets';
    $('rkDivSub').textContent = `Spread like ${M.capN.toFixed(1)} equal asset classes by money, but only ${M.bets.toFixed(1)} by risk. Diversification ratio ${M.dr.toFixed(2)} (1 = none).`;
    // capital vs risk bars
    const bars = $('rkBars'); bars.textContent = '';
    for (const [lab, o] of [['Money', M.w], ['Risk', M.rc]]) {
      const row = document.createElement('div'); row.className = 'sc-arow';
      const l = document.createElement('span'); l.textContent = lab;
      const bar = document.createElement('span'); bar.className = 'sc-abar';
      BUCKETS.forEach((b, ix) => { const v = Math.max(0, o[b]); if (v < 0.002) return; const seg = document.createElement('i'); seg.className = 'bk-' + ix; seg.style.width = (v * 100) + '%'; seg.title = `${b}: ${(M.w[b] * 100).toFixed(1)}% of money, ${(M.rc[b] * 100).toFixed(1)}% of risk`; bar.append(seg); });
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = lab === 'Money' ? fmtShort(M.A) : 'assets ' + (M.vol * 100).toFixed(1) + '%/yr';
      row.append(l, bar, a); bars.append(row);
    }
    const lg = $('rkLegend'); lg.textContent = '';
    BUCKETS.forEach((b, ix) => { if (M.w[b] < 0.002) return; const s = document.createElement('span'); const d = document.createElement('i'); d.className = 'bk-' + ix; s.append(d, `${b} ${Math.round(M.w[b] * 100)}% → ${Math.round(M.rc[b] * 100)}%`); lg.append(s); });
    const gaps = BUCKETS.filter(b => M.w[b] > 0.002).sort((a, b) => (M.rc[b] - M.w[b]) - (M.rc[a] - M.w[a]));
    const hi = gaps[0], lo = gaps[gaps.length - 1];
    $('rkRiskNote').textContent = `${hi} ${M.w[hi] < 0.995 ? `are ${Math.round(M.w[hi] * 100)}% of your money but about ${Math.round(M.rc[hi] * 100)}% of your risk` : 'are all of your risk'}` +
      (lo && lo !== hi && M.w[lo] > 0.02 ? `; ${lo.toLowerCase()} (${Math.round(M.w[lo] * 100)}% of money) add${M.rc[lo] < 0.005 ? ' almost no' : ` only ${Math.round(M.rc[lo] * 100)}% of`} risk` : '') + '. Legend shows share of money → share of risk.';
    // stress tests
    const tbl = $('rkStress'); tbl.textContent = '';
    const hr = document.createElement('tr'); ['Scenario', 'Net worth change', '% of net worth', 'Hardest hit'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody');
    const by = BUCKETS.reduce((o, b) => (o[b] = M.w[b] * M.A, o), {});
    const fxNet = Object.entries(exposures(visible()).currency).filter(([c]) => c !== dispCur() && !PRICED.includes(c)).reduce((a, [, e]) => a + e.assets - e.debts, 0);
    const rows = M.stress.map(t => ({ ...t, hit: BUCKETS.filter(b => by[b] * (t.s[b] || 0) < 0).sort((a, b) => by[a] * t.s[a] - by[b] * t.s[b])[0] }));
    if (Math.abs(fxNet) > 1) rows.push({ name: `${dispCur()} up 15%`, sub: `Against every other currency you hold (net of debts in them); gold and bitcoin excluded`, loss: fxNet * (1 / 1.15 - 1), hit: null, fx: true });
    for (const r of rows) {
      const tr = document.createElement('tr');
      const n = document.createElement('td'); n.className = 'rk-scn'; n.textContent = r.name; const sm = document.createElement('small'); sm.textContent = r.sub; n.append(sm); tr.append(n);
      const v = document.createElement('td'); v.textContent = (r.loss >= 0 ? '+' : '−') + fmt(Math.abs(r.loss)); v.className = r.loss < -0.5 ? 'rk-neg' : 'rk-pos'; tr.append(v);
      const pc = document.createElement('td'); pc.textContent = R.nw > 0 ? ((r.loss >= 0 ? '+' : '−') + Math.abs(r.loss / R.nw * 100).toFixed(1) + '%') : '—'; tr.append(pc);
      const h = document.createElement('td'); h.textContent = r.fx ? 'Non-' + dispCur() + ' holdings' : r.hit ? `${r.hit} (${String(r.s[r.hit]).replace('-', '−')}%)` : '—'; tr.append(h);
      tb.append(tr);
    }
    tbl.append(tb);
    // scorecard
    const sc = $('rkScore'); sc.textContent = '';
    for (const c of checks) {
      const row = document.createElement('div'); row.className = 'rk-item rk-' + c.status;
      const ic = document.createElement('span'); ic.className = 'rk-ico'; ic.textContent = RK_ICON[c.status]; ic.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('div'); nm.className = 'rk-name'; nm.textContent = c.name; const w = document.createElement('small'); w.textContent = RK_WORD[c.status]; nm.append(w);
      const f = document.createElement('div'); f.className = 'rk-find'; f.textContent = c.find; const r = document.createElement('small'); r.textContent = c.rule; f.append(r);
      row.append(ic, nm, f); sc.append(row);
    }
    const watch = checks.filter(c => c.status === 'warning').map(c => c.name.toLowerCase()), act = checks.filter(c => c.status === 'serious').map(c => c.name.toLowerCase());
    const ok = checks.filter(c => c.status === 'good').length, scored = checks.filter(c => c.status !== 'info').length;
    const list = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
    $('rkVerdict').textContent = (volNW === null ? '' : `${profileOf(volNW)} risk overall: ${equivMix(volNW)}. `) +
      `${ok} of ${scored} checks pass.` + (act.length ? ` Address ${list(act)}.` : '') + (watch.length ? ` Keep an eye on ${list(watch)}.` : '') + (!act.length && !watch.length ? ' Nothing stands out.' : '');
    $('rkNote').textContent = 'Market risk uses the long-run return, volatility and correlation assumptions from the Scenarios tab, applied to your look-through mix; a normal approximation that understates real-world tails, which is why the stress tests are there. Stress moves are approximate peak-to-trough figures in US dollar terms; a home is valued less often than a fund, so its swings look smaller than they are. Limits are common institutional and planning guidelines, not personal advice.';
  }

  // ---------- Rebalance what-if ----------
  // A list of manual moves ("$20k from Checking to Gold"). Hindsight: what each move would have earned over the last
  // 12 months / 5 years, using each holding's trailing returns (cash: its interest rate). Forward: the change in expected
  // return, using each holding's Expected return or, if blank, the long-run assumption for its asset mix.
  // Moves are kept in this browser's preferences.
  const MV = prefs.moves = Array.isArray(prefs.moves) ? prefs.moves.filter(m => m && typeof m === 'object').slice(0, 20) : [];
  const has = v => v !== null && v !== undefined && Number.isFinite(Number(v));
  const mvAssets = () => visible().filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx);
  const r12Of = i => retOf(i).r;
  const r5Of = i => has(i.ret5) ? i.ret5 : (mainBucket(i) === 'Cash' && has(i.rate) ? i.rate : null);
  const assumedRet = mix => { let s = 0, t = 0; for (const [c, w] of Object.entries(mix)) { s += w * SC_DEFAULTS[bucketOf(c)][0]; t += w; } return t ? s / t : 0; };
  const fwdOf = i => has(i.rate) ? i.rate : assumedRet(mixFor(i));
  // a "new position" in a bucket uses the value-weighted figures of the holdings you already have in that bucket
  function newPos(bucket, assets) {
    const inB = assets.filter(i => mainBucket(i) === bucket);
    const avg = f => { const h = inB.filter(i => f(i) !== null); const w = h.reduce((a, i) => a + i.value, 0); return w ? h.reduce((a, i) => a + i.value * f(i), 0) / w : null; };
    return { id: 'b:' + bucket, name: 'New ' + bucket.toLowerCase() + ' position', value: 0, virtual: true, bucket,
      r12: avg(r12Of), r5: avg(r5Of), fwd: has(avg(i => has(i.rate) ? i.rate : null)) ? avg(i => has(i.rate) ? i.rate : null) : SC_DEFAULTS[bucket][0], mix: { [bucket]: 100 } };
  }
  const posOf = (id, assets) => {
    if (typeof id === 'string' && id.startsWith('b:') && BUCKETS.includes(id.slice(2))) return newPos(id.slice(2), assets);
    const i = assets.find(a => a.id === id); if (!i) return null;
    return { id: i.id, name: i.name, value: i.value, r12: r12Of(i), r5: r5Of(i), fwd: fwdOf(i), mix: mixFor(i), bucket: mainBucket(i), item: i };
  };
  // apply all moves; amounts are capped at what's left in the source after earlier moves
  function mvCompute() {
    const assets = mvAssets(), left = Object.fromEntries(assets.map(i => [i.id, i.value]));
    const rows = MV.map(m => {
      const from = posOf(m.from, assets), to = posOf(m.to, assets), want = Math.max(0, Number(m.amount) || 0);
      if (!from || from.virtual || !to || from.id === to.id || !want) return { m, from, to, amt: 0, want };
      const amt = Math.min(want, Math.max(0, left[from.id])); left[from.id] -= amt; if (!to.virtual) left[to.id] += amt;
      const d12 = from.r12 !== null && to.r12 !== null ? amt * (to.r12 - from.r12) / 100 : null;
      const d5 = from.r5 !== null && to.r5 !== null ? amt * (Math.pow(1 + to.r5 / 100, 5) - Math.pow(1 + from.r5 / 100, 5)) : null;
      return { m, from, to, amt, want, d12, d5, dF: amt * (to.fwd - from.fwd) / 100 };
    });
    const total = assets.reduce((a, i) => a + i.value, 0);
    // portfolio-level figures before and after (12-mo counts missing as 0%, like the Returns panel; 5-yr and forward
    // weight only holdings with a figure)
    const pts12 = assets.reduce((a, i) => a + i.value * (r12Of(i) || 0), 0);
    const w5 = assets.filter(i => r5Of(i) !== null), v5 = w5.reduce((a, i) => a + i.value, 0), p5 = w5.reduce((a, i) => a + i.value * r5Of(i), 0);
    const pF = assets.reduce((a, i) => a + i.value * fwdOf(i), 0);
    const act = rows.filter(r => r.amt > 0);
    let a12 = pts12, a5 = p5, a5v = v5, aF = pF;
    for (const r of act) {
      a12 += r.amt * ((r.to.r12 || 0) - (r.from.r12 || 0));
      if (r.from.r5 !== null) { a5 -= r.amt * r.from.r5; a5v -= r.amt; }
      if (r.to.r5 !== null) { a5 += r.amt * r.to.r5; a5v += r.amt; }
      aF += r.amt * (r.to.fwd - r.from.fwd);
    }
    // bucket mix before / after
    const by = (vals, extra) => {
      const o = Object.fromEntries(BUCKETS.map(b => [b, 0]));
      for (const i of assets) for (const [c, w] of Object.entries(mixFor(i))) o[bucketOf(c)] += vals[i.id] * w / 100;
      for (const [b, v] of Object.entries(extra)) o[b] += v;
      return o;
    };
    const extra = {}; for (const r of act) if (r.to.virtual) extra[r.to.bucket] = (extra[r.to.bucket] || 0) + r.amt;
    const before = by(Object.fromEntries(assets.map(i => [i.id, i.value])), {}), after = by(left, extra);
    return { assets, rows, act, total, left, extra, before, after,
      r12: [pts12 / total, a12 / total], r5: v5 ? [p5 / v5, a5v ? a5 / a5v : null] : null, fwd: [pF / total, aF / total] };
  }
  // months of emergency cover before / after (same rules as the Emergency fund card)
  function mvEf(R) {
    const ex = expView().filter(e => e.monthly !== null), ess = ex.filter(e => e.essential).reduce((a, e) => a + e.monthly, 0);
    const base = ess || ex.reduce((a, e) => a + e.monthly, 0); if (!base) return null;
    const ids = new Set(efHoldings().map(i => i.id));
    const setAside = asides.reduce((t, a) => t + (a.amount === null ? 0 : (conv(a.amount, a.currency) || 0)), 0);
    const cashNow = R.assets.filter(i => ids.has(i.id)).reduce((a, i) => a + i.value, 0);
    let cashAfter = R.assets.filter(i => ids.has(i.id)).reduce((a, i) => a + R.left[i.id], 0);
    if (EF.mode !== 'custom') cashAfter += R.extra.Cash || 0;
    return [Math.max(0, cashNow - setAside) / base, Math.max(0, cashAfter - setAside) / base];
  }
  const signed = n => (n > 0.5 ? '+' : n < -0.5 ? '−' : '') + fmt(Math.abs(n));
  const pctArrow = (a, b, unit = '') => `${a.toFixed(1)}%${unit} → ${b.toFixed(1)}%${unit}`;
  function mvOptions(sel, assets, withNew, value) {
    sel.textContent = '';
    const groups = {};
    for (const i of assets) (groups[mainBucket(i)] = groups[mainBucket(i)] || []).push(i);
    for (const g of ['Cash', ...BUCKETS.filter(b => b !== 'Cash'), 'Multi-asset'].filter(g => groups[g])) {
      const og = document.createElement('optgroup'); og.label = g === 'Multi-asset' ? 'Multi-asset funds' : g;
      for (const i of groups[g].sort((a, b) => b.value - a.value)) { const o = document.createElement('option'); o.value = i.id; o.textContent = `${i.name} · ${fmtShort(i.value)}`; og.append(o); }
      sel.append(og);
    }
    if (withNew) {
      const og = document.createElement('optgroup'); og.label = 'New position';
      for (const b of BUCKETS) { const o = document.createElement('option'); o.value = 'b:' + b; o.textContent = 'New ' + b.toLowerCase() + ' position'; og.append(o); }
      sel.append(og);
    }
    if (value && [...sel.options].some(o => o.value === value)) sel.value = value;
    else if (value) { const o = document.createElement('option'); o.value = value; o.textContent = '(holding not found)'; sel.prepend(o); sel.value = value; }
  }
  function renderMoves() {
    const sec = $('mvSection');
    if (mode === 'locked') { sec.hidden = true; return; }
    const R = mvCompute(); sec.hidden = !R.assets.length; if (!R.assets.length) return;
    const list = $('mvList');
    const typing = document.activeElement && document.activeElement.classList.contains('mv-amt') && list.contains(document.activeElement);
    if (!typing) {          // don't rebuild while someone is typing an amount
      list.textContent = '';
      if (!MV.length) { const e = document.createElement('div'); e.className = 'mv-empty'; e.textContent = 'Add a move, e.g. part of your cash into gold, to see what it would have earned.'; list.append(e); }
      MV.forEach((m, k) => {
        const row = document.createElement('div'); row.className = 'mv-row';
        const amt = document.createElement('input'); amt.className = 'mv-amt'; amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.inputMode = 'decimal';
        amt.placeholder = 'Amount (' + dispCur() + ')'; amt.setAttribute('aria-label', `Move ${k + 1} amount in ${dispCur()}`); amt.value = m.amount || '';
        amt.oninput = () => { m.amount = Math.max(0, Number(amt.value) || 0); savePrefs(); renderMoves(); };
        const w1 = document.createElement('span'); w1.className = 'mv-w'; w1.textContent = 'from';
        const from = document.createElement('select'); from.className = 'mv-from'; from.setAttribute('aria-label', `Move ${k + 1} from`); mvOptions(from, R.assets, false, m.from);
        const w2 = document.createElement('span'); w2.className = 'mv-w'; w2.textContent = 'to';
        const to = document.createElement('select'); to.className = 'mv-to'; to.setAttribute('aria-label', `Move ${k + 1} to`); mvOptions(to, R.assets, true, m.to);
        from.onchange = () => { m.from = from.value; savePrefs(); renderMoves(); };
        to.onchange = () => { m.to = to.value; savePrefs(); renderMoves(); };
        const x = document.createElement('button'); x.type = 'button'; x.className = 'icon-btn mv-x'; x.textContent = '×'; x.setAttribute('aria-label', `Remove move ${k + 1}`);
        x.onclick = () => { MV.splice(k, 1); savePrefs(); renderMoves(); };
        row.append(amt, w1, from, w2, to, x);
        const r = R.rows[k];
        const msg = !r.from ? 'The source holding isn’t in this view.' : !r.to ? 'The destination holding isn’t in this view.' : r.from.id === r.to.id ? 'Pick a different destination.'
          : r.want > r.amt + 0.5 ? `Only ${fmt(r.amt)} is available in ${r.from.name}${r.amt < r.from.value - 0.5 ? ' after earlier moves' : ''}; that’s what’s counted.` : '';
        if (msg) { const w = document.createElement('div'); w.className = 'mv-max'; w.textContent = msg; row.append(w); }
        list.append(row);
      });
    } else {
      // refresh just the warnings under each row
      [...list.querySelectorAll('.mv-row')].forEach((row, k) => {
        const r = R.rows[k]; if (!r) return; let w = row.querySelector('.mv-max');
        const msg = r.from && r.to && r.from.id !== r.to.id && r.want > r.amt + 0.5 ? `Only ${fmt(r.amt)} is available in ${r.from.name}; that’s what’s counted.` : '';
        if (!msg) { if (w) w.remove(); return; }
        if (!w) { w = document.createElement('div'); w.className = 'mv-max'; row.append(w); } w.textContent = msg;
      });
    }
    $('mvClear').hidden = !MV.length;
    $('mvOut').hidden = !R.act.length;
    $('mvNote').textContent = 'Hindsight uses each holding’s trailing returns in its own currency (currency moves aren’t counted). Cash uses today’s interest rate for the whole period, though real rates varied. A new position uses your existing holdings in that bucket. Ignores taxes, fees and trading costs. Past returns don’t predict future ones. Moves are saved in this browser.';
    if (!R.act.length) return;
    const moved = R.act.reduce((a, r) => a + r.amt, 0);
    const s12 = R.act.filter(r => r.d12 !== null), s5 = R.act.filter(r => r.d5 !== null);
    const g12 = s12.reduce((a, r) => a + r.d12, 0), g5 = s5.reduce((a, r) => a + r.d5, 0), gF = R.act.reduce((a, r) => a + r.dF, 0);
    const tone = (el, n) => { el.classList.toggle('pos', n > 0.5); el.classList.toggle('neg', n < -0.5); };
    $('mv12').textContent = s12.length ? signed(g12) : 'no data'; tone($('mv12'), s12.length ? g12 : 0);
    const nod = n => `${n} move${n > 1 ? 's' : ''} without data, not counted`;
    $('mv12Sub').textContent = (!s12.length ? 'No 12-month figures for these holdings' : s12.length < R.act.length ? `For the moves with data · ${nod(R.act.length - s12.length)}` : `Portfolio return ${pctArrow(...R.r12)}`) + '.';
    $('mv5').textContent = s5.length ? signed(g5) : 'no data'; tone($('mv5'), s5.length ? g5 : 0);
    $('mv5Sub').textContent = (!s5.length ? 'No 5-year figures for these holdings' : s5.length < R.act.length ? `Total over 5 years · ${nod(R.act.length - s5.length)}` : `Total over 5 years · ${R.r5 && R.r5[1] !== null ? pctArrow(R.r5[0], R.r5[1], '/yr') : ''}`) + '.';
    $('mvFwd').textContent = signed(gF) + '/yr'; tone($('mvFwd'), gF);
    $('mvFwdSub').textContent = `Expected return ${pctArrow(...R.fwd)} · moving ${fmt(moved)} (${Math.round(moved / R.total * 100)}% of assets).`;
    // per-move table
    const tbl = $('mvTable'); tbl.textContent = '';
    const hr = document.createElement('tr');
    ['Move', 'Amount', '12-mo return', '12-mo gain', '5-yr return', '5-yr gain', 'Expected'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody');
    const f = v => v === null ? '—' : v.toFixed(1) + '%';
    for (const r of R.act) {
      const tr = document.createElement('tr');
      [`${r.from.name} → ${r.to.name}`, fmt(r.amt), `${f(r.from.r12)} → ${f(r.to.r12)}`, r.d12 === null ? '—' : signed(r.d12),
        `${f(r.from.r5)} → ${f(r.to.r5)}`, r.d5 === null ? '—' : signed(r.d5), `${f(r.from.fwd)} → ${f(r.to.fwd)}`].forEach((t, ix) => {
        const td = document.createElement('td'); td.textContent = t; if (!ix) td.className = 'mv-move'; tr.append(td);
      });
      tb.append(tr);
    }
    if (R.act.length > 1) {
      const tr = document.createElement('tr'); tr.className = 'ret-total';
      ['Total', fmt(moved), '', s12.length ? signed(g12) : '—', '', s5.length ? signed(g5) : '—', signed(gF) + '/yr'].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
      tb.append(tr);
    }
    tbl.append(tb);
    // mix bars
    const bars = $('mvBars'); bars.textContent = '';
    const tot = o => Object.values(o).reduce((a, b) => a + b, 0);
    for (const [lab, o] of [['Now', R.before], ['After', R.after]]) {
      const t = tot(o), row = document.createElement('div'); row.className = 'sc-arow';
      const l = document.createElement('span'); l.textContent = lab;
      const bar = document.createElement('span'); bar.className = 'sc-abar';
      bar.classList.add('lab');
      BUCKETS.forEach((b, ix) => {
        const w = t ? o[b] / t : 0; if (w < 0.002) return; const seg = document.createElement('i'); seg.className = 'bk-' + ix; seg.style.width = (w * 100) + '%'; seg.title = `${b} ${(w * 100).toFixed(1)}% · ${fmt(o[b])}`;
        const pc = document.createElement('b'); pc.textContent = (w * 100 >= 9.95 ? Math.round(w * 100) : (w * 100).toFixed(1)) + '%'; seg.append(pc); bar.append(seg);
      });
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = fmtShort(t);
      row.append(l, bar, a); bars.append(row);
    }
    // percentages sit inside each segment; hidden where the segment is too narrow (the legend lists every value)
    requestAnimationFrame(() => bars.querySelectorAll('.sc-abar.lab i').forEach(seg => { const b = seg.firstChild; b.hidden = b.scrollWidth + 6 > seg.clientWidth; }));
    const lg = $('mvLegend'); lg.textContent = '';
    const tb0 = tot(R.before), ta = tot(R.after), pct = v => (v * 100).toFixed(1) + '%';
    BUCKETS.forEach((b, ix) => {
      if (R.before[b] < 0.5 && R.after[b] < 0.5) return; const s = document.createElement('span'); const d = document.createElement('i'); d.className = 'bk-' + ix;
      const w0 = tb0 ? R.before[b] / tb0 : 0, w1 = ta ? R.after[b] / ta : 0, v = document.createElement('b'); v.className = 'lg-pct';
      v.textContent = Math.abs(w0 - w1) >= 0.0005 ? `${pct(w0)} → ${pct(w1)}` : pct(w0); s.append(d, b + ' ', v); lg.append(s);
    });
    const ch = BUCKETS.filter(b => Math.abs(R.before[b] / tb0 - R.after[b] / ta) >= 0.0005).map(b => `${b} ${(R.before[b] / tb0 * 100).toFixed(1)}% → ${(R.after[b] / ta * 100).toFixed(1)}%`);
    $('mvChanges').textContent = ch.length ? ch.join(' · ') : 'No change in your asset-class mix (the moves stay within the same buckets).';
    const dNow = visible().filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx).reduce((a, i) => a + i.value, 0);
    const m0 = riskModel(R.before, dNow), m1 = riskModel(R.after, dNow);
    if (m0 && m1 && m0.volNW !== null && m1.volNW !== null) {
      const wl = M => Math.round(-Math.min(0, ...M.stress.map(t => t.loss)) / M.nw * 100);
      $('mvRisk').textContent = `Risk: net-worth volatility ${(m0.volNW * 100).toFixed(1)}% → ${(m1.volNW * 100).toFixed(1)}% (${profileOf(m0.volNW)}${profileOf(m0.volNW) !== profileOf(m1.volNW) ? ' → ' + profileOf(m1.volNW) : ''}) · diversification ${m0.bets.toFixed(1)} → ${m1.bets.toFixed(1)} bets · worst stress −${wl(m0)}% → −${wl(m1)}% of net worth · 1-in-20 bad year −${fmtShort(Math.max(0, m0.var95))} → −${fmtShort(Math.max(0, m1.var95))}.`;
    } else $('mvRisk').textContent = '';
    const ef = mvEf(R), warns = [];
    if (ef && Math.abs(ef[0] - ef[1]) > 0.05) warns.push(`Emergency fund: ${fmtMonths(ef[0])} → ${fmtMonths(ef[1])} months of cover${ef[1] < 3 ? ', below the common 3–6 month guideline' : ''}.`);
    $('mvWarn').textContent = warns.join(' '); $('mvWarn').hidden = !warns.length;
    $('mvWarn').classList.toggle('warn-text', !!(ef && ef[1] < 3));
  }
  $('mvAdd').onclick = () => {
    const assets = mvAssets(); if (!assets.length) return;
    const cash = assets.filter(i => mainBucket(i) === 'Cash').sort((a, b) => b.value - a.value)[0] || [...assets].sort((a, b) => b.value - a.value)[0];
    const gold = assets.find(i => mainBucket(i) === 'Gold' && i.id !== cash.id);
    MV.push({ from: cash.id, to: gold ? gold.id : 'b:Gold', amount: 0 }); savePrefs(); renderMoves();
    const ins = $('mvList').querySelectorAll('.mv-amt'); if (ins.length) ins[ins.length - 1].focus();
  };
  $('mvClear').onclick = () => { MV.splice(0); savePrefs(); renderMoves(); };
  $('mvProject').onclick = () => {
    const R = mvCompute(), liq = BUCKETS.filter(b => b !== 'Property'), t = liq.reduce((a, b) => a + R.after[b], 0); if (!t) return;
    const start = Object.fromEntries(liq.map(b => [b, Math.round(R.after[b] / t * 1000) / 10]));
    const sc = cleanScenario({ name: 'After my moves', start, end: start, glide: 0, assume: Object.fromEntries(BUCKETS.map(b => [b, SC_DEFAULTS[b].slice()])), monthly: null, growth: 0, rebalance: true, holdProperty: true });
    sc._tmp = 'tmp' + Date.now(); scenarios.push(sc); scSel = sc._tmp; scDirty = true; renderScenarios();
    $('scTabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showBanner('Added “After my moves” as a scenario. Save it to keep it.', 'info');
  };

  // ---------- Plan: target allocation & rebalancing ----------
  // A written policy: a target % per bucket (of investable assets: everything except property, unless included, and
  // except a cash reserve of N months of spending plus set-asides), with a tolerance band. When any bucket leaves its
  // band, the plan trades back to target (or fixes only the breaches). Trades are turned into holding-level moves:
  // low-yield excess cash and liquid holdings first; retirement-account holdings become "switch inside the account";
  // bucket shortfalls go to your largest existing holding in that bucket, else a new position.
  const POL = prefs.policy = Object.assign({ targets: null, band: 5, reserve: 6, breach: false }, prefs.policy || {});
  if (!POL.basis) { POL.basis = 'all'; if (POL.targets && !POL.prop) POL._migrate = true; delete POL.prop; }   // older policies were set on investable money; re-expressed on first render
  const spendNow = () => { const ex = expView().filter(e => e.monthly !== null); return { ess: ex.filter(e => e.essential).reduce((a, e) => a + e.monthly, 0), all: ex.reduce((a, e) => a + e.monthly, 0) }; };
  const asideTotal = () => asides.reduce((t, a) => t + (a.amount === null ? 0 : (conv(a.amount, a.currency) || 0)), 0);
  // Two bases: "all" = your whole portfolio, exactly the mix in "Your real mix" (property held at its current share,
  // since it can't be partly sold; cash isn't sold below the reserve). "investable" = everything except property
  // and the cash reserve.
  const polAll = () => POL.basis !== 'investable';
  function polBase() {
    const vis = visible(), by = bucketValues(vis), sp = spendNow(), all = polAll();
    const reserve = (Number(POL.reserve) || 0) * (sp.ess || sp.all) + asideTotal();
    const keep = all ? 0 : Math.min(by.Cash, reserve);
    const inc = BUCKETS.filter(b => all || b !== 'Property');
    const cur = Object.fromEntries(inc.map(b => [b, b === 'Cash' ? by.Cash - keep : by[b]]));
    const T = inc.reduce((a, b) => a + cur[b], 0);
    const propShare = all && T ? Math.round(by.Property / T * 1000) / 10 : 0;
    return { vis, by, inc, cur, T, reserve, keep, all, propShare, spendSet: !!(sp.ess || sp.all) };
  }
  // a mix of the non-property classes (e.g. a preset or a Macro suggestion) expressed on the current basis
  function polFromMix(mix) {
    const B = polBase(), others = BUCKETS.filter(b => b !== 'Property'), t = others.reduce((a, b) => a + (Number(mix[b]) || 0), 0) || 100;
    const scale = (100 - B.propShare) / t;
    const out = Object.fromEntries(others.map(b => [b, Math.round((Number(mix[b]) || 0) * scale * 10) / 10]));
    if (B.all) out.Property = B.propShare;
    const d = Math.round((100 - Object.values(out).reduce((a, b) => a + b, 0)) * 10) / 10, big = others.slice().sort((a, b) => (out[b] || 0) - (out[a] || 0))[0];
    if (d && big) out[big] = Math.round((out[big] + d) * 10) / 10;
    return out;
  }
  function roundTo100(o) {
    const r = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
    const d = 100 - Object.values(r).reduce((a, b) => a + b, 0), big = Object.keys(r).sort((a, b) => o[b] - o[a])[0];
    if (big && d) r[big] += d; return r;
  }
  const polCurrent = B => {
    if (!B.T) return Object.fromEntries(B.inc.map(b => [b, 0]));
    const r = Object.fromEntries(B.inc.map(b => [b, Math.round(B.cur[b] / B.T * 1000) / 10]));   // one decimal, like Your real mix
    if (B.all) r.Property = B.propShare;
    const d = Math.round((100 - Object.values(r).reduce((a, x) => a + x, 0)) * 10) / 10, big = B.inc.filter(b => !(B.all && b === 'Property')).sort((a, b) => r[b] - r[a])[0];
    if (d && big) r[big] = Math.round((r[big] + d) * 10) / 10;
    return r;
  };
  const polTargets = B => {
    const t = POL.targets ? Object.fromEntries(B.inc.map(b => [b, Math.max(0, Number(POL.targets[b]) || 0)])) : polCurrent(B);
    if (B.all) t.Property = B.propShare;      // property is held as is: its target is always its current share
    return t;
  };
  function polTrades(B, tg) {
    const T = B.T, band = Math.max(0, Number(POL.band) || 0);
    const rows = B.inc.map(b => { const now = T ? B.cur[b] / T * 100 : 0, t = tg[b] || 0, want = t / 100 * T; return { b, now, t, drift: now - t, out: Math.abs(now - t) > band + 1e-9, cur: B.cur[b], want, trade: 0 }; });
    const anyOut = rows.some(r => r.out);
    if (anyOut && !POL.breach) rows.forEach(r => { r.trade = r.want - r.cur; });
    else if (anyOut) {
      rows.forEach(r => { r.trade = r.out ? r.want - r.cur : 0; });
      let gap = -rows.reduce((a, r) => a + r.trade, 0);           // >0: money freed to place; <0: money needed
      const cash = rows.find(r => r.b === 'Cash' && !r.out);
      if (cash) { const take = gap < 0 ? Math.max(gap, -cash.cur) : gap; cash.trade += take; gap -= take; }
      if (Math.abs(gap) > 0.5) { const pool = rows.filter(r => !r.out && r.b !== 'Cash'), tot = pool.reduce((a, r) => a + r.cur, 0); pool.forEach(r => { r.trade += tot ? gap * r.cur / tot : 0; }); }
    }
    return { rows, anyOut };
  }
  function polMoves(B, rows) {
    const assets = B.vis.filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx);
    const left = Object.fromEntries(assets.map(i => [i.id, i.value]));
    let cashFree = Math.max(0, assets.filter(i => mainBucket(i) === 'Cash').reduce((a, i) => a + i.value, 0) - B.reserve);
    const sources = [], unfilled = [];
    for (const r of rows.filter(r => r.trade < -0.5)) {
      let need = -r.trade;
      const cands = assets.filter(i => mainBucket(i) === r.b).sort((a, b) => {
        const la = liquidityOf(a) === 'liquid' ? 0 : 1, lb = liquidityOf(b) === 'liquid' ? 0 : 1; if (la !== lb) return la - lb;
        return r.b === 'Cash' ? fwdOf(a) - fwdOf(b) : b.value - a.value;
      });
      for (const i of cands) {
        if (need < 0.5) break;
        let amt = Math.min(need, left[i.id]); if (r.b === 'Cash') amt = Math.min(amt, cashFree);
        if (amt < 0.5) continue;
        left[i.id] -= amt; need -= amt; if (r.b === 'Cash') cashFree -= amt;
        sources.push({ i, amt, bucket: r.b, locked: liquidityOf(i) === 'locked' });
      }
      if (need >= 0.5) unfilled.push({ b: r.b, amt: need, dir: 'sell' });
    }
    const buys = rows.filter(r => r.trade > 0.5).map(r => {
      const pool = assets.filter(i => mainBucket(i) === r.b && liquidityOf(i) === 'liquid');
      const dest = r.b === 'Cash' ? pool.sort((a, b) => fwdOf(b) - fwdOf(a))[0] : pool.sort((a, b) => b.value - a.value)[0];
      return { b: r.b, amt: r.trade, dest };
    });
    const moves = [];
    sources.sort((a, b) => a.locked - b.locked);
    for (const s of sources) {
      let amt = s.amt;
      for (const y of buys) {
        if (amt < 0.5) break; if (y.amt < 0.5) continue;
        const a = Math.min(amt, y.amt); amt -= a; y.amt -= a;
        const to = s.locked || !y.dest ? 'b:' + y.b : y.dest.id;
        const prev = moves.find(m => m.from === s.i.id && m.to === to);
        if (prev) prev.amount += a; else moves.push({ from: s.i.id, to, amount: a, fromName: s.i.name, toName: to.startsWith('b:') ? `new ${y.b.toLowerCase()} position` : y.dest.name, bucket: y.b, fromBucket: s.bucket, locked: s.locked, taxable: !s.locked && s.bucket !== 'Cash' });
      }
    }
    for (const y of buys) if (y.amt >= 0.5) unfilled.push({ b: y.b, amt: y.amt, dir: 'buy' });
    return { moves, unfilled };
  }
  function renderTargets() {
    let B = polBase(); const sec = $('taSection');
    if (!B.T) { sec.hidden = true; return; } sec.hidden = false;
    if (POL._migrate) { const { Property, ...rest } = POL.targets || {}; POL.targets = POL.targets ? polFromMix(rest) : null; delete POL._migrate; savePrefs(); B = polBase(); }
    const tg = polTargets(B), sum = B.inc.reduce((a, b) => a + (tg[b] || 0), 0), ok = Math.abs(sum - 100) < 0.05;
    $('taBand').value = POL.band; $('taReserve').value = POL.reserve; $('taBasis').value = B.all ? 'all' : 'investable'; $('taBreach').checked = !!POL.breach;
    const resTxt = `${POL.reserve} months of ${B.spendSet ? 'spending' : 'spending (add expenses to set this)'}${asideTotal() > 0.5 ? ' plus set-asides' : ''}`;
    $('taBase').textContent = (B.all
      ? `Targets apply to your whole portfolio (${fmt(B.T)}), the same mix as “Your real mix” on the overview. Property (${B.propShare}%) is held as is.` + (B.reserve > 0.5 ? ` Cash won’t be sold below your ${fmt(Math.min(B.reserve, B.by.Cash))} reserve (${resTxt}).` : '')
      : `Targets apply to ${fmt(B.T)}: your assets except property (${fmt(B.by.Property)})` + (B.keep > 0.5 ? ` and your ${fmt(B.keep)} cash reserve (${resTxt})` : '') + '.') +
      (POL.targets ? '' : ' Targets start at your current mix: change them to your policy, or pick a starting point.');
    const { rows, anyOut } = ok ? polTrades(B, tg) : { rows: B.inc.map(b => ({ b, now: B.cur[b] / B.T * 100, t: tg[b] || 0, drift: B.cur[b] / B.T * 100 - (tg[b] || 0), out: false, cur: B.cur[b], trade: 0 })), anyOut: false };
    const tbl = $('taTable'); tbl.textContent = '';
    const hr = document.createElement('tr'); ['Asset class', 'Target %', 'Now', 'Drift', 'Status', 'Trade'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody'), band = Math.max(0, Number(POL.band) || 0), span = Math.max(band * 3, ...rows.map(r => Math.abs(r.drift)), 1);
    for (const r of rows) {
      const tr = document.createElement('tr');
      const n = document.createElement('td'); const dot = document.createElement('i'); dot.className = 'sc-dot bk-' + BUCKETS.indexOf(r.b); n.append(dot, r.b); tr.append(n);
      const ti = document.createElement('td'); const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = 'any'; inp.value = tg[r.b] || 0; inp.setAttribute('aria-label', `${r.b} target %`);
      inp.onchange = () => { const v = Math.max(0, Math.min(100, Number(inp.value) || 0)); POL.targets = { ...tg, [r.b]: v }; savePrefs(); renderPlan(); };
      if (B.all && r.b === 'Property') { inp.disabled = true; inp.title = 'Property is held as is; its target is its current share'; }
      ti.append(inp); tr.append(ti);
      const nw = document.createElement('td'); nw.textContent = `${r.now.toFixed(1)}% · ${fmtShort(r.cur)}`; tr.append(nw);
      const dr = document.createElement('td'); const g = document.createElement('span'); g.className = 'ta-drift';
      const sh = document.createElement('s'); sh.style.left = (50 - band / span * 50) + '%'; sh.style.width = (band / span * 100) + '%'; g.append(sh);
      const z = document.createElement('b'); z.style.left = '50%'; g.append(z);
      const bar = document.createElement('i'); const wpx = Math.abs(r.drift) / span * 50; bar.style.left = (r.drift < 0 ? 50 - wpx : 50) + '%'; bar.style.width = wpx + '%'; if (r.out) bar.className = 'out'; g.append(bar);
      dr.append(g, document.createTextNode((r.drift > 0 ? '+' : r.drift < 0 ? '−' : '') + Math.abs(r.drift).toFixed(1) + ' pts')); tr.append(dr);
      const stc = document.createElement('td'); stc.className = 'ta-st ' + (r.out ? 'rk-warning' : 'rk-good');
      const ic = document.createElement('span'); ic.className = 'rk-ico'; ic.textContent = r.out ? '!' : '✓'; ic.setAttribute('aria-hidden', 'true');
      stc.append(ic, ok ? (r.out ? (r.drift > 0 ? 'Over band' : 'Under band') : 'In band') : '—'); tr.append(stc);
      const trd = document.createElement('td'); trd.textContent = Math.abs(r.trade) < 0.5 ? '—' : (r.trade > 0 ? 'Buy ' : 'Sell ') + fmt(Math.abs(r.trade)); tr.append(trd);
      tb.append(tr);
    }
    const sr = document.createElement('tr'); sr.className = 'sc-sum';
    ['Total', (Math.round(sum * 10) / 10) + '%', '100% · ' + fmtShort(B.T), '', '', ''].forEach(t => { const td = document.createElement('td'); td.textContent = t; sr.append(td); });
    tb.append(sr); tbl.append(tb);
    const plan = $('taPlan'); plan.textContent = '';
    const out = rows.filter(r => r.out).length;
    $('taSum').textContent = !ok ? `Targets add up to ${Math.round(sum * 10) / 10}%. Make them add up to 100% to get a plan.` : anyOut ? `${out} of ${rows.length} asset classes are outside the ±${band}-point band.` : `Everything is within ±${band} points of target. No trades needed.`;
    $('taSum').classList.toggle('warn-text', !ok);
    $('taLoad').hidden = true; $('taRisk').textContent = '';
    if (!ok || !anyOut) { const e = document.createElement('div'); e.className = 'mv-empty'; e.textContent = !ok ? 'Fix the targets first.' : 'Nothing to do. Check again after big market moves or when you add money.'; plan.append(e); return; }
    const { moves, unfilled } = polMoves(B, rows);
    const list = document.createElement('div'); list.className = 'ta-plan';
    for (const m of moves) {
      const row = document.createElement('div'); row.className = 'ta-move';
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = fmt(m.amount);
      const d = document.createElement('span'); d.textContent = m.locked ? `Inside ${m.fromName}: switch from ${m.fromBucket.toLowerCase()} to ${m.bucket.toLowerCase()}` : `${m.fromName} → ${m.toName}`;
      const note = m.locked ? 'Retirement account: switch funds within the plan (no tax on the switch in a 401(k)/IRA).' : m.taxable ? 'Selling in a taxable account can realise capital gains; check your cost basis first.' : m.fromBucket === 'Cash' ? 'Excess cash above your reserve, lowest-yielding first.' : '';
      if (note) { const sm = document.createElement('small'); sm.textContent = note; d.append(sm); }
      row.append(a, d); list.append(row);
    }
    for (const u of unfilled) {
      const row = document.createElement('div'); row.className = 'ta-move';
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = fmt(u.amt);
      const d = document.createElement('span'); d.textContent = u.dir === 'sell' ? `Couldn’t find a holding to trim for ${u.b.toLowerCase()}` : `Nothing left to fund ${u.b.toLowerCase()}`;
      const sm = document.createElement('small'); sm.textContent = u.dir === 'sell' ? 'It’s held inside multi-asset funds or your cash reserve. Adjust those funds, or loosen this target.' : 'Sells fell short (see above).'; d.append(sm);
      row.append(a, d); list.append(row);
    }
    plan.append(list);
    // contributions-only alternative
    const monthly = B.vis.filter(i => i.kind === 'asset').reduce((a, i) => a + (Number(i.monthly) || 0), 0);
    const under = rows.filter(r => r.trade > 0.5), need = under.reduce((a, r) => a + r.trade, 0);
    if (monthly > 0 && need > 0) {
      const mo = need / monthly, p = document.createElement('p'); p.className = 'hint';
      p.textContent = `Or without selling: send all ${fmt(monthly)}/month of contributions to ${under.map(r => r.b.toLowerCase()).join(' and ')}. That closes the gap in about ${mo < 1 ? 'a month' : mo < 24 ? Math.ceil(mo) + ' months' : Math.round(mo / 12) + ' years'} if markets stand still${mo <= 12 ? ', usually the better route since nothing is sold' : ''}.`;
      plan.append(p);
    }
    const D = B.vis.filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx).reduce((a, i) => a + i.value, 0);
    const after = { ...B.by }; for (const r of rows) after[r.b] += r.trade;
    const m0 = riskModel(B.by, D), m1 = riskModel(after, D);
    if (m0 && m1 && m0.volNW !== null && m1.volNW !== null) $('taRisk').textContent = `After the plan: net-worth volatility ${(m0.volNW * 100).toFixed(1)}% → ${(m1.volNW * 100).toFixed(1)}%, diversification ${m0.bets.toFixed(1)} → ${m1.bets.toFixed(1)} bets, expected return ${(m0.mu * 100).toFixed(1)}% → ${(m1.mu * 100).toFixed(1)}% on assets. Turnover ${fmt(moves.reduce((a, m) => a + m.amount, 0))}.`;
    $('taLoad').hidden = !moves.length;
    $('taLoad').onclick = () => { MV.splice(0, MV.length, ...moves.map(m => ({ from: m.from, to: m.to, amount: Math.round(m.amount) }))); savePrefs(); location.hash = '#scenarios'; window.scrollTo(0, 0); };
    $('taNote').textContent = 'Bands are absolute percentage points. Trades use today’s values and ignore taxes and costs. Moves into an existing holding go to your largest one in that asset class; retirement-account changes are shown as switches inside the account. Your policy is saved in this browser.';
  }
  $('taPreset').onchange = () => {
    const k = $('taPreset').value; if (!k) return;
    const B = polBase();
    POL.targets = k === 'current' ? polCurrent(B) : polFromMix(SC_PRESETS[k].alloc || {});
    $('taPreset').value = ''; savePrefs(); renderPlan();
  };
  $('taBand').onchange = () => { POL.band = clampNum($('taBand').value, 1, 25, 5); savePrefs(); renderPlan(); };
  $('taReserve').onchange = () => { POL.reserve = clampNum($('taReserve').value, 0, 60, 6); savePrefs(); renderPlan(); };
  $('taBasis').onchange = () => {
    const toAll = $('taBasis').value === 'all'; if (toAll === polAll()) return;
    const old = POL.targets ? { ...POL.targets } : null;
    POL.basis = toAll ? 'all' : 'investable'; delete POL.prop;
    if (old) { const { Property, ...rest } = old; POL.targets = polFromMix(rest); }   // keep your policy, re-expressed on the new basis
    savePrefs(); renderPlan();
  };
  $('taBreach').onchange = () => { POL.breach = $('taBreach').checked; savePrefs(); renderPlan(); };

  // ---------- Plan: financial independence ----------
  // FI number = yearly spending ÷ safe withdrawal rate. Counts investments and cash (and property if you choose), less
  // debts not secured on property you've excluded. Projection is in today's money: expected real return from each
  // holding's expected return less inflation, volatility from the risk model, contributions growing with inflation.
  const FI = prefs.fi = Object.assign({ age: null, target: null, spend: null, wr: 4, prop: false }, prefs.fi || {});
  function gauss(rnd) { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
  function fiSim(W, C, num, mu, vol, months, paths, seed) {
    const rnd = mulberry(seed), s = vol / Math.sqrt(12), m = Math.log(1 + mu) / 12 - s * s / 2, hit = [];
    for (let p = 0; p < paths; p++) {
      let w = W, k = 0;
      if (w >= num) { hit.push(0); continue; }
      for (k = 1; k <= months; k++) { w = w * Math.exp(m + s * gauss(rnd)) + C; if (w >= num) break; }
      hit.push(k <= months ? k : Infinity);
    }
    return hit.sort((a, b) => a - b);
  }
  function fiCalc() {
    const vis = visible(), assets = vis.filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx);
    const directProp = i => mainBucket(i) === 'Property' && !i.ticker;
    const incl = assets.filter(i => !['Vehicles', 'Collectibles'].includes(i.category) && (FI.prop || !directProp(i)));
    const debts = vis.filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx && (FI.prop || !/mortgage/i.test(i.category + ' ' + i.name)));
    const W = incl.reduce((a, i) => a + i.value, 0) - debts.reduce((a, i) => a + i.value, 0);
    const sp = spendNow(), spend = FI.spend !== null && FI.spend !== undefined && FI.spend !== '' ? Number(FI.spend) : sp.all * 12;
    const wr = clampNum(FI.wr, 2, 8, 4), num = spend > 0 ? spend / (wr / 100) : null;
    const V = incl.reduce((a, i) => a + i.value, 0), nom = V ? incl.reduce((a, i) => a + i.value * fwdOf(i), 0) / V / 100 : 0;
    const real = (1 + nom) / (1 + (Number(P.infl) || 0) / 100) - 1;
    const by = Object.fromEntries(BUCKETS.map(b => [b, 0])); for (const i of incl) for (const [c, w] of Object.entries(mixFor(i))) by[bucketOf(c)] += i.value * w / 100;
    const M = riskModel(by, 0), vol = M ? M.vol : 0.1;
    const C = incl.reduce((a, i) => a + (Number(i.monthly) || 0), 0);
    return { W, spend, wr, num, real, nom, vol, C, V, excludedProp: assets.filter(directProp).reduce((a, i) => a + i.value, 0) };
  }
  function renderFI() {
    const F = fiCalc();
    $('fiAge').value = FI.age ?? ''; $('fiTarget').value = FI.target ?? ''; $('fiWR').value = F.wr;
    $('fiSpend').value = FI.spend ?? ''; const fromExp = F.spend > 0 && (FI.spend === null || FI.spend === undefined || FI.spend === ''); $('fiSpend').placeholder = fromExp ? String(Math.round(F.spend)) : 'Type'; $('fiSpend').title = fromExp ? 'From your expenses × 12; type to override' : 'Yearly spending';
    $('fiProp').checked = !!FI.prop;
    const bar = $('fiBar'); bar.textContent = '';
    if (!F.num) {
      $('fiNum').textContent = '—'; $('fiNumSub').textContent = 'Enter yearly spending, or add your monthly expenses on the overview.';
      ['fiProg', 'fiProgSub', 'fiWhen', 'fiWhenSub', 'fiVerdict'].forEach(id => { $(id).textContent = ''; }); $('fiNote').textContent = ''; return;
    }
    $('fiNum').textContent = fmt(F.num);
    $('fiNumSub').textContent = `${fmt(F.spend)} a year ÷ ${F.wr}% withdrawal rate.`;
    const prog = Math.max(0, F.W / F.num);
    $('fiProg').textContent = Math.round(prog * 100) + '%';
    $('fiProgSub').textContent = `${fmt(Math.max(0, F.W))} counted${F.excludedProp > 0.5 && !FI.prop ? ', not your property' : ''}. Adding ${fmt(F.C)}/month.`;
    const f = document.createElement('div'); f.style.width = Math.min(100, prog * 100) + '%'; bar.append(f);
    const age = Number(FI.age) || null, tgt = Number(FI.target) || null;
    const horizon = Math.max(1, Math.min(80, age ? 100 - age : 60)) * 12;
    const hit = fiSim(Math.max(0, F.W), F.C, F.num, F.real, F.vol, horizon, 600, 4242);
    const med = hit[Math.floor(hit.length / 2)];
    const yrsTxt = mo => mo === 0 ? 'now' : mo < 12 ? 'within a year' : `in ${Math.round(mo / 12)} years`;
    if (prog >= 1) { $('fiWhen').textContent = 'Now'; $('fiWhenSub').textContent = 'Your counted assets already cover your spending at this withdrawal rate.'; }
    else if (!Number.isFinite(med)) { $('fiWhen').textContent = 'Not on track'; $('fiWhenSub').textContent = `Fewer than half of 600 simulated markets get there within ${Math.round(horizon / 12)} years at your current saving.`; }
    else { const yr = new Date().getFullYear() + Math.round(med / 12); $('fiWhen').textContent = age ? `Age ${Math.round(age + med / 12)}` : String(yr); $('fiWhenSub').textContent = `Median of 600 simulated markets: ${yrsTxt(med)} (${yr}). A 1-in-4 bad run: ${Number.isFinite(hit[Math.floor(hit.length * 0.75)]) ? (age ? 'age ' + Math.round(age + hit[Math.floor(hit.length * 0.75)] / 12) : 'in ' + Math.round(hit[Math.floor(hit.length * 0.75)] / 12) + ' years') : 'not within the horizon'}.`; }
    let verdict = '';
    if (age && tgt && tgt > age && prog < 1) {
      const mo = (tgt - age) * 12, pr = hit.filter(h => h <= mo).length / hit.length;
      verdict = `${Math.round(pr * 100)}% chance of reaching it by your target age of ${tgt}.`;
      if (pr < 0.75) {
        let lo = F.C, hi = F.C + F.num / mo * 2;
        for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; const h = fiSim(Math.max(0, F.W), mid, F.num, F.real, F.vol, mo, 300, 99); if (h.filter(x => x <= mo).length / h.length >= 0.75) hi = mid; else lo = mid; }
        verdict += ` To make that 75%, save about ${fmt(Math.ceil(hi / 10) * 10)}/month (now ${fmt(F.C)}), spend less, or push the date back.`;
      } else verdict += ' You’re on course.';
    } else if (!age) verdict = 'Add your age and a target age to see your chances of getting there in time.';
    $('fiVerdict').textContent = verdict;
    $('fiNote').textContent = `In today’s money. Expected return ${(F.nom * 100).toFixed(1)}% (each holding’s expected return, or the Scenarios assumption for its asset class), less ${P.infl}% inflation = ${(F.real * 100).toFixed(1)}% real, with ${(F.vol * 100).toFixed(1)}% volatility. Contributions are assumed to rise with inflation. The 4% rule comes from US history over 30-year retirements; for an early retirement many planners use 3–3.5%. Excludes pensions and Social Security. Saved in this browser.`;
  }
  const fiNum = (id, k, lo, hi) => { $(id).onchange = () => { const v = $(id).value; FI[k] = v === '' ? null : clampNum(v, lo, hi, null); savePrefs(); renderFI(); }; };
  fiNum('fiAge', 'age', 16, 100); fiNum('fiTarget', 'target', 17, 100); fiNum('fiSpend', 'spend', 0, 1e9); fiNum('fiWR', 'wr', 2, 8);
  $('fiProp').onchange = () => { FI.prop = $('fiProp').checked; savePrefs(); renderFI(); };

  // ---------- Plan: goals ----------
  const GL = prefs.goals = Array.isArray(prefs.goals) ? prefs.goals.filter(g => g && typeof g === 'object').slice(0, 30) : [];
  function goalCalc(g) {
    const vis = visible();
    let cur = 0, rate = SC_DEFAULTS.Cash[0], src = '';
    if (typeof g.fund === 'string' && g.fund.startsWith('aside:')) { const a = asides.find(x => x.id === g.fund.slice(6)); if (a) { cur = a.amount === null ? 0 : (conv(a.amount, a.currency) || 0); src = 'set-aside'; } }
    else if (g.fund) { const i = vis.find(x => x.id === g.fund); if (i) { cur = i.value; rate = fwdOf(i); src = 'holding'; } }
    const target = Math.max(0, Number(g.target) || 0), monthly = Math.max(0, Number(g.monthly) || 0);
    const m = /^(\d{4})-(\d{2})$/.exec(g.date || ''), now = new Date();
    const n = m ? (Number(m[1]) - now.getFullYear()) * 12 + (Number(m[2]) - 1 - now.getMonth()) : null;
    const rm = Math.pow(1 + rate / 100, 1 / 12) - 1;
    const fv = n === null || n < 0 ? cur : cur * Math.pow(1 + rm, n) + (rm ? monthly * (Math.pow(1 + rm, n) - 1) / rm : monthly * n);
    const need = n > 0 ? Math.max(0, (target - cur * Math.pow(1 + rm, n)) * (rm ? rm / (Math.pow(1 + rm, n) - 1) : 1 / n)) : null;
    return { cur, rate, target, monthly, n, fv, need, src };
  }
  function goalOut(g, box) {
    const c = goalCalc(g); box.textContent = '';
    const txt = document.createElement('span'), right = document.createElement('span');
    if (!c.target) txt.textContent = 'Enter a target amount.';
    else if (c.cur >= c.target) { txt.textContent = `Funded: ${fmt(c.cur)} of ${fmt(c.target)}.`; right.textContent = '✓ Funded'; }
    else if (c.n === null) txt.textContent = `${fmt(c.cur)} of ${fmt(c.target)} so far. Add a date to see if you’re on track.`;
    else if (c.n < 0) txt.textContent = 'The target date has passed.';
    else {
      const on = c.fv >= c.target - 0.5;
      txt.append(`${fmt(c.cur)} now → `); const b = document.createElement('b'); b.textContent = fmt(c.fv); txt.append(b, ` projected by the date (${c.rate.toFixed(1)}%/yr on ${c.src || 'nothing linked yet'}${c.monthly ? ` + ${fmt(c.monthly)}/month` : ''}).`);
      if (!on) txt.append(` Save about ${fmt(Math.ceil(c.need / 10) * 10)}/month to reach ${fmt(c.target)}.`);
      right.textContent = on ? '✓ On track' : `Short ${fmt(c.target - c.fv)}`; right.className = on ? 'rk-pos' : 'warn-text';
    }
    const bar = document.createElement('div'); bar.className = 'bar'; const f = document.createElement('div'); f.style.width = (c.target ? Math.min(100, c.cur / c.target * 100) : 0) + '%'; bar.append(f);
    box.append(txt, right, bar);
  }
  function renderGoals() {
    const list = $('glList');
    if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { [...list.querySelectorAll('.gl-out')].forEach((b, k) => GL[k] && goalOut(GL[k], b)); return; }
    list.textContent = '';
    if (!GL.length) { const e = document.createElement('div'); e.className = 'mv-empty'; e.textContent = 'Add a goal, like a house deposit or business capital, and link it to a set-aside or a holding to track it.'; list.append(e); }
    else { const h = document.createElement('div'); h.className = 'gl-head'; ['Goal', 'Target', 'By', 'Funded from', 'Saving / month', ''].forEach(t => { const s = document.createElement('span'); s.textContent = t; h.append(s); }); list.append(h); }
    const vis = visible().filter(i => i.kind === 'asset' && i.value > 0);
    GL.forEach((g, k) => {
      const row = document.createElement('div'); row.className = 'gl-row';
      const mk = (cls, type, val, ph, label, on) => { const i = document.createElement('input'); i.className = cls; i.type = type; i.value = val ?? ''; if (ph) i.placeholder = ph; i.setAttribute('aria-label', label); i.oninput = () => { on(i.value); savePrefs(); goalOut(g, out); }; return i; };
      const name = mk('gl-name', 'text', g.name, 'e.g. House deposit', `Goal ${k + 1} name`, v => { g.name = v.slice(0, 60); }); name.maxLength = 60;
      const tgt = mk('gl-tgt', 'number', g.target, 'Target', `Goal ${k + 1} target amount`, v => { g.target = Math.max(0, Number(v) || 0); }); tgt.min = '0';
      const date = mk('gl-date', 'month', g.date, '', `Goal ${k + 1} target month`, v => { g.date = /^\d{4}-\d{2}$/.test(v) ? v : ''; });
      const fund = document.createElement('select'); fund.className = 'gl-fund'; fund.setAttribute('aria-label', `Goal ${k + 1} funded from`);
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Not linked'; fund.append(o0);
      if (asides.length) { const og = document.createElement('optgroup'); og.label = 'Set-asides'; for (const a of asides) { const o = document.createElement('option'); o.value = 'aside:' + a.id; o.textContent = a.name; og.append(o); } fund.append(og); }
      const og2 = document.createElement('optgroup'); og2.label = 'Holdings'; for (const i of vis.sort((a, b) => b.value - a.value)) { const o = document.createElement('option'); o.value = i.id; o.textContent = `${i.name} · ${fmtShort(i.value)}`; og2.append(o); } fund.append(og2);
      fund.value = [...fund.options].some(o => o.value === g.fund) ? g.fund : '';
      fund.onchange = () => { g.fund = fund.value; savePrefs(); goalOut(g, out); };
      const mon = mk('gl-mon', 'number', g.monthly || '', '0', `Goal ${k + 1} monthly saving`, v => { g.monthly = Math.max(0, Number(v) || 0); }); mon.min = '0';
      const x = document.createElement('button'); x.type = 'button'; x.className = 'icon-btn gl-x'; x.textContent = '×'; x.setAttribute('aria-label', `Remove goal ${k + 1}`);
      x.onclick = () => { GL.splice(k, 1); savePrefs(); renderGoals(); };
      const out = document.createElement('div'); out.className = 'gl-out';
      row.append(name, tgt, date, fund, mon, x, out); list.append(row); goalOut(g, out);
    });
    $('glNote').textContent = GL.length ? 'Growth uses the linked holding’s expected return (cash and set-asides 3%). Goals are saved in this browser.' : '';
  }
  $('glAdd').onclick = () => {
    const d = new Date(); GL.push({ name: '', target: 0, date: `${d.getFullYear() + 3}-${String(d.getMonth() + 1).padStart(2, '0')}`, fund: asides[0] ? 'aside:' + asides[0].id : '', monthly: 0 });
    savePrefs(); renderGoals(); const ins = $('glList').querySelectorAll('.gl-name'); if (ins.length) ins[ins.length - 1].focus();
  };

  // ---------- Plan: expat tax & reporting checks ----------
  // Flags only, from the currencies, categories and names in your data. Thresholds are the published US figures
  // (FBAR $10,000 aggregate; Form 8938 by filing status and residence, not indexed for inflation).
  const TAX = prefs.tax = Object.assign({ us: '', live: 'yes', filing: 'single', uk: false, au: false }, prefs.tax || {});
  const toUSD = i => { const r = rateOf(i.currency); return r ? i.native / r : null; };
  const PENSION_RE = /super|kiwisaver|sipp|pension|aware|australiansuper|hostplus|unisuper|cbus|retire/i;
  function taxChecks() {
    const vis = visible(), out = [];
    const nm = i => [i.name, i.category, i.accountType, i.institution, i.fund].join(' ');
    const foreign = vis.filter(i => i.kind === 'asset' && i.native > 0 && i.currency !== 'USD' && !PRICED.includes(i.currency) && !(mainBucket(i) === 'Property' && !i.ticker) && !['Vehicles', 'Collectibles'].includes(i.category));
    const fUSD = foreign.reduce((a, i) => a + (toUSD(i) || 0), 0), usd = v => fmtIn(v, 'USD');
    const names = l => l.slice(0, 4).map(i => i.name).join(', ') + (l.length > 4 ? ` and ${l.length - 4} more` : '');
    if (TAX.us === 'yes') {
      out.push({ name: 'FBAR', status: fUSD > 10000 ? 'warning' : 'good',
        find: foreign.length ? `Accounts in other currencies total about ${usd(fUSD)} (${names(foreign)}). ${fUSD > 10000 ? 'Over $10,000 combined at any point in the year means filing FinCEN Form 114.' : 'Under the $10,000 combined threshold right now.'}` : 'No accounts in other currencies.',
        rule: 'Due April 15, automatic extension to October 15. Uses each account’s highest balance in the year; joint accounts count in full for each owner. Missing it carries steep penalties.' });
      const abroad = TAX.live === 'no', joint = TAX.filing === 'joint';
      const [ye, any] = abroad ? (joint ? [400000, 600000] : [200000, 300000]) : (joint ? [100000, 150000] : [50000, 75000]);
      out.push({ name: 'Form 8938 (FATCA)', status: fUSD > ye ? 'warning' : fUSD > ye * 0.8 ? 'warning' : 'good',
        find: `About ${usd(fUSD)} of foreign financial assets vs your threshold of ${usd(ye)} at year end or ${usd(any)} at any time (${abroad ? 'living abroad' : 'living in the US'}, ${joint ? 'married filing jointly' : 'single'}).${fUSD > ye ? ' Likely required with your tax return.' : fUSD > ye * 0.8 ? ' Close to the threshold.' : ''}`,
        rule: 'Filed with your Form 1040. Foreign pensions and superannuation usually count. Separate from the FBAR: you may need both.' });
      const pfic = foreign.filter(i => !PENSION_RE.test(nm(i)) && mainBucket(i) !== 'Cash' && i.category !== 'Retirement');
      out.push({ name: 'Foreign funds (PFIC)', status: pfic.length ? 'serious' : 'good',
        find: pfic.length ? `Possible PFICs: ${names(pfic)}.` : 'No non-US funds outside pensions found.',
        rule: 'Non-US mutual funds and ETFs are usually PFICs for US taxpayers: punitive tax plus interest on gains unless you make a QEF or mark-to-market election, and Form 8621 every year. Many expats hold US-domiciled funds instead.' });
      const pens = foreign.filter(i => PENSION_RE.test(nm(i)) || i.category === 'Retirement');
      if (pens.length) {
        const au = pens.filter(i => i.currency === 'AUD');
        out.push({ name: 'Foreign pensions', status: au.length ? 'warning' : 'info',
          find: `${names(pens)}.${au.length ? ' The US tax treatment of Australian super is unsettled: it may be treated as a foreign pension or as a foreign trust, and employer contributions and earnings can be taxable in the US.' : ''}`,
          rule: au.length ? 'Get a cross-border specialist’s view on super (possible Forms 3520/3520-A as well as 8938). The US–UK treaty, by contrast, generally defers US tax on UK pension growth.' : 'Treaty treatment varies by country; the US–UK treaty generally defers US tax on UK pension growth. Report on Form 8938 if over the threshold.' });
      }
      const fm = vis.filter(i => i.kind === 'debt' && i.native > 0 && i.currency !== 'USD' && /mortgage|home loan/i.test(nm(i)));
      if (fm.length) out.push({ name: 'Foreign-currency mortgage', status: 'warning',
        find: `${names(fm)}: repaying it after that currency has fallen against the dollar can create a taxable US exchange gain.`,
        rule: 'Losses on a loan for a home you live in usually aren’t deductible, so this is one-sided. Keep the loan’s US-dollar value when you took it out and at each repayment.' });
      const fp = vis.filter(i => i.kind === 'asset' && i.native > 0 && i.currency !== 'USD' && mainBucket(i) === 'Property' && !i.ticker);
      if (fp.length) out.push({ name: 'Foreign property', status: 'info',
        find: `${names(fp)}: rent is reportable on your US return, with a foreign tax credit for tax paid abroad.`,
        rule: 'US depreciation rules apply (30-year straight line for foreign residential rentals). A sale is taxed in US dollars, so currency moves change the gain.' });
      const fl = vis.filter(i => i.kind === 'debt' && i.native > 0 && i.currency !== 'USD' && (i.writeOff || /student/i.test(nm(i))));
      if (fl.length) out.push({ name: 'Foreign loan write-off', status: 'warning',
        find: `${names(fl)}${fl.some(i => i.writeOff) ? ` (written off ${fl.filter(i => i.writeOff).map(i => i.writeOff).join(', ')})` : ''}: a forgiven balance can count as taxable cancellation-of-debt income in the US that year.`,
        rule: 'US exclusions for forgiven student loans may not cover foreign loans. Plan for the tax in that year, or check whether insolvency or other exceptions apply.' });
    }
    if (TAX.uk) {
      const nonRep = vis.filter(i => i.kind === 'asset' && i.ticker && i.currency !== 'GBP' && mainBucket(i) !== 'Cash');
      out.push({ name: 'UK: offshore funds', status: nonRep.length ? 'warning' : 'good',
        find: nonRep.length ? `Non-UK funds: ${names(nonRep)}. Check each one has UK “reporting fund” status.` : 'No non-UK funds found.',
        rule: 'Gains on offshore funds without reporting status are taxed as income, not capital gains. Many US-domiciled ETFs aren’t reporting funds.' });
    }
    if (TAX.au) out.push({ name: 'Australia: worldwide income', status: 'info',
      find: 'Australian residents are taxed on worldwide income and gains, including US fund distributions and sales.',
      rule: 'US tax withheld goes on your Australian return as a foreign income tax offset. Currency moves are part of the capital gain in Australian dollars.' });
    if (!out.length) out.push({ name: TAX.us === '' ? 'Choose your situation' : 'No checks', status: 'info', find: TAX.us === '' ? 'Set whether you’re a US taxpayer (and any UK or Australian residency) above to see the checks that apply.' : 'Nothing to flag for your selection.', rule: '' });
    return out;
  }
  function renderTax() {
    $('cmUS').value = TAX.us; $('cmLive').value = TAX.live; $('cmFiling').value = TAX.filing; $('cmUK').checked = !!TAX.uk; $('cmAU').checked = !!TAX.au;
    $('cmLive').disabled = $('cmFiling').disabled = TAX.us !== 'yes';
    const box = $('cmList'); box.textContent = '';
    for (const c of taxChecks()) {
      const row = document.createElement('div'); row.className = 'rk-item rk-' + c.status;
      const ic = document.createElement('span'); ic.className = 'rk-ico'; ic.textContent = RK_ICON[c.status]; ic.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('div'); nm.className = 'rk-name'; nm.textContent = c.name; const w = document.createElement('small'); w.textContent = { good: 'OK', warning: 'Check', serious: 'Act', info: 'Note' }[c.status]; nm.append(w);
      const f = document.createElement('div'); f.className = 'rk-find'; f.textContent = c.find; if (c.rule) { const r = document.createElement('small'); r.textContent = c.rule; f.append(r); }
      row.append(ic, nm, f); box.append(row);
    }
    $('cmNote').textContent = 'Based on the currency, category and name of each holding: a US-dollar account at a foreign bank also counts as foreign, and a foreign-currency account at a US bank may not. Thresholds and rules as published in 2026; confirm with a cross-border tax adviser before acting. Saved in this browser.';
  }
  for (const [id, k, chk] of [['cmUS', 'us'], ['cmLive', 'live'], ['cmFiling', 'filing'], ['cmUK', 'uk', true], ['cmAU', 'au', true]])
    $(id).onchange = () => { TAX[k] = chk ? $(id).checked : $(id).value; savePrefs(); renderTax(); };

  function renderPlan() {
    if (mode === 'locked') return;
    renderTargets(); renderFI(); renderGoals(); renderTax();
  }

  // ---------- Net worth history ----------
  // Airtable mode: the daily sync's "Exposure history" rows (US dollars). Browser mode: a snapshot saved each day you
  // open the app. Today's live totals are added as the last point. Amounts are shown at today's exchange rates.
  // The change is split into money you put in (monthly contributions plus debt payments, from your current settings,
  // so an estimate) and the rest: market moves and revaluations, net of interest.
  const HIST_KEY = 'holdings.history';
  let nwHistory = [], hsRange = '';
  async function atLoadHistory() {
    const out = []; let offset = '';
    for (let page = 0; page < 30; page++) {
      const q = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
      const j = await at(`${session.baseId}/${encodeURIComponent('Exposure history')}?${q}`);
      for (const r of j.records || []) {
        const f = r.fields || {}, d = String(f.Date || '').slice(0, 10), nw = Number(f['Net worth']);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(nw)) out.push({ date: d, nw, assets: Number(f['Total assets']) || 0, debts: Number(f['Total debts']) || 0 });
      }
      if (!j.offset) break; offset = String(j.offset);
    }
    return out.sort((a, b) => a.date < b.date ? -1 : 1);
  }
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function householdUSD() {
    let a = 0, d = 0;
    for (const i of items) { const r = rateOf(i.currency); if (!r || !(i.value > 0)) continue; const v = i.value / r; if (i.kind === 'debt') d += v; else a += v; }
    return { assets: a, debts: d, nw: a - d };
  }
  function recordLocalSnapshot() {
    if (mode !== 'local' || !items.length) return;
    const all = parse(store.get(HIST_KEY)); const map = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    map[today()] = householdUSD();
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort(); while (keys.length > 1500) delete map[keys.shift()];
    store.set(HIST_KEY, JSON.stringify(map));
  }
  function historyPoints() {
    let pts = nwHistory;
    if (mode === 'local') { const m = parse(store.get(HIST_KEY)) || {}; pts = Object.entries(m).filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v && Number.isFinite(Number(v.nw))).map(([date, v]) => ({ date, nw: Number(v.nw), assets: Number(v.assets) || 0, debts: Number(v.debts) || 0 })).sort((a, b) => a.date < b.date ? -1 : 1); }
    const live = { date: today(), ...householdUSD(), live: true };
    pts = pts.filter(p => p.date < live.date).concat([live]);
    return pts.map(p => ({ ...p, t: Date.parse(p.date + 'T12:00:00'), v: conv(p.nw, 'USD') })).filter(p => p.v !== null);
  }
  function renderHistory() {
    const sec = $('hsSection');
    if (mode === 'locked' || !items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const all = historyPoints(), first = all[0], last = all[all.length - 1], DAY = 864e5;
    const spanDays = (last.t - first.t) / DAY;
    const ranges = [['1M', 30], ['3M', 91], ['YTD', null], ['1Y', 365], ['All', Infinity]];
    if (!hsRange || !ranges.some(r => r[0] === hsRange)) hsRange = spanDays > 365 ? '1Y' : 'All';
    const rg = $('hsRange'); rg.textContent = '';
    for (const [k, d] of ranges) {
      if (k !== 'All' && d !== null && d > spanDays + 1) continue;
      if (k === 'YTD' && first.date > `${new Date().getFullYear()}-01-01`) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (k === hsRange ? ' on' : ''); b.textContent = k; b.setAttribute('aria-pressed', String(k === hsRange));
      b.onclick = () => { hsRange = k; renderHistory(); }; rg.append(b);
    }
    rg.hidden = all.length < 2;
    const start = hsRange === 'All' ? first.t : hsRange === 'YTD' ? Date.parse(`${new Date().getFullYear()}-01-01T00:00:00`) : last.t - (ranges.find(r => r[0] === hsRange)[1]) * DAY;
    const pts = all.filter(p => p.t >= start - DAY / 2);
    const chart = $('hsChart'); [...chart.querySelectorAll('svg')].forEach(n => n.remove()); $('hsTip').hidden = true;
    if (pts.length < 2) {
      ['hsChange', 'hsContrib', 'hsGrowth'].forEach(id => { $(id).textContent = '—'; $(id).classList.remove('pos', 'neg'); });
      $('hsChangeSub').textContent = `Net worth today: ${fmt(last.v)}.`; $('hsContribSub').textContent = ''; $('hsGrowthSub').textContent = '';
      $('hsNote').textContent = mode === 'airtable' ? 'History builds up from the daily sync’s Exposure history table. Check back tomorrow.' : 'History builds up from a snapshot saved each day you open the app in this browser. Check back tomorrow.';
      return;
    }
    const p0 = pts[0], p1 = pts[pts.length - 1], months = (p1.t - p0.t) / DAY / 30.4375;
    const conv2 = items.map(i => ({ ...i, value: conv(i.value, i.currency) || 0, monthly: i.monthly === null ? null : conv(i.monthly, i.currency) }));
    const inAssets = conv2.filter(i => i.kind === 'asset').reduce((a, i) => a + (Number(i.monthly) || 0), 0);
    const inDebts = conv2.filter(i => i.kind === 'debt' && i.value > 0).reduce((a, i) => a + (debtTerms(i, i.value, i.monthly).pay || 0), 0);
    const put = (inAssets + inDebts) * months, change = p1.v - p0.v, growth = change - put;
    const tone = (el, n) => { el.classList.toggle('pos', n > 0.5); el.classList.toggle('neg', n < -0.5); };
    const sg = n => (n > 0.5 ? '+' : n < -0.5 ? '−' : '') + fmt(Math.abs(n));
    const dl = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    $('hsChange').textContent = sg(change); tone($('hsChange'), change);
    $('hsChangeSub').textContent = `${fmt(p0.v)} on ${dl(p0.t)} → ${fmt(p1.v)} today${p0.v > 0 ? ` (${change >= 0 ? '+' : '−'}${Math.abs(change / p0.v * 100).toFixed(1)}%)` : ''}.`;
    $('hsContrib').textContent = sg(put); tone($('hsContrib'), 0);
    $('hsContribSub').textContent = `About ${fmt(inAssets)}/month of contributions${inDebts > 0.5 ? ` and ${fmt(inDebts)}/month of debt payments` : ''} over ${months < 1.5 ? Math.max(1, Math.round(months * 30.4375)) + ' days' : Math.round(months) + ' months'}.`;
    $('hsGrowth').textContent = sg(growth); tone($('hsGrowth'), growth);
    const base = p0.v + put / 2, r = base > 0 ? growth / base : null;
    $('hsGrowthSub').textContent = r === null ? '' : `About ${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}% on your money${months >= 12 ? `, ${((Math.pow(1 + r, 12 / months) - 1) * 100).toFixed(1)}% a year` : ' over the period'} (money-weighted, net of interest).`;
    histChart(chart, pts);
    $('hsNote').textContent = `Whole household${ownerView ? ' (the owner filter doesn’t apply here)' : ''}, at today’s exchange rates. “Money you put in” is estimated from each holding’s current monthly contribution and debt payment, so it’s approximate. ${mode === 'airtable' ? 'From the daily sync’s Exposure history table.' : 'From daily snapshots saved in this browser.'}`;
  }
  function histChart(chart, pts) {
    const tip = $('hsTip');
    const W = Math.max(300, Math.round(chart.clientWidth || 640)), narrow = W < 520;
    const H = narrow ? 200 : 240, L = narrow ? 46 : 56, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const vals = pts.map(p => p.v); let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi = lo + Math.max(1, Math.abs(lo) * 0.01); lo = lo - Math.max(1, Math.abs(lo) * 0.01); }
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t, x = t => L + (t - t0) / (t1 - t0) * pw, y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Net worth from ${pts[0].date} to today: ${fmt(pts[0].v)} to ${fmt(pts[pts.length - 1].v)}.` });
    for (let v = lo; v <= hi + step / 2; v += step) { el('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }, svg); el('text', { class: 'axis-t', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtShort(v); }
    const ticks = narrow ? 3 : 5, span = t1 - t0;
    for (let k = 0; k <= ticks; k++) { const t = t0 + span * k / ticks; el('text', { class: 'axis-t', x: x(t), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle' }, svg).textContent = new Date(t).toLocaleDateString(undefined, span > 400 * 864e5 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }); }
    el('path', { class: 'sc-line ln-0', d: pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ') }, svg);
    if (pts.length <= 40) for (const p of pts) el('circle', { class: 'hs-dot', cx: x(p.t), cy: y(p.v), r: 3 }, svg);
    const cross = el('line', { class: 'cross', y1: T, y2: T + ph, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }, svg);
    const show = evt => {
      const r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * W / r.width, t = t0 + (px - L) / pw * span;
      let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
      tip.textContent = ''; const h = document.createElement('div'); h.textContent = best.live ? 'Today (live)' : new Date(best.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); tip.append(h);
      const b = document.createElement('div'); const v = document.createElement('b'); v.textContent = fmt(best.v); b.append('Net worth ', v); tip.append(b);
      tip.hidden = false; const left = x(best.t) / W * r.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    chart.prepend(svg);
  }

  // ---------- Macro tab ----------
  // Data from the daily sync's "Macro" table: row "fred" (monthly FRED series) and row "prices" (monthly closes per
  // ticker). In browser-only mode there's no sync, so the regime and return streams explain how to get them.
  let macroData = {};
  async function atLoadMacro() {
    const out = {};
    const j = await at(`${session.baseId}/${encodeURIComponent('Macro')}?pageSize=100`);
    for (const r of j.records || []) { const f = r.fields || {}; try { out[String(f.Name || '')] = JSON.parse(f.Notes || '{}'); } catch (x) { } }
    return out;
  }

  // ---- four environments (All Weather) ----
  // Each asset class does well when growth or inflation surprise in a particular direction. Following Bridgewater's
  // framing, every class is assigned to the environments it's built for (half its risk to each), and the portfolio's
  // risk (Euler contributions from the risk model) is summed per environment. Balanced = about 25% in each.
  const ENVS = ['Rising growth', 'Falling growth', 'Rising inflation', 'Falling inflation'];
  const ENV_MAP = {
    Equities: { 'Rising growth': .5, 'Falling inflation': .5 },
    Bonds: { 'Falling growth': .5, 'Falling inflation': .5 },
    Gold: { 'Falling growth': .5, 'Rising inflation': .5 },
    Commodities: { 'Rising growth': .5, 'Rising inflation': .5 },
    Property: { 'Rising growth': .5, 'Rising inflation': .5 },
    Bitcoin: { 'Rising growth': .6, 'Rising inflation': .4 },
    Other: { 'Rising growth': .25, 'Falling growth': .25, 'Rising inflation': .5 },
    Cash: { 'Falling growth': .5, 'Rising inflation': .5 }
  };
  // Illustrative one-year returns (%) by asset class in each growth/inflation quadrant (rough historical analogues).
  const QUADS = [
    { k: 'gi', name: 'Goldilocks', sub: 'Growth rising, inflation falling (e.g. 1990s, 2013–19)', s: { Equities: 15, Bonds: 4, Cash: 3, Gold: -5, Property: 8, Commodities: -5, Bitcoin: 40, Other: 6 } },
    { k: 'GI', name: 'Inflationary boom', sub: 'Growth rising, inflation rising (e.g. 2004–07, 2021)', s: { Equities: 6, Bonds: -6, Cash: 4, Gold: 12, Property: 8, Commodities: 25, Bitcoin: 30, Other: 8 } },
    { k: 'Gi', name: 'Stagflation', sub: 'Growth falling, inflation rising (e.g. 1970s, 2022)', s: { Equities: -20, Bonds: -10, Cash: 5, Gold: 25, Property: -8, Commodities: 15, Bitcoin: -50, Other: -5 } },
    { k: 'gI', name: 'Deflationary bust', sub: 'Growth falling, inflation falling (e.g. 2008, early 2020)', s: { Equities: -30, Bonds: 15, Cash: 2, Gold: 5, Property: -15, Commodities: -35, Bitcoin: -60, Other: -15 } }
  ];
  function envShares(M) {
    const e = Object.fromEntries(ENVS.map(k => [k, 0]));
    for (const b of BUCKETS) for (const [k, w] of Object.entries(ENV_MAP[b] || {})) e[k] += Math.max(0, M.rc[b]) * w;
    const t = ENVS.reduce((a, k) => a + e[k], 0) || 1;
    return Object.fromEntries(ENVS.map(k => [k, e[k] / t]));
  }
  const envGap = sh => ENVS.reduce((a, k) => a + (sh[k] - .25) ** 2, 0);
  // Suggested mixes of the four core asset classes (shares, bonds, gold, commodities): search in 2.5% steps for the mix
  // whose risk across the four environments best matches a target (25% each = balanced), with ties broken toward
  // spreading risk across asset classes (risk parity) and, for "closest", toward your current core mix.
  const CORE = ['Equities', 'Bonds', 'Gold', 'Commodities'];
  function suggestMix(T, w0) {
    let best = null;
    for (let e = 0; e <= 100; e += 2.5) for (let b = 0; b <= 100 - e; b += 2.5) for (let g = 0; g <= 100 - e - b; g += 2.5) {
      const c = 100 - e - b - g, by = { Equities: e, Bonds: b, Cash: 0, Gold: g, Property: 0, Commodities: c, Bitcoin: 0, Other: 0 };
      const M = riskModel(by, 0); if (!M) continue;
      const sh = envShares(M);
      let obj = ENVS.reduce((a, k) => a + (sh[k] - T[k]) ** 2, 0) + 0.05 * BUCKETS.reduce((a, k) => a + Math.max(0, M.rc[k]) ** 2, 0);
      if (w0) obj += 0.3 * CORE.reduce((a, k) => a + ((by[k] - w0[k]) / 100) ** 2, 0);
      if (!best || obj < best.obj - 1e-12) best = { obj, mix: { Equities: e, Bonds: b, Gold: g, Commodities: c }, M };
    }
    return best;
  }
  const tiltT = (gUp, iUp, size) => ({ 'Rising growth': .25 + size * gUp, 'Falling growth': .25 - size * gUp, 'Rising inflation': .25 + size * iUp, 'Falling inflation': .25 - size * iUp });
  const ENV_SUGGEST = [
    { k: 'balanced', label: 'Balanced (All Weather)', why: 'Equal risk in all four environments: what Bridgewater holds when it has no view. It should never be the best or the worst in any single environment.' },
    { k: 'closest', label: 'Closest to my mix', why: 'Balances the four environments while moving as little as possible from your current shares, bonds, gold and commodities.' },
    { k: 'regime', label: 'Match the regime', why: '' },
    { k: 'gi', label: 'Prepare: goldilocks', why: 'Tilts risk toward rising growth and falling inflation (more shares and bonds), while keeping some protection elsewhere.' },
    { k: 'GI', label: 'Prepare: inflationary boom', why: 'Tilts risk toward rising growth and rising inflation (more commodities and shares, fewer bonds).' },
    { k: 'Gi', label: 'Prepare: stagflation', why: 'Tilts risk toward falling growth and rising inflation (more gold and commodities, fewer shares).' },
    { k: 'gI', label: 'Prepare: deflationary bust', why: 'Tilts risk toward falling growth and falling inflation (more bonds, fewer commodities).' }
  ];
  const QUAD_DIR = { gi: [1, -1], GI: [1, 1], Gi: [-1, 1], gI: [-1, -1] };   // [growth, inflation] direction of each quadrant (keys as in QUADS)
  const envCache = {};
  let envPick = prefs.envPick || 'balanced';
  function envSuggestion(k, by) {
    const coreT = CORE.reduce((a, c) => a + (by[c] || 0), 0);
    const w0 = coreT ? Object.fromEntries(CORE.map(c => [c, (by[c] || 0) / coreT * 100])) : null;
    let T = tiltT(0, 0, 0), extra = '';
    if (k === 'closest') { if (!w0) return null; }
    else if (k === 'regime') {
      const R = macroData.fred ? regimeAt(0) : null;
      if (!R || R.g === null || R.i === null) return null;
      T = tiltT(R.g, R.i, 0.10);
      extra = `Tilts toward ${quadOf(R.g, R.i).name.toLowerCase()} (growth ${R.g >= 0 ? '+' : ''}${R.g.toFixed(2)}, inflation ${R.i >= 0 ? '+' : ''}${R.i.toFixed(2)}), by up to 10 points of risk scaled to how strong the signals are, while still holding all four environments. Regime calls are often wrong, so the tilt is deliberately modest.`;
    } else if (QUAD_DIR[k]) T = tiltT(...QUAD_DIR[k], 0.12);
    const key = k + (k === 'closest' ? JSON.stringify(w0) : k === 'regime' ? JSON.stringify(T) : '');
    if (!envCache[key]) envCache[key] = suggestMix(T, k === 'closest' ? w0 : null);
    return { ...envCache[key], T, extra };
  }
  let balancedCache = null;   // kept for older callers (cleared on lock)
  function renderEnv() {
    const vis = visible(), D = vis.filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx).reduce((a, i) => a + i.value, 0);
    const by = bucketValues(vis), M = riskModel(by, D), sec = $('envSection');
    if (!M) { sec.hidden = true; return; } sec.hidden = false;
    const sh = envShares(M);
    const bars = $('envBars'); bars.textContent = '';
    for (const k of ENVS) {
      const row = document.createElement('div'); row.className = 'env-row';
      const n = document.createElement('span'); n.textContent = k;
      const t = document.createElement('span'); t.className = 'env-track'; t.title = `${k}: ${(sh[k] * 100).toFixed(0)}% of your risk (balanced ≈ 25%)`;
      const f = document.createElement('i'); f.style.width = (sh[k] * 100) + '%'; t.append(f);
      const mark = document.createElement('b'); mark.style.left = '25%'; t.append(mark);
      const p = document.createElement('span'); p.className = 'pct'; p.textContent = Math.round(sh[k] * 100) + '%';
      row.append(n, t, p); bars.append(row);
    }
    const top = ENVS.slice().sort((a, b) => sh[b] - sh[a]), gap = envGap(sh);
    $('envVerdict').textContent = `${gap < 0.01 ? 'Well balanced' : gap < 0.04 ? 'Somewhat tilted' : 'Concentrated'}: ${Math.round(sh[top[0]] * 100)}% of your risk depends on ${top[0].toLowerCase()} and only ${Math.round(sh[top[3]] * 100)}% on ${top[3].toLowerCase()}. ` +
      `You’re positioned for ${top[0].toLowerCase()}${sh[top[1]] > .28 ? ` and ${top[1].toLowerCase()}` : ''}; the marker shows the balanced 25%.`;
    // quadrant table
    const nw = M.nw, tbl = $('envQuad'); tbl.textContent = '';
    const hr = document.createElement('tr'); ['Environment', 'Net worth change', '% of net worth', 'Biggest drag', 'Biggest help'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody'); let worst = null;
    for (const q of QUADS) {
      const contrib = BUCKETS.map(b => [b, (by[b] || 0) * (q.s[b] || 0) / 100]).filter(([, v]) => Math.abs(v) > 0.5);
      const tot = contrib.reduce((a, [, v]) => a + v, 0);
      if (!worst || tot < worst.tot) worst = { q, tot };
      const drag = contrib.slice().sort((a, b) => a[1] - b[1])[0], help = contrib.slice().sort((a, b) => b[1] - a[1])[0];
      const tr = document.createElement('tr');
      const n = document.createElement('td'); n.className = 'rk-scn'; n.textContent = q.name; const sm = document.createElement('small'); sm.textContent = q.sub; n.append(sm); tr.append(n);
      const v = document.createElement('td'); v.textContent = (tot >= 0 ? '+' : '−') + fmt(Math.abs(tot)); v.className = tot < -0.5 ? 'rk-neg' : 'rk-pos'; tr.append(v);
      const pc = document.createElement('td'); pc.textContent = nw > 0 ? (tot >= 0 ? '+' : '−') + Math.abs(tot / nw * 100).toFixed(1) + '%' : '—'; tr.append(pc);
      const d = document.createElement('td'); d.textContent = drag && drag[1] < 0 ? `${drag[0]} (−${fmtShort(-drag[1]).replace('-', '')})` : '—'; tr.append(d);
      const h = document.createElement('td'); h.textContent = help && help[1] > 0 ? `${help[0]} (+${fmtShort(help[1])})` : '—'; tr.append(h);
      tb.append(tr);
    }
    tbl.append(tb);
    // suggested allocations
    const opts = $('envOpts'); opts.textContent = '';
    const regimeOk = !!(macroData.fred && (() => { const R = regimeAt(0); return R.g !== null && R.i !== null; })());
    if (envPick === 'regime' && !regimeOk) envPick = 'balanced';
    for (const o of ENV_SUGGEST) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'chip' + (o.k === envPick ? ' on' : ''); btn.textContent = o.label;
      btn.setAttribute('aria-pressed', String(o.k === envPick));
      if (o.k === 'regime' && !regimeOk) { btn.disabled = true; btn.title = 'Needs the macro indicators from the daily sync'; }
      btn.onclick = () => { envPick = o.k; prefs.envPick = o.k; savePrefs(); renderEnv(); };
      opts.append(btn);
    }
    const pick = ENV_SUGGEST.find(o => o.k === envPick), S = envSuggestion(envPick, by) || envSuggestion('balanced', by), ss = envShares(S.M);
    const mixTxt = CORE.filter(c => S.mix[c] > 0).map(c => `${c.toLowerCase()} ${S.mix[c]}%`).join(', ');
    $('envBalSub').textContent = `${pick.label}: ${mixTxt}. ${S.extra || pick.why} Risk by environment: ${ENVS.map(k => `${k.toLowerCase()} ${Math.round(ss[k] * 100)}%`).join(', ')}.`;
    const bb = $('envBalBars'); bb.textContent = '';
    const liqT = BUCKETS.filter(b => b !== 'Property').reduce((a, b) => a + by[b], 0);
    const nowW = Object.fromEntries(BUCKETS.map(b => [b, b === 'Property' || !liqT ? 0 : by[b] / liqT]));
    const sugW = Object.fromEntries(BUCKETS.map(b => [b, (S.mix[b] || 0) / 100]));
    for (const [lab, o] of [['Now', nowW], ['Suggested', sugW]]) {
      const row = document.createElement('div'); row.className = 'sc-arow';
      const l = document.createElement('span'); l.textContent = lab;
      const bar = document.createElement('span'); bar.className = 'sc-abar';
      BUCKETS.forEach((b, ix) => { const w = o[b]; if (w < 0.002) return; const seg = document.createElement('i'); seg.className = 'bk-' + ix; seg.style.width = (w * 100) + '%'; seg.title = `${b} ${(w * 100).toFixed(1)}%`; bar.append(seg); });
      const a = document.createElement('span'); a.className = 'amt'; a.textContent = lab === 'Now' ? 'excl. property' : '';
      row.append(l, bar, a); bb.append(row);
    }
    const lg = $('envBalLegend'); lg.textContent = '';
    BUCKETS.forEach((b, ix) => { if (b === 'Property' || (nowW[b] < 0.002 && !(S.mix[b] > 0))) return; const s = document.createElement('span'); const d = document.createElement('i'); d.className = 'bk-' + ix; s.append(d, b); lg.append(s); });
    // now vs suggested, environment by environment (investable money, excluding property)
    const ret = (w, q) => BUCKETS.reduce((a, b) => a + (w[b] || 0) * (q.s[b] || 0), 0);
    const nowBy = Object.fromEntries(BUCKETS.map(b => [b, b === 'Property' ? 0 : by[b]])), Mn = riskModel(nowBy, 0);
    const cmp = $('envCmp'); cmp.textContent = '';
    const hr2 = document.createElement('tr'); ['On your investable money', 'Now', 'Suggested', 'Difference'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr2.append(th); });
    const th2 = document.createElement('thead'); th2.append(hr2); cmp.append(th2);
    const tb2 = document.createElement('tbody');
    const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
    const rowsC = QUADS.map(q => [q.name, ret(nowW, q), ret(sugW, q)]);
    const worstNow = Math.min(...rowsC.map(r => r[1])), worstSug = Math.min(...rowsC.map(r => r[2]));
    rowsC.push(['Worst environment', worstNow, worstSug]);
    for (const [name, a, b2] of rowsC) {
      const tr = document.createElement('tr'); if (name === 'Worst environment') tr.className = 'sc-sum';
      [name, pct(a), pct(b2), `${b2 - a >= 0 ? '+' : '−'}${Math.abs(b2 - a).toFixed(1)} pts`].forEach((t, ix) => { const td = document.createElement('td'); td.textContent = t; if (ix === 3) td.className = b2 - a >= 0.05 ? 'rk-pos' : b2 - a <= -0.05 ? 'rk-neg' : ''; tr.append(td); });
      tb2.append(tr);
    }
    if (Mn) for (const [name, a, b2, isVol] of [['Expected return (long run)', Mn.mu * 100, S.M.mu * 100, false], ['Volatility', Mn.vol * 100, S.M.vol * 100, true]]) {
      const tr = document.createElement('tr');
      [name, a.toFixed(1) + '%', b2.toFixed(1) + '%', `${b2 - a >= 0 ? '+' : '−'}${Math.abs(b2 - a).toFixed(1)} pts`].forEach((t, ix) => { const td = document.createElement('td'); td.textContent = t; if (ix === 3) { const good = isVol ? b2 < a : b2 > a; td.className = Math.abs(b2 - a) < 0.05 ? '' : good ? 'rk-pos' : 'rk-neg'; } tr.append(td); });
      tb2.append(tr);
    }
    cmp.append(tb2);
    $('envUse').onclick = () => { POL.targets = polFromMix(S.mix); savePrefs(); location.hash = '#plan'; window.scrollTo(0, 0); showBanner(`Target allocation set to “${pick.label}”. Your cash reserve is kept aside; review the trades below.`, 'info'); };
    $('envScen').onclick = () => {
      const start = Object.fromEntries(BUCKETS.map(b => [b, S.mix[b] || 0]));
      const sc = cleanScenario({ name: pick.label, start, end: start, glide: 0, assume: Object.fromEntries(BUCKETS.map(b => [b, SC_DEFAULTS[b].slice()])), monthly: null, growth: 0, rebalance: true, holdProperty: true });
      sc._tmp = 'tmp' + Date.now(); scenarios.push(sc); scSel = sc._tmp; scDirty = true; location.hash = '#scenarios'; window.scrollTo(0, 0);
      showBanner(`Added “${pick.label}” as a scenario. Save it to keep it.`, 'info');
    };
    $('envNote').textContent = 'Assignments follow Bridgewater’s published framing: shares like rising growth and falling inflation; bonds like falling growth and falling inflation; gold likes falling growth and rising inflation; commodities and property like rising growth and inflation. Bitcoin is treated as a growth-and-liquidity asset. Risk uses the Scenarios assumptions (bonds at 6% volatility, i.e. intermediate maturity), which is why a balanced mix holds a lot of bonds; All Weather itself uses longer bonds and inflation-linked bonds. Quadrant returns are rough one-year analogues, not forecasts.';
  }

  // ---- macro regime ----
  const fS = (sid, drop = 0) => { const s = ((macroData.fred || {}).series || {})[sid]; const m = s && Array.isArray(s.m) ? s.m : []; return drop ? m.slice(0, Math.max(0, m.length - drop)) : m; };
  const lastV = m => m.length ? Number(m[m.length - 1][1]) : null;
  // value n calendar months before the latest point (or the nearest earlier one, as series can have gaps)
  const ymShift = (ym, n) => { const [y, mo] = ym.split('-').map(Number), t = y * 12 + (mo - 1) - n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
  const agoV = (m, n) => {
    if (!m.length) return null; const want = ymShift(m[m.length - 1][0], n);
    for (let k = m.length - 1; k >= 0; k--) if (m[k][0] <= want) return m[k][0] >= ymShift(want, 2) ? Number(m[k][1]) : null;
    return null;
  };
  const yoyOf = (m, n = 0) => { const a = agoV(m, n), b = agoV(m, n + 12); return a !== null && b ? (a / b - 1) * 100 : null; };
  const clamp1 = x => Math.max(-1, Math.min(1, x));
  function regimeAt(drop) {
    const sig = [];
    const add = (group, name, score, value, what) => { if (score !== null && Number.isFinite(score)) sig.push({ group, name, score: clamp1(score), value, what }); };
    // growth
    const un = fS('UNRATE', drop);
    if (un.length >= 15) {
      const lastYm = un[un.length - 1][0], u3 = (agoV(un, 0) + agoV(un, 1) + agoV(un, 2)) / 3;
      const low = Math.min(...un.filter(p => p[0] >= ymShift(lastYm, 14) && p[0] <= ymShift(lastYm, 3)).map(p => Number(p[1])));
      add('Growth', 'Unemployment trend', -((u3 - low) - 0.25) / 0.35, `${lastV(un).toFixed(1)}%`, `3-month average ${(u3 - low >= 0 ? '+' : '')}${(u3 - low).toFixed(2)} pts vs its 12-month low (0.5+ has marked recessions)`);
    }
    const pay = fS('PAYEMS', drop);
    if (pay.length >= 4) { const g = (lastV(pay) - agoV(pay, 3)) / 3; add('Growth', 'Payroll growth', (g - 75) / 125, `${g >= 0 ? '+' : '−'}${Math.abs(Math.round(g))}k/mo`, '3-month average jobs added (about 100k keeps pace with the labour force)'); }
    const ip = fS('INDPRO', drop);
    if (ip.length >= 19) { const y0 = yoyOf(ip), y6 = yoyOf(ip, 6); add('Growth', 'Industrial production', (y0 / 3 + (y0 - y6) / 2) / 2, `${y0 >= 0 ? '+' : ''}${y0.toFixed(1)}% y/y`, `${y0 >= y6 ? 'accelerating' : 'slowing'} from ${y6.toFixed(1)}% six months earlier`); }
    const hy = fS('BAMLH0A0HYM2', drop);
    if (hy.length >= 4) { const d = lastV(hy) - agoV(hy, 3); add('Growth', 'Credit spreads', -d / 1.0, `${lastV(hy).toFixed(2)}%`, `${d >= 0 ? 'widened' : 'narrowed'} ${Math.abs(d).toFixed(2)} pts in 3 months (widening = lenders getting nervous)`); }
    // inflation
    const cpi = fS('CPIAUCSL', drop);
    if (cpi.length >= 13) { const y = yoyOf(cpi), a3 = (Math.pow(lastV(cpi) / agoV(cpi, 3), 4) - 1) * 100; add('Inflation', 'CPI momentum', (a3 - y) / 1.5, `${y.toFixed(1)}% y/y`, `last 3 months ran at ${a3.toFixed(1)}% annualised`); }
    const core = fS('CPILFESL', drop);
    if (core.length >= 19) { const y0 = yoyOf(core), y6 = yoyOf(core, 6); add('Inflation', 'Core inflation trend', (y0 - y6) / 0.75, `${y0.toFixed(1)}% y/y`, `${y0 >= y6 ? 'up' : 'down'} from ${y6.toFixed(1)}% six months earlier`); }
    const be = fS('T10YIE', drop);
    if (be.length >= 4) { const d = lastV(be) - agoV(be, 3); add('Inflation', 'Market inflation expectations', d / 0.3, `${lastV(be).toFixed(2)}%`, `10-year breakeven ${d >= 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(2)} pts in 3 months`); }
    const avg = g => { const l = sig.filter(s => s.group === g); return l.length ? l.reduce((a, s) => a + s.score, 0) / l.length : null; };
    return { sig, g: avg('Growth'), i: avg('Inflation') };
  }
  const quadOf = (g, i) => g >= 0 ? (i >= 0 ? QUADS[1] : QUADS[0]) : (i >= 0 ? QUADS[2] : QUADS[3]);
  const dirWord = (x, up, dn) => Math.abs(x) < 0.15 ? 'roughly flat' : x > 0 ? (Math.abs(x) > .5 ? 'clearly ' : '') + up : (Math.abs(x) > .5 ? 'clearly ' : '') + dn;
  function renderRegime() {
    const sec = $('rgSection'), fred = macroData.fred;
    const empty = msg => { $('rgVerdict').textContent = msg; ['rgGrowth', 'rgGrowthSub', 'rgInfl', 'rgInflSub', 'rgImplication', 'rgNote'].forEach(id => { $(id).textContent = ''; }); $('rgMap').textContent = ''; $('rgSignals').textContent = ''; $('rgMarkets').textContent = ''; };
    sec.hidden = false;
    if (!fred || !fred.series) { empty(mode === 'airtable' ? 'Waiting for data: add a “Macro” table to your base (see the README) and the daily sync will fill it with indicators from the St. Louis Fed (FRED).' : 'The macro regime needs the daily sync, which runs in Airtable mode.'); return; }
    const R = regimeAt(0);
    if (R.g === null || R.i === null) { empty('Not enough indicator history yet.'); return; }
    const Q = quadOf(R.g, R.i);
    $('rgGrowth').textContent = dirWord(R.g, 'rising', 'falling'); $('rgGrowthSub').textContent = `Score ${R.g >= 0 ? '+' : ''}${R.g.toFixed(2)} from ${R.sig.filter(s => s.group === 'Growth').length} signals (−1 to +1).`;
    $('rgInfl').textContent = dirWord(R.i, 'rising', 'falling'); $('rgInflSub').textContent = `Score ${R.i >= 0 ? '+' : ''}${R.i.toFixed(2)} from ${R.sig.filter(s => s.group === 'Inflation').length} signals.`;
    const weak = Math.min(Math.abs(R.g), Math.abs(R.i)) < 0.15;
    $('rgVerdict').textContent = `${weak ? 'Leaning toward' : 'Heading toward'} ${Q.name.toLowerCase()}: growth ${dirWord(R.g, 'rising', 'falling')}, inflation ${dirWord(R.i, 'rising', 'falling')}. Data as of ${fred.asOf || 'the last sync'}.`;
    // 2x2 map with a 6-month trail
    const trail = []; for (let d = 6; d >= 0; d--) { const r = regimeAt(d); if (r.g !== null && r.i !== null) trail.push({ d, g: r.g, i: r.i }); }
    const W = 340, H = 280, P = 26, cl = v => Math.max(-0.75, Math.min(0.75, v)), x = g => P + (cl(g) + 1) / 2 * (W - 2 * P), y = i => H - P - (cl(i) + 1) / 2 * (H - 2 * P);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Regime map: growth ${R.g.toFixed(2)}, inflation ${R.i.toFixed(2)}, ${Q.name}. Dashed trail shows the last six months.` });
    const qs = [[QUADS[2], 0, 0], [QUADS[1], 1, 0], [QUADS[3], 0, 1], [QUADS[0], 1, 1]];
    for (const [q, cx, cy] of qs) {
      const rx = cx ? W / 2 : P, ry = cy ? H / 2 : P;
      el('rect', { x: rx, y: ry, width: W / 2 - P, height: H / 2 - P, class: q === Q ? 'q-on' : '', fill: q === Q ? '' : 'transparent' }, svg);
      el('text', { x: rx + (W / 2 - P) / 2, y: cy ? H - P - 8 : P + 14, class: 'q-lab', 'text-anchor': 'middle' }, svg).textContent = q.name;
    }
    el('line', { x1: W / 2, x2: W / 2, y1: P, y2: H - P, class: 'ax' }, svg); el('line', { x1: P, x2: W - P, y1: H / 2, y2: H / 2, class: 'ax' }, svg);
    el('text', { x: W - P, y: H / 2 - 4, class: 'ax-t', 'text-anchor': 'end' }, svg).textContent = 'growth ↑';
    el('text', { x: P, y: H / 2 - 4, class: 'ax-t' }, svg).textContent = 'growth ↓';
    el('text', { x: W / 2 + 4, y: P - 8, class: 'ax-t' }, svg).textContent = 'inflation ↑';
    el('text', { x: W / 2 + 4, y: H - P + 16, class: 'ax-t' }, svg).textContent = 'inflation ↓';
    if (trail.length > 1) el('path', { class: 'trail', d: trail.map((t, k) => (k ? 'L' : 'M') + x(t.g).toFixed(1) + ' ' + y(t.i).toFixed(1)).join(' ') }, svg);
    for (const t of trail.slice(0, -1)) { const c = el('circle', { class: 'pt', cx: x(t.g), cy: y(t.i), r: 3 }, svg); el('title', {}, c).textContent = `${t.d} month${t.d > 1 ? 's' : ''} ago`; }
    const now = el('circle', { class: 'now', cx: x(R.g), cy: y(R.i), r: 7 }, svg); el('title', {}, now).textContent = 'Now';
    $('rgMap').textContent = ''; $('rgMap').append(svg);
    // signals table
    const st = $('rgSignals'); st.textContent = '';
    const h1 = document.createElement('tr'); ['Signal', 'Latest', 'Reading', 'What it says'].forEach(t => { const th = document.createElement('th'); th.textContent = t; h1.append(th); });
    const th1 = document.createElement('thead'); th1.append(h1); st.append(th1);
    const tb1 = document.createElement('tbody');
    for (const s of R.sig) {
      const tr = document.createElement('tr');
      const n = document.createElement('td'); n.textContent = `${s.group}: ${s.name}`; tr.append(n);
      const v = document.createElement('td'); v.textContent = s.value; tr.append(v);
      const r = document.createElement('td'); r.textContent = `${s.score > 0.15 ? '↑' : s.score < -0.15 ? '↓' : '→'} ${s.score >= 0 ? '+' : ''}${s.score.toFixed(2)}`; tr.append(r);
      const w = document.createElement('td'); w.className = 'rg-what'; w.textContent = s.what; tr.append(w);
      tb1.append(tr);
    }
    st.append(tb1);
    // markets table
    const mk = $('rgMarkets'); mk.textContent = '';
    const h2 = document.createElement('tr'); ['Market', 'Latest', '3-month change', 'Why it matters'].forEach(t => { const th = document.createElement('th'); th.textContent = t; h2.append(th); });
    const th2 = document.createElement('thead'); th2.append(h2); mk.append(th2);
    const tb2 = document.createElement('tbody');
    const MK = [['DFF', 'Fed funds rate', '%', 'The price of money; your cash yield follows it'], ['DGS10', 'US 10-year yield', '%', 'Discount rate for every asset; rising hurts bonds and long-duration shares'],
      ['DFII10', 'US 10-year real yield', '%', 'The return after inflation; high real yields pressure gold and growth stocks'], ['T10YIE', '10-year breakeven inflation', '%', 'What bond markets expect inflation to average'],
      ['T10Y2Y', 'Yield curve (10y − 2y)', ' pts', 'Below zero has preceded most US recessions'], ['BAMLH0A0HYM2', 'High-yield spread', '%', 'Extra yield lenders demand from riskier companies'],
      ['DTWEXBGS', 'US dollar index', '', 'A stronger dollar shrinks the dollar value of your AUD and GBP holdings'], ['IRLTLT01AUM156N', 'Australia 10-year yield', '%', 'Australian rates: your mortgage and property'],
      ['IRLTLT01GBM156N', 'UK 10-year yield', '%', 'UK rates and sterling']];
    for (const [sid, name, unit, why] of MK) {
      const m = fS(sid); if (!m.length) continue;
      const v = lastV(m), a = agoV(m, 3), tr = document.createElement('tr');
      const ch = a === null ? '—' : unit === '' ? `${v >= a ? '+' : '−'}${Math.abs((v / a - 1) * 100).toFixed(1)}%` : `${v >= a ? '+' : '−'}${Math.abs(v - a).toFixed(2)}${unit === '%' ? ' pts' : unit}`;
      [name, unit === '' ? v.toFixed(1) : v.toFixed(2) + (unit === '%' ? '%' : unit), ch].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
      const w = document.createElement('td'); w.className = 'rg-what'; w.textContent = why; tr.append(w);
      tb2.append(tr);
    }
    mk.append(tb2);
    // implication for this portfolio
    const vis = visible(), by = bucketValues(vis), D = vis.filter(i => i.kind === 'debt' && i.value > 0 && !i.noFx).reduce((a, i) => a + i.value, 0), nw = Object.values(by).reduce((a, b) => a + b, 0) - D;
    const tot = BUCKETS.reduce((a, b) => a + (by[b] || 0) * (Q.s[b] || 0) / 100, 0);
    const helps = BUCKETS.filter(b => (Q.s[b] || 0) > 5).map(b => b.toLowerCase()), hurts = BUCKETS.filter(b => (Q.s[b] || 0) < -5 && by[b] > 0.5).map(b => b.toLowerCase());
    $('rgImplication').textContent = `If ${Q.name.toLowerCase()} plays out over a year, your portfolio would move roughly ${tot >= 0 ? '+' : '−'}${fmt(Math.abs(tot))}${nw > 0 ? ` (${tot >= 0 ? '+' : '−'}${Math.abs(tot / nw * 100).toFixed(1)}% of net worth)` : ''}. Typically helped: ${helps.join(', ') || 'little'}. Exposed: ${hurts.join(', ') || 'little'}.`;
    $('rgNote').textContent = 'Scores compare each indicator with its own recent trend (direction, not level) and average them per side; the dashed trail shows the last six months. Regimes shift slowly and signals are often mixed: Bridgewater’s own advice is to stay balanced rather than bet on the call. Source: Federal Reserve Bank of St. Louis (FRED), refreshed by the daily sync.';
  }

  // ---- currency policy ----
  const CPOL = prefs.cpol = Object.assign({ mix: null, band: 10, real: true }, prefs.cpol || {});
  function cpolMixDefault() {
    const spend = {}; let t = 0;
    for (const e of expView()) if (e.monthly) { spend[e.currency] = (spend[e.currency] || 0) + e.monthly; t += e.monthly; }
    if (!t) return { [dispCur()]: 100 };
    return roundTo100(Object.fromEntries(Object.entries(spend).map(([c, v]) => [c, v / t * 100])));
  }
  function renderCpol() {
    const vis = visible(), xp = exposures(vis).currency, sec = $('cpolSection');
    const net = Object.fromEntries(Object.entries(xp).map(([c, e]) => [c, e.assets - e.debts]));
    const stateless = ['XAU', 'BTC'].reduce((a, c) => a + Math.max(0, net[c] || 0), 0);
    const curs = Object.keys(net).filter(c => !(CPOL.real && PRICED.includes(c)));
    const T = curs.reduce((a, c) => a + net[c], 0);
    if (!(T > 0)) { sec.hidden = true; return; } sec.hidden = false;
    const mix = CPOL.mix || cpolMixDefault();
    // spending-mix inputs: every currency you hold or spend in
    const box = $('cpolMix'); box.textContent = '';
    const cand = [...new Set([...Object.keys(mix), ...curs.filter(c => !PRICED.includes(c) && Math.abs(net[c]) / T > 0.02 && HOME_OF[c])])];
    const lab0 = document.createElement('label'); lab0.className = 'inline'; lab0.style.color = 'var(--muted)'; lab0.textContent = 'Where you’ll spend (%):'; box.append(lab0);
    for (const c of cand) {
      const l = document.createElement('label'); l.textContent = c;
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '5'; inp.value = mix[c] || 0; inp.setAttribute('aria-label', `Share of future spending in ${c}`);
      inp.onchange = () => { CPOL.mix = { ...mix, [c]: Math.max(0, Math.min(100, Number(inp.value) || 0)) }; savePrefs(); renderCpol(); };
      l.append(inp); box.append(l);
    }
    $('cpolBand').value = CPOL.band; $('cpolReal').checked = !!CPOL.real;
    const ms = Object.values(mix).reduce((a, b) => a + b, 0), ok = Math.abs(ms - 100) < 0.5;
    const band = Number(CPOL.band) || 10;
    const rows = [...new Set([...curs, ...Object.keys(mix)])].map(c => {
      const now = (net[c] || 0) / T * 100, tgt = ok ? (mix[c] || 0) : 0;
      return { c, now, tgt, gap: now - tgt, v: net[c] || 0, out: ok && Math.abs(now - tgt) > band, assets: (xp[c] || {}).assets || 0, debts: (xp[c] || {}).debts || 0 };
    }).filter(r => Math.abs(r.v) > 0.5 || r.tgt > 0).sort((a, b) => b.v - a.v);
    const tbl = $('cpolTable'); tbl.textContent = '';
    const hr = document.createElement('tr'); ['Currency', 'Assets', 'Debts', 'Net', 'Now', 'Policy', 'Gap', 'Status'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      [`${r.c}${CUR_NAME[r.c] ? ' · ' + CUR_NAME[r.c] : ''}`, fmtShort(r.assets), r.debts ? '−' + fmtShort(r.debts) : '—', fmtShort(r.v), r.now.toFixed(1) + '%', ok ? r.tgt.toFixed(0) + '%' : '—', ok ? `${r.gap >= 0 ? '+' : '−'}${Math.abs(r.gap).toFixed(1)} pts` : '—'].forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.append(td); });
      const s = document.createElement('td'); s.className = 'ta-st ' + (r.out ? 'rk-warning' : 'rk-good');
      const ic = document.createElement('span'); ic.className = 'rk-ico'; ic.textContent = r.out ? '!' : '✓'; ic.setAttribute('aria-hidden', 'true');
      s.append(ic, !ok ? '—' : r.out ? (r.gap > 0 ? 'Over' : 'Under') : 'In band'); tr.append(s);
      tb.append(tr);
    }
    tbl.append(tb);
    const outside = rows.filter(r => !(mix[r.c] > 0)).reduce((a, r) => a + Math.max(0, r.v), 0);
    const breaches = rows.filter(r => r.out);
    $('cpolVerdict').textContent = !ok ? `Your spending mix adds up to ${ms}%. Make it 100% to compare.` :
      `${Math.round(outside / T * 100)}% of your currency exposure is in currencies you don’t plan to spend in${stateless > 0.5 && CPOL.real ? ` (plus ${fmt(stateless)} in gold and bitcoin, left out)` : ''}. ` + (breaches.length ? `${breaches.length} currenc${breaches.length > 1 ? 'ies are' : 'y is'} outside the ±${band}-point band.` : 'Everything is within the band.');
    // actions
    const act = $('cpolActions'); act.textContent = '';
    const item = (amt, text, note) => { const row = document.createElement('div'); row.className = 'ta-move'; const a = document.createElement('span'); a.className = 'amt'; a.textContent = amt; const d = document.createElement('span'); d.textContent = text; if (note) { const sm = document.createElement('small'); sm.textContent = note; d.append(sm); } row.append(a, d); act.append(row); };
    for (const r of rows.filter(r => r.debts > 0.5 && r.assets > 0.5)) item(Math.round(Math.min(1, r.debts / r.assets) * 100) + '%', `of your ${r.c} assets are offset by ${r.c} debt`, `A natural hedge: if the ${CUR_NAME[r.c] || r.c} falls, your ${r.c} debt shrinks in ${dispCur()} too.`);
    if (ok) for (const r of breaches) {
      const amt = Math.abs(r.gap) / 100 * T;
      if (r.gap > 0) {
        // which holdings bring this currency
        const src = vis.filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx).map(i => [i, (exposures([i]).currency[r.c] || {}).assets || 0]).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 2);
        item(fmt(amt), `Reduce ${r.c} exposure (${r.now.toFixed(0)}% vs ${r.tgt}% policy)`, src.length ? `Mostly from ${src.map(([i, v]) => `${i.name} (${fmtShort(v)})`).join(' and ')}. ${PRICED.includes(r.c) ? 'Trim the position, or accept it as a deliberate bet.' : HOME_OF[r.c] && r.c !== dispCur() && src.some(([i]) => i.currency !== r.c) ? 'Use currency-hedged share classes for the international part, or hold more in your spending currencies.' : `Hold more in your spending currencies, or borrow in ${r.c} against it.`}` : '');
      } else item(fmt(amt), `Build ${r.c} exposure (${r.now.toFixed(0)}% vs ${r.tgt}% policy)`, `New savings in ${r.c} assets, or ${r.c}-hedged versions of what you already hold.`);
    }
    if (!act.children.length) item('✓', 'No action needed', 'Your currency mix is within your policy band.');
    $('cpolNote').textContent = 'Look-through: international share funds count in the currencies of the markets they own (assumed unhedged); bond funds and cash count in their own currency; debts subtract. The policy is your expected future spending by currency, saved in this browser. Hedging has a cost (roughly the interest-rate gap between the two currencies).';
  }
  $('cpolBand').onchange = () => { CPOL.band = clampNum($('cpolBand').value, 1, 50, 10); savePrefs(); renderCpol(); };
  $('cpolReal').onchange = () => { CPOL.real = $('cpolReal').checked; savePrefs(); renderCpol(); };

  // ---- return streams ----
  // Monthly total returns from the sync's price history; correlations over the common window (24–60 months).
  // Independent streams = participation ratio of the correlation matrix's eigenvalues ((Σλ)² / Σλ²): N for N
  // uncorrelated streams, 1 if they all move together.
  function jacobiEig(A) {
    const n = A.length, a = A.map(r => r.slice());
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
      if (off < 1e-12) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      }
    }
    return a.map((r, i) => r[i]);
  }
  // ---- recommendations: more independent streams, lower correlation ----
  // Measured on the priced part of the portfolio, at its actual weights. "Weighted streams" = diversification ratio²
  // ((Σ wᵢσᵢ / σₚ)²): N for N equal-sized uncorrelated holdings, 1 if everything moves together. Candidates are the
  // reference streams the daily sync keeps (public ETFs used only as price proxies, not product advice). Each is sized
  // and funded from the cluster driving most of the risk, then the best few are combined greedily.
  const REF_INFO = {
    TLT: { name: 'Long-term Treasuries', bucket: 'Bonds', why: 'tends to rise when growth disappoints and rates fall (the deflationary-bust quadrant)' },
    SCHP: { name: 'Inflation-linked bonds (TIPS)', bucket: 'Bonds', why: 'pays inflation plus a real yield, so it holds up when inflation surprises' },
    DBC: { name: 'Broad commodities', bucket: 'Commodities', why: 'tends to do well in inflationary booms and supply shocks, when stocks and bonds struggle' },
    IAU: { name: 'Gold', bucket: 'Gold', why: 'a hedge against currency debasement, falling real rates and crises' },
    DBMF: { name: 'Trend-following (managed futures)', bucket: 'Other', why: 'follows sustained moves up or down across markets, so it has often made money in long bear markets' },
    VEA: { name: 'Developed ex-US stocks', bucket: 'Equities', why: 'different economies, sectors and currencies from US stocks' },
    VWO: { name: 'Emerging-market stocks', bucket: 'Equities', why: 'driven by different growth cycles, commodities and currencies' }
  };
  function rsStats(w, Rm, mu) {
    const n = w.length, T = Rm[0].length, mean = Rm.map(r => r.reduce((a, b) => a + b, 0) / T);
    const S = Rm.map((r, a) => Rm.map((q, b) => r.reduce((t, v, k) => t + (v - mean[a]) * (q[k] - mean[b]), 0) / (T - 1)));
    let v = 0; const Sw = S.map(r => r.reduce((t, x, b) => t + x * w[b], 0));
    for (let a = 0; a < n; a++) v += w[a] * Sw[a];
    const sig = S.map((r, a) => Math.sqrt(r[a])), vol = Math.sqrt(v * 12), dr = w.reduce((t, x, a) => t + x * sig[a], 0) * Math.sqrt(12) / (vol || 1);
    return { vol, bets: dr * dr, ret: w.reduce((t, x, a) => t + x * mu[a], 0), rc: w.map((x, a) => v ? x * Sw[a] / v : 0), S };
  }
  function renderStreamRecs(ctx) {
    const box = $('rsRecs'); box.textContent = '';
    const { use, months, C } = ctx, n = use.length, prices = macroData.prices || {};
    const add = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; box.append(d); return d; };
    const WT = use.reduce((a, s) => a + s.value, 0), w0 = use.map(s => s.value / WT);
    const mu0 = use.map(s => { const it = s.items, t = it.reduce((a, i) => a + i.value, 0); return t ? it.reduce((a, i) => a + i.value * fwdOf(i), 0) / t : 0; });
    const R0 = use.map(s => months.map(m => s.ret[m]));
    const base = rsStats(w0, R0, mu0);
    // portfolio return series, for each candidate's correlation with what you already hold
    const port = months.map((_, k) => R0.reduce((t, r, a) => t + w0[a] * r[k], 0));
    const corr = (x, y) => { const T = x.length, mx = x.reduce((a, b) => a + b, 0) / T, my = y.reduce((a, b) => a + b, 0) / T; let sxy = 0, sx = 0, sy = 0; for (let k = 0; k < T; k++) { sxy += (x[k] - mx) * (y[k] - my); sx += (x[k] - mx) ** 2; sy += (y[k] - my) ** 2; } return sxy / Math.sqrt(sx * sy || 1); };
    // 1) what is driving the risk
    const order = base.rc.map((r, a) => a).sort((a, b) => base.rc[b] - base.rc[a]), top = order[0];
    const cluster = use.map((_, j) => j).filter(j => j === top || C[top][j] >= 0.7);
    const clRisk = cluster.reduce((a, j) => a + base.rc[j], 0), clW = cluster.reduce((a, j) => a + w0[j], 0);
    const pc = x => Math.round(x * 100) + '%', lbl = j => esc(use[j].label);
    const lines = [], avgC = g => { let s = 0, p = 0; for (const a of g) for (const b of g) if (a < b) { s += C[a][b]; p++; } return p ? s / p : 1; };
    const and = l => l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : l[0];
    // duplicate clusters (≥0.85): one bet held several times
    const par = use.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (C[a][b] >= 0.85) par[find(a)] = find(b);
    const groupsC = {}; use.forEach((_, i) => { (groupsC[find(i)] = groupsC[find(i)] || []).push(i); });
    const dupes = Object.values(groupsC).filter(g => g.length > 1), same = g => g.length === cluster.length && g.every(j => cluster.includes(j));
    const consol = 'Holding them separately doesn’t diversify: treat them as one bet when sizing, and consolidate if that’s simpler (watch tax on selling).';
    lines.push((cluster.length > 1 ? `<b>${and(cluster.map(lbl))} ${dupes.some(same) ? `are effectively one stream (average correlation ${avgC(cluster).toFixed(2)})` : 'move together'} and drive ${pc(clRisk)} of your measured risk</b>` : `<b>${lbl(top)} drives ${pc(clRisk)} of your measured risk</b>`) +
      ` from ${pc(clW)} of the priced value. Sized as they are, your ${n} priced holdings behave like <b>${base.bets.toFixed(1)}</b> independent stream${base.bets.toFixed(1) === '1.0' ? '' : 's'} (volatility ${(base.vol * 100).toFixed(1)}%/yr).` + (dupes.some(same) ? ' ' + consol : ''));
    for (const g of dupes.filter(g => !same(g)))
      lines.push(`<b>${and(g.map(lbl))}</b> are effectively one stream (average correlation ${avgC(g).toFixed(2)}), together ${pc(g.reduce((t, j) => t + w0[j], 0))} of value and ${pc(g.reduce((t, j) => t + base.rc[j], 0))} of risk. ${consol}`);
    const intro = add('rs-rec-intro', ''); intro.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
    // 2) candidates
    const held = new Set(use.map(s => s.k));
    const cands = Object.keys(REF_INFO).filter(t => !held.has(t) && !(t === 'IAU' && held.has('coin:XAU'))).map(t => {
      const m = ((prices['ref:' + t] || {}).m || []).filter(p => Array.isArray(p) && Number(p[1]) > 0), ret = {};
      for (let j = 1; j < m.length; j++) ret[m[j][0]] = m[j][1] / m[j - 1][1] - 1;
      return { t, ...REF_INFO[t], ret, ok: months.every(mm => mm in ret) };
    });
    const ready = cands.filter(c => c.ok), waiting = cands.filter(c => !c.ok);
    if (!ready.length) {
      add('hint', mode === 'airtable' ? `Suggestions appear once the daily sync has fetched price history for the reference streams (${cands.map(c => c.name.toLowerCase()).join(', ')}). It adds a few each day within the free Alpha Vantage allowance, so allow up to a week.` : 'Suggestions need the daily sync’s price history (Airtable mode).');
      return;
    }
    // weights after adding candidate(s) at sizes, funded pro rata from the risk cluster
    const fund = cluster.slice(), fundW = fund.reduce((a, j) => a + w0[j], 0);
    const build = picks => {   // picks: [{c, a}]
      const take = Math.min(fundW * 0.9, picks.reduce((t, p) => t + p.a, 0)), scale = take / (picks.reduce((t, p) => t + p.a, 0) || 1);
      const w = w0.map((x, j) => fund.includes(j) ? x - take * x / fundW : x);
      const R = R0.concat(picks.map(p => months.map(m => p.c.ret[m]))), mu = mu0.concat(picks.map(p => SC_DEFAULTS[p.c.bucket][0]));
      return { st: rsStats(w.concat(picks.map(p => p.a * scale)), R, mu), picks: picks.map(p => ({ ...p, a: p.a * scale })) };
    };
    const SIZES = [0.05, 0.1, 0.15, 0.2];
    const bestSize = (c, prev) => { let best = null; for (const a of SIZES) { const r = build([...prev, { c, a }]); if (!best || r.st.bets > best.st.bets + 0.02) best = { ...r, a }; } return best; };
    const singles = ready.map(c => ({ c, corr: corr(months.map(m => c.ret[m]), port), ...bestSize(c, []) })).sort((x, y) => y.st.bets - x.st.bets);
    // greedy package of up to 3
    let pack = [], cur = { st: base };
    for (let k = 0; k < 3; k++) {
      const total = pack.reduce((t, p) => t + p.a, 0); if (total >= 0.35) break;
      let best = null;
      for (const c of ready.filter(c => !pack.some(p => p.c === c))) { const r = bestSize(c, pack); if (r && (!best || r.st.bets > best.st.bets)) best = r; }
      if (!best || best.st.bets - cur.st.bets < 0.15) break;
      pack = best.picks; cur = best;
    }
    const eff = st => st.vol ? (st.ret - SC_DEFAULTS.Cash[0]) / (st.vol * 100) : 0;   // excess return over cash ÷ volatility
    const money = a => fmt(a * WT), sgn = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
    const delta = (st) => `<span class="rs-d"><b>${base.bets.toFixed(1)} → ${st.bets.toFixed(1)}</b> streams</span><span class="rs-d"><b>${(base.vol * 100).toFixed(1)}% → ${(st.vol * 100).toFixed(1)}%</b> volatility</span><span class="rs-d"><b>${sgn(st.ret - base.ret)}%/yr</b> expected return</span><span class="rs-d"><b>${eff(base).toFixed(2)} → ${eff(st).toFixed(2)}</b> return per unit of risk</span>`;
    const fromTxt = fund.length > 1 ? `${fund.map(lbl).join(', ')} (pro rata)` : lbl(fund[0]);
    if (pack.length) {
      const d = add('rs-pack', `<div class="label">Suggested package</div>
        <p>${pack.map(p => `<b>${pc(p.a)} ${esc(p.c.name)}</b> (${money(p.a)})`).join(' + ')}, funded from ${fromTxt}.</p>
        <div class="rs-ds">${delta(cur.st)}</div>`);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn primary'; b.textContent = 'Model in Rebalance what-if'; b.onclick = () => rsModel(pack, fund); d.append(b);
    } else add('rs-pack', `<p>None of the reference streams adds much at sensible sizes: your priced holdings are already about as diversified as these candidates can make them.</p>`);
    const tbl = document.createElement('table'); tbl.className = 'proj-table rs-cands';
    tbl.innerHTML = `<thead><tr><th>Stream to add</th><th title="Correlation with your portfolio">Corr.</th><th>Size</th><th title="Change in independent streams">Streams</th><th title="Change in volatility">Vol.</th><th title="Change in expected return">Return</th><th title="Change in return per unit of risk">Ret./risk</th><th></th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const s of singles) {
      const tr = document.createElement('tr'), gain = s.st.bets - base.bets;
      tr.innerHTML = `<td><div class="name">${esc(s.c.name)} <span class="muted">${esc(s.c.t)}</span></div><div class="hint">${esc(s.c.why)}</div></td><td>${s.corr.toFixed(2)}</td><td>${pc(s.a)}<div class="hint">${money(s.a)}</div></td><td class="${gain >= 0.15 ? 'pos' : ''}">${sgn(gain)}</td><td>${sgn((s.st.vol - base.vol) * 100)}</td><td>${sgn(s.st.ret - base.ret)}%</td><td class="${eff(s.st) > eff(base) + 0.005 ? 'pos' : ''}">${sgn(eff(s.st) - eff(base), 2)}</td>`;
      const td = document.createElement('td'); const b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn'; b.textContent = 'Model'; b.setAttribute('aria-label', `Model adding ${s.c.name}`); b.onclick = () => rsModel(s.picks, fund); td.append(b); tr.append(td); tb.append(tr);
    }
    tbl.append(tb); const wrap = document.createElement('div'); wrap.className = 'proj-table-wrap'; wrap.append(tbl); box.append(wrap);
    add('hint', `Each stream is sized (5–20% of the ${fmt(WT)} priced portfolio) to add the most independent streams and funded from ${fromTxt}, the cluster driving most of the risk. Columns show the change from adding each one on its own (Corr. = its correlation with your portfolio; Vol. and Return in percentage points a year). Measured on ${months.length} months of actual returns${waiting.length ? `; still waiting for price history: ${waiting.map(c => c.name).join(', ')}` : ''}. Expected returns use your assumptions for each asset class; return per unit of risk is expected return above cash ÷ volatility, so a higher figure means each unit of risk is better paid even if the total return is lower. Tickers are public price proxies, not product recommendations. Correlations change, notably stocks and bonds have moved together since 2022, so treat these as a direction, not a precise answer.`);
  }
  function rsModel(picks, fund) {
    const assets = mvAssets(), use = fund.map(j => rsLast.use[j]);
    for (const p of picks) {
      const amt = p.a * rsLast.WT, items = use.flatMap(s => s.items).filter(i => assets.some(a => a.id === i.id)), t = items.reduce((a, i) => a + i.value, 0);
      for (const i of items) { const x = Math.round(amt * i.value / t / 100) * 100; if (x > 0 && MV.length < 20) MV.push({ from: i.id, to: 'b:' + p.c.bucket, amount: x }); }
    }
    savePrefs(); location.hash = '#scenarios'; renderMoves();
    setTimeout(() => { const s = $('mvSection'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }
  let rsLast = null;
  const RS_POS = ['#b7d3f6', '#86b6ef', '#3987e5', '#1c5cab'], RS_NEG = ['#f6c9c8', '#ef9a99', '#e66767', '#b52e2d'];
  function renderStreams() {
    const sec = $('rsSection'), prices = macroData.prices;
    const reset = msg => { ['rsEff', 'rsAvg', 'rsVol'].forEach(id => { $(id).textContent = '—'; }); ['rsEffSub', 'rsAvgSub', 'rsVolSub', 'rsDupes'].forEach(id => { $(id).textContent = ''; }); $('rsHeat').textContent = ''; $('rsRecs').textContent = ''; $('rsRecsH').hidden = true; $('rsNote').textContent = msg; };
    sec.hidden = false;
    if (!prices || typeof prices !== 'object') { reset(mode === 'airtable' ? 'Waiting for data: once the “Macro” table exists, the daily sync saves monthly prices for each holding with a ticker.' : 'Return streams need the daily sync’s price history (Airtable mode).'); return; }
    const vis = visible().filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx);
    const keyOf = i => i.ticker || ({ BTC: 'coin:BTC', XAU: 'coin:XAU' })[i.currency] || '';
    const groups = {};
    for (const i of vis) { const k = keyOf(i); if (!k) continue; const g = groups[k] = groups[k] || { k, names: [], items: [], value: 0 }; g.names.push(i.name); g.items.push(i); g.value += i.value; }
    const series = Object.values(groups).map(g => {
      const m = ((prices[g.k] || {}).m || []).filter(p => Array.isArray(p) && Number(p[1]) > 0);
      const ret = {}; for (let j = 1; j < m.length; j++) ret[m[j][0]] = m[j][1] / m[j - 1][1] - 1;
      return { ...g, ret, label: g.k.startsWith('coin:') ? (g.k === 'coin:BTC' ? 'Bitcoin' : 'Gold') : g.k };
    }).filter(s => Object.keys(s.ret).length >= 24);
    const missing = Object.values(groups).filter(g => !series.some(s => s.k === g.k)).map(g => g.k.replace('coin:', ''));
    if (series.length < 2) { reset(`Not enough price history yet (need 24+ months for at least two holdings).${missing.length ? ' Without data: ' + missing.join(', ') + '.' : ''}`); return; }
    let months = Object.keys(series[0].ret); for (const s of series.slice(1)) months = months.filter(m => m in s.ret);
    months = months.sort().slice(-60);
    const use = months.length >= 24 ? series : series.filter(s => Object.keys(s.ret).length >= 24);
    const n = use.length, X = use.map(s => months.map(m => s.ret[m]));
    const mean = X.map(r => r.reduce((a, b) => a + b, 0) / r.length), sd = X.map((r, k) => Math.sqrt(r.reduce((a, b) => a + (b - mean[k]) ** 2, 0) / (r.length - 1)));
    const C = X.map((r, a) => X.map((q, b) => a === b ? 1 : r.reduce((t, v, k) => t + (v - mean[a]) * (q[k] - mean[b]), 0) / ((r.length - 1) * sd[a] * sd[b] || 1)));
    const lam = jacobiEig(C).map(v => Math.max(0, v)), eff = lam.reduce((a, b) => a + b, 0) ** 2 / lam.reduce((a, b) => a + b * b, 0);
    let pairs = 0, sum = 0; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { pairs++; sum += C[a][b]; }
    const avg = sum / pairs;
    // value-weighted realised volatility of the priced part
    const W = use.map(s => s.value), WT = W.reduce((a, b) => a + b, 0), wv = W.map(w => w / WT);
    let pv = 0; for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) pv += wv[a] * wv[b] * C[a][b] * sd[a] * sd[b];
    const vol = Math.sqrt(pv * 12);
    $('rsEff').textContent = eff.toFixed(1); $('rsEffSub').textContent = `out of ${n} holdings with price history. Bridgewater aims for 10–15 genuinely uncorrelated streams.`;
    $('rsAvg').textContent = avg.toFixed(2); $('rsAvgSub').textContent = `between pairs, over ${months.length} months to ${months[months.length - 1]}. Below 0.3 is diversifying; above 0.8 is the same bet.`;
    $('rsVol').textContent = (vol * 100).toFixed(1) + '%'; $('rsVolSub').textContent = `a year for these ${n} holdings (value-weighted), from actual monthly returns.`;
    const tbl = $('rsHeat'); tbl.textContent = '';
    const hr = document.createElement('tr'); hr.append(document.createElement('th'));
    for (const s of use) { const th = document.createElement('th'); th.textContent = s.label; th.title = s.names.join(', '); hr.append(th); }
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody');
    use.forEach((s, a) => {
      const tr = document.createElement('tr'); const h = document.createElement('th'); h.textContent = s.label; h.title = s.names.join(', '); tr.append(h);
      use.forEach((q, b) => {
        const td = document.createElement('td'), v = C[a][b];
        td.textContent = a === b ? '1' : v.toFixed(2);
        if (a === b) td.className = 'self';
        else { const step = Math.min(3, Math.floor(Math.abs(v) * 4)); td.style.background = (v >= 0 ? RS_POS : RS_NEG)[step]; if (step >= 2) td.className = 'dark'; }
        td.title = `${s.label} vs ${q.label}: ${v.toFixed(2)}`; tr.append(td);
      });
      tb.append(tr);
    });
    tbl.append(tb);
    const dupes = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (C[a][b] > 0.9) dupes.push(`${use[a].label} & ${use[b].label} (${C[a][b].toFixed(2)})`);
    $('rsDupes').textContent = dupes.length ? `Near-duplicates (correlation above 0.9): ${dupes.join(', ')}. Holding both adds little diversification.` : 'No near-duplicates (nothing correlated above 0.9).';
    $('rsNote').textContent = `Total returns (dividends reinvested) from Alpha Vantage monthly prices, refreshed by the daily sync; gold uses IAU as a proxy. Not included (no price history): ${missing.length ? missing.join(', ') : 'nothing'}, nor cash and property. Correlations rise in crises, so real-world diversification is usually lower than this shows.`;
    rsLast = { use, WT: use.reduce((a, s) => a + s.value, 0) }; $('rsRecsH').hidden = false;
    renderStreamRecs({ use, months, C });
  }

  function renderMacro() {
    if (mode === 'locked') return;
    renderRegime(); renderEnv(); renderCpol(); renderStreams();
  }

  // ---------- Savings forecast (24 months) ----------
  // Month by month: regular savings (what's left after spending and bills) + bonuses − automatic investment
  // contributions ± planned one-offs + interest on cash = the change in your emergency-fund cash. Each month's
  // savings and bonus can be overridden. The target is N months of essential spending (growing with inflation) plus
  // set-asides. "You could invest" is the largest steady extra monthly amount, plus a lump sum now, that keeps cash at
  // or above the target in every month of the forecast.
  const SF = prefs.sf = Object.assign({ savings: null, raise: 0, months: null, retTake: false, mode: 'plan', basis: 'all', events: [], over: {}, bonus: {} }, prefs.sf || {});
  if (!Array.isArray(SF.events)) SF.events = [];
  if (!SF.over || typeof SF.over !== 'object') SF.over = {};
  if (!SF.bonus || typeof SF.bonus !== 'object') SF.bonus = {};
  delete SF.income; delete SF.debtIn;   // older version asked for take-home pay instead of savings
  const SF_N = 24;
  const ymAdd = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const ymLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); };
  const sfBase = t => (Number(SF.savings) || 0) * Math.pow(1 + (Number(SF.raise) || 0) / 100, Math.floor((t - 1) / 12));
  const sfSav = (t, ym) => has(SF.over[ym]) ? Number(SF.over[ym]) : sfBase(t);
  const sfBon = ym => Math.max(0, Number(SF.bonus[ym]) || 0);
  function sfModel() {
    const vis = visible(), sp = spendNow(), infl = (Number(P.infl) || 0) / 100;
    const ess = SF.basis === 'ess' ? (sp.ess || sp.all) : sp.all, months = SF.months === null || SF.months === undefined || SF.months === '' ? (Number(POL.reserve) || 6) : Number(SF.months);
    const fund = efHoldings(), cash0 = fund.reduce((a, i) => a + i.value, 0);
    const cashRate = cash0 ? fund.reduce((a, i) => a + i.value * (has(i.rate) ? i.rate : SC_DEFAULTS.Cash[0]), 0) / cash0 : SC_DEFAULTS.Cash[0];
    const fundIds = new Set(fund.map(i => i.id));
    const invs = vis.filter(i => i.kind === 'asset' && i.value > 0 && !i.noFx && !fundIds.has(i.id) && !(mainBucket(i) === 'Property' && !i.ticker) && !['Vehicles', 'Collectibles'].includes(i.category));
    const inv0 = invs.reduce((a, i) => a + i.value, 0), invRet = inv0 ? invs.reduce((a, i) => a + i.value * fwdOf(i), 0) / inv0 : SC_DEFAULTS.Equities[0];
    const fromPay = invs.filter(i => SF.retTake || liquidityOf(i) !== 'locked').reduce((a, i) => a + (Number(i.monthly) || 0), 0);
    const payroll = invs.filter(i => !SF.retTake && liquidityOf(i) === 'locked').reduce((a, i) => a + (Number(i.monthly) || 0), 0);
    const asides0 = asides.map(a => ({ id: a.id, name: a.name, v: a.amount === null ? 0 : (conv(a.amount, a.currency) || 0) }));
    const evs = SF.events.filter(e => e && /^\d{4}-\d{2}$/.test(e.month || '') && Number(e.amount));
    const run = (X, L) => {
      let cash = cash0 - L, inv = inv0 + L; const aside = Object.fromEntries(asides0.map(a => [a.id, a.v]));
      const rows = [];
      for (let t = 1; t <= SF_N; t++) {
        const ym = ymAdd(t), grow = Math.pow(1 + infl, t / 12), sav = sfSav(t, ym), bonus = sfBon(ym);
        let ev = 0; const evNames = [];
        for (const e of evs) if (e.month === ym) {
          const amt = Number(e.amount) * (e.dir === 'in' ? 1 : -1); ev += amt; evNames.push(e.name || (amt >= 0 ? 'Money in' : 'Spend'));
          if (amt < 0 && e.fund && aside[e.fund] !== undefined) aside[e.fund] = Math.max(0, aside[e.fund] + amt);   // paid from a set-aside: it's released
        }
        const interest = cash > 0 ? cash * (Math.pow(1 + cashRate / 100, 1 / 12) - 1) : 0;
        cash += sav + bonus - fromPay - X + ev + interest;
        inv = inv * Math.pow(1 + invRet / 100, 1 / 12) + fromPay + payroll + X;
        const setA = Object.values(aside).reduce((a, b) => a + b, 0), target = months * ess * grow + setA;
        rows.push({ t, ym, sav, bonus, invest: fromPay + X, payroll, ev, evNames, interest, cash: cash - setA, cashAll: cash, setA, target: target - setA, inv, over: has(SF.over[ym]), cover: (ess * grow) ? Math.max(0, cash - setA) / (ess * grow) : null });
      }
      return rows;
    };
    const plan = run(0, 0);
    const asidesT = asides0.reduce((a, b) => a + b.v, 0), free0 = cash0 - asidesT, target0 = months * ess, slack0 = free0 - target0;   // emergency fund only: set-asides are kept out of both sides
    let X = Infinity; for (const r of plan) X = Math.min(X, (r.cash - r.target) / r.t);
    const slackMin = Math.min(slack0, ...plan.map(r => r.cash - r.target));
    let rec = null;
    if (slack0 >= 0 && X > 0) {
      X = Math.max(0, Math.floor(X / 50) * 50);
      const after = run(X, 0); const L = Math.max(0, Math.floor(Math.min(slack0, ...after.map(r => r.cash - r.target)) / 100) * 100);
      rec = { X, L, rows: run(X, L) };
      const rr = rec.rows, tb = rr.reduce((k, r, i) => r.cash - r.target < rr[k].cash - rr[k].target ? i : k, 0);
      if (tb < rr.length - 1) {
        let X2 = Infinity; for (let i = tb + 1; i < rr.length; i++) X2 = Math.min(X2, ((rr[i].cash - rr[i].target) - (rr[tb].cash - rr[tb].target)) / (i - tb));
        X2 = Math.floor(X2 / 50) * 50;
        if (X2 >= 100) rec.after = { ym: rr[tb + 1].ym, extra: X2 };
      }
    } else if (slack0 >= 0) {
      const L = Math.max(0, Math.floor(slackMin / 100) * 100);
      rec = { X: 0, L, rows: run(0, L) };
    }
    const reach = slack0 < 0 ? plan.find(r => r.cash >= r.target) : null;
    const bonusT = plan.reduce((a, r) => a + r.bonus, 0), savT = plan.reduce((a, r) => a + r.sav, 0);
    const any = (Number(SF.savings) || 0) > 0 || bonusT > 0 || plan.some(r => r.over && r.sav > 0);
    const noFx = expView().filter(e => e.noFx).length;
    return { plan, rec, cash0: free0, cashAll0: cash0, target0, slack0, ess, noFx, months, fromPay, payroll, inv0, invRet, cashRate, sp, reach, bonusT, savT, any, asidesT };
  }
  function sfChart(chart, tip, rows, lines, labels) {
    [...chart.querySelectorAll('svg')].forEach(n => n.remove()); tip.hidden = true;
    const W = Math.max(300, Math.round(chart.clientWidth || 640)), narrow = W < 520, H = narrow ? 200 : 230, L = narrow ? 48 : 58, R = 12, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
    const vals = lines.flatMap(l => l.pts.filter(v => v !== null)); let lo = Math.min(0, ...vals), hi = Math.max(...vals); if (hi === lo) hi = lo + 1;
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const n = labels.length - 1, x = i => L + i / n * pw, y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': lines.map(l => `${l.label}: ${fmt(l.pts[0])} now to ${fmt(l.pts[n])} in ${n} months`).join('; ') + '. The table below has every month.' });
    for (let v = lo; v <= hi + step / 2; v += step) { el('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }, svg); el('text', { class: 'axis-t', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtShort(v); }
    if (lo < 0) el('line', { class: 'zero', x1: L, x2: L + pw, y1: y(0), y2: y(0) }, svg);
    for (let i = 0; i <= n; i += narrow ? 6 : 3) el('text', { class: 'axis-t', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle' }, svg).textContent = labels[i];
    for (const l of lines) el('path', { class: l.cls, d: l.pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ') }, svg);
    const cross = el('line', { class: 'cross', y1: T, y2: T + ph, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }, svg);
    const show = evt => {
      const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n, Math.round(((evt.clientX - r.left) * W / r.width - L) / pw * n)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.textContent = ''; const h = document.createElement('div'); h.textContent = labels[i]; tip.append(h);
      for (const l of lines) { const row = document.createElement('div'); const sw = document.createElement('i'); sw.className = 'sw ' + l.sw; const b = document.createElement('b'); b.textContent = fmt(l.pts[i]); row.append(sw, l.label + ' ', b); tip.append(row); }
      const ev = i > 0 && rows[i - 1] && rows[i - 1].evNames.length ? rows[i - 1].evNames.join(', ') : '';
      if (ev) { const e = document.createElement('div'); e.className = 'muted'; e.textContent = ev; tip.append(e); }
      tip.hidden = false; const left = x(i) / W * r.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    chart.prepend(svg);
  }
  // stacked monthly bars: regular savings + bonus above zero, one-offs out below; click a month to edit it
  function sfFlowChart(rows) {
    const chart = $('sfFlowChart'), tip = $('sfFlowTip'); [...chart.querySelectorAll('svg')].forEach(n => n.remove()); tip.hidden = true;
    const W = Math.max(300, Math.round(chart.clientWidth || 640)), narrow = W < 520, H = narrow ? 190 : 220, L = narrow ? 48 : 58, R = 8, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
    const up = rows.map(r => r.sav + r.bonus), dn = rows.map(r => Math.min(0, r.ev) + Math.min(0, r.sav));
    let hi = Math.max(1, ...up, ...rows.map(r => r.ev > 0 ? r.sav + r.bonus + r.ev : 0)), lo = Math.min(0, ...dn);
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const n = rows.length, slot = pw / n, bw = Math.max(4, slot - 2), y = v => T + (1 - (v - lo) / (hi - lo)) * ph, x = i => L + i * slot + (slot - bw) / 2;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Savings and bonuses for the next ${n} months; the grid below lists and edits every month.` });
    for (let v = lo; v <= hi + step / 2; v += step) { el('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }, svg); el('text', { class: 'axis-t', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtShort(v); }
    el('line', { class: 'zero', x1: L, x2: L + pw, y1: y(0), y2: y(0) }, svg);
    const bar = (cls, i, a, b) => { const top = y(Math.max(a, b)), h = Math.abs(y(a) - y(b)); if (h < 0.5) return; el('rect', { class: cls, x: x(i), y: top, width: bw, height: h, rx: Math.min(2, bw / 4) }, svg); };
    rows.forEach((r, i) => {
      const s = Math.max(0, r.sav); bar('b-sav' + (r.over ? ' ov' : ''), i, 0, s);
      if (r.bonus > 0) bar('b-bon', i, s + 1.5 * (hi - lo) / ph, s + r.bonus);          // 1.5px surface gap between segments
      if (r.ev > 0) bar('b-in', i, s + r.bonus + 1.5 * (hi - lo) / ph, s + r.bonus + r.ev);
      if (r.sav < 0) bar('b-out', i, 0, r.sav);
      if (r.ev < 0) bar('b-out', i, Math.min(0, r.sav) - 1.5 * (hi - lo) / ph, Math.min(0, r.sav) + r.ev);
      if (i % (narrow ? 6 : 3) === 0 || i === n - 1) el('text', { class: 'axis-t', x: x(i) + bw / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = ymLabel(r.ym);
    });
    const hl = el('rect', { class: 'b-hl', y: T, width: slot, height: ph, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent', style: 'cursor:pointer' }, svg);
    const idx = evt => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor(((evt.clientX - r.left) * W / r.width - L) / slot))); };
    const show = evt => {
      const i = idx(evt), r = rows[i], rr = svg.getBoundingClientRect();
      hl.setAttribute('x', L + i * slot); hl.setAttribute('visibility', 'visible');
      tip.textContent = ''; const h = document.createElement('div'); h.textContent = ymLabel(r.ym) + (r.over ? ' (edited)' : ''); tip.append(h);
      const line = (sw, label, v) => { const d = document.createElement('div'); const i2 = document.createElement('i'); i2.className = 'sw ' + sw; const b = document.createElement('b'); b.textContent = fmt(v); d.append(i2, label + ' ', b); tip.append(d); };
      line('sw-sav', 'Savings', r.sav); if (r.bonus) line('sw-bon', 'Bonus', r.bonus); if (r.ev) line(r.ev > 0 ? 'sw-in' : 'sw-out', r.evNames.join(', ') || 'One-off', r.ev);
      const hint = document.createElement('div'); hint.className = 'muted'; hint.textContent = 'Click to edit'; tip.append(hint);
      tip.hidden = false; const left = (L + (i + 0.5) * slot) / W * rr.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), rr.width - tip.offsetWidth) + 'px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', () => { hl.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    hit.addEventListener('click', evt => { const c = $('sfGrid').querySelectorAll('.sf-cell')[idx(evt)]; if (c) { c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.querySelector('input').focus(); } });
    chart.prepend(svg);
  }
  // the 24-month editing grid
  function renderSfGrid() {
    const box = $('sfGrid'); box.textContent = '';
    for (let t = 1; t <= SF_N; t++) {
      const ym = ymAdd(t), cell = document.createElement('div'); cell.className = 'sf-cell' + (has(SF.over[ym]) ? ' ov' : '') + (sfBon(ym) ? ' has-bon' : '');
      const h = document.createElement('div'); h.className = 'sf-cell-h'; h.textContent = ymLabel(ym); cell.append(h);
      const mk = (label, cls, val, ph, on) => {
        const l = document.createElement('label'); l.className = cls; const sp = document.createElement('span'); sp.textContent = label;
        const i = document.createElement('input'); i.type = 'number'; i.min = '0'; i.step = 'any'; i.inputMode = 'decimal'; i.value = val; i.placeholder = ph; i.setAttribute('aria-label', `${label} ${ymLabel(ym)}`);
        i.onchange = () => { on(i.value); savePrefs(); cell.classList.toggle('ov', has(SF.over[ym])); cell.classList.toggle('has-bon', !!sfBon(ym)); renderSf(false); };
        l.append(sp, i); cell.append(l); return i;
      };
      mk('Savings', 'sf-in-sav', has(SF.over[ym]) ? SF.over[ym] : '', String(Math.round(sfBase(t))), v => { if (v === '') delete SF.over[ym]; else SF.over[ym] = Number(v) || 0; });
      mk('Bonus', 'sf-in-bon', sfBon(ym) || '', '0', v => { const n = Math.max(0, Number(v) || 0); if (n) SF.bonus[ym] = n; else delete SF.bonus[ym]; });
      box.append(cell);
    }
  }
  function renderSf(rebuild = true) {
    if (mode === 'locked') return;
    const Mo = sfModel();
    $('sfSavings').value = SF.savings ?? ''; $('sfSavings').placeholder = 'e.g. 3000'; $('sfRaise').value = SF.raise; $('sfMonths').value = Mo.months; $('sfRetTake').checked = !!SF.retTake;
    const covNow = Mo.ess ? Math.max(0, Mo.cash0) / Mo.ess : null;
    $('sfNow').textContent = covNow === null ? fmt(Mo.cash0) : `${fmtMonths(covNow)} mo`;
    const spLabel = SF.basis === 'ess' && Mo.sp.ess ? 'essential spending' : 'living expenses';
    $('sfNowSub').textContent = !Mo.ess ? 'Add monthly living expenses on the overview to set a target.'
      : `${fmt(Mo.cash0)} emergency fund` + (Mo.asidesT > 0.5 ? ` (${fmt(Mo.cashAll0)} cash minus ${fmt(Mo.asidesT)} set aside for goals)` : '') + ` ÷ ${fmt(Mo.ess)}/mo ${spLabel}. ` +
        `Target: ${Mo.months} months × ${fmt(Mo.ess)} = ${fmt(Mo.target0)}.` +
        (Mo.noFx ? ` ${Mo.noFx} expense${Mo.noFx === 1 ? ' isn’t' : 's aren’t'} counted (no exchange rate).` : '');
    const bs = $('sfBasis'); bs.textContent = '';
    for (const [k, t, v] of [['all', 'All living expenses', Mo.sp.all], ['ess', 'Essentials only', Mo.sp.ess]]) { const o = document.createElement('option'); o.value = k; o.textContent = `${t} (${fmt(v)}/mo)`; bs.append(o); }
    bs.value = SF.basis === 'ess' ? 'ess' : 'all';
    const none = !Mo.any;
    const modeBox = $('sfMode'); modeBox.textContent = '';
    if (!Mo.rec && SF.mode === 'rec') SF.mode = 'plan';
    for (const [k, label] of [['plan', 'Your current plan'], ['rec', 'With recommended investing']]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (SF.mode === k ? ' on' : ''); b.textContent = label; b.setAttribute('aria-pressed', String(SF.mode === k));
      if (k === 'rec' && (!Mo.rec || none)) { b.disabled = true; b.title = none ? 'Enter your regular savings first' : 'Your cash is below target, so there’s nothing extra to invest yet'; }
      b.onclick = () => { SF.mode = k; savePrefs(); renderSf(false); }; modeBox.append(b);
    }
    const rows = SF.mode === 'rec' && Mo.rec ? Mo.rec.rows : Mo.plan;
    const low = rows.reduce((a, r) => r.cash - r.target < a.cash - a.target ? r : a, rows[0]);
    $('sfLow').textContent = none ? '—' : `${low.cover === null ? fmtShort(low.cash) : fmtMonths(low.cover) + ' mo'}`;
    $('sfLowSub').textContent = none ? 'Enter your regular savings to forecast.' : `${ymLabel(low.ym)}: ${fmt(low.cash)} emergency fund vs ${fmt(low.target)} target${low.evNames.length ? ` (${low.evNames.join(', ')})` : ''}.`;
    $('sfLow').classList.toggle('neg', !none && low.cash < low.target);
    if (none) { $('sfRec').textContent = '—'; $('sfRecSub').textContent = ''; }
    else if (Mo.rec) { $('sfRec').textContent = `${fmt(Mo.rec.X)}/mo`; $('sfRecSub').textContent = `${Mo.rec.L > 0 ? `plus ${fmt(Mo.rec.L)} now, ` : ''}on top of the ${fmt(Mo.fromPay)}/month you already invest, while never dropping below the target.` + (Mo.rec.after ? ` From ${ymLabel(Mo.rec.after.ym)} you could raise it to ${fmt(Mo.rec.X + Mo.rec.after.extra)}/month.` : ''); }
    else { $('sfRec').textContent = '$0'; $('sfRecSub').textContent = Mo.reach ? `Build cash first: at your current plan you reach the target in ${ymLabel(Mo.reach.ym)}.` : `Build cash first: you’re ${fmt(-Mo.slack0)} below target and the forecast doesn’t get there in 24 months.`; }
    const planLow = Mo.plan.reduce((a, r) => r.cash - r.target < a.cash - a.target ? r : a, Mo.plan[0]), endP = Mo.plan[SF_N - 1];
    const base = Number(SF.savings) || 0, toCash = base - Mo.fromPay;
    $('sfVerdict').textContent = none ? 'Enter what you save each month (what’s left after spending and bills) and any bonuses to forecast your cash and investments for the next 24 months.'
      : `You save about ${fmt(base)}/month${Mo.bonusT > 0.5 ? ` plus ${fmt(Mo.bonusT)} in bonuses over the next 24 months` : ''}. ` +
        (Mo.fromPay > 0.5 ? `${fmt(Mo.fromPay)}/month of that already goes into investments automatically, so ${toCash >= 0 ? `about ${fmt(toCash)}/month builds cash` : `cash shrinks by about ${fmt(-toCash)}/month between bonuses`}. ` : '') +
        (Mo.slack0 < 0 ? `Your emergency fund is ${fmt(-Mo.slack0)} below target. ` : planLow.cash < planLow.target ? `On your current plan cash dips below target in ${ymLabel(planLow.ym)}. ` : '') +
        (Mo.rec && Mo.rec.X + Mo.rec.L > 0 ? `You could invest an extra ${fmt(Mo.rec.X)}/month${Mo.rec.L > 0 ? ` and ${fmt(Mo.rec.L)} now` : ''} and still keep ${Mo.months} months of cover in every month.` : endP.cash > endP.target ? `Cash ends at ${fmt(endP.cash)} vs ${fmt(endP.target)} target.` : '');
    // savings & bonuses: bars + grid
    $('sfFlowSub').textContent = `${fmt(Mo.savT)} of savings and ${fmt(Mo.bonusT)} of bonuses over 24 months. Type in a month to change it; leave Savings blank to use your regular amount${Number(SF.raise) ? ` (growing ${SF.raise}% a year)` : ''}.`;
    $('sfReset').hidden = !Object.keys(SF.over).some(k => k >= ymAdd(1));
    sfFlowChart(Mo.plan);
    if (rebuild || !$('sfGrid').querySelector('.sf-cell')) renderSfGrid();
    // cash and investment charts
    const labels = ['Now', ...rows.map(r => ymLabel(r.ym))];
    const lines1 = [{ label: SF.mode === 'rec' ? 'Emergency fund (with investing)' : 'Emergency fund', cls: 'l-cash', sw: 'sw-cash', pts: [SF.mode === 'rec' && Mo.rec ? Mo.cash0 - Mo.rec.L : Mo.cash0, ...rows.map(r => r.cash)] }, { label: 'Target', cls: 'l-tgt', sw: 'sw-tgt', pts: [Mo.target0, ...rows.map(r => r.target)] }];
    if (SF.mode === 'rec' && Mo.rec) lines1.push({ label: 'Emergency fund (current plan)', cls: 'l-cash2', sw: 'sw-dot', pts: [Mo.cash0, ...Mo.plan.map(r => r.cash)] });
    const lg1 = $('sfLegend1'); lg1.textContent = ''; for (const l of lines1) { const s = document.createElement('span'); const i = document.createElement('i'); i.className = 'sw ' + l.sw; s.append(i, l.label); lg1.append(s); }
    const lines2 = [{ label: SF.mode === 'rec' ? 'Investments (with investing)' : 'Investments', cls: 'l-inv', sw: 'sw-inv', pts: [SF.mode === 'rec' && Mo.rec ? Mo.inv0 + Mo.rec.L : Mo.inv0, ...rows.map(r => r.inv)] }];
    if (SF.mode === 'rec' && Mo.rec) lines2.push({ label: 'Investments (current plan)', cls: 'l-inv2', sw: 'sw-dot', pts: [Mo.inv0, ...Mo.plan.map(r => r.inv)] });
    const lg2 = $('sfLegend2'); lg2.textContent = ''; for (const l of lines2) { const s = document.createElement('span'); const i = document.createElement('i'); i.className = 'sw ' + l.sw; s.append(i, l.label); lg2.append(s); }
    if (none) { [$('sfChart1'), $('sfChart2')].forEach(c => [...c.querySelectorAll('svg')].forEach(n => n.remove())); }
    else { sfChart($('sfChart1'), $('sfTip1'), rows, lines1, labels); sfChart($('sfChart2'), $('sfTip2'), rows, lines2, labels); }
    if (rebuild || !$('sfEvents').querySelector('.sf-ev')) renderSfEvents();
    // table
    const tbl = $('sfTable'); tbl.textContent = '';
    const hr = document.createElement('tr'); ['Month', 'Savings', 'Bonus', 'To investments', 'One-offs', 'Interest', 'Emergency fund', 'Target', 'Cover', 'Set aside'].forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.append(th); });
    const th = document.createElement('thead'); th.append(hr); tbl.append(th);
    const tb = document.createElement('tbody');
    if (!none) for (const r of rows) {
      const tr = document.createElement('tr'); if (r.ev || r.bonus) tr.className = 'sf-ev-row';
      const cells = [ymLabel(r.ym), (r.sav < 0 ? '−' : '+') + fmtShort(Math.abs(r.sav)) + (r.over ? '*' : ''), r.bonus ? '+' + fmtShort(r.bonus) : '—', r.invest > 0.5 ? '−' + fmtShort(r.invest) : '—', r.ev ? (r.ev > 0 ? '+' : '−') + fmtShort(Math.abs(r.ev)) : '—', '+' + fmtShort(r.interest), fmtShort(r.cash), fmtShort(r.target), r.cover === null ? '—' : fmtMonths(r.cover) + ' mo', r.setA > 0.5 ? fmtShort(r.setA) : '—'];
      cells.forEach((t, k) => { const td = document.createElement('td'); td.textContent = t; if (k === 4 && r.evNames.length) td.title = r.evNames.join(', '); if (k === 6 && r.cash < 0) td.className = 'neg'; else if ((k === 6 || k === 8) && r.cash < r.target) td.className = 'low'; tr.append(td); });
      tb.append(tr);
    }
    tbl.append(tb);
    $('sfNote').textContent = `Regular savings is what’s left each month after spending and bills (* = a month you edited). The target is ${Mo.months} months of ${spLabel} (${fmt(Mo.ess)}/month from your Monthly living expenses list), growing with ${P.infl}% inflation. The emergency fund is your emergency-fund holdings${Mo.asidesT > 0.5 ? ` minus cash set aside for goals (${fmt(Mo.asidesT)} now; a set-aside is released when a one-off is paid from it)` : ''}; cash earns ${Mo.cashRate.toFixed(1)}%/yr. ` +
      `Automatic investments (${fmt(Mo.fromPay)}/month, from each holding’s monthly contribution) come out of your savings${Mo.payroll > 0.5 ? `; ${fmt(Mo.payroll)}/month into retirement accounts is treated as a payroll deduction${SF.retTake ? '' : ' and isn’t taken from savings'}` : ''}. ` +
      `Investments start at ${fmt(Mo.inv0)} and grow at ${Mo.invRet.toFixed(1)}%/yr. Everything here is saved in this browser.`;
  }
  function renderSfEvents() {
    const box = $('sfEvents');
    box.textContent = '';
    if (!SF.events.length) { const e = document.createElement('div'); e.className = 'mv-empty'; e.textContent = 'Add big one-off spends or windfalls in the next two years: a tax bill, a house deposit, school fees, a car, an inheritance.'; box.append(e); return; }
    SF.events.forEach((ev, k) => {
      const row = document.createElement('div'); row.className = 'sf-ev';
      const mk = (cls, type, val, label, on, ph) => { const i = document.createElement('input'); i.className = cls; i.type = type; i.value = val ?? ''; if (ph) i.placeholder = ph; i.setAttribute('aria-label', label); i.onchange = () => { on(i.value); savePrefs(); renderSf(false); }; return i; };
      const name = mk('sf-name', 'text', ev.name, `One-off ${k + 1} name`, v => { ev.name = v.slice(0, 60); }, 'e.g. Tax bill'); name.maxLength = 60;
      const month = mk('sf-month', 'month', ev.month, `One-off ${k + 1} month`, v => { ev.month = /^\d{4}-\d{2}$/.test(v) ? v : ''; });
      const dir = document.createElement('select'); dir.className = 'sf-dir'; dir.setAttribute('aria-label', `One-off ${k + 1} in or out`);
      for (const [v, t] of [['out', 'Out'], ['in', 'In']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; dir.append(o); }
      dir.value = ev.dir === 'in' ? 'in' : 'out'; dir.onchange = () => { ev.dir = dir.value; savePrefs(); renderSf(); };
      const amt = mk('sf-amt', 'number', ev.amount, `One-off ${k + 1} amount`, v => { ev.amount = Math.max(0, Number(v) || 0); }, 'Amount'); amt.min = '0';
      const fund = document.createElement('select'); fund.className = 'sf-fund'; fund.setAttribute('aria-label', `One-off ${k + 1} paid from`);
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = ev.dir === 'in' ? 'Into cash' : 'Paid from cash'; fund.append(o0);
      if (ev.dir !== 'in') for (const a of asides) { const o = document.createElement('option'); o.value = a.id; o.textContent = `Paid from set-aside: ${a.name}`; fund.append(o); }
      fund.value = [...fund.options].some(o => o.value === ev.fund) ? ev.fund : ''; fund.onchange = () => { ev.fund = fund.value; savePrefs(); renderSf(false); };
      const x = document.createElement('button'); x.type = 'button'; x.className = 'icon-btn sf-x'; x.textContent = '×'; x.setAttribute('aria-label', `Remove one-off ${k + 1}`);
      x.onclick = () => { SF.events.splice(k, 1); savePrefs(); renderSf(); };
      row.append(name, month, dir, amt, fund, x); box.append(row);
    });
  }
  $('sfAdd').onclick = () => { SF.events.push({ name: '', month: ymAdd(3), dir: 'out', amount: 0, fund: '' }); savePrefs(); renderSf(); const ins = $('sfEvents').querySelectorAll('.sf-name'); if (ins.length) ins[ins.length - 1].focus(); };
  $('sfReset').onclick = () => { for (const k of Object.keys(SF.over)) delete SF.over[k]; savePrefs(); renderSf(); };
  for (const [id, k, lo, hi] of [['sfSavings', 'savings', -1e7, 1e8], ['sfRaise', 'raise', -20, 50], ['sfMonths', 'months', 0, 36]])
    $(id).onchange = () => { const v = $(id).value; SF[k] = v === '' ? null : clampNum(v, lo, hi, null); savePrefs(); renderSf(); };
  $('sfBasis').onchange = () => { SF.basis = $('sfBasis').value; savePrefs(); renderSf(false); };
  $('sfRetTake').onchange = () => { SF.retTake = $('sfRetTake').checked; savePrefs(); renderSf(false); };
  window.addEventListener('resize', () => { if (!$('sfView').hidden) { clearTimeout(scResizeT); scResizeT = setTimeout(() => renderSf(false), 150); } });

  // ---------- Start ----------
  if (mode === 'local') { fx = localFx(); loadScenarios(); }
  if (!window.crypto || !crypto.subtle) showBanner('This browser lacks the secure encryption features Holdings needs for Airtable. Make sure you’re on the https:// address.');
  render();
  if (mode === 'locked') openUnlock();
})();
