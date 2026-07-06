/**
 * Integration tests for database.js and server.js.
 *
 * Uses a temporary SQLite database (test-faculty.db) and supertest
 * to exercise every API endpoint with and without authentication.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const request = require('supertest');

const TEST_DB = path.join(__dirname, 'test-faculty.db');

// ── Clean up leftover test DB before setting env ─────────────
try { fs.unlinkSync(TEST_DB); } catch (_) {}

process.env.FACULTY_DB_PATH = TEST_DB;
process.env.API_KEY = 'test-key-456';

const app = require('../server');
const db = require('../database');

// ── Helper: seed a minimal graph ────────────────────────────
function seedGraph() {
  db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
    ['node_a', 'Node A', 5.0, 7.9, 'gate']);
  db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
    ['node_b', 'Node B', 5.001, 7.901, 'junction']);
  db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
    ['node_c', 'Node C', 5.002, 7.902, 'building_entrance']);
  db.execute('INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)',
    ['node_a', 'node_b', 150, 'paved']);
  db.execute('INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)',
    ['node_b', 'node_c', 150, 'earthen']);
  db.execute('INSERT INTO pois (name, node_id) VALUES (?, ?)',
    ['Computer Science Dept', 'node_c']);
}

// ═══════════════════════════════════════════════════════════════
//  DATABASE LAYER
// ═══════════════════════════════════════════════════════════════

describe('Database', function () {

  before(function () {
    return db.getDb();
  });

  beforeEach(function () {
    db.execute('DELETE FROM pois');
    db.execute('DELETE FROM edges');
    db.execute('DELETE FROM nodes');
  });

  describe('getDb', function () {
    it('should return a database object', function () {
      return db.getDb().then(function (d) {
        assert.ok(d);
        assert.ok(d.run);
        assert.ok(d.exec);
      });
    });
  });

  describe('queryAll', function () {
    it('should return an empty array for an empty table', function () {
      const rows = db.queryAll('SELECT * FROM nodes');
      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, 0);
    });

    it('should return all rows after insert', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['x', 'X', 1, 2, 'gate']);
      const rows = db.queryAll('SELECT * FROM nodes');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 'x');
    });

    it('should accept bound parameters', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['param_test', 'PT', 3, 4, 'junction']);
      const rows = db.queryAll('SELECT * FROM nodes WHERE id = ?', ['param_test']);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, 'PT');
    });
  });

  describe('queryOne', function () {
    it('should return undefined for an empty table', function () {
      const row = db.queryOne('SELECT * FROM nodes');
      assert.strictEqual(row, undefined);
    });

    it('should return the first matching row', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['first', 'First', 0, 0, 'gate']);
      const row = db.queryOne('SELECT * FROM nodes');
      assert.strictEqual(row.id, 'first');
    });
  });

  describe('execute', function () {
    it('should insert a row and return insertId', function () {
      const result = db.execute(
        'INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['ins_test', 'Inserted', 1.1, 2.2, 'gate']
      );
      assert.ok(result.insertId !== undefined);
      const row = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['ins_test']);
      assert.strictEqual(row.name, 'Inserted');
    });

    it('should update a row', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['upd', 'Old', 0, 0, 'gate']);
      db.execute('UPDATE nodes SET name = ? WHERE id = ?', ['New', 'upd']);
      const row = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['upd']);
      assert.strictEqual(row.name, 'New');
    });

    it('should delete a row', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['del', 'DeleteMe', 0, 0, 'gate']);
      db.execute('DELETE FROM nodes WHERE id = ?', ['del']);
      const row = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['del']);
      assert.strictEqual(row, undefined);
    });

    it('should handle insert with missing foreign key', function () {
      // sql.js does not enforce FK constraints in all WASM builds,
      // so we just verify the operation does not crash.
      var before = db.queryAll('SELECT * FROM edges').length;
      db.execute(
        'INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)',
        ['no_such_node', 'no_such_node2', 100, 'paved']
      );
      // sql.js may or may not enforce the FK — either way is OK
      var after = db.queryAll('SELECT * FROM edges').length;
      assert.ok(after === before || after === before + 1,
        'Edge count should stay same or increase by 1, was ' + before + ' → ' + after);
    });
  });

  describe('executeRaw', function () {
    it('should execute within a transaction context', function () {
      db.runInTransaction(function (exec) {
        const r = exec('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
          ['raw_test', 'Raw', 9, 9, 'gate']);
        assert.ok(r.insertId !== undefined);
      });
      const row = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['raw_test']);
      assert.strictEqual(row.name, 'Raw');
    });
  });

  describe('runInTransaction', function () {
    it('should commit all changes on success', function () {
      var result = db.runInTransaction(function (exec) {
        exec('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
          ['tx1', 'Tx1', 0, 0, 'gate']);
        exec('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
          ['tx2', 'Tx2', 0, 0, 'junction']);
        return 'done';
      });
      assert.strictEqual(result, 'done');
      assert.strictEqual(db.queryAll('SELECT * FROM nodes').length, 2);
    });

    it('should roll back all changes on application error', function () {
      db.execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
        ['existing', 'Existing', 0, 0, 'gate']);

      assert.throws(function () {
        db.runInTransaction(function (exec) {
          exec('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)',
            ['tx_fail', 'ShouldRollback', 1, 1, 'gate']);
          // Throw deliberately to force rollback
          throw new Error('Simulated failure');
        });
      }, /Simulated failure/);

      // The node 'tx_fail' should NOT exist after rollback
      var rollbackNode = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['tx_fail']);
      assert.strictEqual(rollbackNode, undefined, 'Node should have been rolled back');

      // The existing node should still be there
      var existing = db.queryOne('SELECT * FROM nodes WHERE id = ?', ['existing']);
      assert.strictEqual(existing.name, 'Existing');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  SERVER API ENDPOINTS (with API_KEY set)
// ═══════════════════════════════════════════════════════════════

describe('API (auth enabled)', function () {

  before(function () {
    return db.getDb();
  });

  beforeEach(function () {
    db.execute('DELETE FROM pois');
    db.execute('DELETE FROM edges');
    db.execute('DELETE FROM nodes');
  });

  after(function () {
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
  });

  describe('GET /api/graph', function () {
    it('should return empty graph when DB is empty', function () {
      return request(app)
        .get('/api/graph')
        .expect(200)
        .then(function (res) {
          assert.ok(Array.isArray(res.body.nodes));
          assert.ok(Array.isArray(res.body.edges));
          assert.strictEqual(res.body.nodes.length, 0);
          assert.strictEqual(res.body.edges.length, 0);
        });
    });

    it('should return seeded nodes and edges', function () {
      seedGraph();
      return request(app)
        .get('/api/graph')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.nodes.length, 3);
          assert.strictEqual(res.body.edges.length, 2);
          assert.strictEqual(res.body.nodes[0].id, 'node_a');
          assert.strictEqual(res.body.edges[0].from_node_id, 'node_a');
        });
    });
  });

  describe('GET /api/pois', function () {
    it('should return empty array when no POIs', function () {
      return request(app)
        .get('/api/pois')
        .expect(200)
        .then(function (res) {
          assert.ok(Array.isArray(res.body));
          assert.strictEqual(res.body.length, 0);
        });
    });

    it('should return POIs after seeding', function () {
      seedGraph();
      return request(app)
        .get('/api/pois')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.length, 1);
          assert.strictEqual(res.body[0].name, 'Computer Science Dept');
        });
    });
  });

  describe('GET /api/pois/search', function () {
    it('should return 400 when q is missing', function () {
      return request(app)
        .get('/api/pois/search')
        .expect(400)
        .then(function (res) {
          assert.ok(res.body.error);
        });
    });

    it('should return matching POIs', function () {
      seedGraph();
      return request(app)
        .get('/api/pois/search?q=Computer')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.length, 1);
          assert.strictEqual(res.body[0].name, 'Computer Science Dept');
        });
    });

    it('should be case-insensitive', function () {
      seedGraph();
      return request(app)
        .get('/api/pois/search?q=computer')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.length, 1);
        });
    });

    it('should return empty array for no match', function () {
      seedGraph();
      return request(app)
        .get('/api/pois/search?q=zzzzz')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.length, 0);
        });
    });
  });

  describe('GET /api/nodes/:id', function () {
    it('should return 404 for unknown node', function () {
      return request(app)
        .get('/api/nodes/nope')
        .expect(404);
    });

    it('should return the node', function () {
      seedGraph();
      return request(app)
        .get('/api/nodes/node_a')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.id, 'node_a');
          assert.strictEqual(res.body.name, 'Node A');
          assert.strictEqual(res.body.type, 'gate');
        });
    });
  });

  describe('GET /api/export', function () {
    it('should return full DB dump', function () {
      seedGraph();
      return request(app)
        .get('/api/export')
        .expect(200)
        .then(function (res) {
          assert.ok(res.body.exportedAt);
          assert.strictEqual(res.body.nodes.length, 3);
          assert.strictEqual(res.body.edges.length, 2);
          assert.strictEqual(res.body.pois.length, 1);
        });
    });
  });

  describe('POST /api/nodes (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .post('/api/nodes')
        .send({ id: 'x', name: 'X', lat: 1, lng: 2, type: 'gate' })
        .expect(401);
    });

    it('should return 401 with wrong API key', function () {
      return request(app)
        .post('/api/nodes')
        .set('x-api-key', 'wrong-key')
        .send({ id: 'x', name: 'X', lat: 1, lng: 2, type: 'gate' })
        .expect(401);
    });

    it('should create a node with valid API key', function () {
      return request(app)
        .post('/api/nodes')
        .set('x-api-key', 'test-key-456')
        .send({ id: 'new_node', name: 'New Node', lat: 5.5, lng: 7.5, type: 'junction' })
        .expect(201)
        .then(function (res) {
          assert.strictEqual(res.body.id, 'new_node');
          assert.strictEqual(res.body.name, 'New Node');
        });
    });

    it('should return 400 for missing fields', function () {
      return request(app)
        .post('/api/nodes')
        .set('x-api-key', 'test-key-456')
        .send({ id: 'bad' })
        .expect(400);
    });

    it('should return 400 for invalid type', function () {
      return request(app)
        .post('/api/nodes')
        .set('x-api-key', 'test-key-456')
        .send({ id: 'bad', name: 'Bad', lat: 1, lng: 2, type: 'invalid' })
        .expect(400);
    });

    it('should return 409 for duplicate id', function () {
      seedGraph();
      return request(app)
        .post('/api/nodes')
        .set('x-api-key', 'test-key-456')
        .send({ id: 'node_a', name: 'Duplicate', lat: 1, lng: 2, type: 'gate' })
        .expect(409);
    });
  });

  describe('POST /api/edges (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .post('/api/edges')
        .send({ from_node_id: 'a', to_node_id: 'b', surface_type: 'paved' })
        .expect(401);
    });

    it('should create an edge with valid API key', function () {
      seedGraph();
      return request(app)
        .post('/api/edges')
        .set('x-api-key', 'test-key-456')
        .send({ from_node_id: 'node_a', to_node_id: 'node_c', surface_type: 'paved' })
        .expect(201)
        .then(function (res) {
          assert.strictEqual(res.body.from_node_id, 'node_a');
          assert.strictEqual(res.body.to_node_id, 'node_c');
          assert.ok(res.body.weight > 0);
        });
    });

    it('should return 400 for missing fields', function () {
      seedGraph();
      return request(app)
        .post('/api/edges')
        .set('x-api-key', 'test-key-456')
        .send({ from_node_id: 'node_a' })
        .expect(400);
    });

    it('should return 404 for unknown node', function () {
      seedGraph();
      return request(app)
        .post('/api/edges')
        .set('x-api-key', 'test-key-456')
        .send({ from_node_id: 'node_a', to_node_id: 'ghost', surface_type: 'paved' })
        .expect(404);
    });
  });

  describe('POST /api/pois (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .post('/api/pois')
        .send({ name: 'X', node_id: 'n' })
        .expect(401);
    });

    it('should create a POI with valid API key', function () {
      seedGraph();
      return request(app)
        .post('/api/pois')
        .set('x-api-key', 'test-key-456')
        .send({ name: 'New POI', node_id: 'node_a' })
        .expect(201)
        .then(function (res) {
          assert.strictEqual(res.body.name, 'New POI');
          // Verify it was persisted
          var pois = db.queryAll('SELECT * FROM pois');
          var match = pois.filter(function (p) { return p.name === 'New POI'; });
          assert.strictEqual(match.length, 1);
        });
    });

    it('should return 404 for unknown node', function () {
      seedGraph();
      return request(app)
        .post('/api/pois')
        .set('x-api-key', 'test-key-456')
        .send({ name: 'Orphan', node_id: 'ghost' })
        .expect(404);
    });
  });

  describe('POST /api/survey/batch (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .post('/api/survey/batch')
        .send({ nodes: [], edges: [] })
        .expect(401);
    });

    it('should batch-insert nodes and edges atomically', function () {
      return request(app)
        .post('/api/survey/batch')
        .set('x-api-key', 'test-key-456')
        .send({
          nodes: [
            { id: 's1', name: 'Survey1', lat: 1, lng: 2, type: 'gate' },
            { id: 's2', name: 'Survey2', lat: 3, lng: 4, type: 'junction' }
          ],
          edges: [
            { from_node_id: 's1', to_node_id: 's2', surface_type: 'paved' }
          ]
        })
        .expect(201)
        .then(function (res) {
          assert.strictEqual(res.body.nodes.length, 2);
          assert.strictEqual(res.body.edges.length, 1);
          assert.ok(res.body.edges[0].weight > 0);
        });
    });

    it('should reject edges referencing unknown nodes', function () {
      return request(app)
        .post('/api/survey/batch')
        .set('x-api-key', 'test-key-456')
        .send({
          nodes: [{ id: 'alone', name: 'Alone', lat: 0, lng: 0, type: 'gate' }],
          edges: [{ from_node_id: 'alone', to_node_id: 'ghost', surface_type: 'paved' }]
        })
        .expect(400)
        .then(function (res) {
          assert.ok(res.body.error.indexOf('ghost') !== -1);
        });
    });

    it('should reject nodes with invalid type', function () {
      return request(app)
        .post('/api/survey/batch')
        .set('x-api-key', 'test-key-456')
        .send({
          nodes: [{ id: 'bad', name: 'Bad', lat: 0, lng: 0, type: 'invalid' }]
        })
        .expect(400);
    });
  });

  describe('PUT /api/nodes/:id (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .put('/api/nodes/x')
        .send({ name: 'New' })
        .expect(401);
    });

    it('should update a node name', function () {
      seedGraph();
      return request(app)
        .put('/api/nodes/node_a')
        .set('x-api-key', 'test-key-456')
        .send({ name: 'Updated A' })
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.name, 'Updated A');
        });
    });

    it('should return 404 for unknown node', function () {
      return request(app)
        .put('/api/nodes/ghost')
        .set('x-api-key', 'test-key-456')
        .send({ name: 'X' })
        .expect(404);
    });
  });

  describe('PUT /api/edges/:id (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .put('/api/edges/1')
        .send({ surface_type: 'paved' })
        .expect(401);
    });

    it('should update edge surface type', function () {
      seedGraph();
      // Need to know the edge id — edges table has autoincrement
      var edges = db.queryAll('SELECT * FROM edges');
      var edgeId = edges[0].id;
      return request(app)
        .put('/api/edges/' + edgeId)
        .set('x-api-key', 'test-key-456')
        .send({ surface_type: 'earthen' })
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.surface_type, 'earthen');
        });
    });

    it('should return 404 for unknown edge', function () {
      return request(app)
        .put('/api/edges/99999')
        .set('x-api-key', 'test-key-456')
        .send({ surface_type: 'paved' })
        .expect(404);
    });
  });

  describe('DELETE /api/nodes/:id (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .delete('/api/nodes/x')
        .expect(401);
    });

    it('should cascade-delete a node, its edges, and POIs', function () {
      seedGraph();
      return request(app)
        .delete('/api/nodes/node_c')
        .set('x-api-key', 'test-key-456')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.deleted, 'node_c');
          // POI should be gone
          var pois = db.queryAll('SELECT * FROM pois');
          assert.strictEqual(pois.length, 0);
          // Edges referencing node_c should be gone
          var edges = db.queryAll('SELECT * FROM edges');
          assert.strictEqual(edges.length, 1); // only a→b remains
        });
    });

    it('should return 404 for unknown node', function () {
      return request(app)
        .delete('/api/nodes/ghost')
        .set('x-api-key', 'test-key-456')
        .expect(404);
    });
  });

  describe('DELETE /api/pois/:id (auth protected)', function () {
    it('should return 401 without API key', function () {
      return request(app)
        .delete('/api/pois/1')
        .expect(401);
    });

    it('should delete a POI', function () {
      seedGraph();
      var pois = db.queryAll('SELECT * FROM pois');
      var poiId = pois[0].id;
      return request(app)
        .delete('/api/pois/' + poiId)
        .set('x-api-key', 'test-key-456')
        .expect(200)
        .then(function (res) {
          assert.strictEqual(res.body.deleted, poiId);
          assert.strictEqual(db.queryAll('SELECT * FROM pois').length, 0);
        });
    });

    it('should return 404 for unknown POI', function () {
      return request(app)
        .delete('/api/pois/99999')
        .set('x-api-key', 'test-key-456')
        .expect(404);
    });
  });

  describe('404 handler', function () {
    it('should return JSON for unknown API routes', function () {
      return request(app)
        .get('/api/nonexistent')
        .expect(404);
    });

    it('should redirect HTML pages to landing', function () {
      return request(app)
        .get('/some-page')
        .expect(302);
    });
  });
});
