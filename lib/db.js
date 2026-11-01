// Read-only access to OmniRoute's storage.sqlite. Never opens the database writable.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// node:sqlite prints an ExperimentalWarning on Node 22/24. A 'warning' listener does not
// silence Node's own stderr print, so the manifest and README run
// `node --disable-warning=ExperimentalWarning`; nothing to do here.
const { DatabaseSync } = require('node:sqlite');

// ~/.omniroute by default; honour OmniRoute's own env names. From inside WSL the state still
// lives in the Windows profile, so look there before giving up.
function defaultDataDir() {
  if (process.env.OMNIROUTE_DATA_DIR) return process.env.OMNIROUTE_DATA_DIR;
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const home = path.join(os.homedir(), '.omniroute');
  if (fs.existsSync(home)) return home;
  if (process.platform === 'linux' && fs.existsSync('/mnt/c/Users')) {
    for (const user of fs.readdirSync('/mnt/c/Users')) {
      const candidate = path.join('/mnt/c/Users', user, '.omniroute');
      if (fs.existsSync(path.join(candidate, 'storage.sqlite'))) return candidate;
    }
  }
  return home;
}

function openReadOnly(dbPath) {
  const file = dbPath || path.join(defaultDataDir(), 'storage.sqlite');
  if (!fs.existsSync(file)) throw new Error(`OmniRoute database not found: ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

// name -> { strategy, models: [{ id, model, providerId, connectionId? }] }
function loadCombos(db) {
  const combos = new Map();
  for (const row of db.prepare('SELECT name, data FROM combos').all()) {
    try {
      const data = JSON.parse(row.data);
      combos.set(row.name, {
        strategy: data.strategy || 'priority',
        models: Array.isArray(data.models) ? data.models : [],
      });
    } catch {
      combos.set(row.name, { strategy: '?', models: [] });
    }
  }
  return combos;
}

// Combo-routed rows since an ISO timestamp, oldest first. Connection tests are OmniRoute's own
// health pings and never go through a combo step the operator chose.
function loadRows(db, { sinceIso, combo = null, tag = null } = {}) {
  const where = ["combo_name IS NOT NULL", "timestamp >= ?", "model IS NOT 'connection-test'"];
  const params = [sinceIso];
  if (combo) { where.push('combo_name = ?'); params.push(combo); }
  if (tag) { where.push('session_tag = ?'); params.push(tag); }
  const sql = `SELECT timestamp, duration, combo_name, combo_step_id, provider, model, requested_model,
                      status, error_summary, session_tag, api_key_name
                 FROM call_logs WHERE ${where.join(' AND ')} ORDER BY timestamp`;
  return db.prepare(sql).all(...params);
}

const ROW_COLUMNS = `rowid, timestamp, duration, combo_name, combo_step_id, provider, model, requested_model,
                     status, error_summary, session_tag, api_key_name`;

// Combo-routed rows the watcher has not seen yet, in insertion order. `rowid` is SQLite's own
// row number, which only grows for an append-only log; the TEXT `id` column is a UUID.
function loadRowsAfter(db, rowid, { limit = 5000 } = {}) {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM call_logs
               WHERE rowid > ? AND combo_name IS NOT NULL AND model IS NOT 'connection-test'
               ORDER BY rowid LIMIT ?`)
    .all(rowid, limit);
}

// Combo-routed rows with fromRowid < rowid <= toRowid: what OmniRoute logged while no watcher
// was looking (the gap a restarted watcher reports). By rowid, not time: exact, whatever the
// clock or the timestamp format did.
function loadRowsInRange(db, fromRowid, toRowid) {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM call_logs
               WHERE rowid > ? AND rowid <= ? AND combo_name IS NOT NULL AND model IS NOT 'connection-test'`)
    .all(fromRowid, toRowid);
}

// The newest and oldest rowids, 0 for an empty table. call_logs has a TEXT primary key, so its
// rowid is SQLite's implicit one, with no AUTOINCREMENT: emptying the table (OmniRoute's "Purge
// call logs") makes the next row rowid 1 again. Retention deletes the oldest rows.
function maxRowid(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS r FROM call_logs').get().r);
}
function minRowid(db) {
  return Number(db.prepare('SELECT COALESCE(MIN(rowid), 0) AS r FROM call_logs').get().r);
}

// The TEXT id of the row at `rowid`, or null: tells a row apart from a different one that got
// the same rowid after a purge.
function idAt(db, rowid) {
  const row = db.prepare('SELECT id FROM call_logs WHERE rowid = ?').get(rowid);
  return row && row.id !== null && row.id !== undefined ? String(row.id) : null;
}

// The rowid to start a fresh watcher from: whatever rows are `sinceMs` old or newer get replayed
// so a pane that was already mid-session gets its state back, nothing older. With no row that
// recent, nothing at all (not the newest row, however old it is).
function cursorBefore(db, sinceMs, nowMs = Date.now()) {
  const sinceIso = new Date(nowMs - sinceMs).toISOString();
  const row = db.prepare(`SELECT COALESCE((SELECT MIN(rowid) FROM call_logs WHERE timestamp >= ?) - 1,
                                          (SELECT MAX(rowid) FROM call_logs), 0) AS r`).get(sinceIso);
  return Math.max(0, Number(row.r));
}

module.exports = { defaultDataDir, openReadOnly, loadCombos, loadRows, loadRowsAfter, loadRowsInRange, maxRowid, minRowid, idAt, cursorBefore };
