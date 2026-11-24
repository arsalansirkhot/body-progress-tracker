/**
 * Body Progress Tracker JSON API (standalone Apps Script).
 *
 * Setup: see README.md, "Apps Script setup".
 * Script Properties:
 *   SHEET_ID   - the spreadsheet ID (required)
 *   API_TOKEN  - any long random string; the app sends it with every request (required)
 *   SHEET_NAME - tab name (optional, defaults to the first tab)
 *
 * Sheet layout (the "Progress Card" layout):
 *   Column A holds labels. The "Date" row holds one date per column (B, C, D, ...).
 *   Every other labelled row is a measurement (Weight, Chest, Waist U/L, ...).
 *   Rows whose label starts with an emoji are shown in the app as notes.
 *   Rows that contain a link (e.g. "Sample video") are shown in the app as links.
 *   Measurement rows that contain formulas are read-only: the app never overwrites them.
 */

// ---------- HTTP entry points ----------

function doGet(e) {
  return handle_(e.parameter || {});
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Invalid JSON' });
  }
  return handle_(body);
}

function handle_(req) {
  try {
    checkToken_(req.token);
    switch (req.action) {
      case 'ping': return json_({ ok: true, data: 'pong' });
      case 'data': return json_({ ok: true, data: getData_() });
      case 'add': return json_({ ok: true, data: withLock_(function () { return addEntry_(parseData_(req.data)); }) });
      case 'update': return json_({ ok: true, data: withLock_(function () { return updateEntry_(parseData_(req.data)); }) });
      case 'delete': return json_({ ok: true, data: withLock_(function () { return deleteEntry_(req.date); }) });
      case 'export': return exportCsv_();
      default: return json_({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------- Helpers ----------

function props_() { return PropertiesService.getScriptProperties(); }

function checkToken_(token) {
  var expected = props_().getProperty('API_TOKEN');
  if (!expected) throw new Error('API_TOKEN is not set in Script Properties');
  if (token !== expected) throw new Error('Unauthorized');
}

function ss_() {
  var id = props_().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

function sheet_() {
  var ss = ss_();
  var name = props_().getProperty('SHEET_NAME');
  var sh = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sh) throw new Error('Sheet not found: ' + name);
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseData_(d) {
  return typeof d === 'string' ? JSON.parse(d) : (d || {});
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function pad_(n) { return ('0' + n).slice(-2); }

var MONTHS_ = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Turns a date cell (real date or text like "12-Nov", "12 Nov 2026", "12/11/2026") into yyyy-MM-dd, or ''. */
function toIso_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/MM/yyyy
  if (m) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  m = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3})[A-Za-z]*[\s\-\/,]*(\d{4})?$/); // 12-Nov, 12 Nov 2026
  if (m && MONTHS_[m[2].toLowerCase()] !== undefined) {
    var mon = MONTHS_[m[2].toLowerCase()];
    var year = m[3] ? Number(m[3]) : guessYear_(mon, Number(m[1]), tz);
    return year + '-' + pad_(mon + 1) + '-' + pad_(m[1]);
  }
  return '';
}

// Text dates without a year: assume the most recent such date that is not in the future.
function guessYear_(mon, day, tz) {
  var now = new Date();
  var y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  var todayIso = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var iso = y + '-' + pad_(mon + 1) + '-' + pad_(day);
  return iso > todayIso ? y - 1 : y;
}

function cellOut_(v, display) {
  if (typeof v === 'number') return v;
  return String(display == null ? '' : display).trim();
}

function cellIn_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function hasLink_(row, display) {
  return row.some(function (c, i) { return /https?:\/\//i.test(String(display[i] || c || '')); });
}

/** Reads the whole sheet and works out which rows are dates, measurements, notes and links. */
function readGrid_() {
  var sh = sheet_();
  var tz = sh.getParent().getSpreadsheetTimeZone();
  var lastRow = Math.max(sh.getLastRow(), 1);
  var lastCol = Math.max(sh.getLastColumn(), 2);
  var range = sh.getRange(1, 1, lastRow, lastCol);
  var values = range.getValues();
  var display = range.getDisplayValues();
  var formulas = range.getFormulas();

  var dateRow = -1;
  for (var r = 0; r < lastRow; r++) {
    if (String(values[r][0]).trim().toLowerCase() === 'date') { dateRow = r; break; }
  }
  if (dateRow < 0) throw new Error('No "Date" row found in column A');

  var metrics = [], notes = [], links = [];
  for (r = 0; r < lastRow; r++) {
    if (r === dateRow) continue;
    var label = String(values[r][0]).trim();
    if (!label) continue;
    if (hasLink_(values[r], display[r])) {
      var url = '';
      display[r].slice(1).some(function (c) { var mm = String(c).match(/https?:\/\/\S+/); if (mm) url = mm[0]; return !!mm; });
      if (url) links.push({ label: label, url: url });
      continue;
    }
    if (!/^[A-Za-z0-9]/.test(label)) { notes.push(label); continue; }
    var readOnly = formulas[r].slice(1).some(function (f) { return !!f; });
    metrics.push({
      key: label,
      label: label,
      row: r + 1,
      kind: /\bU\s*\/\s*L\b/i.test(label) ? 'pair' : 'number',
      readOnly: readOnly
    });
  }

  var entries = [];
  for (var c = 1; c < lastCol; c++) {
    var iso = toIso_(values[dateRow][c], tz);
    if (!iso) continue;
    var vals = {};
    metrics.forEach(function (m) {
      var out = cellOut_(values[m.row - 1][c], display[m.row - 1][c]);
      if (out !== '') vals[m.key] = out;
    });
    entries.push({ date: iso, col: c + 1, values: vals });
  }

  return {
    sh: sh, tz: tz, lastRow: lastRow, lastCol: lastCol, values: values, display: display,
    formulas: formulas, dateRow: dateRow + 1, metrics: metrics, notes: notes, links: links, entries: entries
  };
}

function findEntry_(g, iso) {
  for (var i = 0; i < g.entries.length; i++) if (g.entries[i].date === iso) return g.entries[i];
  return null;
}

function writeValues_(g, col, values, clearMissing) {
  values = values || {};
  g.metrics.forEach(function (m) {
    if (m.readOnly) return;
    var has = Object.prototype.hasOwnProperty.call(values, m.key);
    var v = has ? cellIn_(values[m.key]) : '';
    if (v === '' && !clearMissing) return;
    var cell = g.sh.getRange(m.row, col);
    if (cell.getFormula()) return;
    cell.setValue(v);
  });
}

function validateDate_(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) throw new Error('Date must be yyyy-MM-dd');
}

function dateCellValue_(g, iso, refCol) {
  var p = iso.split('-').map(Number);
  var ref = refCol ? g.values[g.dateRow - 1][refCol - 1] : null;
  if (ref == null || ref === '' || ref instanceof Date) return new Date(p[0], p[1] - 1, p[2]);
  // Sheet stores dates as text: keep the same style ("12-Nov").
  return Utilities.formatDate(new Date(p[0], p[1] - 1, p[2]), g.tz, 'd-MMM');
}

// ---------- Actions ----------

function getData_() {
  var g = readGrid_();
  return {
    metrics: g.metrics.map(function (m) { return { key: m.key, label: m.label, kind: m.kind, readOnly: m.readOnly }; }),
    entries: g.entries.map(function (e) { return { date: e.date, values: e.values }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }),
    notes: g.notes,
    links: g.links
  };
}

/**
 * Adds measurements for a date. If the date already has a column, the new values are merged
 * into it (blank fields leave existing values alone), so retries from the offline queue are safe.
 * New dates get a new column in date order, formatted like its neighbour.
 */
function addEntry_(d) {
  validateDate_(d.date);
  var g = readGrid_();
  var existing = findEntry_(g, d.date);
  if (existing) {
    writeValues_(g, existing.col, d.values, false);
    return { date: d.date, merged: true };
  }

  var before = null, after = null;
  g.entries.forEach(function (e) {
    if (e.date < d.date && (!before || e.col > before.col)) before = e;
    if (e.date > d.date && (!after || e.col < after.col)) after = e;
  });

  var col, ref;
  if (before) {
    g.sh.insertColumnAfter(before.col);
    col = before.col + 1;
    ref = before.col;
  } else if (after) {
    g.sh.insertColumnBefore(after.col);
    col = after.col;
    ref = after.col + 1; // the old column moved right
  } else {
    col = 2;
    ref = null;
  }

  var sh = g.sh;
  if (ref) {
    // Same look as the neighbouring column, and carry over any formula rows (e.g. ratios).
    sh.getRange(1, ref, g.lastRow, 1).copyTo(sh.getRange(1, col, g.lastRow, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    g.metrics.forEach(function (m) {
      if (!m.readOnly) return;
      var src = sh.getRange(m.row, ref);
      if (src.getFormula()) src.copyTo(sh.getRange(m.row, col));
    });
  }
  var refDateCol = before ? before.col : (after ? after.col : null); // value lookup uses the pre-insert grid
  sh.getRange(g.dateRow, col).setValue(dateCellValue_(g, d.date, refDateCol));
  writeValues_(g, col, d.values, false);
  return { date: d.date, created: true };
}

/** Replaces the values for a date. Blank fields are cleared. Can also move the entry to a new date. */
function updateEntry_(d) {
  validateDate_(d.date);
  var g = readGrid_();
  var e = findEntry_(g, d.date);
  if (!e) throw new Error('No entry for ' + d.date);
  if (d.newDate && d.newDate !== d.date) {
    validateDate_(d.newDate);
    if (findEntry_(g, d.newDate)) throw new Error('There is already an entry for ' + d.newDate);
    g.sh.getRange(g.dateRow, e.col).setValue(dateCellValue_(g, d.newDate, e.col));
  }
  writeValues_(g, e.col, d.values, true);
  return { date: d.newDate || d.date };
}

/**
 * Deletes a date's column. If that column also holds something else (like the sample video link),
 * only the date and measurements are cleared so nothing else is lost.
 */
function deleteEntry_(iso) {
  validateDate_(iso);
  var g = readGrid_();
  var e = findEntry_(g, iso);
  if (!e) throw new Error('No entry for ' + iso);
  var metricRows = {};
  g.metrics.forEach(function (m) { metricRows[m.row] = m; });
  var hasOther = false;
  for (var r = 1; r <= g.lastRow; r++) {
    if (r === g.dateRow || metricRows[r]) continue;
    if (String(g.values[r - 1][e.col - 1]).trim() !== '' || g.formulas[r - 1][e.col - 1]) { hasOther = true; break; }
  }
  if (!hasOther) {
    g.sh.deleteColumn(e.col);
  } else {
    g.sh.getRange(g.dateRow, e.col).clearContent();
    writeValues_(g, e.col, {}, true);
  }
  return { date: iso };
}

/** CSV download: one row per date, one column per measurement. */
function exportCsv_() {
  var data = getData_();
  function cell(v) {
    v = String(v == null ? '' : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  var keys = data.metrics.map(function (m) { return m.key; });
  var lines = [['Date'].concat(keys).map(cell).join(',')];
  data.entries.forEach(function (e) {
    lines.push([e.date].concat(keys.map(function (k) { return e.values[k]; })).map(cell).join(','));
  });
  return ContentService.createTextOutput(lines.join('\r\n'))
    .setMimeType(ContentService.MimeType.CSV)
    .downloadAsFile('body-progress.csv');
}

/** Run once from the editor to check setup. Logs what the app will see. */
function testSetup() {
  var d = getData_();
  Logger.log('Measurements: ' + d.metrics.map(function (m) { return m.label + (m.readOnly ? ' (formula)' : ''); }).join(', '));
  Logger.log('Dates: ' + d.entries.map(function (e) { return e.date; }).join(', '));
  Logger.log('Notes: ' + d.notes.length + ', links: ' + d.links.length);
}
