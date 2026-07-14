# FindMyBlock

A GPS-driven campus navigation system for university students. Built with **vanilla JavaScript**, **Node.js / Express**, **SQLite**, and **Leaflet.js** — zero build tools, zero frameworks, zero external services.

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser.

**The database starts empty.** You have two paths:

**Path A — Real data** (you are surveying a campus):  
Open `/survey.html` on your phone, walk the campus, capture nodes and edges, then save them. The map at `/navigate.html` will display whatever you've collected.

**Path B — Demo / testing** (you want to see the app working immediately):  
Run the example seed script once, then start the server:

```bash
npm run seed-example
npm start
```

This loads a fictional faculty layout near Uyo, Akwa Ibom State, Nigeria, so you can explore the routing and map features right away.

## Project Structure

```
faculty-navigator/
├── package.json              # Dependencies & scripts
├── server.js                 # Express server + REST endpoints
├── database.js               # SQLite schema + connection helper
├── seed.js                   # Startup checks (no auto-data)
├── seed-example.js           # Standalone demo dataset script
├── public/
│   ├── index.html            # Landing page (hero, about, CTA)
│   ├── navigate.html         # Map + routing interface
│   ├── survey.html           # Field data collection tool
│   ├── admin.html            # Database review & editing
│   ├── style.css             # Full design system
│   ├── app.js                # Map/routing frontend controller
│   └── router.js             # A* engine + MinHeap + Haversine
├── test/
│   └── router.test.js        # Unit tests for the routing engine
└── README.md
```

## Pages

| URL | Page | Purpose |
|-----|------|---------|
| `/` | Landing | Bold hero, how-it-works, preview map, CTA to enter the navigator |
| `/navigate.html` | Navigator | Full-screen map with GPS tracking, POI search, A* route display |
| `/survey.html` | Survey | Mobile-first field tool to capture GPS coordinates and build the graph |
| `/admin.html` | Admin | Review/edit nodes, edges, POIs; connectivity check; JSON backup |

## How It Works

### Haversine Distance
The Haversine formula computes the great-circle distance between two GPS coordinates on the Earth's surface (modelled as a sphere of radius 6 371 km). It is accurate to ~0.5 % for the distances we deal with (a few hundred metres). The formula is:

```
a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
c = 2 · atan2(√a, √(1−a))
d = R · c
```

We use it for two purposes:
1. **Edge weights** — when an edge is created (POST /api/edges), the server computes its weight as the Haversine distance in metres between the two endpoint nodes.
2. **A\* heuristic** — `h(n)` is the Haversine distance from node `n` to the goal. Since straight-line distance never overestimates actual walking distance, the heuristic is **admissible**, which guarantees A\* returns the optimal (shortest) path.

### Min-Heap Priority Queue
A\* needs to always expand the node with the lowest `f(n) = g(n) + h(n)`. A binary min-heap gives us O(log n) insert and extract-min operations, which is essential for good performance.

The heap is stored as a flat array where:
- Parent of index `i` is `⌊(i−1)/2⌋`
- Left child of index `i` is `2i + 1`
- Right child of index `i` is `2i + 2`

**Insert:** append to the end, then "bubble up" by swapping with the parent until the heap property is restored.

**Extract-min:** save the root, replace it with the last element, then "sift down" by swapping with the smaller child until the heap property is restored.

### A\* Pathfinding
The A\* algorithm maintains two scores for each node:
- **`g(n)`** — the actual cost from the start node to node `n`
- **`h(n)`** — the heuristic (Haversine) estimate from `n` to the goal
- **`f(n) = g(n) + h(n)`** — the priority used in the min-heap

Procedure:
1. Push the start node onto the min-heap with `f(start)=h(start)` (since `g(start)=0`).
2. Pop the node with the lowest `f(n)`.
3. If it's the goal, reconstruct the path via parent pointers and return it.
4. Otherwise, for each neighbour, compute `tentativeG = g(n) + weight(edge)`. If this is better than the neighbour's current `g`, update `g`, set the parent, and push the neighbour onto the heap with `f = tentativeG + h(neighbour)`.
5. If the heap empties without reaching the goal, the graph is disconnected → return `null`.

Because `h(n)` is admissible (never overestimates), the first time the goal is popped from the heap, the path found is guaranteed to be optimal.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/graph` | All nodes + edges as JSON |
| GET | `/api/pois` | All Points of Interest |
| GET | `/api/pois/search?q=...` | Search POIs by name (case-insensitive substring) |
| POST | `/api/nodes` | Add a new node |
| POST | `/api/edges` | Add a new edge (weight computed server-side) |
| POST | `/api/pois` | Add a new POI linked to a node |
| POST | `/api/survey/batch` | Batch-insert nodes + edges atomically |
| GET | `/api/nodes/:id` | Get a single node by ID |
| PUT | `/api/nodes/:id` | Update a node's name/type |
| DELETE | `/api/nodes/:id` | Cascading delete node + its edges and POIs |
| PUT | `/api/edges/:id` | Update an edge's surface_type |
| DELETE | `/api/edges/:id` | Delete a single edge |
| PUT | `/api/pois/:id` | Update a POI's name |
| DELETE | `/api/pois/:id` | Delete a single POI |
| GET | `/api/export` | Full database dump as downloadable JSON |

### POST `/api/nodes` — example body
```json
{ "id": "new_gate", "name": "North Gate", "lat": 5.0350, "lng": 7.9220, "type": "gate" }
```

### POST `/api/edges` — example body
```json
{ "from_node_id": "junction_a", "to_node_id": "new_gate", "surface_type": "paved" }
```

### POST `/api/pois` — example body
```json
{ "name": "North Gate Security Post", "node_id": "new_gate" }
```

### POST `/api/survey/batch` — example body
```json
{
  "nodes": [
    { "id": "gate_1", "name": "Main Gate", "lat": 5.0300, "lng": 7.9200, "type": "gate" },
    { "id": "junction_1", "name": "Junction A", "lat": 5.0310, "lng": 7.9210, "type": "junction" }
  ],
  "edges": [
    { "from_node_id": "gate_1", "to_node_id": "junction_1", "surface_type": "paved" }
  ]
}
```

## Running Tests

```bash
npm test
```

The test suite validates:
- MinHeap: insertion order, extraction, size tracking, duplicate scores
- Haversine distance: zero distance, known distances, approximate correctness
- `findNearestNode`: basic selection, single-element, empty array
- A\*: shortest path, path distance, self-loop, disconnected graph, missing nodes, equal-cost alternatives

## Extending to a Full Campus

The graph model is general. To map the entire university:
1. Collect GPS coordinates for building entrances, path junctions, and gates using the survey tool at `/survey.html`.
2. Connect walkable paths as edges (the survey tool does this as you walk).
3. Tag each building entrance as a Point of Interest in `/admin.html`.
4. Review connectivity in `/admin.html` to catch disconnected components.

No code changes are needed — the A\* algorithm works on any connected graph.

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `FACULTY_DB_PATH` | `./faculty.db` | Path to the SQLite database file |
| `API_KEY` | *(unset)* | If set, all POST / PUT / DELETE endpoints require `x-api-key` header |

### Auth behaviour

- **`API_KEY` unset** — Write endpoints are open (development mode). The server logs `🔓  Write API is OPEN` on startup.
- **`API_KEY` set** (e.g. `API_KEY=secret123`) — Every write request must include the header `x-api-key: secret123`. Returns `401` otherwise. The server logs `🔐  Write API requires x-api-key header`.

The admin and survey pages include an **API key input** bar at the top. Fill in your key and it is sent with every write request for the session.

### Rate limiting

All `/api/*` routes are rate-limited per IP:

| Scope | Limit | Window |
|---|---|---|
| All API routes | 200 requests | 15 minutes |
| Write routes (POST/PUT/DELETE) | 30 requests | 15 minutes |

When exceeded the server returns `{ "error": "Too many requests — try again later." }` with status `429`.

## Remaining Production Notes

- **Input sanitisation** and request size limits (`express.json({ limit: '2mb' })` already protects against oversized payloads).
- **HTTPS** via a reverse proxy (nginx / Caddy) or using Render/Railway's built-in TLS.
