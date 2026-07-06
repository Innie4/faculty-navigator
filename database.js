const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'faculty.db');

let db = null;
let SQL = null;

/**
 * Initialise (or re-open) the SQLite database.
 * sql.js is pure WASM — no native compilation needed.
 * We manually persist to a file after every write operation.
 */
async function getDb() {
  if (!db) {
    SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    initializeSchema();
  }
  return db;
}

/**
 * Persist the in-memory database to disk.
 */
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initializeSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('building_entrance', 'junction', 'gate', 'turning_point'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node_id TEXT NOT NULL REFERENCES nodes(id),
      to_node_id TEXT NOT NULL REFERENCES nodes(id),
      weight REAL NOT NULL,
      surface_type TEXT NOT NULL CHECK(surface_type IN ('paved', 'earthen')),
      UNIQUE(from_node_id, to_node_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pois (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES nodes(id)
    )
  `);
  saveDb();
}

/**
 * Run a query and return all matching rows as objects.
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Run a query and return the first matching row, or undefined.
 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * Execute a write statement and save the DB.
 */
function execute(sql, params = []) {
  db.run(sql, params);
  saveDb();
  return {
    affectedRows: db.getRowsModified(),
    insertId: queryOne('SELECT last_insert_rowid() AS id')?.id
  };
}

/**
 * Execute a write statement WITHIN a transaction (no auto-save).
 * Caller is responsible for saveDb() after COMMIT.
 */
function executeRaw(sql, params = []) {
  db.run(sql, params);
  return {
    affectedRows: db.getRowsModified(),
    insertId: queryOne('SELECT last_insert_rowid() AS id')?.id
  };
}

/**
 * Run a batch of operations inside a single SQLite transaction.
 * If any operation fails, all changes are rolled back and the
 * database file is never touched — the DB stays in its pre-batch
 * state. This prevents partial updates from a failed survey save.
 *
 * @param {function} callback — receives (executeRaw) as its arg.
 *   Inside the callback, use executeRaw(sql, params) for all writes.
 * @returns {any} — whatever the callback returned.
 */
function runInTransaction(callback) {
  // Snapshot current state in case we need to roll back
  const snapshot = db.export();

  db.run('BEGIN');
  try {
    const result = callback(executeRaw);
    db.run('COMMIT');
    saveDb(); // persist once after the whole transaction succeeds
    return result;
  } catch (err) {
    // Roll back: restore from the pre-transaction snapshot
    db = new SQL.Database(snapshot);
    db.run('PRAGMA foreign_keys = ON');
    saveDb(); // over-write with pre-transaction state
    throw err;
  }
}

module.exports = { getDb, queryAll, queryOne, execute, executeRaw, runInTransaction, saveDb };
