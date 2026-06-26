import L from 'leaflet';

let _map = null;
let _tilesLoaded = false;

// ─── Corridor colour ───────────────────────────────────────
function routeColor(name) {
  const n = String(name);
  if (/^(104|237|145|44[GKZ]?|45[KGP]?|17[AB]?|239|133)/.test(n)) return '#2EC4F0'; // Thika Rd — sky
  if (/^(33|34[BJL]?|110[A-Z]*)/.test(n))                           return '#FF5722'; // Mombasa — flame
  if (/^(111|125|126[A-Z]?|15|16|24[A-Z]?)/.test(n))               return '#1FB876'; // Ngong Rd — green
  if (/^(58|23[A-Z]*|46[A-Z]*|14[A-Z]*|28|26[A-Z]*)/.test(n))     return '#7B5CFF'; // Jogoo Rd — violet
  if (/^(30|105|107[A-Z]?|108|115|116|118|119[A-Z]?|48[A-Z]?|56|106|114)/.test(n)) return '#FFC400'; // Westlands — amber
  return 'rgba(255,255,255,0.14)'; // neutral ghost for unmapped routes
}

// ─── Schematiser ───────────────────────────────────────────
// Converts a pair of geographic points into at most two segments that
// use only 0°, 45°, or 90° angles — matching the Digital Matatus / TfL Go
// cartographic style.
//
// Given A(lat1,lon1) → B(lat2,lon2):
//   • If the bearing is within 22.5° of a cardinal axis → single straight segment
//   • Otherwise → diagonal segment until one axis aligns, then cardinal segment
//
// The result is a list of intermediate points to insert between A and B.
function schematizeSegment(lat1, lon1, lat2, lon2) {
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const adlat = Math.abs(dlat);
  const adlon = Math.abs(dlon);

  // Skip negligibly small segments
  if (adlat < 5e-5 && adlon < 5e-5) return [];

  const ratio = adlat / (adlon || 1e-9);

  if (ratio > 2.414) {
    // Bearing within 22.5° of N/S — draw straight vertical, no intermediate
    return [];
  }
  if (ratio < 0.414) {
    // Bearing within 22.5° of E/W — draw straight horizontal, no intermediate
    return [];
  }

  // Between 22.5° and 67.5°: true diagonal or mixed.
  // Go diagonal for min(adlat, adlon) steps, then straight for the remainder.
  const diagLen = Math.min(adlat, adlon);
  const midLat = lat1 + diagLen * Math.sign(dlat);
  const midLon = lon1 + diagLen * Math.sign(dlon);

  // Only add midpoint if it's meaningfully different from both A and B
  const nearStart = Math.abs(midLat - lat1) < 1e-5 && Math.abs(midLon - lon1) < 1e-5;
  const nearEnd   = Math.abs(midLat - lat2) < 1e-5 && Math.abs(midLon - lon2) < 1e-5;
  if (nearStart || nearEnd) return [];
  return [[midLat, midLon]];
}

// Reduce a full GPS stop sequence to key waypoints, then schematise
// each segment between consecutive waypoints.
function schematizePath(rawCoords) {
  if (rawCoords.length < 2) return rawCoords;

  // Simplify: keep every Nth stop to reduce waypoint density.
  // Larger step = fewer waypoints = cleaner angular lines.
  const STEP = 8;
  const keyPts = [rawCoords[0]];
  for (let i = STEP; i < rawCoords.length - 1; i += STEP) {
    keyPts.push(rawCoords[i]);
  }
  keyPts.push(rawCoords[rawCoords.length - 1]);

  // Build schematic path
  const result = [keyPts[0]];
  for (let i = 1; i < keyPts.length; i++) {
    const [lat1, lon1] = result[result.length - 1];
    const [lat2, lon2] = keyPts[i];
    const mid = schematizeSegment(lat1, lon1, lat2, lon2);
    if (mid.length) result.push(...mid);
    result.push([lat2, lon2]);
  }
  return result;
}

// ─── Route polylines ───────────────────────────────────────
function buildPolylines(map, si, routeStops) {
  for (const [routeName, stops] of Object.entries(routeStops)) {
    // Collect GPS coordinates from the stops index
    const raw = [];
    for (const s of stops) {
      const stop = si.findStopBySourceStopId(s.id);
      if (stop?.lat && stop?.lon) raw.push([stop.lat, stop.lon]);
    }
    if (raw.length < 2) continue;

    // Convert to schematic (45°/90° only)
    const coords = schematizePath(raw);
    if (coords.length < 2) continue;

    L.polyline(coords, {
      color:       routeColor(routeName),
      weight:      2,
      opacity:     0.6,
      interactive: false,
      // No smoothFactor — straight segments must stay straight
      smoothFactor: 0,
    }).addTo(map);
  }
}

// ─── Stop markers ──────────────────────────────────────────
function buildStopMarkers(map, si, routableStops) {
  if (!routableStops) return;
  for (const [srcId, count] of Object.entries(routableStops)) {
    if (count < 8) continue; // major terminals only
    const stop = si.findStopBySourceStopId(srcId);
    if (!stop?.lat || !stop?.lon) continue;

    L.circleMarker([stop.lat, stop.lon], {
      radius:      count >= 15 ? 5 : 3,
      color:       '#F5F3EE',
      fillColor:   '#F5F3EE',
      fillOpacity: 0.75,
      weight:      1,
      interactive: false,
    }).addTo(map);
  }
}

// ─── Map init ──────────────────────────────────────────────
export async function initTransitMap(container, si, routeStops, routableStops) {
  _map = L.map(container, {
    center:             [-1.286389, 36.817223], // Nairobi CBD
    zoom:               12,
    zoomControl:        false,
    attributionControl: false,
    renderer:           L.svg(),
  });

  const tiles = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 19, crossOrigin: true }
  );

  tiles.on('tileload', () => {
    if (!_tilesLoaded) {
      _tilesLoaded = true;
      const fallback = container.querySelector('.plan-map-schematic');
      if (fallback) fallback.style.opacity = '0';
    }
  });

  tiles.addTo(_map);

  // Defer polyline + marker build — non-blocking
  setTimeout(() => {
    buildPolylines(_map, si, routeStops);
    buildStopMarkers(_map, si, routableStops);
  }, 0);

  return _map;
}

export function getMap() { return _map; }
