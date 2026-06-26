// ─── Helpers ───────────────────────────────────────────────
function fmt(time) { return time.toString().substring(0, 5); }

export function routeColor(name) {
  const n = String(name);
  if (/^(104|237|145|44[GKZ]?|45[KGP]?|17[AB]?|239|133)/.test(n)) return '#2EC4F0';
  if (/^(33|34[BJL]?|110[A-Z]*)/.test(n))                           return '#FF5722';
  if (/^(111|125|126[A-Z]?|15|16|24[A-Z]?)/.test(n))               return '#1FB876';
  if (/^(58|23[A-Z]*|46[A-Z]*|14[A-Z]*|28|26[A-Z]*)/.test(n))     return '#7B5CFF';
  if (/^(30|105|107[A-Z]?|108|115|116|118|119[A-Z]?|48[A-Z]?|56|106|114)/.test(n)) return '#FFC400';
  return '#A8A8A0';
}

// Count intermediate stops (not counting board/alight endpoints).
// Returns null when data isn't available — the UI degrades gracefully.
function countStops(routeName, fromId, toId, routeStops) {
  const stops = routeStops?.[routeName];
  if (!stops) return null;
  const from = stops.findIndex(s => s.id === fromId);
  const to   = stops.findIndex(s => s.id === toId);
  if (from === -1 || to === -1 || to <= from) return null;
  return to - from - 1;
}

function navButton(stop) {
  if (!stop?.lat && !stop?.lon) return '';
  const { lat, lon, name } = stop;
  const label   = encodeURIComponent(name ?? '');
  const geoUri  = `geo:${lat},${lon}?q=${lat},${lon}(${label})`;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
  return `
    <button class="step-nav-btn"
      data-geo="${geoUri}"
      data-maps="${mapsUrl}"
      aria-label="Navigate to ${name}">
      <svg style="width:12px;height:12px;flex-shrink:0"><use href="#icon-pin"/></svg>
      Navigate here
    </button>`;
}

// ─── Step-line renderer ────────────────────────────────────
// Returns an HTML string representing the vertical step timeline.
export function renderStepLine(legs, routeStops, stopsIndex) {
  const vehicleLegs = legs.filter(l => 'departureTime' in l);
  if (!vehicleLegs.length) return '';

  let html = '<div class="step-timeline">';

  vehicleLegs.forEach((leg, idx) => {
    const color    = routeColor(leg.route.name);
    const isFirst  = idx === 0;
    const midCount = countStops(leg.route.name, leg.from.sourceStopId, leg.to.sourceStopId, routeStops);

    // Look up coordinates from stopsIndex for the navigate button
    const fromStop = stopsIndex?.findStopBySourceStopId(leg.from.sourceStopId) ?? leg.from;

    // ── Board / transfer node ──
    html += `
      <div class="step-node ${isFirst ? 'step-node--board' : 'step-node--transfer'}">
        <div class="step-rail">
          <div class="step-dot" style="border-color:${color};background:${isFirst ? color : 'var(--surface)'}"></div>
          <div class="step-track" style="background:${color}"></div>
        </div>
        <div class="step-info">
          <div class="step-stop-name">${leg.from.name}</div>
          <div class="step-meta">
            <span class="step-time">${fmt(leg.departureTime)}</span>
            <span class="step-route-badge" style="background:${color}18;color:${color}">Route ${leg.route.name}</span>
          </div>
          ${navButton(fromStop)}
        </div>
      </div>`;

    // ── Intermediate stops count ──
    if (midCount !== null && midCount > 0) {
      html += `
        <div class="step-node step-node--count">
          <div class="step-rail">
            <div class="step-track step-track--dashed" style="background:${color}"></div>
          </div>
          <div class="step-info step-info--count">${midCount} stop${midCount !== 1 ? 's' : ''}</div>
        </div>`;
    }
  });

  // ── Alighting node ──
  const last     = vehicleLegs[vehicleLegs.length - 1];
  const lastColor = routeColor(last.route.name);
  const toStop   = stopsIndex?.findStopBySourceStopId(last.to.sourceStopId) ?? last.to;

  html += `
    <div class="step-node step-node--alight">
      <div class="step-rail">
        <div class="step-dot step-dot--alight" style="border-color:${lastColor}"></div>
      </div>
      <div class="step-info">
        <div class="step-stop-name">${last.to.name}</div>
        <div class="step-meta">
          <span class="step-time">${fmt(last.arrivalTime)}</span>
          <span style="font-size:11px;color:var(--text-secondary)">Alight</span>
        </div>
        ${navButton(toStop)}
      </div>
    </div>`;

  html += '</div>';
  return html;
}

// Wire navigate buttons inside a container element.
export function wireStepNavButtons(container) {
  container.querySelectorAll('.step-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const geoUri  = btn.dataset.geo;
      const mapsUrl = btn.dataset.maps;
      const a = document.createElement('a');
      a.href = geoUri; a.target = '_blank';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => { if (!document.hidden) window.open(mapsUrl, '_blank'); }, 500);
    });
  });
}
