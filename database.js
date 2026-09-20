require('dotenv').config();
const { Pool } = require('pg');

let pool = null;

/**
 * Build the connection pool from DATABASE_URL (a Postgres connection
 * string — in production this is a Supabase project's connection
 * string; in dev/test it can point at any local or containerised
 * Postgres). SSL is required by Supabase but not by a local instance.
 */
function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL environment variable is required (a Postgres connection string, e.g. from Supabase).'
    );
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });
}

/**
 * Convert the `?` placeholders every caller uses into Postgres'
 * positional `$1, $2, …` placeholders.
 */
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Initialise (or re-use) the connection pool and make sure the schema
 * exists. Safe to call repeatedly — CREATE TABLE IF NOT EXISTS is a
 * no-op once the tables are there.
 */
async function getDb() {
  if (!pool) {
    pool = createPool();
    await initializeSchema();
  }
  return pool;
}

async function initializeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('building_entrance', 'junction', 'gate', 'turning_point'))
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS edges (
      id SERIAL PRIMARY KEY,
      from_node_id TEXT NOT NULL REFERENCES nodes(id),
      to_node_id TEXT NOT NULL REFERENCES nodes(id),
      weight DOUBLE PRECISION NOT NULL,
      surface_type TEXT NOT NULL CHECK (surface_type IN ('paved', 'earthen')),
      UNIQUE (from_node_id, to_node_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pois (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES nodes(id)
    )
  `);
}

/**
 * Run a query and return all matching rows as objects.
 */
async function queryAll(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows;
}

/**
 * Run a query and return the first matching row, or undefined.
 */
async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * Build an exec(sql, params) function bound to a given query runner
 * (the pool for one-off writes, or a checked-out client for writes
 * inside a transaction). INSERT statements get `RETURNING id` appended
 * automatically so callers keep getting { affectedRows, insertId } —
 * Postgres has no SQLite-style last_insert_rowid().
 */
function buildExec(runner) {
  return async function exec(sql, params = []) {
    const trimmed = sql.trim();
    const isInsert = /^insert/i.test(trimmed) && !/returning/i.test(trimmed);
    const finalSql = isInsert ? `${trimmed} RETURNING id` : trimmed;
    const res = await runner(toPgQuery(finalSql), params);
    return {
      affectedRows: res.rowCount,
      insertId: isInsert && res.rows[0] ? res.rows[0].id : undefined
    };
  };
}

const execute = buildExec((sql, params) => pool.query(sql, params));

/**
 * Run a batch of operations inside a single Postgres transaction on
 * one dedicated client. If the callback throws, every change made
 * through its `exec` is rolled back and nothing is committed — this
 * prevents partial updates from a failed survey save.
 *
 * @param {function} callback — receives (exec) as its arg; exec has
 *   the same (sql, params) => {affectedRows, insertId} shape as
 *   execute(), but runs on the transaction's own client.
 * @returns {Promise<any>} whatever the callback resolved to.
 */
async function runInTransaction(callback) {
  const client = await pool.connect();
  const exec = buildExec((sql, params) => client.query(sql, params));
  try {
    await client.query('BEGIN');
    const result = await callback(exec);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getDb, queryAll, queryOne, execute, runInTransaction };
