/**
 * router.js — A* pathfinding engine with Haversine heuristic
 * and a hand-written binary min-heap priority queue.
 *
 * This file has zero dependencies and runs in both the browser
 * (via <script> tag) and Node (via require) by checking for
 * module.exports at the bottom.
 * ============================================================
 */

/**
 * haversineDistance(lat1, lng1, lat2, lng2) → metres
 *
 * Computes the great-circle distance between two points on the
 * Earth's surface using the Haversine formula.  Earth is modelled
 * as a sphere of radius 6 371 km, which gives ~0.5 % accuracy for
 * the distances we care about (a few hundred metres).
 *
 * This is used in two places:
 *   1. As the A* heuristic h(n) — the straight-line distance to
 *      the goal, which is always admissible (never overestimates
 *      true walking distance) and therefore guarantees optimality.
 *   2. To pre-compute edge weights when an edge is created (the
 *      server does this; see POST /api/edges).
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;                // Earth radius in metres
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;                     // distance in metres
}

/**
 * MinHeap — a binary min-heap keyed on a numeric score f(n).
 *
 * The heap is stored as a flat array where the element at index i
 * has children at 2i+1 and 2i+2.  The parent of i is ⌊(i-1)/2⌋.
 *
 * Operations:
 *   insert(nodeId, score)   O(log n)  — push + bubble up
 *   extractMin()            O(log n)  — pop root + sift down
 *   size                    O(1)      — current number of elements
 *
 * We use this instead of Array.sort() or a naive priority queue
 * because A* may explore hundreds of nodes; O(log n) per operation
 * keeps the whole thing snappy even on a phone.
 */
class MinHeap {
  constructor() {
    this.heap = [];
  }

  /**
   * Insert a new element with a given priority score.
   * Append to the end, then let it "bubble up" until the heap
   * property is restored (parent score ≤ child score).
   */
  insert(nodeId, score) {
    this.heap.push({ nodeId, score });
    this._heapifyUp(this.heap.length - 1);
  }

  /**
   * Remove and return the element with the smallest score.
   * Replace the root with the last element, then "sift down"
   * to restore the heap property.
   * Returns null when the heap is empty.
   */
  extractMin() {
    if (this.heap.length === 0) return null;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop();
    this._heapifyDown(0);
    return min;
  }

  /** Number of elements currently in the heap. */
  get size() {
    return this.heap.length;
  }

  /**
   * Bubble-up helper: swap the element at idx with its parent
   * until the parent has a lower-or-equal score.
   */
  _heapifyUp(idx) {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.heap[parent].score <= this.heap[idx].score) break;
      [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
      idx = parent;
    }
  }

  /**
   * Sift-down helper: swap the element at idx with its smallest
   * child until both children have larger-or-equal scores.
   */
  _heapifyDown(idx) {
    const n = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < n && this.heap[left].score < this.heap[smallest].score) smallest = left;
      if (right < n && this.heap[right].score < this.heap[smallest].score) smallest = right;
      if (smallest === idx) break;

      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
      idx = smallest;
    }
  }
}

/**
 * findNearestNode(lat, lng, nodes) → node object | null
 *
 * Brute-force scan over all graph nodes to find the one closest
 * to a given GPS coordinate.  The graph is small (tens to low
 * hundreds of nodes for a faculty) so a linear scan is fine.
 */
function findNearestNode(lat, lng, nodes) {
  let best = null;
  let bestDist = Infinity;

  for (const node of nodes) {
    const d = haversineDistance(lat, lng, node.lat, node.lng);
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best;
}

/**
 * aStar(graph, startNodeId, endNodeId) → { path, distance } | null
 *
 * Classic A* shortest-path algorithm.
 *
 * @param {Object} graph         — { nodes: [...], edges: [...] }
 * @param {string} startNodeId   — id of the origin node
 * @param {string} endNodeId     — id of the destination node
 *
 * @returns {Object|null}
 *   { path: [node, node, ...], distance: number }  or  null if unreachable
 *
 * Algorithm sketch:
 *   1. Build an adjacency list so we can iterate neighbours in O(1).
 *   2. g(n) = known shortest distance from start to node n.
 *      h(n) = Haversine distance from n to the goal (admissible).
 *      f(n) = g(n) + h(n).
 *   3. Initialise the open set (MinHeap) with the start node.
 *   4. Repeatedly pop the node with the smallest f(n).
 *      - If it's the goal, reconstruct and return the path.
 *      - Otherwise, for each neighbour, compute tentative g.
 *        If it's better than any previous g, update and push into
 *        the heap.  (We may push the same node multiple times with
 *        decreasing scores; the first time it is popped it has the
 *        optimal g, and later stale entries are ignored.)
 *   5. If the heap empties, the graph is disconnected → return null.
 */
function aStar(graph, startNodeId, endNodeId) {
  // ---- 1. Build adjacency list ----------------------------------
  const adjacency = new Map();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    // Treat edges as bidirectional (walkable both ways)
    adjacency.get(edge.from_node_id).push({ neighborId: edge.to_node_id, weight: edge.weight });
    adjacency.get(edge.to_node_id).push({ neighborId: edge.from_node_id, weight: edge.weight });
  }

  // ---- 2. Node lookup map ---------------------------------------
  const nodeMap = new Map();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  if (!nodeMap.has(startNodeId) || !nodeMap.has(endNodeId)) {
    return null; // one of the nodes doesn't exist
  }

  const endNode = nodeMap.get(endNodeId);

  // ---- 3. Initialise data structures ----------------------------
  // gScores[n] = lowest known cost from start to n
  // cameFrom[n] = predecessor on the best path found so far
  const gScores = new Map();
  const cameFrom = new Map();
  gScores.set(startNodeId, 0);

  const openSet = new MinHeap();
  const hStart = haversineDistance(
    nodeMap.get(startNodeId).lat,
    nodeMap.get(startNodeId).lng,
    endNode.lat,
    endNode.lng
  );
  openSet.insert(startNodeId, hStart); // f(start) = 0 + h(start)

  // ---- 4. Main loop ---------------------------------------------
  while (openSet.size > 0) {
    const current = openSet.extractMin();
    const currentNodeId = current.nodeId;

    // Skip stale heap entries (we may have pushed the same node
    // multiple times with decreasing g-scores)
    if (current.score !== gScores.get(currentNodeId) + haversineDistance(
      nodeMap.get(currentNodeId).lat,
      nodeMap.get(currentNodeId).lng,
      endNode.lat,
      endNode.lng
    )) {
      continue;
    }

    // Goal reached
    if (currentNodeId === endNodeId) {
      const path = [];
      let id = endNodeId;
      while (id !== startNodeId) {
        path.unshift(nodeMap.get(id));
        id = cameFrom.get(id);
      }
      path.unshift(nodeMap.get(startNodeId));
      return { path, distance: Math.round(gScores.get(endNodeId)) };
    }

    const currentG = gScores.get(currentNodeId);

    for (const { neighborId, weight } of adjacency.get(currentNodeId) || []) {
      const tentativeG = currentG + weight;

      if (!gScores.has(neighborId) || tentativeG < gScores.get(neighborId)) {
        // This is a better path to the neighbour
        gScores.set(neighborId, tentativeG);
        cameFrom.set(neighborId, currentNodeId);

        const neighbor = nodeMap.get(neighborId);
        const h = haversineDistance(neighbor.lat, neighbor.lng, endNode.lat, endNode.lng);
        const f = tentativeG + h;
        openSet.insert(neighborId, f);
      }
    }
  }

  // ---- 5. No path found -----------------------------------------
  return null;
}

/**
 * generateDirections(path) → Array<{type, text, node, distance?, turnText?}>
 *
 * Takes the ordered array of graph nodes returned by A* and produces
 * human-readable turn-by-turn direction steps.  Turn angles are derived
 * from the Haversine bearing between consecutive path segments.
 *
 * Step types:
 *   'start'  — origin (first node)
 *   'walk'   — straight walk segment (no turn, first step after start)
 *   'turn'   — direction change at a junction
 *   'arrive' — destination (last node)
 *
 * Each step object:
 *   type, text, node, distance(segment m), turnText(if turn), toward(next name)
 */
function generateDirections(path) {
  if (!path || path.length < 2) return [];

  var toRad = function (d) { return (d * Math.PI) / 180; };
  var toDeg = function (r) { return (r * 180) / Math.PI; };

  function bearing(lat1, lng1, lat2, lng2) {
    var dLng = toRad(lng2 - lng1);
    var y = Math.sin(dLng) * Math.cos(toRad(lat2));
    var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function classifyTurn(angle) {
    if (angle > -20 && angle < 20) return 'Continue straight';
    if (angle >= 20 && angle < 100) return 'Turn right';
    if (angle >= 100) return 'Sharp right';
    if (angle <= -20 && angle > -100) return 'Turn left';
    return 'Sharp left';
  }

  var steps = [];
  var getName = function (n, f) { return (n && n.name) ? n.name : (f || 'Unknown'); };

  // Start
  steps.push({ type: 'start', text: getName(path[0], 'Start'), node: path[0] });

  for (var i = 1; i < path.length; i++) {
    var from = path[i - 1];
    var to   = path[i];
    var dist = Math.round(haversineDistance(from.lat, from.lng, to.lat, to.lng));

    if (i === 1 && i === path.length - 1) {
      // Only 2 nodes — first segment is also the arrival
      steps.push({
        type: 'arrive',
        text: getName(to, 'Destination'),
        node: to,
        distance: dist
      });
    } else if (i === 1) {
      // First segment of a longer path — no turn yet
      steps.push({
        type: 'walk',
        text: getName(to, 'Next'),
        node: to,
        distance: dist
      });
    } else {
      // Every subsequent segment may include a turn
      var prev = path[i - 2];
      var bearingIn  = bearing(prev.lat, prev.lng, from.lat, from.lng);
      var bearingOut = bearing(from.lat, from.lng, to.lat, to.lng);
      var diff = bearingOut - bearingIn;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      var turnText = classifyTurn(diff);

      var stepType = (i === path.length - 1) ? 'arrive' : 'turn';
      steps.push({
        type: stepType,
        text: turnText + ' at ' + getName(from, 'Junction'),
        node: stepType === 'arrive' ? to : from,
        toward: getName(to, 'Destination'),
        distance: dist,
        turnText: turnText,
        turnAngle: Math.round(diff)
      });
    }
  }

  return steps;
}

// Expose for Node.js (tests); in the browser these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { haversineDistance, MinHeap, findNearestNode, aStar, generateDirections };
}
