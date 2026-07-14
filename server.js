const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { haversineDistance, MinHeap, findNearestNode, aStar, dijkstra, generateDirections } = require('./public/router.js');
const { getDb, queryAll, queryOne, execute, executeRaw, runInTransaction } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null; // null = auth disabled

/* ─── Rate limiters ───────────────────────────────────────── */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests — slow down.' }
});

/* ─── Auth middleware ──────────────────────────────────────── */
function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open for development
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Provide x-api-key header or unset API_KEY for dev mode.' });
  }
  next();
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', generalLimiter);

/**
 * Haversine distance in metres — used to compute edge weights server-side.
 */
function haversineWeight(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

async function startup() {
  await getDb();

  // Check if database has data and give guidance
  const count = queryOne('SELECT COUNT(*) AS c FROM nodes');
  if (!count || count.c === 0) {
    console.log('');
    console.log('  ⚠  Database is empty — no nodes or edges loaded yet.');
    console.log('  ');
    console.log('  Option A — Use /survey.html to capture real campus data.');
    console.log('  Option B — Run `npm run seed-example` then restart to load a demo dataset.');
    console.log('');
  }

  if (API_KEY) {
    console.log(`  🔐  Write API requires x-api-key header`);
  } else {
    console.log(`  🔓  Write API is OPEN (set API_KEY env var to lock)`);
  }
    console.log(`FindMyBlock running at http://localhost:${PORT}`);
}

// ─── Existing endpoints (unchanged) ────────────────────────────

app.get('/api/graph', (req, res) => {
  res.json({
    nodes: queryAll('SELECT * FROM nodes'),
    edges: queryAll('SELECT * FROM edges')
  });
});

app.get('/api/pois', (req, res) => {
  res.json(queryAll('SELECT * FROM pois'));
});

app.get('/api/pois/search', (req, res) => {
  const q = req.query.q;
  if (!q || q.trim() === '') {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }
  res.json(
    queryAll('SELECT * FROM pois WHERE LOWER(name) LIKE ?', [`%${q.toLowerCase()}%`])
  );
});

// ─── Routing endpoints (A* and Dijkstra) ──────────────────────

function buildGraphFromDb() {
  return {
    nodes: queryAll('SELECT * FROM nodes'),
    edges: queryAll('SELECT * FROM edges')
  };
}

/**
 * GET /api/route/a-star?from=node_id&to=node_id
 * GET /api/route/dijkstra?from=node_id&to=node_id
 *
 * Compute the shortest path using the requested algorithm.
 * Returns { path: [...], distance: number, algorithm: string }
 * or { error: '...' } with appropriate HTTP status.
 */
app.get('/api/route/:algorithm', (req, res) => {
  const algorithm = req.params.algorithm;
  if (algorithm !== 'a-star' && algorithm !== 'dijkstra') {
    return res.status(400).json({ error: 'Algorithm must be "a-star" or "dijkstra"' });
  }

  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Query parameters "from" and "to" (node IDs) are required' });
  }

  const graph = buildGraphFromDb();

  if (!graph.nodes.find((n) => n.id === from)) {
    return res.status(404).json({ error: 'Start node "' + from + '" not found' });
  }
  if (!graph.nodes.find((n) => n.id === to)) {
    return res.status(404).json({ error: 'Destination node "' + to + '" not found' });
  }

  const fn = algorithm === 'a-star' ? aStar : dijkstra;
  const result = fn(graph, from, to);

  if (!result) {
    return res.status(404).json({ error: 'No path found between the given nodes' });
  }

  res.json({
    algorithm: algorithm,
    path: result.path,
    distance: result.distance,
    directions: generateDirections(result.path)
  });
});

app.post('/api/nodes', requireAuth, writeLimiter, (req, res) => {
  const { id, name, lat, lng, type } = req.body;
  if (!id || !name || lat == null || lng == null || !type) {
    return res.status(400).json({ error: 'Missing required fields: id, name, lat, lng, type' });
  }
  if (!['building_entrance', 'junction', 'gate', 'turning_point'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  try {
    execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)', [
      id, name, lat, lng, type
    ]);
    res.status(201).json({ id, name, lat, lng, type });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/edges', requireAuth, writeLimiter, (req, res) => {
  const { from_node_id, to_node_id, surface_type } = req.body;
  if (!from_node_id || !to_node_id || !surface_type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['paved', 'earthen'].includes(surface_type)) {
    return res.status(400).json({ error: 'surface_type must be paved or earthen' });
  }
  const fromNode = queryOne('SELECT * FROM nodes WHERE id = ?', [from_node_id]);
  const toNode = queryOne('SELECT * FROM nodes WHERE id = ?', [to_node_id]);
  if (!fromNode || !toNode) {
    return res.status(404).json({ error: 'One or both node IDs not found' });
  }
  const weight = haversineWeight(fromNode.lat, fromNode.lng, toNode.lat, toNode.lng);
  try {
    execute('INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)', [
      from_node_id, to_node_id, weight, surface_type
    ]);
    res.status(201).json({ from_node_id, to_node_id, weight, surface_type });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/pois', requireAuth, writeLimiter, (req, res) => {
  const { name, node_id } = req.body;
  if (!name || !node_id) {
    return res.status(400).json({ error: 'Missing required fields: name, node_id' });
  }
  if (!queryOne('SELECT * FROM nodes WHERE id = ?', [node_id])) {
    return res.status(404).json({ error: 'Node not found' });
  }
  try {
    const result = execute('INSERT INTO pois (name, node_id) VALUES (?, ?)', [name, node_id]);
    res.status(201).json({ id: result.insertId, name, node_id });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ─── New: Batch survey save ────────────────────────────────────
/**
 * POST /api/survey/batch
 *
 * Accepts arrays of nodes and edges to insert atomically.
 * Edge weights are computed server-side from node coordinates.
 * Everything succeeds or fails together — no partial writes.
 *
 * Payload: { nodes: [...], edges: [...] }
 */
app.post('/api/survey/batch', requireAuth, writeLimiter, (req, res) => {
  const { nodes, edges } = req.body;

  if (!Array.isArray(nodes) && !Array.isArray(edges)) {
    return res.status(400).json({ error: 'Payload must contain nodes and/or edges arrays' });
  }

  // Validate node types
  const validTypes = ['building_entrance', 'junction', 'gate', 'turning_point'];
  for (const n of nodes || []) {
    if (!n.id || !n.name || n.lat == null || n.lng == null || !n.type) {
      return res.status(400).json({
        error: `Node "${n.id || '(unnamed)'}" is missing required fields`
      });
    }
    if (!validTypes.includes(n.type)) {
      return res.status(400).json({ error: `Node "${n.id}" has invalid type "${n.type}"` });
    }
  }

  // Collect all node IDs that will exist after the batch
  const newNodeIds = new Set((nodes || []).map((n) => n.id));

  // Validate edges reference existing nodes
  for (const e of edges || []) {
    if (!e.from_node_id || !e.to_node_id || !e.surface_type) {
      return res.status(400).json({ error: 'Edge missing from_node_id, to_node_id, or surface_type' });
    }
    if (!['paved', 'earthen'].includes(e.surface_type)) {
      return res.status(400).json({ error: `Edge has invalid surface_type "${e.surface_type}"` });
    }
    // Allow referencing nodes in the same batch OR already in the DB
    const fromExists = newNodeIds.has(e.from_node_id) ||
      queryOne('SELECT 1 FROM nodes WHERE id = ?', [e.from_node_id]);
    const toExists = newNodeIds.has(e.to_node_id) ||
      queryOne('SELECT 1 FROM nodes WHERE id = ?', [e.to_node_id]);
    if (!fromExists) {
      return res.status(400).json({ error: `Edge references unknown node "${e.from_node_id}"` });
    }
    if (!toExists) {
      return res.status(400).json({ error: `Edge references unknown node "${e.to_node_id}"` });
    }
  }

  try {
    const result = runInTransaction((exec) => {
      const insertedNodes = [];
      const insertedEdges = [];

      // 1. Insert all nodes
      for (const n of nodes || []) {
        exec('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)', [
          n.id, n.name, n.lat, n.lng, n.type
        ]);
        insertedNodes.push({ id: n.id, name: n.name, lat: n.lat, lng: n.lng, type: n.type });
      }

      // 2. Insert all edges with server-computed Haversine weights
      for (const e of edges || []) {
        // Fetch coordinates to compute weight (handle both newly inserted and existing nodes)
        const fromNode =
          (nodes || []).find((n) => n.id === e.from_node_id) ||
          queryOne('SELECT lat, lng FROM nodes WHERE id = ?', [e.from_node_id]);
        const toNode =
          (nodes || []).find((n) => n.id === e.to_node_id) ||
          queryOne('SELECT lat, lng FROM nodes WHERE id = ?', [e.to_node_id]);

        const weight = haversineWeight(fromNode.lat, fromNode.lng, toNode.lat, toNode.lng);
        const r = exec(
          'INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)',
          [e.from_node_id, e.to_node_id, weight, e.surface_type]
        );
        insertedEdges.push({
          id: r.insertId,
          from_node_id: e.from_node_id,
          to_node_id: e.to_node_id,
          weight,
          surface_type: e.surface_type
        });
      }

      return { nodes: insertedNodes, edges: insertedEdges };
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ─── New: Single-node helpers ──────────────────────────────────

app.get('/api/nodes/:id', (req, res) => {
  const node = queryOne('SELECT * FROM nodes WHERE id = ?', [req.params.id]);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  res.json(node);
});

/**
 * DELETE /api/nodes/:id
 *
 * Cascading delete: removes all edges referencing the node,
 * all POIs linked to it, then the node itself.
 */
app.delete('/api/nodes/:id', requireAuth, writeLimiter, (req, res) => {
  const nodeId = req.params.id;
  const node = queryOne('SELECT * FROM nodes WHERE id = ?', [nodeId]);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  try {
    execute('DELETE FROM edges WHERE from_node_id = ? OR to_node_id = ?', [nodeId, nodeId]);
    execute('DELETE FROM pois WHERE node_id = ?', [nodeId]);
    execute('DELETE FROM nodes WHERE id = ?', [nodeId]);
    res.json({ deleted: nodeId });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ─── New: Update helpers (admin page) ──────────────────────────

app.put('/api/nodes/:id', requireAuth, writeLimiter, (req, res) => {
  const node = queryOne('SELECT * FROM nodes WHERE id = ?', [req.params.id]);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const { name, type } = req.body;
  if (name != null) {
    execute('UPDATE nodes SET name = ? WHERE id = ?', [name, req.params.id]);
  }
  if (type != null) {
    const validTypes = ['building_entrance', 'junction', 'gate', 'turning_point'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    execute('UPDATE nodes SET type = ? WHERE id = ?', [type, req.params.id]);
  }
  res.json(queryOne('SELECT * FROM nodes WHERE id = ?', [req.params.id]));
});

app.put('/api/edges/:id', requireAuth, writeLimiter, (req, res) => {
  const edge = queryOne('SELECT * FROM edges WHERE id = ?', [req.params.id]);
  if (!edge) return res.status(404).json({ error: 'Edge not found' });

  const { surface_type } = req.body;
  if (surface_type != null) {
    if (!['paved', 'earthen'].includes(surface_type)) {
      return res.status(400).json({ error: 'surface_type must be paved or earthen' });
    }
    execute('UPDATE edges SET surface_type = ? WHERE id = ?', [surface_type, req.params.id]);
  }
  res.json(queryOne('SELECT * FROM edges WHERE id = ?', [req.params.id]));
});

app.delete('/api/edges/:id', requireAuth, writeLimiter, (req, res) => {
  const edge = queryOne('SELECT * FROM edges WHERE id = ?', [req.params.id]);
  if (!edge) return res.status(404).json({ error: 'Edge not found' });
  execute('DELETE FROM edges WHERE id = ?', [req.params.id]);
  res.json({ deleted: parseInt(req.params.id, 10) });
});

// ─── New: POI delete ───────────────────────────────────────────

app.delete('/api/pois/:id', requireAuth, writeLimiter, (req, res) => {
  const poi = queryOne('SELECT * FROM pois WHERE id = ?', [req.params.id]);
  if (!poi) return res.status(404).json({ error: 'POI not found' });
  execute('DELETE FROM pois WHERE id = ?', [req.params.id]);
  res.json({ deleted: parseInt(req.params.id, 10) });
});

// ─── New: Full export ──────────────────────────────────────────
/**
 * GET /api/export
 *
 * Dumps the entire database as a single JSON object,
 * useful for manual backup after a survey session.
 */
app.get('/api/export', (req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    nodes: queryAll('SELECT * FROM nodes ORDER BY id'),
    edges: queryAll('SELECT * FROM edges ORDER BY id'),
    pois: queryAll('SELECT * FROM pois ORDER BY id')
  });
});

// ─── Catch-all 404 ────────────────────────────────────────────

app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((req, res) => {
  res.redirect('/');
});

if (require.main === module) {
  startup().then(() => app.listen(PORT));
}
module.exports = app;
