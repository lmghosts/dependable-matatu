import L from 'leaflet';

let _map = null;
let _tilesLoaded = false;

// Corridor colour per route name — same tokens as the design system
function routeColor(name) {
  const n = String(name);
  if (/^(104|237|145|44[GKZ]?|45[KGP]?|17[AB]?|239|133)/.test(n)) return '#2EC4F0'; // Thika Rd — sky
  if (/^(33|34[BJL]?|110[A-Z]*)/.test(n))                           return '#FF5722'; // Mombasa — flame
  if (/^(111|125|126[A-Z]?|15|16|24[A-Z]?)/.test(n))               return '#1FB876'; // Ngong Rd — green
  if (/^(58|23[A-Z]*|46[A-Z]*|14[A-Z]*|28|26[A-Z]*)/.test(n))     return '#7B5CFF'; // Jogoo Rd — violet
  if (/^(30|105|107[A-Z]?|108|115|116|118|119[A-Z]?|48[A-Z]?|56|106|114)/.test(n)) return '#FFC400'; // Westlands — amber
  return 'rgba(255,255,255,0.12)'; // unmapped route — neutral ghost
}

// Build route polylines from route-stops.json + stops index.
// Deferred via setTimeout so it doesn't block the initial render.
function buildPolylines(map, si, routeStops) {
  for (const [routeName, stops] of Object.entries(routeStops)) {
    const coords = [];
    for (const s of stops) {
      const stop = si.findStopBySourceStopId(s.id);
      if (stop?.lat && stop?.lon) coords.push([stop.lat, stop.lon]);
    }
    if (coords.length < 2) continue;

    L.polyline(coords, {
      color:     routeColor(routeName),
      weight:    2,
      opacity:   0.55,
      interactive: false,
      smoothFactor: 1.5,
    }).addTo(map);
  }
}

// Key stop markers — only stops with high route counts to avoid clutter.
function buildStopMarkers(map, si, routableStops) {
  if (!routableStops) return;
  for (const [srcId, count] of Object.entries(routableStops)) {
    if (count < 8) continue; // only major terminals
    const stop = si.findStopBySourceStopId(srcId);
    if (!stop?.lat || !stop?.lon) continue;

    L.circleMarker([stop.lat, stop.lon], {
      radius:      count >= 15 ? 5 : 3,
      color:       '#F5F3EE',
      fillColor:   '#F5F3EE',
      fillOpacity: 0.7,
      weight:      1,
      interactive: false,
    }).addTo(map);
  }
}

// Initialise the Leaflet map inside `container`.
// Returns the Leaflet map instance.
export async function initTransitMap(container, si, routeStops, routableStops) {
  _map = L.map(container, {
    center:            [-1.286389, 36.817223], // Nairobi CBD
    zoom:              12,
    zoomControl:       false,
    attributionControl: false,
    renderer:          L.svg(),               // SVG renderer — safer in Capacitor WebViews
  });

  // CartoDB Dark Matter — dark base map, no API key required
  const tiles = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 19, crossOrigin: true }
  );

  tiles.on('tileload', () => {
    if (!_tilesLoaded) {
      _tilesLoaded = true;
      // Fade out the schematic fallback once real tiles start appearing
      const fallback = container.querySelector('.plan-map-schematic');
      if (fallback) fallback.style.opacity = '0';
    }
  });

  tiles.addTo(_map);

  // Defer polyline + marker building — keeps the UI thread free at launch
  setTimeout(() => {
    buildPolylines(_map, si, routeStops);
    buildStopMarkers(_map, si, routableStops);
  }, 0);

  return _map;
}

export function getMap() { return _map; }
