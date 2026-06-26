// ─── Projection ────────────────────────────────────────────
// Geographic bounds covering the full Nairobi matatu network.
const LAT_MIN = -1.50, LAT_MAX = -0.98;
const LON_MIN = 36.58, LON_MAX = 37.15;
const W = 1000, H = 850;

function toX(lon) { return ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W; }
function toY(lat) { return (1 - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * H; }

// ─── Corridor colour ───────────────────────────────────────
// Corridor-based colouring using the app design tokens.
// Routes not matching a named corridor get a muted neutral.
function routeColor(name) {
  const n = String(name);
  // Thika Road corridor — sky
  if (/^(104|237|145|44[GKZ]?|45[KGP]?|17[AB]?|239|133|45G|45P|44G|44K|44Z|45K|145[BD]?)/.test(n)) return '#2EC4F0';
  // Mombasa Road / Eastlands — flame
  if (/^(33[A-Z]*|34[A-Z]*|110[A-Z]*|19[A-Z]*|35|36|38|39[A-Z]*|20|1960|1961|3560|3738)/.test(n)) return '#FF5722';
  // Ngong Road / Karen / Rongai — green
  if (/^(111|125|126[A-Z]?|15|16|24[A-Z]?|8|4|2)/.test(n)) return '#1FB876';
  // Jogoo Road / Eastleigh — violet
  if (/^(58|23[A-Z]*|46[A-Z]*|14[A-Z]*|28|26[A-Z]*|6[A-Z]?|7[A-Z]?|11[A-Z]?|29)/.test(n)) return '#7B5CFF';
  // Westlands / Kangemi / Limuru — amber
  if (/^(30|105|107[A-Z]?|108|115|116|118|119[A-Z]?|48[A-Z]?|56|106|114[A-Z]?|135|100[A-Z]?|120|121|102|103)/.test(n)) return '#FFC400';
  // Githurai / Kasarani branch — sky (lighter, same corridor)
  if (/^(49|53|25[A-Z]?|27|43)/.test(n)) return '#2EC4F0';
  // South / Langata — green (same corridor)
  if (/^(5|11B|16\/62|12[A-Z]?)/.test(n)) return '#1FB876';
  // Unlabelled — neutral ghost
  return 'rgba(255,255,255,0.22)';
}

// ─── Schematiser ───────────────────────────────────────────
// Converts each A→B segment to at most two segments constrained to
// 0°, 45°, or 90° angles — replicating the Digital Matatus map style.
function schematizeSegment(lat1, lon1, lat2, lon2) {
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const adlat = Math.abs(dlat);
  const adlon = Math.abs(dlon);

  if (adlat < 4e-5 && adlon < 4e-5) return [];

  const ratio = adlat / (adlon || 1e-9);

  // Within 22.5° of a cardinal axis → single straight segment
  if (ratio > 2.414 || ratio < 0.414) return [];

  // Diagonal zone: go diagonal until one axis aligns, then straight
  const diagLen = Math.min(adlat, adlon);
  const midLat  = lat1 + diagLen * Math.sign(dlat);
  const midLon  = lon1 + diagLen * Math.sign(dlon);

  const nearStart = Math.abs(midLat - lat1) < 1e-5 && Math.abs(midLon - lon1) < 1e-5;
  const nearEnd   = Math.abs(midLat - lat2) < 1e-5 && Math.abs(midLon - lon2) < 1e-5;
  if (nearStart || nearEnd) return [];
  return [[midLat, midLon]];
}

function schematizePath(geoCoords, step = 8) {
  if (geoCoords.length < 2) return geoCoords;

  // Reduce to key waypoints
  const keyPts = [geoCoords[0]];
  for (let i = step; i < geoCoords.length - 1; i += step) keyPts.push(geoCoords[i]);
  keyPts.push(geoCoords[geoCoords.length - 1]);

  // Insert angular elbows between consecutive waypoints
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

// Convert a schematic geo path to an SVG `d` attribute string.
function toSvgPath(geoPts) {
  return geoPts
    .map(([lat, lon], i) => `${i ? 'L' : 'M'}${toX(lon).toFixed(1)},${toY(lat).toFixed(1)}`)
    .join(' ');
}

// ─── SVG generation ────────────────────────────────────────
function buildSvg(si, routeStops, routableStops) {
  const routes = [];
  const dots   = [];
  const labels = [];

  // ── Route lines ──
  for (const [routeName, stops] of Object.entries(routeStops)) {
    const geo = [];
    for (const s of stops) {
      const stop = si.findStopBySourceStopId(s.id);
      if (stop?.lat && stop?.lon) geo.push([stop.lat, stop.lon]);
    }
    if (geo.length < 2) continue;

    const schematic = schematizePath(geo);
    if (schematic.length < 2) continue;

    const d     = toSvgPath(schematic);
    const color = routeColor(routeName);
    routes.push(
      `<path d="${d}" stroke="${color}" fill="none" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.78"/>`
    );
  }

  // ── Stop circles for major terminals ──
  if (routableStops) {
    for (const [srcId, count] of Object.entries(routableStops)) {
      if (count < 10) continue;
      const stop = si.findStopBySourceStopId(srcId);
      if (!stop?.lat || !stop?.lon) continue;
      const x = toX(stop.lon).toFixed(1);
      const y = toY(stop.lat).toFixed(1);
      const r = count >= 20 ? 5 : count >= 15 ? 4 : 3;
      const fill = count >= 20 ? '#FFFFFF' : '#F5F3EE';
      dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="0.85"/>`);
    }
  }

  // ── CBD hub marker ──
  const cbdX = toX(36.817223).toFixed(1);
  const cbdY = toY(-1.286389).toFixed(1);
  dots.push(
    `<circle cx="${cbdX}" cy="${cbdY}" r="7" fill="none" stroke="#F5F3EE" stroke-width="1.5" opacity="0.5"/>`,
    `<circle cx="${cbdX}" cy="${cbdY}" r="3" fill="#F5F3EE" opacity="0.6"/>`
  );

  // ── Corridor text labels ──
  // Placed at approximate corridor termini in SVG coordinates
  const corridorLabels = [
    // [label, lon, lat, anchor]
    ['Thika Rd',     36.97, -1.13, 'middle'],  // pulled south to stay in default view
    ['Mombasa Rd',   37.05, -1.32, 'start'],
    ['Ngong Rd',     36.67, -1.43, 'start'],
    ['Westlands',    36.61, -1.26, 'start'],
    ['Limuru Rd',    36.67, -1.15, 'start'],
    ['CBD',          36.83, -1.30, 'start'],
  ];

  for (const [text, lon, lat, anchor] of corridorLabels) {
    const x = toX(lon).toFixed(1);
    const y = toY(lat).toFixed(1);
    labels.push(
      `<text x="${x}" y="${y}" ` +
      `fill="#A8A8A0" font-size="11" font-family="Space Grotesk, sans-serif" ` +
      `font-weight="600" text-anchor="${anchor}" letter-spacing=".04em" ` +
      `opacity="0.6">${text}</text>`
    );
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     id="transit-svg"
     viewBox="0 0 ${W} ${H}"
     style="width:100%;height:100%;display:block;cursor:grab;touch-action:none">
  <rect width="${W}" height="${H}" fill="#0E0F12"/>
  <g id="tm-routes">${routes.join('')}</g>
  <g id="tm-dots">${dots.join('')}</g>
  <g id="tm-labels">${labels.join('')}</g>
</svg>`.trim();
}

// ─── Pan / zoom ────────────────────────────────────────────
function initPanZoom(svg) {
  let vb = { x: 0, y: 0, w: W, h: H };
  const MIN_W = W * 0.18;   // max ~5.5× zoom
  const MAX_W = W * 1.4;    // slight zoom-out allowed

  let dragging = false, lastMouse = null;
  let lastDist = null, lastMid = null;

  function clamp() {
    vb.w = Math.max(MIN_W, Math.min(MAX_W, vb.w));
    vb.h = vb.w * (H / W);
    vb.x = Math.max(-W * 0.05, Math.min(W * 1.05 - vb.w, vb.x));
    vb.y = Math.max(-H * 0.05, Math.min(H * 1.05 - vb.h, vb.y));
  }
  function apply() {
    clamp();
    svg.setAttribute('viewBox',
      `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`);
  }
  function svgPt(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width  * vb.w + vb.x,
      y: (clientY - r.top)  / r.height * vb.h + vb.y,
    };
  }
  function zoom(factor, cx, cy) {
    const p = svgPt(cx, cy);
    vb.x = p.x - (p.x - vb.x) * factor;
    vb.y = p.y - (p.y - vb.y) * factor;
    vb.w *= factor;
    vb.h *= factor;
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

  // Touch pan + pinch zoom
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
        // Pinch zoom around midpoint
        zoom(lastDist / dist, lastMid.x, lastMid.y);
        // Pan with midpoint movement
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
    if (now - lastTap < 300 && e.changedTouches.length === 1) {
      zoom(0.55, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    lastTap = now;
  }, { passive: true });

  svg.addEventListener('dblclick', e => {
    zoom(0.55, e.clientX, e.clientY);
  });
}

// ─── Public API ────────────────────────────────────────────
export function initTransitMap(container, si, routeStops, routableStops) {
  container.style.background = '#0E0F12';
  container.innerHTML = buildSvg(si, routeStops, routableStops);

  const svg = container.querySelector('#transit-svg');
  if (!svg) return;

  // Start zoomed in on the core urban network — CBD centred,
  // showing roughly 70% of the full map width so lines read clearly.
  const startW = W * 0.72;
  const startH = startW * (H / W);
  const cbdX   = toX(36.817223);
  const cbdY   = toY(-1.286389);
  svg.setAttribute('viewBox',
    `${(cbdX - startW * 0.42).toFixed(1)} ${(cbdY - startH * 0.46).toFixed(1)} ` +
    `${startW.toFixed(1)} ${startH.toFixed(1)}`
  );

  initPanZoom(svg);
}
