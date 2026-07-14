/**
 * app.js — Main frontend controller for Faculty Navigator.
 *
 * Fetches graph + POI data, initialises the Leaflet map, tracks GPS
 * position with three-state indicator, and draws A*-computed routes.
 */

/* ─── State ────────────────────────────────────────────────── */
let map, graph, pois, currentPosMarker, routePolyline, destMarker;
let currentPos = null;
let activeDestNodeId = null;
let directionsSteps = null;
let currentAlgorithm = 'a-star';

/* ─── Config ───────────────────────────────────────────────── */
const DEFAULT_CENTER = [5.0315, 7.9208];
const DEFAULT_ZOOM = 16;

/* ─── DOM refs (cached) ────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const distanceEl = $('distance');
const gpsDot = $('gps-dot');
const gpsLabel = $('gps-label');
const toggleDirBtn = $('toggle-directions');
const clearRouteBtn = $('clear-route');

/* ─── GPS state management ─────────────────────────────────── */
function setGpsState(state) {
  /* state: 'locating' | 'locked' | 'weak' | 'poor' | 'error' */
  gpsDot.className = 'gps-dot state-' + state;

  const labels = {
    locating: 'LOCATING',
    locked:   'GPS LOCKED',
    weak:     'WEAK SIGNAL',
    poor:     'POOR SIGNAL',
    error:    'NO GPS'
  };
  gpsLabel.textContent = labels[state] || state.toUpperCase();
}

/* ─── Initialisation ───────────────────────────────────────── */
async function init() {
  setGpsState('locating');

  try {
    const [graphRes, poisRes] = await Promise.all([
      fetch('/api/graph'),
      fetch('/api/pois')
    ]);
    if (!graphRes.ok || !poisRes.ok) throw new Error('API error');

    graph = await graphRes.json();
    pois = await poisRes.json();
  } catch (err) {
    statusEl.textContent = 'Failed to load map data. Is the server running?';
    setGpsState('error');
    return;
  }

  statusEl.textContent = 'Loaded — waiting for GPS…';

  map = L.map('map', { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  drawGraph();
  startGps();

  $('search-box').addEventListener('input', onSearch);
  $('search-box').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#results-list li');
      if (first) first.click();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      $('results-list').innerHTML = '';
    }
  });

  /* Algorithm picker (A* vs Dijkstra) */
  const algoBtns = document.querySelectorAll('#algo-toggle .algo-btn');
  algoBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentAlgorithm = btn.dataset.algo;
      algoBtns.forEach((b) => b.classList.toggle('active', b === btn));
      if (activeDestNodeId) recalculateRoute();
    });
  });

  /* Directions toggle & close */
  toggleDirBtn.addEventListener('click', toggleDirectionsPanel);
  $('close-directions').addEventListener('click', function () {
    $('directions-panel').classList.add('hidden');
    toggleDirBtn.textContent = '☰ ROUTE';
  });

  /* Clear route button */
  clearRouteBtn.addEventListener('click', clearRoute);

  /* Locate-me button */
  $('locate-me').addEventListener('click', function () {
    if (currentPos) {
      map.setView([currentPos.lat, currentPos.lng], Math.max(map.getZoom(), 17));
    } else {
      statusEl.textContent = 'No GPS position yet.';
    }
  });
}

/* ─── Draw graph overlay ──────────────────────────────────── */
function drawGraph() {
  for (const edge of graph.edges) {
    const from = graph.nodes.find((n) => n.id === edge.from_node_id);
    const to   = graph.nodes.find((n) => n.id === edge.to_node_id);
    if (from && to) {
      L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color: '#aaa', weight: 2, opacity: 0.55
      }).addTo(map);
    }
  }

  for (const node of graph.nodes) {
    let color = '#3388ff';
    if (node.type === 'gate')              color = '#d94f14';
    else if (node.type === 'junction')      color = '#f5c518';
    else if (node.type === 'building_entrance') color = '#2d7d46';

    L.circleMarker([node.lat, node.lng], {
      radius: 5, color, fillColor: color, fillOpacity: 0.85, weight: 1
    }).bindTooltip(node.name).addTo(map);
  }
}

/* ─── GPS tracking ─────────────────────────────────────────── */
function startGps() {
  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation not supported.';
    setGpsState('error');
    return;
  }

  currentPosMarker = L.marker(DEFAULT_CENTER, {
    icon: L.divIcon({
      className: 'gps-marker',
      html: '<div class="gps-pulse"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    }),
    zIndexOffset: 1000
  }).addTo(map).bindTooltip('You are here');

  navigator.geolocation.watchPosition(
    onPositionUpdate,
    onGpsError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function onPositionUpdate(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  currentPos = { lat: latitude, lng: longitude };

  currentPosMarker.setLatLng([latitude, longitude]);

  /* Determine GPS quality */
  if (accuracy <= 10) {
    setGpsState('locked');
  } else if (accuracy <= 25) {
    setGpsState('weak');
  } else {
    setGpsState('poor');
  }

  if (activeDestNodeId) recalculateRoute();
}

function onGpsError(err) {
  statusEl.textContent = 'GPS error: ' + err.message;
  setGpsState('error');
}

/* ─── Fetch a route from the backend (/api/route/:algorithm) ── */
async function fetchRoute(fromId, toId) {
  const res = await fetch(
    '/api/route/' + currentAlgorithm +
    '?from=' + encodeURIComponent(fromId) +
    '&to=' + encodeURIComponent(toId)
  );
  if (!res.ok) return null;
  return res.json();
}

/* ─── Recalculate route from current position ──────────────── */
async function recalculateRoute() {
  const nearest = findNearestNode(currentPos.lat, currentPos.lng, graph.nodes);
  if (!nearest) return;

  const data = await fetchRoute(nearest.id, activeDestNodeId);
  if (data) {
    drawRoute(data);
    distanceEl.textContent = Math.round(data.distance) + ' m';
  } else {
    statusEl.textContent = 'No route from your position.';
  }
}

/* ─── Search box handler ───────────────────────────────────── */
async function onSearch(e) {
  const q = e.target.value.trim();
  const resultsList = $('results-list');

  if (q.length < 2) { resultsList.innerHTML = ''; return; }

  try {
    const res = await fetch('/api/pois/search?q=' + encodeURIComponent(q));
    if (!res.ok) return;

    const results = await res.json();
    resultsList.innerHTML = results
      .map((poi) =>
        '<li data-node-id="' + poi.node_id +
        '" data-name="' + poi.name.replace(/"/g, '&quot;') + '">' +
        poi.name + '</li>'
      ).join('');

    resultsList.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () =>
        selectDestination(li.dataset.nodeId, li.dataset.name)
      );
    });
  } catch (_) { /* ignore */ }
}

/* ─── User selects a destination ───────────────────────────── */
async function selectDestination(nodeId, name) {
  const searchBox = $('search-box');
  searchBox.value = name;
  $('results-list').innerHTML = '';

  activeDestNodeId = nodeId;

  const destNode = graph.nodes.find((n) => n.id === nodeId);
  if (destNode) {
    if (destMarker) map.removeLayer(destMarker);
    destMarker = L.marker([destNode.lat, destNode.lng], {
      icon: L.divIcon({
        className: 'dest-marker',
        html: '<div class="dest-flag">&#9873;</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 24]
      })
    }).addTo(map);
    destMarker.bindTooltip(name);
  }

  if (currentPos) {
    const nearest = findNearestNode(currentPos.lat, currentPos.lng, graph.nodes);
    if (!nearest) {
      statusEl.textContent = 'No nearest node found.';
      return;
    }

    const result = await fetchRoute(nearest.id, nodeId);
    if (result) {
      drawRoute(result);
      distanceEl.textContent = Math.round(result.distance) + ' m';
      statusEl.textContent = 'Route to ' + name + ' (' + currentAlgorithm + ')';
    } else {
      statusEl.textContent = 'No route found — disconnected?';
      distanceEl.textContent = '';
    }
  } else {
    statusEl.textContent = 'Selected ' + name + '. Waiting for GPS…';
  }
}

/* ─── Draw the route polyline ──────────────────────────────── */
function drawRoute(result) {
  if (routePolyline) map.removeLayer(routePolyline);

  const latlngs = result.path.map((n) => [n.lat, n.lng]);
  routePolyline = L.polyline(latlngs, {
    color: '#d94f14', weight: 4, opacity: 0.85
  }).addTo(map);

  map.fitBounds(routePolyline.getBounds().pad(0.1));

  /* Generate & display directions */
  directionsSteps = generateDirections(result.path);
  displayDirections(directionsSteps);

  /* Show route buttons */
  toggleDirBtn.hidden = false;
  clearRouteBtn.hidden = false;
  toggleDirBtn.textContent = '☰ ROUTE';
}

/* ─── Display directions in the panel ─────────────────────── */
function displayDirections(steps) {
  const list = $('directions-list');
  list.innerHTML = steps.map(function (s, i) {
    var icon = '';
    var suffix = '';
    if (s.type === 'start')   { icon = '●'; suffix = ''; }
    else if (s.type === 'walk')   { icon = '↑'; suffix = s.distance + ' m'; }
    else if (s.type === 'turn')   {
      icon = s.turnText.indexOf('left') !== -1 ? '←' : s.turnText.indexOf('right') !== -1 ? '→' : '↑';
      suffix = s.distance + ' m → ' + s.toward;
    }
    else if (s.type === 'arrive') { icon = '★'; suffix = s.distance + ' m'; }

    var cls = 'dir-step dir-' + s.type;
    return '<li class="' + cls + '"><span class="dir-icon">' + icon + '</span>' +
           '<span class="dir-text">' + s.text + '</span>' +
           (suffix ? '<span class="dir-suffix">' + suffix + '</span>' : '') + '</li>';
  }).join('');
}

/* ─── Toggle directions panel ─────────────────────────────── */
function toggleDirectionsPanel() {
  var panel = $('directions-panel');
  var isHidden = panel.classList.toggle('hidden');
  toggleDirBtn.textContent = isHidden ? '☰ ROUTE' : '✕ ROUTE';
}

/* ─── Clear the current route ──────────────────────────────── */
function clearRoute() {
  if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
  if (destMarker)    { map.removeLayer(destMarker);    destMarker = null; }
  activeDestNodeId = null;
  directionsSteps = null;

  $('directions-list').innerHTML = '';
  $('directions-panel').classList.add('hidden');
  toggleDirBtn.hidden = true;
  clearRouteBtn.hidden = true;
  $('search-box').value = '';
  statusEl.textContent = 'Route cleared.';
  distanceEl.textContent = '';
}

/* ─── Boot ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
