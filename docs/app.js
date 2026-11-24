'use strict';

// ---------- Storage ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }
};

// Shown until the app has talked to the Sheet once; the Sheet's own rows replace this.
const DEFAULT_DATA = {
  metrics: ['Height', 'Weight', 'Chest', 'Neck', 'Shoulder', 'Arm', 'Waist U/L', 'Thigh', 'Hip',
    'Waist to Hip Ratio', 'LBM%', 'Body Fat%'].map(k => ({ key: k, label: k, kind: /U\/L/.test(k) ? 'pair' : 'number', readOnly: false })),
  entries: [],
  notes: [],
  links: []
};

const state = {
  config: store.get('config', { apiUrl: '', token: '' }),
  data: store.get('data', DEFAULT_DATA),
  queue: store.get('queue', []), // adds waiting for signal: [{date, values}]
  view: 'log',
  metric: store.get('metric', ''),
  range: store.get('range', 'all')
};

// ---------- Utils ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseIso(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function niceDate(iso, withYear) {
  if (iso === today()) return 'Today';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (withYear || parseIso(iso).getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return parseIso(iso).toLocaleDateString('en-IN', opts);
}
function shortDate(iso) { return parseIso(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function unit(label) {
  if (/%/.test(label)) return '%';
  if (/ratio/i.test(label)) return '';
  if (/weight|lbm(?!%)|mass/i.test(label)) return 'kg';
  return 'cm';
}
function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
// "73, 76" -> [73, 76]
function pairOf(v) {
  if (v == null || v === '') return [null, null];
  const parts = String(v).split(/[,/;]+/).map(s => num(s));
  return [parts[0] ?? null, parts[1] ?? null];
}
function fmtNum(n) { return n == null ? '' : String(Math.round(n * 100) / 100); }
function fmtVal(m, v) {
  if (v == null || v === '') return '';
  if (m.kind === 'pair') { const [a, b] = pairOf(v); return [a, b].filter(x => x != null).map(fmtNum).join(' / ') + ' ' + unit(m.label); }
  const n = num(v);
  return n == null ? String(v) : `${fmtNum(n)}${unit(m.label) === '%' ? '%' : unit(m.label) ? ' ' + unit(m.label) : ''}`;
}
function delta(d, u) {
  if (d == null || Math.abs(d) < 0.005) return '<span class="delta">±0</span>';
  const s = (d > 0 ? '+' : '−') + fmtNum(Math.abs(d)) + (u === '%' ? '%' : u ? ' ' + u : '');
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${s}</span>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- API ----------
function configured() { return !!(state.config.apiUrl && state.config.token); }

async function api(action, payload = {}) {
  if (!configured()) throw new Error('Not set up');
  const { apiUrl, token } = state.config;
  let res;
  if (action === 'data' || action === 'ping') {
    const qs = new URLSearchParams({ action, token, ...payload });
    res = await fetch(`${apiUrl}?${qs}`, { redirect: 'follow' });
  } else {
    // text/plain avoids a CORS preflight, which Apps Script does not support.
    res = await fetch(apiUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token, ...payload })
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

const isConfigError = e => e.message === 'Unauthorized' || /not set|not found|No "Date" row|Unknown action/i.test(e.message);

// ---------- Data ----------
function metrics() { return state.data.metrics || []; }
function editable() { return metrics().filter(m => !m.readOnly); }

/** Sheet entries with queued (offline) adds merged on top, oldest first. */
function allEntries() {
  const map = new Map(state.data.entries.map(e => [e.date, { ...e, values: { ...e.values } }]));
  state.queue.forEach(q => {
    const e = map.get(q.date) || { date: q.date, values: {} };
    Object.entries(q.values).forEach(([k, v]) => { if (v !== '') e.values[k] = v; });
    e.pending = true;
    map.set(q.date, e);
  });
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

function lastValue(key, beforeDate) {
  const list = allEntries();
  for (let i = list.length - 1; i >= 0; i--) {
    if (beforeDate && list[i].date >= beforeDate) continue;
    const v = list[i].values[key];
    if (v != null && v !== '') return { date: list[i].date, value: v };
  }
  return null;
}

async function loadData(quiet = true) {
  if (!configured()) { renderAll(); return; }
  try {
    const data = await api('data');
    state.data = data;
    store.set('data', data);
    renderAll();
  } catch (e) {
    if (!quiet) toast(`Could not load: ${e.message}`);
  }
}

// ---------- Offline queue ----------
function saveQueue() { store.set('queue', state.queue); updateSyncBadge(); }
function updateSyncBadge() {
  const el = $('#sync');
  if (state.queue.length) { el.hidden = false; el.textContent = `${state.queue.length} to sync`; }
  else el.hidden = true;
}

let flushing = false;
async function flushQueue() {
  if (flushing || !state.queue.length || !configured()) return;
  flushing = true;
  try {
    while (state.queue.length) {
      // Adds merge into the date's column, so a retry after a dropped reply is harmless.
      await api('add', { data: state.queue[0] });
      state.queue.shift();
      saveQueue();
    }
    toast('Synced');
    await loadData();
  } catch { /* still offline; try later */ } finally { flushing = false; }
}

// ---------- Form ----------
function fieldHtml(m, value, placeholder, big) {
  const u = unit(m.label);
  if (m.kind === 'pair') {
    const [a, b] = pairOf(value);
    const [pa, pb] = pairOf(placeholder);
    return `<div class="field pair${big ? ' big' : ''}"><span class="flabel">${esc(m.label)} <small>${u}</small></span>
      <div class="row">
        <input name="${esc(m.key)}::0" type="number" inputmode="decimal" step="any" placeholder="${pa == null ? 'Upper' : 'U ' + fmtNum(pa)}" value="${a == null ? '' : a}">
        <input name="${esc(m.key)}::1" type="number" inputmode="decimal" step="any" placeholder="${pb == null ? 'Lower' : 'L ' + fmtNum(pb)}" value="${b == null ? '' : b}">
      </div></div>`;
  }
  const n = num(value);
  const p = num(placeholder);
  return `<label class="field${big ? ' big' : ''}"><span class="flabel">${esc(m.label)} <small>${u}</small></span>
    <input name="${esc(m.key)}" type="number" inputmode="decimal" step="any" placeholder="${p == null ? '' : fmtNum(p)}" value="${n == null ? (value && typeof value === 'string' ? esc(value) : '') : n}"></label>`;
}

/** entry: existing entry to edit (dialog), or null for the Log form. */
function formHtml(entry, date) {
  const isEdit = !!entry;
  const list = editable();
  const main = list.find(m => /weight/i.test(m.key)) || list[0];
  const rest = list.filter(m => m !== main);
  const existing = !isEdit ? allEntries().find(e => e.date === date) : null;
  const val = m => isEdit ? entry.values[m.key] : '';
  const ph = m => {
    if (isEdit) return '';
    if (existing && existing.values[m.key] != null) return existing.values[m.key];
    const last = lastValue(m.key, date);
    return last ? last.value : '';
  };
  return `
    ${isEdit ? `<h2 style="margin:0">Edit ${esc(niceDate(entry.date, true))}</h2>` : ''}
    <label class="field"><span class="flabel">Date</span><input name="__date" type="date" value="${esc(isEdit ? entry.date : date)}" max="${today()}" required></label>
    ${!isEdit && existing ? `<p class="hint">You already logged ${esc(niceDate(date))}. Filled fields are added to it; blank ones stay as they are.</p>` : ''}
    ${!isEdit ? '<p class="hint">Fill in only what you measured today. Grey numbers are your last values.</p>' : ''}
    ${main ? fieldHtml(main, val(main), ph(main), true) : ''}
    <div class="grid">${rest.map(m => fieldHtml(m, val(m), ph(m), false)).join('')}</div>
    <button class="primary" type="submit">${isEdit ? 'Save changes' : 'Save'}</button>
    ${isEdit ? `<div class="row"><button type="button" class="secondary" data-act="cancel">Cancel</button>
      <button type="button" class="danger" data-act="delete">Delete</button></div>` : ''}
  `;
}

function readForm(form) {
  const values = {};
  editable().forEach(m => {
    if (m.kind === 'pair') {
      const a = form.elements[`${m.key}::0`]?.value.trim() || '';
      const b = form.elements[`${m.key}::1`]?.value.trim() || '';
      values[m.key] = a || b ? [a, b].filter(Boolean).join(', ') : '';
    } else {
      values[m.key] = form.elements[m.key]?.value.trim() || '';
    }
  });
  return { date: form.elements.__date.value, values };
}

function renderLogForm(date) {
  const form = $('#logForm');
  const d = date || form.elements.__date?.value || today();
  form.innerHTML = formHtml(null, d);
}

function logFormDirty() {
  const form = $('#logForm');
  return $$('input[type=number]', form).some(i => i.value);
}

async function submitLog(e) {
  e.preventDefault();
  const form = e.target;
  const data = readForm(form);
  if (!Object.values(data.values).some(v => v)) { toast('Enter at least one measurement'); return; }
  if (!configured()) { toast('Set up the app first'); showView('settings'); return; }
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    await api('add', { data });
    toast('Saved');
    renderLogForm(data.date);
    await loadData();
  } catch (err) {
    if (isConfigError(err)) { toast(err.message); btn.disabled = false; return; }
    state.queue.push(data);
    saveQueue();
    toast('Offline: saved, will sync later');
    renderAll();
  }
  btn.disabled = false;
}

// ---------- Edit dialog ----------
let editing = null;
function openEdit(date) {
  const entry = allEntries().find(e => e.date === date);
  if (!entry || entry.pending) return;
  editing = entry;
  $('#editForm').innerHTML = formHtml(entry);
  $('#editDialog').showModal();
}

async function submitEdit(e) {
  e.preventDefault();
  const form = e.target;
  const { date, values } = readForm(form);
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    await api('update', { data: { date: editing.date, newDate: date, values } });
    $('#editDialog').close();
    toast('Saved');
    await loadData();
  } catch (err) {
    toast(`Not saved: ${err.message}`);
  } finally { btn.disabled = false; }
}

async function deleteEditing() {
  if (!editing) return;
  const btn = $('[data-act=delete]', $('#editForm'));
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to delete'; return; }
  btn.disabled = true;
  try {
    await api('delete', { date: editing.date });
    $('#editDialog').close();
    toast('Deleted');
    await loadData();
  } catch (err) {
    toast(`Not deleted: ${err.message}`);
    btn.disabled = false;
  }
}

// ---------- History ----------
function renderHistory() {
  const list = allEntries();
  const el = $('#historyList');
  $('#histCount').textContent = list.length ? `${list.length} check-ins` : '';
  if (!list.length) { el.innerHTML = `<div class="empty">${configured() ? 'No measurements yet' : 'Open Settings (gear icon) to connect your Sheet'}</div>`; return; }
  const ms = metrics();
  const main = ms.find(m => /weight/i.test(m.key));
  let html = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    let head = '';
    if (main && e.values[main.key] != null) {
      const prev = lastValue(main.key, e.date);
      const d = prev ? num(e.values[main.key]) - num(prev.value) : null;
      head = `<div class="amt">${esc(fmtVal(main, e.values[main.key]))} ${prev ? delta(d, unit(main.label)) : ''}</div>`;
    }
    const others = ms.filter(m => m !== main && e.values[m.key] != null && e.values[m.key] !== '');
    html += `<button class="tx${e.pending ? ' pending' : ''}" data-date="${esc(e.date)}" ${e.pending ? 'disabled' : ''}>
      <div class="tx-top"><div class="sum">${esc(niceDate(e.date))}${e.pending ? ' <small class="hint">waiting to sync</small>' : ''}</div>${head}</div>
      ${others.length ? `<div class="tags">${others.map(m => `<span>${esc(m.label)} <b>${esc(fmtVal(m, e.values[m.key]))}</b></span>`).join('')}</div>` : ''}
    </button>`;
  }
  el.innerHTML = html;
}

// ---------- Progress ----------
const RANGES = [['1m', '1M', 31], ['3m', '3M', 92], ['6m', '6M', 183], ['1y', '1Y', 366], ['all', 'All', 0]];

function series(m, list) {
  // Returns [{date, a, b}] where b is only used for U/L pairs.
  return list.map(e => {
    const v = e.values[m.key];
    if (v == null || v === '') return null;
    if (m.kind === 'pair') { const [a, b] = pairOf(v); return a == null && b == null ? null : { date: e.date, a, b }; }
    const n = num(v);
    return n == null ? null : { date: e.date, a: n, b: null };
  }).filter(Boolean);
}

function chartSvg(points, m) {
  const W = 340, H = 190, L = 36, R = 10, T = 12, B = 26;
  const vals = points.flatMap(p => [p.a, p.b]).filter(v => v != null);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 0.5) { min -= 0.5; max += 0.5; }
  const padV = (max - min) * 0.12; min -= padV; max += padV;
  const t0 = parseIso(points[0].date).getTime();
  const t1 = parseIso(points[points.length - 1].date).getTime();
  const x = d => points.length === 1 ? (L + W - R) / 2 : L + (parseIso(d).getTime() - t0) / (t1 - t0) * (W - L - R);
  const y = v => T + (max - v) / (max - min) * (H - T - B);
  const line = key => {
    const pts = points.filter(p => p[key] != null);
    if (!pts.length) return '';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const cls = key === 'b' ? 'line2' : 'line1';
    return `<path class="${cls}" d="${d}"/>` + pts.map(p => `<circle class="${cls}" cx="${x(p.date).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="3"><title>${shortDate(p.date)}: ${fmtNum(p[key])}</title></circle>`).join('');
  };
  const ticks = [max - padV, (max + min) / 2, min + padV];
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(m.label)} over time">
    ${ticks.map(v => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtNum(Math.round(v * 10) / 10)}</text>`).join('')}
    <text class="axis" x="${L}" y="${H - 6}">${shortDate(points[0].date)}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${shortDate(points[points.length - 1].date)}</text>
    ${line('a')}${m.kind === 'pair' ? line('b') : ''}
  </svg>`;
}

function renderProgress() {
  const ms = metrics();
  const list = allEntries();
  const withData = ms.filter(m => series(m, list).length);
  if (!withData.find(m => m.key === state.metric)) {
    state.metric = (withData.find(m => /weight/i.test(m.key)) || withData[0] || ms[0] || {}).key || '';
  }
  $('#metricChips').innerHTML = ms.map(m =>
    `<button type="button" class="chip${m.key === state.metric ? ' on' : ''}${withData.includes(m) ? '' : ' dim'}" data-metric="${esc(m.key)}">${esc(m.label)}</button>`).join('');
  $('#rangeChips').innerHTML = RANGES.map(([k, l]) => `<button type="button" class="chip${k === state.range ? ' on' : ''}" data-range="${k}">${l}</button>`).join('');

  const m = ms.find(x => x.key === state.metric);
  const days = (RANGES.find(r => r[0] === state.range) || RANGES[4])[2];
  const from = days ? new Date(Date.now() - days * 864e5) : null;
  const inRange = from ? list.filter(e => parseIso(e.date) >= from) : list;
  const pts = m ? series(m, inRange) : [];
  const u = m ? unit(m.label) : '';

  if (!m || !pts.length) {
    $('#chartCard').innerHTML = `<div class="empty">${m ? `No ${esc(m.label)} entries in this period` : 'No measurements yet'}</div>`;
  } else {
    const first = pts[0], last = pts[pts.length - 1];
    const aVals = pts.map(p => p.a).filter(v => v != null);
    const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
    let stats;
    if (m.kind === 'pair') {
      const dA = last.a != null && first.a != null ? last.a - first.a : null;
      const dB = last.b != null && first.b != null ? last.b - first.b : null;
      stats = stat('Latest', esc(fmtVal(m, [last.a, last.b].join(', ')))) + stat('Upper', delta(dA, u)) + stat('Lower', delta(dB, u));
    } else {
      stats = stat('Latest', esc(fmtVal(m, last.a))) + stat(`Since ${shortDate(first.date)}`, delta(last.a - first.a, u)) +
        stat('Range', `${fmtNum(Math.min(...aVals))}–${fmtNum(Math.max(...aVals))}`);
    }
    $('#chartCard').innerHTML = `<h2>${esc(m.label)}</h2><div class="stats">${stats}</div>${chartSvg(pts, m)}
      ${m.kind === 'pair' ? '<div class="legend"><span class="k1"></span>Upper <span class="k2"></span>Lower</div>' : ''}
      <p class="hint">${pts.length} entr${pts.length === 1 ? 'y' : 'ies'}</p>`;
  }

  // All measurements: first vs latest in the selected period.
  const rows = ms.map(mm => {
    const s = series(mm, inRange);
    if (!s.length) return '';
    const f = s[0], l = s[s.length - 1];
    let ch;
    if (mm.kind === 'pair') {
      ch = [l.a != null && f.a != null ? delta(l.a - f.a, '') : '', l.b != null && f.b != null ? delta(l.b - f.b, '') : ''].join(' ');
    } else ch = s.length > 1 ? delta(l.a - f.a, unit(mm.label)) : '';
    const fv = mm.kind === 'pair' ? [f.a, f.b].join(', ') : f.a;
    const lv = mm.kind === 'pair' ? [l.a, l.b].join(', ') : l.a;
    return `<tr data-metric="${esc(mm.key)}"><td>${esc(mm.label)}</td><td>${esc(fmtVal(mm, fv))}</td><td><b>${esc(fmtVal(mm, lv))}</b></td><td>${ch}</td></tr>`;
  }).join('');
  $('#tableCard').innerHTML = rows
    ? `<h2>All measurements</h2><table class="tbl"><thead><tr><th></th><th>First</th><th>Latest</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`
    : '';
  $('#tableCard').hidden = !rows;

  const notes = state.data.notes || [];
  $('#notes').innerHTML = notes.map(n => `<p>${esc(n)}</p>`).join('');
}

function renderLinks() {
  const links = state.data.links || [];
  $('#logLinks').innerHTML = links.map(l =>
    `<a class="link-card" href="${esc(l.url)}" target="_blank" rel="noopener">▶ ${esc(l.label)}<small>How to measure</small></a>`).join('');
}

function renderAll() {
  if (!logFormDirty()) renderLogForm();
  renderLinks();
  renderHistory();
  renderProgress();
}

// ---------- Export ----------
const IN_APK = /; wv\)/.test(navigator.userAgent);

function toCsv() {
  const ms = metrics();
  const cell = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const lines = [['Date', ...ms.map(m => m.label)].map(cell).join(',')];
  allEntries().forEach(e => lines.push([e.date, ...ms.map(m => e.values[m.key])].map(cell).join(',')));
  return lines.join('\r\n');
}

function exportCsv() {
  if (!configured()) { toast('Set up the app first'); return; }
  if (IN_APK) {
    // The Android app hands this link to the browser, which downloads the CSV file.
    const qs = new URLSearchParams({ action: 'export', token: state.config.token });
    location.href = `${state.config.apiUrl}?${qs}`;
    toast('Downloading in your browser');
    return;
  }
  const blob = new Blob([toCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'body-progress.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Navigation ----------
const TITLES = { log: 'Log', history: 'History', progress: 'Progress', settings: 'Settings' };
function showView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#title').textContent = TITLES[name];
  if (name === 'settings') {
    const f = $('#settingsForm');
    f.apiUrl.value = state.config.apiUrl;
    f.token.value = state.config.token;
  }
  history.replaceState(null, '', `#${name}`);
}

async function saveSettings(e) {
  e.preventDefault();
  const f = e.target;
  state.config = { apiUrl: f.apiUrl.value.trim(), token: f.token.value.trim() };
  const msg = $('#settingsMsg');
  msg.textContent = 'Testing…';
  try {
    await api('ping');
    store.set('config', state.config);
    msg.textContent = 'Connected.';
    toast('Connected to your Sheet');
    await loadData(false);
    flushQueue();
    showView('log');
  } catch (err) {
    msg.textContent = `Could not connect: ${err.message}`;
  }
}

// ---------- Init ----------
function init() {
  $('#logForm').addEventListener('submit', submitLog);
  $('#logForm').addEventListener('change', e => {
    if (e.target.name === '__date') renderLogForm(e.target.value || today()); // refresh "already logged" hint
  });
  $('#editForm').addEventListener('submit', submitEdit);
  $('#editForm').addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (act === 'cancel') $('#editDialog').close();
    if (act === 'delete') deleteEditing();
  });
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#settingsBtn').addEventListener('click', () => showView(state.view === 'settings' ? 'log' : 'settings'));
  $('#refreshBtn').addEventListener('click', async () => { toast('Refreshing…'); await flushQueue(); await loadData(false); });
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#historyList').addEventListener('click', e => {
    const row = e.target.closest('.tx');
    if (row && !row.disabled) openEdit(row.dataset.date);
  });
  $('#view-progress').addEventListener('click', e => {
    const mt = e.target.closest('[data-metric]');
    const rg = e.target.closest('[data-range]');
    if (mt) { state.metric = mt.dataset.metric; store.set('metric', state.metric); renderProgress(); if (mt.tagName === 'TR') window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (rg) { state.range = rg.dataset.range; store.set('range', state.range); renderProgress(); }
  });
  $('#exportBtn').addEventListener('click', exportCsv);
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { flushQueue(); loadData(); }
  });

  updateSyncBadge();
  const start = location.hash.slice(1);
  showView(!configured() ? 'settings' : (TITLES[start] ? start : 'log'));
  renderAll();
  if (configured()) { loadData(); flushQueue(); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
