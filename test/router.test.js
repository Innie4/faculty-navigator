/**
 * Unit tests for router.js (Haversine, MinHeap, findNearestNode, A*,
 * generateDirections).
 *
 * We require the router module directly — it exports everything
 * when running under Node (via the module.exports guard at the
 * bottom of the file).
 */
const assert = require('assert');
const {
  haversineDistance,
  MinHeap,
  findNearestNode,
  aStar,
  dijkstra,
  generateDirections
} = require('../public/router.js');

// ──────────────────────────────────────────────────────────
// Synthetic test graph (linear with a shortcut).
//
//  A ────── B ────── C ────── D
//   \─────────────────/
//
// Distances at the equator:  1° ≈ 111 319 m
// 0.001° ≈ 111 m,  0.002° ≈ 223 m
// ──────────────────────────────────────────────────────────
const syntheticNodes = [
  { id: 'A', name: 'Node A', lat: 0, lng: 0 },
  { id: 'B', name: 'Node B', lat: 0, lng: 0.001 },
  { id: 'C', name: 'Node C', lat: 0, lng: 0.002 },
  { id: 'D', name: 'Node D', lat: 0, lng: 0.003 }
];

function distBetween(n1, n2) {
  return Math.round(haversineDistance(n1.lat, n1.lng, n2.lat, n2.lng));
}

const syntheticEdges = [
  { from_node_id: 'A', to_node_id: 'B', weight: distBetween(syntheticNodes[0], syntheticNodes[1]) },
  { from_node_id: 'B', to_node_id: 'C', weight: distBetween(syntheticNodes[1], syntheticNodes[2]) },
  { from_node_id: 'C', to_node_id: 'D', weight: distBetween(syntheticNodes[2], syntheticNodes[3]) },
  { from_node_id: 'A', to_node_id: 'C', weight: distBetween(syntheticNodes[0], syntheticNodes[2]) }
];

const syntheticGraph = { nodes: syntheticNodes, edges: syntheticEdges };

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('MinHeap', function () {
  it('should insert and extract in priority order', function () {
    const heap = new MinHeap();
    heap.insert('a', 5);
    heap.insert('b', 1);
    heap.insert('c', 3);

    assert.strictEqual(heap.extractMin().nodeId, 'b');
    assert.strictEqual(heap.extractMin().nodeId, 'c');
    assert.strictEqual(heap.extractMin().nodeId, 'a');
    assert.strictEqual(heap.extractMin(), null);
  });

  it('should handle a single element', function () {
    const heap = new MinHeap();
    heap.insert('x', 42);
    assert.strictEqual(heap.extractMin().nodeId, 'x');
    assert.strictEqual(heap.extractMin(), null);
  });

  it('should handle duplicate scores', function () {
    const heap = new MinHeap();
    heap.insert('a', 1);
    heap.insert('b', 1);
    heap.insert('c', 1);

    const ids = [
      heap.extractMin().nodeId,
      heap.extractMin().nodeId,
      heap.extractMin().nodeId
    ];
    assert.deepStrictEqual(ids.sort(), ['a', 'b', 'c']);
    assert.strictEqual(heap.extractMin(), null);
  });

  it('should report correct size', function () {
    const heap = new MinHeap();
    assert.strictEqual(heap.size, 0);
    heap.insert('a', 1);
    assert.strictEqual(heap.size, 1);
    heap.insert('b', 2);
    assert.strictEqual(heap.size, 2);
    heap.extractMin();
    assert.strictEqual(heap.size, 1);
    heap.extractMin();
    assert.strictEqual(heap.size, 0);
  });
});

describe('haversineDistance', function () {
  it('should return 0 for identical coordinates', function () {
    assert.strictEqual(haversineDistance(0, 0, 0, 0), 0);
    assert.strictEqual(haversineDistance(5.031, 7.921, 5.031, 7.921), 0);
  });

  it('should compute a plausible distance between two points ~0.001° apart', function () {
    const d = haversineDistance(0, 0, 0, 0.001);
    // ~111 m at the equator
    assert.ok(d > 100 && d < 120, 'distance should be ~111 m, got ' + d);
  });

  it('should compute a known distance near Uyo', function () {
    const d = haversineDistance(5.0300, 7.9200, 5.0325, 7.9220);
    assert.ok(d > 280 && d < 360, 'distance should be ~320 m, got ' + d);
  });
});

describe('findNearestNode', function () {
  it('should return the closest node', function () {
    const nearest = findNearestNode(0, 0.0011, syntheticNodes);
    assert.strictEqual(nearest.id, 'B');
  });

  it('should return null for an empty array', function () {
    const nearest = findNearestNode(0, 0, []);
    assert.strictEqual(nearest, null);
  });

  it('should return the only node when array has one element', function () {
    const nearest = findNearestNode(10, 20, [{ id: 'X', lat: 10, lng: 20 }]);
    assert.strictEqual(nearest.id, 'X');
  });
});

describe('aStar', function () {
  it('should find the shortest path A → D via the A–C shortcut', function () {
    const result = aStar(syntheticGraph, 'A', 'D');
    assert.ok(result !== null, 'Route should exist');

    const pathIds = result.path.map((n) => n.id);
    // A→C→D is shorter than A→B→C→D
    assert.deepStrictEqual(
      pathIds,
      ['A', 'C', 'D'],
      'Expected A→C→D but got ' + pathIds.join('→')
    );
  });

  it('should return the correct total distance for A → D', function () {
    const result = aStar(syntheticGraph, 'A', 'D');
    const expected =
      distBetween(syntheticNodes[0], syntheticNodes[2]) +
      distBetween(syntheticNodes[2], syntheticNodes[3]);
    assert.strictEqual(result.distance, expected);
  });

  it('should handle direct neighbours (A → B)', function () {
    const result = aStar(syntheticGraph, 'A', 'B');
    assert.ok(result !== null);
    assert.deepStrictEqual(
      result.path.map((n) => n.id),
      ['A', 'B']
    );
    assert.strictEqual(
      result.distance,
      distBetween(syntheticNodes[0], syntheticNodes[1])
    );
  });

  it('should return the same node when start === end', function () {
    const result = aStar(syntheticGraph, 'B', 'B');
    assert.ok(result !== null);
    assert.deepStrictEqual(
      result.path.map((n) => n.id),
      ['B']
    );
    assert.strictEqual(result.distance, 0);
  });

  it('should return null when the graph is disconnected', function () {
    const disconnectedGraph = {
      nodes: syntheticNodes,
      edges: [{ from_node_id: 'A', to_node_id: 'B', weight: 100 }]
    };
    const result = aStar(disconnectedGraph, 'A', 'D');
    assert.strictEqual(result, null);
  });

  it('should return null for non-existent node IDs', function () {
    const result = aStar(syntheticGraph, 'A', 'Z');
    assert.strictEqual(result, null);
  });

  it('should handle a path with equal alternatives gracefully', function () {
    // A → B → D  and  A → C → D  are equal in this graph
    const nodes = [
      { id: 'A', lat: 0, lng: 0 },
      { id: 'B', lat: 0, lng: 0.001 },
      { id: 'C', lat: 0, lng: 0.001 },
      { id: 'D', lat: 0, lng: 0.002 }
    ];
    const edges = [
      { from_node_id: 'A', to_node_id: 'B', weight: 111 },
      { from_node_id: 'A', to_node_id: 'C', weight: 111 },
      { from_node_id: 'B', to_node_id: 'D', weight: 111 },
      { from_node_id: 'C', to_node_id: 'D', weight: 111 }
    ];
    const g = { nodes, edges };
    const result = aStar(g, 'A', 'D');
    assert.ok(result !== null);
    assert.strictEqual(result.distance, 222);
  });
});

describe('dijkstra', function () {
  it('should find the shortest path A → D', function () {
    const result = dijkstra(syntheticGraph, 'A', 'D');
    assert.ok(result !== null);
    const pathIds = result.path.map((n) => n.id);
    // Dijkstra uses only edge weights, so it also finds A→C→D
    assert.deepStrictEqual(pathIds, ['A', 'C', 'D']);
  });

  it('should return the correct total distance', function () {
    const result = dijkstra(syntheticGraph, 'A', 'D');
    const expected =
      distBetween(syntheticNodes[0], syntheticNodes[2]) +
      distBetween(syntheticNodes[2], syntheticNodes[3]);
    assert.strictEqual(result.distance, expected);
  });

  it('should handle direct neighbours', function () {
    const result = dijkstra(syntheticGraph, 'A', 'B');
    assert.ok(result !== null);
    assert.deepStrictEqual(result.path.map((n) => n.id), ['A', 'B']);
    assert.strictEqual(result.distance, distBetween(syntheticNodes[0], syntheticNodes[1]));
  });

  it('should return the same node when start === end', function () {
    const result = dijkstra(syntheticGraph, 'B', 'B');
    assert.ok(result !== null);
    assert.deepStrictEqual(result.path.map((n) => n.id), ['B']);
    assert.strictEqual(result.distance, 0);
  });

  it('should return null when the graph is disconnected', function () {
    const disconnectedGraph = {
      nodes: syntheticNodes,
      edges: [{ from_node_id: 'A', to_node_id: 'B', weight: 100 }]
    };
    const result = dijkstra(disconnectedGraph, 'A', 'D');
    assert.strictEqual(result, null);
  });

  it('should return null for non-existent node IDs', function () {
    const result = dijkstra(syntheticGraph, 'A', 'Z');
    assert.strictEqual(result, null);
  });

  it('should match A* result on this graph', function () {
    const a = aStar(syntheticGraph, 'A', 'D');
    const d = dijkstra(syntheticGraph, 'A', 'D');
    assert.strictEqual(d.distance, a.distance);
    assert.deepStrictEqual(
      d.path.map((n) => n.id),
      a.path.map((n) => n.id)
    );
  });
});

describe('generateDirections', function () {
  it('should return empty array for null or empty path', function () {
    assert.deepStrictEqual(generateDirections(null), []);
    assert.deepStrictEqual(generateDirections([]), []);
    assert.deepStrictEqual(generateDirections([{ id: 'x' }]), []);
  });

  it('should return start + arrive for a 2-node path', function () {
    const path = [
      { id: 'A', name: 'Gate', lat: 5.0, lng: 7.9 },
      { id: 'B', name: 'Library', lat: 5.001, lng: 7.901 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].type, 'start');
    assert.strictEqual(steps[0].text, 'Gate');
    assert.strictEqual(steps[1].type, 'arrive');
    assert.strictEqual(steps[1].text, 'Library');
    assert.ok(steps[1].distance > 0);
  });

  it('should detect a right turn', function () {
    // A(0,0) → B(0.001,0) bearing ≈ 0° (north)
    // B(0.001,0) → C(0.001,0.001) bearing ≈ 90° (east)
    // Turn at B: 90 - 0 = 90° → "Turn right"
    // C(0.001,0.001) → D(0.002,0.001) bearing ≈ 90° (east, continue straight)
    const path = [
      { id: 'A', name: 'Start', lat: 0, lng: 0 },
      { id: 'B', name: 'Junction', lat: 0.001, lng: 0 },
      { id: 'C', name: 'Lab', lat: 0.001, lng: 0.001 },
      { id: 'D', name: 'Dept', lat: 0.002, lng: 0.001 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps.length, 4);
    assert.strictEqual(steps[0].type, 'start');
    assert.strictEqual(steps[1].type, 'walk');
    assert.strictEqual(steps[2].type, 'turn');
    assert.ok(steps[2].turnText.indexOf('right') !== -1,
      'Expected right turn, got: ' + steps[2].turnText);
    assert.strictEqual(steps[2].node.id, 'B');
    assert.strictEqual(steps[3].type, 'arrive');
  });

  it('should detect a left turn', function () {
    // A(0.001,0) → B(0,0) bearing ≈ 180° (south)
    // B(0,0) → C(0,0.001) bearing ≈ 90° (east)
    // diff = 90 - 180 = -90 → "Turn left"
    // C(0,0.001) → D(0,0.002) bearing ≈ 90° (east, continue straight)
    const path = [
      { id: 'A', name: 'Field', lat: 0.001, lng: 0 },
      { id: 'B', name: 'Xroads', lat: 0, lng: 0 },
      { id: 'C', name: 'Hostel', lat: 0, lng: 0.001 },
      { id: 'D', name: 'Gate', lat: 0, lng: 0.002 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps.length, 4);
    assert.strictEqual(steps[2].type, 'turn');
    assert.ok(steps[2].turnText.indexOf('left') !== -1,
      'Expected left turn, got: ' + steps[2].turnText);
    assert.strictEqual(steps[2].node.id, 'B');
    assert.strictEqual(steps[3].type, 'arrive');
  });

  it('should produce 4 steps for a 4-node path with turns', function () {
    // L-shaped path: A→B (east), B→C (north, left turn), C→D (north, straight)
    const path = [
      { id: 'A', name: 'Gate', lat: 0, lng: 0 },
      { id: 'B', name: 'Plaza', lat: 0, lng: 0.002 },
      { id: 'C', name: 'Annex', lat: 0.002, lng: 0.002 },
      { id: 'D', name: 'Dept', lat: 0.004, lng: 0.002 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps.length, 4);
    assert.strictEqual(steps[0].type, 'start');
    assert.strictEqual(steps[1].type, 'walk');
    assert.strictEqual(steps[2].type, 'turn');
    assert.strictEqual(steps[2].node.id, 'B');
    assert.strictEqual(steps[3].type, 'arrive');
    assert.strictEqual(steps[3].node.id, 'D');
  });

  it('should use fallback names when node.name is missing', function () {
    const path = [
      { id: 'n1', lat: 0, lng: 0 },
      { id: 'n2', lat: 0, lng: 0.001 },
      { id: 'n3', lat: 0.001, lng: 0.001 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps[0].text, 'Start');
    assert.ok(steps[1].text);
    assert.ok(steps[2].text);
  });

  it('should return correct step types and node references', function () {
    const path = [
      { id: 'A', name: 'A', lat: 0, lng: 0 },
      { id: 'B', name: 'B', lat: 0, lng: 0.002 }
    ];
    const steps = generateDirections(path);
    assert.strictEqual(steps[0].node, path[0]);
    assert.strictEqual(steps[1].node, path[1]);
  });
});
