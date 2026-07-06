/**
 * seed-example.js — Example dataset (fictional faculty near Uyo).
 *
 * This is NOT run automatically.  To load it:
 *   node seed-example.js
 *
 * It will clear any existing data and insert the demo nodes, edges,
 * and POIs used during development.
 */

const { getDb, execute } = require('./database');

// ── Fictional faculty near Uyo, Akwa Ibom State, Nigeria ──────

const nodes = [
  { id: 'gate_main', name: 'Main Gate', lat: 5.0300, lng: 7.9200, type: 'gate' },
  { id: 'junction_gate', name: 'Gate Junction', lat: 5.0305, lng: 7.9210, type: 'junction' },
  { id: 'junction_a', name: 'Junction A', lat: 5.0310, lng: 7.9210, type: 'junction' },
  { id: 'junction_b', name: 'Junction B', lat: 5.0320, lng: 7.9210, type: 'junction' },
  { id: 'admin_block', name: 'Admin Block Entrance', lat: 5.0305, lng: 7.9220, type: 'building_entrance' },
  { id: 'student_affairs', name: 'Student Affairs Entrance', lat: 5.0300, lng: 7.9215, type: 'building_entrance' },
  { id: 'library', name: 'Library Entrance', lat: 5.0315, lng: 7.9225, type: 'building_entrance' },
  { id: 'cs_dept', name: 'Computer Science Entrance', lat: 5.0325, lng: 7.9220, type: 'building_entrance' },
  { id: 'engineering', name: 'Engineering Entrance', lat: 5.0330, lng: 7.9200, type: 'building_entrance' },
  { id: 'turning_point', name: 'Science Walk Turning', lat: 5.0310, lng: 7.9195, type: 'turning_point' },
  { id: 'science_lab', name: 'Science Lab Entrance', lat: 5.0320, lng: 7.9190, type: 'building_entrance' }
];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const edgeDefs = [
  ['gate_main', 'junction_gate', 'paved'],
  ['junction_gate', 'junction_a', 'paved'],
  ['junction_gate', 'admin_block', 'paved'],
  ['junction_gate', 'student_affairs', 'paved'],
  ['junction_a', 'junction_b', 'paved'],
  ['junction_a', 'turning_point', 'paved'],
  ['junction_a', 'library', 'paved'],
  ['junction_b', 'cs_dept', 'paved'],
  ['junction_b', 'engineering', 'paved'],
  ['turning_point', 'science_lab', 'earthen']
];

const pois = [
  { name: 'Department of Computer Science', node_id: 'cs_dept' },
  { name: 'University Library', node_id: 'library' },
  { name: 'Faculty of Engineering', node_id: 'engineering' },
  { name: 'Science Laboratory', node_id: 'science_lab' },
  { name: 'Administrative Block', node_id: 'admin_block' },
  { name: 'Student Affairs Office', node_id: 'student_affairs' }
];

async function seed() {
  await getDb();
  console.log('Clearing existing data…');
  execute('DELETE FROM pois');
  execute('DELETE FROM edges');
  execute('DELETE FROM nodes');

  console.log('Inserting nodes…');
  for (const n of nodes) {
    execute('INSERT INTO nodes (id, name, lat, lng, type) VALUES (?, ?, ?, ?, ?)', [
      n.id, n.name, n.lat, n.lng, n.type
    ]);
  }

  console.log('Inserting edges…');
  for (const [from, to, surface] of edgeDefs) {
    const a = nodes.find((n) => n.id === from);
    const b = nodes.find((n) => n.id === to);
    const weight = haversine(a.lat, a.lng, b.lat, b.lng);
    execute('INSERT INTO edges (from_node_id, to_node_id, weight, surface_type) VALUES (?, ?, ?, ?)', [
      from, to, weight, surface
    ]);
  }

  console.log('Inserting POIs…');
  for (const p of pois) {
    execute('INSERT INTO pois (name, node_id) VALUES (?, ?)', [p.name, p.node_id]);
  }

  console.log(`Done — ${nodes.length} nodes, ${edgeDefs.length} edges, ${pois.length} POIs.`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
