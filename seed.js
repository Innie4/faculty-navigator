const { getDb, queryAll } = require('./database');

/**
 * seed.js — no longer auto-populates example data.
 *
 * The database is now populated via the /survey.html field tool
 * with real surveyed coordinates. This file exists to ensure the
 * schema is created (done in database.js) and to provide a
 * no-op seedIfEmpty that future surveys can depend on.
 *
 * To restore the old example dataset for demo purposes, run:
 *   node seed-example.js
 */
function seedIfEmpty() {
  const rows = queryAll('SELECT COUNT(*) AS c FROM nodes');
  if (rows[0].c === 0) {
    console.log('Database is empty. Use /survey.html to capture real data,');
    console.log('or run `node seed-example.js` to load the demo dataset.');
  } else {
    console.log(`Database has ${rows[0].c} nodes — ready.`);
  }
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  getDb().then(() => {
    seedIfEmpty();
    console.log('Done.');
  });
}
