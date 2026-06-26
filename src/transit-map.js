// ─── Transit map — loads pre-generated SVG, adds TfL Go stop markers,
//     then attaches pan/zoom.  No tile dependency, fully offline.

// ─── TfL Go stop marker overlay ────────────────────────────
// Stop markers use TfL Go design cues:
//   • Small hollow circle on the route line = normal stop
//   • Larger hollow circle with thicker ring = interchange / terminal
// These are added on top of the pre-generated route network SVG.
//
// We map the geographic GPS coordinates → PDF schematic space using a
// crude linear projection anchored on two known reference points from
// the extracted text labels:
//   THIKA ROAD label  → geo (NE): lon≈36.99  lat≈-1.13
//   NGONG ROAD label  → geo (SW): lon≈36.82  lat≈-1.35
//   In PDF px coords those labels appeared at ≈(1431,713) and (927,1055).
//
// This is an approximation — good enough for terminal-level markers.
const REF = {
  geo1: [36.817223, -1.286389], svgPt1: [1900, 1490], // CBD anchor (4147×2764 canvas)
  geo2: [36.985,   -1.075],    svgPt2: [2690, 920],   // Thika Road anchor
};
const [dx_lon, dx_lat] = [
  (REF.svgPt2[0] - REF.svgPt1[0]) / (REF.geo2[0] - REF.geo1[0]),
  (REF.svgPt2[1] - REF.svgPt1[1]) / (REF.geo2[1] - REF.geo1[1]),
];
function geoToSvg(lon, lat) {
  return [
    REF.svgPt1[0] + (lon - REF.geo1[0]) * dx_lon,
    REF.svgPt1[1] + (lat - REF.geo1[1]) * dx_lat,
  ];
}

function buildStopMarkers(si, routableStops) {
  if (!routableStops || !si) return '';
  const circles = [];
  for (const [srcId, count] of Object.entries(routableStops)) {
    if (count < 8) continue;
    const stop = si.findStopBySourceStopId(srcId);
    if (!stop?.lat || !stop?.lon) continue;
    const [x, y] = geoToSvg(stop.lon, stop.lat);
    const isTerminal  = count >= 20;
    const isExchange  = count >= 12;
    // TfL Go: hollow white circle — larger for interchanges
    const r     = isTerminal ? 8 : isExchange ? 6 : 4;
    const sw    = isTerminal ? 2 : 1.5;
    const inner = isExchange ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r*0.45).toFixed(1)}" fill="#F5F3EE" opacity="0.9"/>` : '';
    circles.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="#F5F3EE" stroke-width="${sw}" opacity="0.9"/>${inner}`
    );
  }
  return circles.join('');
}

// ─── Pan / zoom ────────────────────────────────────────────
// Designer SVG canvas is 4147 × 2764.
// Initial view centres on CBD at ~58% zoom so the core network fills the screen.
const PW = 4147, PH = 2764;

function initPanZoom(svg, initVB) {
  let vb = { ...initVB };
  const MIN_W = PW * 0.12;   // ~8× max zoom
  const MAX_W = PW * 1.2;    // slight zoom-out

  let dragging = false, lastMouse = null;
  let lastDist = null, lastMid = null;

  function clamp() {
    vb.w = Math.max(MIN_W, Math.min(MAX_W, vb.w));
    vb.h = vb.w * (PH / PW);
    vb.x = Math.max(-PW * 0.05, Math.min(PW * 1.05 - vb.w, vb.x));
    vb.y = Math.max(-PH * 0.05, Math.min(PH * 1.05 - vb.h, vb.y));
  }
  function apply() {
    clamp();
    svg.setAttribute('viewBox',
      `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`);
  }
  function svgPt(cx, cy) {
    const r = svg.getBoundingClientRect();
    return {
      x: (cx - r.left) / r.width  * vb.w + vb.x,
      y: (cy - r.top)  / r.height * vb.h + vb.y,
    };
  }
  function zoom(factor, cx, cy) {
    const p = svgPt(cx, cy);
    vb.x = p.x - (p.x - vb.x) * factor;
    vb.y = p.y - (p.y - vb.y) * factor;
    vb.w *= factor; vb.h *= factor;
    apply();
  }

  // Mouse wheel
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.15 : 0.87, e.clientX, e.clientY);
  }, { passive: false });

  // Mouse drag
  svg.addEventListener('mousedown', e => {
    dragging = true; lastMouse = { x: e.clientX, y: e.clientY };
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging || !lastMouse) return;
    const r = svg.getBoundingClientRect();
    vb.x += (lastMouse.x - e.clientX) / r.width  * vb.w;
    vb.y += (lastMouse.y - e.clientY) / r.height * vb.h;
    lastMouse = { x: e.clientX, y: e.clientY };
    apply();
  });
  window.addEventListener('mouseup', () => {
    dragging = false; lastMouse = null;
    svg.style.cursor = 'grab';
  });

  // Touch pinch + pan
  svg.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      lastDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      lastMid  = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
    } else {
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });

  svg.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const mid  = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
      if (lastDist && lastMid) {
        const r = svg.getBoundingClientRect();
        zoom(lastDist / dist, lastMid.x, lastMid.y);
        vb.x += (lastMid.x - mid.x) / r.width  * vb.w;
        vb.y += (lastMid.y - mid.y) / r.height * vb.h;
        apply();
      }
      lastDist = dist; lastMid = mid;
    } else if (e.touches.length === 1 && lastMouse) {
      const r = svg.getBoundingClientRect();
      const t = e.touches[0];
      vb.x += (lastMouse.x - t.clientX) / r.width  * vb.w;
      vb.y += (lastMouse.y - t.clientY) / r.height * vb.h;
      lastMouse = { x: t.clientX, y: t.clientY };
      apply();
    }
  }, { passive: false });

  svg.addEventListener('touchend', () => {
    lastDist = null; lastMid = null; lastMouse = null;
  }, { passive: true });

  // Double-tap / double-click to zoom in
  let lastTap = 0;
  svg.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 300 && e.changedTouches.length === 1)
      zoom(0.55, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    lastTap = now;
  }, { passive: true });
  svg.addEventListener('dblclick', e => zoom(0.55, e.clientX, e.clientY));

  apply();
}

// ─── Public API ────────────────────────────────────────────
export async function initTransitMap(container, si, routeStops, routableStops) {
  container.style.background = '#0E0F12';

  // Load the pre-generated network SVG (extracted from the Digital Matatus PDF)
  let svgText;
  try {
    const res = await fetch('/transit-map.svg');
    svgText = await res.text();
  } catch {
    // Fallback: empty dark canvas
    container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" id="transit-svg" viewBox="0 0 2592 1728" style="width:100%;height:100%;background:#0E0F12"><rect width="2592" height="1728" fill="#0E0F12"/></svg>';
    return;
  }

  // Inject SVG into container
  container.innerHTML = svgText;
  const svg = container.querySelector('#transit-svg');
  if (!svg) return;

  // Force SVG to fill its container — designer file has explicit px dimensions
  // which would otherwise make only the top-left corner visible.
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  // slice fills the portrait container on mobile; meet leaves blank space below.
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

  // Initial view: inner-city overview centred on the network hub (~Chiromo/City Park).
  // Shows Karura Forest→South B vertically, Westlands→Eastleigh horizontally.
  // Users pan from here into the CBD detail ("City Center — See Inset").
  const MAP_CX = 2050, MAP_CY = 1200;
  const initW = PW * 0.58;
  const initH = initW * (PH / PW);
  const initVB = {
    x: MAP_CX - initW * 0.5,
    y: MAP_CY - initH * 0.5,
    w: initW, h: initH,
  };

  initPanZoom(svg, initVB);
}
