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
      note: String((raw && raw.note) || '').trim().slice(0, 300)
    };
  }

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
      category: r.fields.Category, value: r.fields.Value, note: r.fields.Note
    })
  });
  const toFields = d => ({ Name: d.name, Kind: d.kind === 'debt' ? 'Debt' : 'Asset', Category: d.category, Value: d.value, Note: d.note });

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
    session = null; items = []; mode = 'locked';
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

  function renderList(kind) {
    const el = $(kind === 'asset' ? 'assets' : 'debts');
    const list = items.filter(i => i.kind === kind);
    if (!list.length) { el.innerHTML = `<div class="empty">No ${kind}s yet.</div>`; return; }
    el.innerHTML = catsFor(kind, list).map(cat => {
      const g = list.filter(i => i.category === cat);
      if (!g.length) return '';
      return `<div class="group"><div class="group-head"><span>${esc(cat)}</span><span class="amt">${esc(fmt(sum(g)))}</span></div>` +
        g.map(i => `<div class="row"><div><div class="name">${esc(i.name)}</div>${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}</div>` +
          `<div class="amt">${esc(fmt(i.value))}</div><button class="icon-btn" type="button" data-edit="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">✎</button></div>`).join('') +
        `</div>`;
    }).join('');
  }

  function renderMix() {
    const el = $('assetMix'); el.textContent = '';
    const assets = items.filter(i => i.kind === 'asset'), total = sum(assets);
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
    if (locked) {
      ['totAssets', 'totDebts', 'totNet'].forEach(id => { $(id).textContent = '—'; });
      ['assets', 'debts', 'assetMix', 'fName', 'fNote', 'fVal'].forEach(id => { const el = $(id); if ('value' in el && el.tagName === 'INPUT') el.value = ''; else el.textContent = ''; });
      return;
    }
    const a = sum(items.filter(i => i.kind === 'asset')), d = sum(items.filter(i => i.kind === 'debt'));
    $('totAssets').textContent = fmt(a);
    $('totDebts').textContent = fmt(d);
    $('totNet').textContent = fmt(a - d);
    renderMix(); renderList('asset'); renderList('debt');
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
    $('itemDel').hidden = !item;
    $('itemErr').textContent = '';
    $('itemDlg').showModal();
  }
  $('itemForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('fName').value.trim()) { $('itemErr').textContent = 'Please enter a name.'; return; }
    const v = Number($('fVal').value);
    if ($('fVal').value === '' || !Number.isFinite(v) || v < 0) { $('itemErr').textContent = 'Please enter a value of 0 or more.'; return; }
    const d = clean({ name: $('fName').value, kind: editKind, category: $('fCat').value, value: v, note: $('fNote').value });
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
          items = await atLoadAll();
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
        try { items = await atLoadAll(); } catch (x) { session = null; mode = 'locked'; throw x; }
      });
      failedUnlocks = 0; $('unlockDlg').close(); clearSecrets(); lastActivity = Date.now(); $('banner').hidden = true; render();
    } catch (x) { $('unlockErr').textContent = x.message; }
  });

  function disconnect() {
    if (!confirm('Disconnect Airtable on this device? Your data stays in Airtable, and the encrypted token is erased from this browser. You can reconnect anytime with a token.')) return;
    store.del(VAULT_KEY); session = null; mode = 'local'; items = loadLocalItems();
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
