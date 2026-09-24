/**
 * app.js — Main frontend controller for FindMyBlock.
 *
 * Fetches graph + POI data, initialises the Leaflet map, tracks GPS
 * position with three-state indicator, and draws A*-computed routes.
 */

/* ─── State ────────────────────────────────────────────────── */
let map, graph, pois, currentPosMarker, routePolyline, destMarker;
let currentPos = null;
let activeDestNodeId = null;
let activeDestName = '';
let directionsSteps = null;
let currentAlgorithm = 'a-star';
/* Dynamic search connector: direct line from user → destination + live metres */
let guidanceLine = null;
let guidanceLabel = null;
let lastRouteDistance = null;
let lastRouteAt = 0;
let lastRoutePos = null;

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

  /* Always refresh the dynamic connector + live metres instantly (no network). */
  if (activeDestNodeId) updateGuidanceLine();

  /* Throttle backend route recalcs: at most every 5 s unless moved > 10 m. */
  if (activeDestNodeId) {
    const now = Date.now();
    const moved = lastRoutePos
      ? haversineDistance(lastRoutePos.lat, lastRoutePos.lng, latitude, longitude)
      : Infinity;
    if (now - lastRouteAt > 5000 || moved > 10) {
      lastRouteAt = now;
      lastRoutePos = { lat: latitude, lng: longitude };
      recalculateRoute();
    }
  } else if (currentPos && !activeDestNodeId && map) {
    /* No destination yet — keep the user in view on first fix. */
    if (!onPositionUpdate._centred) {
      map.setView([latitude, longitude], Math.max(map.getZoom(), 17));
      onPositionUpdate._centred = true;
    }
  }
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
  if (!currentPos) return;
  const nearest = findNearestNode(currentPos.lat, currentPos.lng, graph.nodes);
  if (!nearest) return;

  const data = await fetchRoute(nearest.id, activeDestNodeId);
  if (data) {
    lastRouteDistance = data.distance;
    drawRoute(data);
  } else {
    lastRouteDistance = null;
    statusEl.textContent = 'No walking path — showing direct line to destination.';
  }
  /* Re-render the dynamic connector so the live metres stay in sync. */
  updateGuidanceLine();
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
  activeDestName = name;
  lastRouteDistance = null;

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

  /* Draw the dynamic connecting line immediately — even before the
     backend route returns — so search always gives instant direction. */
  updateGuidanceLine();

  if (currentPos) {
    const nearest = findNearestNode(currentPos.lat, currentPos.lng, graph.nodes);
    if (!nearest) {
      statusEl.textContent = 'No nearest node found — showing direct line.';
      return;
    }

    const result = await fetchRoute(nearest.id, nodeId);
    if (result) {
      lastRouteDistance = result.distance;
      lastRouteAt = Date.now();
      lastRoutePos = { lat: currentPos.lat, lng: currentPos.lng };
      drawRoute(result);
      statusEl.textContent = 'Route to ' + name + ' (' + currentAlgorithm + ')';
    } else {
      lastRouteDistance = null;
      statusEl.textContent = 'No walking path — follow the direct line to ' + name + '.';
      distanceEl.textContent = '';
      if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
      /* Keep the map framed on user + destination when no graph path exists. */
      if (currentPos && destNode) {
        map.fitBounds(L.latLngBounds(
          [[currentPos.lat, currentPos.lng], [destNode.lat, destNode.lng]]
        ).pad(0.2));
      }
    }
    updateGuidanceLine();
  } else {
    statusEl.textContent = 'Selected ' + name + '. Waiting for GPS…';
    if (destNode) map.setView([destNode.lat, destNode.lng], Math.max(map.getZoom(), 17));
  }
}

/* ─── Dynamic connecting line + live distance (metres) ─────────
 * Draws a dashed straight line from the live GPS position to the
 * selected destination and updates the metres readout on every GPS
 * tick. This runs fully client-side (Haversine) so it stays dynamic
 * even when the backend route is slow, throttled, or disconnected.
 */
function getDestNode() {
  if (!activeDestNodeId || !graph) return null;
  return graph.nodes.find((n) => n.id === activeDestNodeId) || null;
}

function formatLiveDistance(metres) {
  const m = Math.max(0, Math.round(metres));
  return m.toLocaleString('en-US') + ' m';
}

function updateGuidanceLine() {
  const dest = getDestNode();
  if (!dest || !currentPos || !map) return;

  const userLL = [currentPos.lat, currentPos.lng];
  const destLL = [dest.lat, dest.lng];
  const liveMetres = haversineDistance(currentPos.lat, currentPos.lng, dest.lat, dest.lng);

  if (!guidanceLine) {
    guidanceLine = L.polyline([userLL, destLL], {
      color: '#1c1c1c', weight: 2, opacity: 0.85, dashArray: '8 8'
    }).addTo(map);
  } else {
    guidanceLine.setLatLngs([userLL, destLL]);
  }

  /* Live label pinned at the midpoint of the connector. */
  const mid = [(userLL[0] + destLL[0]) / 2, (userLL[1] + destLL[1]) / 2];
  const labelText = '📍 ' + formatLiveDistance(liveMetres);
  if (!guidanceLabel) {
    guidanceLabel = L.tooltip({
      permanent: true, direction: 'center', className: 'guidance-label', opacity: 1
    }).setLatLng(mid).setContent(labelText).addTo(map);
  } else {
    guidanceLabel.setLatLng(mid).setContent(labelText);
  }

  /* Arrival state (< 15 m): celebrate instead of routing. */
  if (liveMetres < 15) {
    distanceEl.textContent = formatLiveDistance(liveMetres) + ' — ARRIVED 🎉';
    statusEl.textContent = 'You have arrived at ' + (activeDestName || dest.name || 'your destination') + ' 🎉';
    return;
  }

  /* Normal state: live straight-line metres, plus walking-route metres when known. */
  if (lastRouteDistance != null) {
    distanceEl.textContent =
      '📍 ' + formatLiveDistance(liveMetres) + ' away • route ' + formatLiveDistance(lastRouteDistance);
  } else {
    distanceEl.textContent = '📍 ' + formatLiveDistance(liveMetres) + ' away';
  }
}

/* ─── Draw the route polyline ──────────────────────────────── */
function drawRoute(result) {
  if (routePolyline) map.removeLayer(routePolyline);

  const latlngs = result.path.map((n) => [n.lat, n.lng]);
  routePolyline = L.polyline(latlngs, {
    color: '#d94f14', weight: 4, opacity: 0.85
  }).addTo(map);

  /* Frame the walking route; the guidance connector refreshes on top of it. */
  map.fitBounds(routePolyline.getBounds().pad(0.1));
  updateGuidanceLine();

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
  if (guidanceLine)  { map.removeLayer(guidanceLine);  guidanceLine = null; }
  if (guidanceLabel) { map.removeLayer(guidanceLabel); guidanceLabel = null; }
  activeDestNodeId = null;
  activeDestName = '';
  lastRouteDistance = null;
  lastRoutePos = null;
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
