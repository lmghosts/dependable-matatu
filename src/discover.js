import { getStopsIndex, getRouter } from './app.js';

// ─── State ─────────────────────────────────────────────────
let activeTab = 'stops';
let detailView = null;  // { type: 'stop'|'sacco', data }

const el = id => document.getElementById(id);

// ─── Tab management ────────────────────────────────────────
function setTab(name) {
  activeTab = name;
  ['stops', 'routes', 'saccos'].forEach(t => {
    const tab = el(`disc-tab-${t}`);
    const panel = el(`disc-panel-${t}`);
    if (tab) { tab.classList.toggle('active', t === name); tab.setAttribute('aria-selected', String(t === name)); }
    if (panel) panel.hidden = t !== name;
  });
  const si = getStopsIndex();
  if (name === 'stops') renderStopsList(si, '');
  if (name === 'routes') renderRoutesList(si);
  if (name === 'saccos') renderSaccosList(si);
}

// ─── Stops tab ─────────────────────────────────────────────
function renderStopsList(si, query) {
  const panel = el('disc-panel-stops');
  if (!si) {
    panel.innerHTML = `<p class="text-secondary" style="padding:20px 16px;font-size:14px">Routing graph loading…</p>`;
    return;
  }

  const stops = query
    ? si.findStopsByName(query)
    : getAllStops(si);

  if (!stops.length) {
    panel.innerHTML = `<p class="autocomplete-empty">No stops found for "${query}"</p>`;
    return;
  }

  panel.innerHTML = stops.slice(0, 50).map(stop => `
    <button class="list-item" data-sid="${stop.sourceStopId}">
      <div class="list-item__icon"><svg><use href="#icon-pin"/></svg></div>
      <div class="list-item__body">
        <div class="list-item__name">${stop.name}</div>
        <div class="list-item__sub">${stop.locationType === 'PARENT_STATION' ? 'Station' : 'Bus stop'}</div>
      </div>
      <div class="list-item__right"><svg><use href="#icon-chevron-right"/></svg></div>
    </button>
  `).join('');

  panel.querySelectorAll('.list-item').forEach(btn => {
    const sid = btn.dataset.sid;
    const stop = stops.find(s => s.sourceStopId === sid);
    btn.addEventListener('click', () => showStopDetail(stop));
  });
}

function getAllStops(si) {
  // StopsIndex doesn't expose a full iteration API directly.
  // Use findStopsByName with common Nairobi prefixes to get a broad set.
  const queries = ['', 'a', 'e', 'i', 'o', 'u', 'k', 'm', 'n', 'g', 'w'];
  const seen = new Set();
  const results = [];
  for (const q of queries) {
    for (const stop of si.findStopsByName(q)) {
      if (!seen.has(stop.sourceStopId)) {
        seen.add(stop.sourceStopId);
        results.push(stop);
      }
    }
  }
  return results;
}

// ─── Routes tab ────────────────────────────────────────────
function renderRoutesList(si) {
  const panel = el('disc-panel-routes');
  if (!si) {
    panel.innerHTML = `<p class="text-secondary" style="padding:20px 16px;font-size:14px">Routing graph loading…</p>`;
    return;
  }

  const routes = getKnownRoutes();

  panel.innerHTML = routes.map(r => `
    <button class="list-item"
      data-fares-id="${r.faresId}"
      data-fares-name="${r.faresName.replace(/"/g, '&quot;')}">
      <div class="list-item__icon" style="background:${r.color}18;color:${r.color}">
        <svg><use href="#icon-bus"/></svg>
      </div>
      <div class="list-item__body">
        <div class="list-item__name">Route ${r.name}</div>
        <div class="list-item__sub">${r.long} · ${r.sacco}</div>
      </div>
      <div class="list-item__right"><svg><use href="#icon-chevron-right"/></svg></div>
    </button>
  `).join('');

  panel.querySelectorAll('.list-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate:fares', {
        detail: { routeId: btn.dataset.faresId, routeName: btn.dataset.faresName }
      }));
    });
  });
}

function getKnownRoutes() {
  return [
    { faresId: 'R30',  name: '30',  faresName: 'Route 30 — Odeon-Westlands-Kangemi-Uthiru',                    long: 'Odeon – Westlands – Kangemi – Uthiru',          sacco: 'Citi Hoppa',  color: '#2EC4F0' },
    { faresId: 'R58',  name: '58',  faresName: 'Route 58 — Ambassadeur-Jogoo Road-Buruburu',                   long: 'Ambassadeur – Jogoo Road – Buruburu',            sacco: 'Citi Hoppa',  color: '#2EC4F0' },
    { faresId: 'R237', name: '237', faresName: 'Route 237 — Munyu Road-Pangani-Roysambu-Githurai-KU-Ruiru-Juja-Thika', long: 'Githurai – KU – Ruiru – Juja – Thika',  sacco: 'Umoinner',    color: '#FFC400' },
    { faresId: 'R125', name: '125', faresName: 'Route 125 — Railways-Langata Road-Bomas-Ongata Rongai',        long: 'Railways – Langata Road – Ongata Rongai',        sacco: 'South Rift',  color: '#FF5722' },
    { faresId: 'R110', name: '110', faresName: 'Route 110 — Railways-Mombasa Road-Mlolongo-Kitengela',         long: 'Railways – Mombasa Road – Mlolongo – Kitengela', sacco: 'Kitengela',   color: '#FF5722' },
  ];
}

// ─── SACCOs tab ────────────────────────────────────────────
function renderSaccosList(si) {
  const panel = el('disc-panel-saccos');

  const saccos = [
    { id: 'GM', name: 'Githurai Matatu SACCO', routes: ['104', '45', '237'], stops: 'Thika Rd corridor' },
    { id: 'UM', name: 'Umoinner SACCO', routes: ['237', '58'], stops: 'Eastlands · CBD' },
    { id: 'CH', name: 'Citi Hoppa SACCO', routes: ['58', '33'], stops: 'Mombasa Rd · Westlands' },
  ];

  panel.innerHTML = saccos.map(sacco => `
    <button class="list-item" data-sacco-id="${sacco.id}">
      <div class="list-item__icon" style="background:rgba(123,92,255,.1);color:var(--accent-violet)">
        <svg><use href="#icon-building"/></svg>
      </div>
      <div class="list-item__body">
        <div class="list-item__name">${sacco.name}</div>
        <div class="list-item__sub">${sacco.routes.length} routes · ${sacco.stops}</div>
      </div>
      <div class="list-item__right"><svg><use href="#icon-chevron-right"/></svg></div>
    </button>
  `).join('');

  panel.querySelectorAll('.list-item').forEach(btn => {
    const sacco = saccos.find(s => s.id === btn.dataset.saccoId);
    btn.addEventListener('click', () => showSaccoDetail(sacco));
  });
}

// ─── Stop detail ───────────────────────────────────────────
function showStopDetail(stop) {
  const view = el('disc-detail');
  const si = getStopsIndex();

  // Check if this is an informal stop (not in GTFS)
  const isInformal = stop.locationType === 'GENERIC_NODE';

  if (isInformal) {
    view.innerHTML = renderInformalStop(stop);
  } else {
    view.innerHTML = `
      <div class="detail-header">
        <button class="back-btn" id="disc-back"><svg><use href="#icon-chevron-left"/></svg></button>
        <h2 class="detail-title">${stop.name}</h2>
      </div>
      <div style="padding:16px">
        <div class="card" style="padding:16px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">
            Stop Details
          </div>
          <div style="font-size:14px;color:var(--text-secondary);margin-bottom:4px">ID: ${stop.sourceStopId}</div>
          ${stop.lat ? `<div style="font-size:14px;color:var(--text-secondary)">
            ${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}
          </div>` : ''}
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">
          Connections
        </div>
        <p style="font-size:14px;color:var(--text-secondary);padding:0 0 8px">
          Routes serving this stop are derived from the cached timetable.
          Tap <strong>Plan</strong> to find a route from this stop.
        </p>
      </div>
    `;
  }

  view.hidden = false;
  el('disc-back')?.addEventListener('click', hideDetail);
}

function renderInformalStop(stop) {
  return `
    <div class="detail-header">
      <button class="back-btn" id="disc-back"><svg><use href="#icon-chevron-left"/></svg></button>
      <h2 class="detail-title">${stop.name}</h2>
    </div>
    <div class="informal-notice">
      <span class="informal-notice__badge">
        <svg><use href="#icon-warning"/></svg> Informal stop
      </span>
      <h3 class="informal-notice__title">${stop.name}</h3>
      <p class="informal-notice__text">
        This stop is an informal boarding/alighting point and may not appear in the GTFS routing graph.
        Matatus serving this area typically pass nearby — look for the nearest official stop.
      </p>
    </div>
  `;
}

// ─── SACCO detail ──────────────────────────────────────────
function showSaccoDetail(sacco) {
  const view = el('disc-detail');

  view.innerHTML = `
    <div class="detail-header">
      <button class="back-btn" id="disc-back"><svg><use href="#icon-chevron-left"/></svg></button>
      <h2 class="detail-title">${sacco.name}</h2>
    </div>

    <div class="sacco-hero">
      <div class="sacco-hero__name">${sacco.name}</div>
      <div class="sacco-hero__routes">
        ${sacco.routes.map(r => `<span class="route-chip">Route ${r}</span>`).join('')}
      </div>
    </div>

    <div class="premise3-notice">
      <div class="premise3-notice__icon"><svg><use href="#icon-info"/></svg></div>
      <div>
        Ratings and reliability scores are not shown. Dependable Matatu surfaces
        crowd-sourced fare data only — operator quality comparisons are not part of v1.
      </div>
    </div>

    <div style="padding:0 16px">
      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">
        Routes operated
      </div>
      ${sacco.routes.map(r => `
        <div class="list-item" style="cursor:default">
          <div class="list-item__icon" style="background:rgba(255,87,34,.1);color:var(--accent-flame)">
            <svg><use href="#icon-bus"/></svg>
          </div>
          <div class="list-item__body">
            <div class="list-item__name">Route ${r}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  view.hidden = false;
  el('disc-back')?.addEventListener('click', hideDetail);
}

function hideDetail() {
  el('disc-detail').hidden = true;
}

// ─── Search ────────────────────────────────────────────────
function onSearch(query) {
  const si = getStopsIndex();
  if (activeTab === 'stops') renderStopsList(si, query);
}

// ─── Shell ─────────────────────────────────────────────────
function renderShell() {
  el('view-discover').innerHTML = `
    <div class="view-header">
      <span class="app-name">Dependable <em>Matatu</em></span>
    </div>

    <!-- Tabs -->
    <div class="tabs-row" role="tablist">
      <button class="tab active" id="disc-tab-stops" role="tab"
        aria-selected="true" aria-controls="disc-panel-stops">Stops</button>
      <button class="tab" id="disc-tab-routes" role="tab"
        aria-selected="false" aria-controls="disc-panel-routes">Routes</button>
      <button class="tab" id="disc-tab-saccos" role="tab"
        aria-selected="false" aria-controls="disc-panel-saccos">SACCOs</button>
    </div>

    <!-- Search -->
    <div class="discover-search">
      <div class="discover-search-wrap">
        <svg><use href="#icon-search"/></svg>
        <input class="discover-search-input" id="disc-search"
          type="search" placeholder="Search stops…" autocomplete="off" />
      </div>
    </div>

    <!-- Panels -->
    <div id="disc-panel-stops" class="pb-safe">
      <p class="text-secondary" style="padding:20px 16px;font-size:14px">Routing graph loading…</p>
    </div>
    <div id="disc-panel-routes" class="pb-safe" hidden></div>
    <div id="disc-panel-saccos" class="pb-safe" hidden></div>

    <!-- Detail overlay -->
    <div id="disc-detail" class="view" style="background:var(--bg);z-index:50" hidden></div>
  `;

  // Tab events
  ['stops', 'routes', 'saccos'].forEach(tab => {
    el(`disc-tab-${tab}`).addEventListener('click', () => setTab(tab));
  });

  // Search
  let debounce;
  el('disc-search').addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onSearch(e.target.value), 200);
  });
}

// ─── Public init ───────────────────────────────────────────
export function initDiscover() {
  renderShell();

  document.addEventListener('graph:ready', () => {
    const si = getStopsIndex();
    if (activeTab === 'stops') renderStopsList(si, '');
    if (activeTab === 'routes') renderRoutesList(si);
    if (activeTab === 'saccos') renderSaccosList(si);
  });
}
