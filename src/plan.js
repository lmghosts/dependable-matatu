import { Query, Time } from 'minotor';
import { getRouter, getStopsIndex } from './app.js';
import { saveJourney, removeJourney, listJourneys, isJourneySaved } from './journeys.js';
import { fetchAggregates, submitReport } from './lib/supabase.js';
import { enqueue } from './lib/offline-queue.js';
import { getDeviceId } from './lib/device-id.js';
import { initTransitMap } from './transit-map.js';
// transit-map.js is now a pure SVG renderer — no external tiles
import { renderStepLine, wireStepNavButtons, routeColor } from './step-line.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ─── Route stops (lazy-loaded) ─────────────────────────────
let _routeStops = null;
let _stopDirections = null; // stopId → "CBD" | "Thika" | "Roysambu" | ...

const _CBD_WORDS = ['odeon','kencom','bus station','koja','railways','otc',
  'tusker','ronald ngala','commercial','muthurwa','town terminal',
  'cabanas','ngara','ambassadeur','archives','city hall'];
const _isCBD = name => _CBD_WORDS.some(c => name.toLowerCase().includes(c));

function _cleanTerminus(name) {
  return name
    .replace(/\b(terminus|terminal|town terminal|stage|bus stop|bus station|mwisho)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function _computeStopDirections(routeStops) {
  const dirs = {};
  for (const [, stops] of Object.entries(routeStops)) {
    if (stops.length < 2) continue;
    const firstCBD = _isCBD(stops[0].name);
    const lastCBD  = _isCBD(stops[stops.length - 1].name);

    if (lastCBD && !firstCBD) {
      // Route goes TO CBD — non-terminus stops are heading toward CBD
      const away = _cleanTerminus(stops[0].name) || 'CBD';
      stops.forEach((s, i) => {
        if (i < stops.length - 1 && !dirs[s.id]) dirs[s.id] = { to: 'CBD', from: away };
      });
    } else if (firstCBD && !lastCBD) {
      // Route goes FROM CBD — non-start stops are heading away from CBD
      const away = _cleanTerminus(stops[stops.length - 1].name);
      if (away) {
        stops.forEach((s, i) => {
          if (i > 0 && !dirs[s.id]) dirs[s.id] = { to: away, from: 'CBD' };
        });
      }
    } else if (!firstCBD && !lastCBD) {
      // Cross-suburban — show actual from→to but only for stops near each end
      const from = _cleanTerminus(stops[0].name);
      const to   = _cleanTerminus(stops[stops.length - 1].name);
      if (from && to) {
        stops.forEach((s, i) => {
          if (!dirs[s.id]) dirs[s.id] = { to, from };
        });
      }
    }
  }
  return dirs;
}

async function getRouteStops() {
  if (_routeStops) return _routeStops;
  try {
    const res = await fetch('/route-stops.json');
    _routeStops = await res.json();
    _stopDirections = _computeStopDirections(_routeStops);
  } catch {
    _routeStops = {};
    _stopDirections = {};
  }
  return _routeStops;
}

// ─── Routable stop index ───────────────────────────────────
// Maps sourceStopId → route count derived from timetable trip data.
// Stops absent from this map have 0 trip service and are filtered out.
// Within search results, stops are sorted by count so the most-connected
// variant of a name (e.g. "Kahawa Sukari") appears first.
let _routableStops = null;

async function loadRoutableStops() {
  if (_routableStops) return;
  try {
    const res = await fetch('/routable-stops.json');
    _routableStops = await res.json();
  } catch {
    _routableStops = {};
  }
}

// Sort stops by connectivity (most-connected first).
function rankStops(stops) {
  if (!_routableStops) return stops;
  return stops.slice().sort((a, b) =>
    (_routableStops[b.sourceStopId] ?? 0) - (_routableStops[a.sourceStopId] ?? 0)
  );
}

// Group stops by display name. Each group carries ALL matching stop IDs so
// the routing engine can try every combination and pick the best result.
// This lets users type "Westlands" and get one result — the app figures out
// which physical stage to use based on their origin/destination.
function groupStopsByName(stops) {
  const groups = new Map();
  for (const s of stops) {
    const name = s.name.trim();
    if (!groups.has(name)) groups.set(name, { name, stops: [], bestCount: 0 });
    const g = groups.get(name);
    g.stops.push(s);
    g.bestCount = Math.max(g.bestCount, _routableStops?.[s.sourceStopId] ?? 0);
  }
  return [...groups.values()].sort((a, b) => b.bestCount - a.bestCount);
}

// ─── State ─────────────────────────────────────────────────
const state = {
  from: null,        // { stop, name }
  to: null,
  activeField: null, // 'from' | 'to'
};

// ─── DOM helpers ───────────────────────────────────────────
const el = id => document.getElementById(id);

// Initialise device ID once — used for deviation reports
let _deviceId = null;
getDeviceId().then(id => { _deviceId = id; }).catch(() => {});

let _devSubtype = null;

function fmt(time) {
  return time.toString().substring(0, 5);  // "HH:MM"
}

function fmtDuration(dur) {
  const total = Math.round(dur.toSeconds() / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function corridorChip(routeName) {
  const color = routeColor(routeName);
  if (color === '#2EC4F0') return '<span class="chip chip-thika">&#9679; Thika Rd</span>';
  if (color === '#1FB876') return '<span class="chip chip-ngong">&#9679; Ngong Rd</span>';
  if (color === '#7B5CFF') return '<span class="chip chip-jogoo">&#9679; Jogoo Rd</span>';
  if (color === '#FF5722') return '<span class="chip chip-mombasa">&#9679; Mombasa Rd</span>';
  if (color === '#FFC400') return '<span class="chip chip-yellow">&#9679; Eastleigh</span>';
  return '';
}

function buildCardStepLine(vehicleLegs) {
  let html = '';
  vehicleLegs.forEach((leg, i) => {
    const color = routeColor(leg.route.name);
    html += `<div class="card-step-node" style="background:${i === 0 ? 'var(--text-secondary)' : color}"></div>`;
    html += `<div class="card-step-track" style="background:${color}"></div>`;
  });
  const lastColor = routeColor(vehicleLegs[vehicleLegs.length - 1].route.name);
  html += `<div class="card-step-node" style="background:${lastColor}"></div>`;
  return `<div class="card-step-line">${html}</div>`;
}

// ─── Autocomplete ──────────────────────────────────────────
let debounceTimer = null;

function openAutocomplete(field) {
  state.activeField = field;
  const overlay = el('plan-autocomplete');
  const input = el('plan-ac-input');
  overlay.hidden = false;
  input.value = (field === 'from' ? state.from?.name : state.to?.name) || '';
  input.placeholder = field === 'from' ? 'From where?' : 'To where?';
  input.focus();
  renderSuggestions(input.value);
}

function closeAutocomplete() {
  el('plan-autocomplete').hidden = true;
  state.activeField = null;
}

function renderSuggestions(query) {
  const list = el('plan-ac-list');
  const si = getStopsIndex();

  if (!si) {
    list.innerHTML = `<p class="autocomplete-empty">Graph still loading — try again in a moment.</p>`;
    return;
  }

  const trimmed = query.trim();

  function groupItemHtml(group) {
    return `
      <button class="autocomplete-item" data-name="${escAttr(group.name)}">
        <div class="autocomplete-item__icon"><svg><use href="#icon-pin"/></svg></div>
        <div class="autocomplete-item__body">
          <div class="autocomplete-item__name">${group.name}</div>
        </div>
      </button>`;
  }

  function wireGroups(groups) {
    list.querySelectorAll('.autocomplete-item').forEach(btn => {
      const group = groups.find(g => g.name === btn.dataset.name);
      if (group) btn.addEventListener('click', () => selectStop(group));
    });
  }

  if (trimmed.length < 1) {
    const groups = groupStopsByName(rankStops(getAllStops(si))).slice(0, 8);
    if (!groups.length) {
      list.innerHTML = `<p class="autocomplete-empty">Type to search for stops</p>`;
      return;
    }
    list.innerHTML = `<div class="autocomplete-section-hd">All stops</div>${groups.map(groupItemHtml).join('')}`;
    wireGroups(groups);
    return;
  }

  const groups = groupStopsByName(rankStops(si.findStopsByName(trimmed)));

  if (!groups.length) {
    list.innerHTML = `<p class="autocomplete-empty">No stops found for "${trimmed}" — try a nearby stage name</p>`;
    return;
  }

  list.innerHTML = `<div class="autocomplete-section-hd">Results</div>${groups.slice(0, 8).map(groupItemHtml).join('')}`;
  wireGroups(groups);
}

function getAllStops(si) {
  const seen = new Set();
  const results = [];
  for (const q of ['', 'a', 'e', 'i', 'k', 'm', 'n', 'g', 'c', 'w']) {
    for (const stop of si.findStopsByName(q)) {
      if (!seen.has(stop.sourceStopId)) {
        seen.add(stop.sourceStopId);
        results.push(stop);
      }
    }
  }
  return results;
}

// group = { name: string, stops: Stop[] } — all physical stages with this name.
// Routing tries every combination to find the best route automatically.
function selectStop(group) {
  const { name, stops } = group;
  if (state.activeField === 'from') {
    state.from = { stops, name };
    el('plan-from-text').textContent = name;
    el('plan-from-text').classList.add('filled');
  } else {
    state.to = { stops, name };
    el('plan-to-text').textContent = name;
    el('plan-to-text').classList.add('filled');
  }
  closeAutocomplete();
  syncFindBtn();
}

function syncFindBtn() {
  el('plan-find-btn').disabled = !state.from || !state.to;
}

// ─── Saved journeys list ───────────────────────────────────
async function renderSavedJourneys() {
  const section = el('plan-saved');
  if (!section) return;
  const journeys = await listJourneys();
  if (!journeys.length) {
    section.hidden = true;
    return;
  }
  const bookmarkSvg = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>`;
  section.hidden = false;
  section.innerHTML = `
    <div class="saved-section__hd">${bookmarkSvg} Saved</div>
    ${journeys.slice(0, 5).map(j => `
      <div class="saved-item">
        <button class="saved-item__run"
          data-from-id="${escAttr(j.fromId)}" data-from-name="${escAttr(j.fromName)}"
          data-to-id="${escAttr(j.toId)}"   data-to-name="${escAttr(j.toName)}">
          <span class="saved-item__label">${esc(j.fromName)} → ${esc(j.toName)}</span>
        </button>
        <button class="saved-item__unsave"
          data-from-id="${escAttr(j.fromId)}" data-to-id="${escAttr(j.toId)}"
          aria-label="Remove saved journey">
          ${bookmarkSvg}
        </button>
      </div>
    `).join('')}
  `;

  section.querySelectorAll('.saved-item__run').forEach(btn => {
    btn.addEventListener('click', () => {
      const { fromId, fromName, toId, toName } = btn.dataset;
      state.from = { stops: [{ sourceStopId: fromId }], name: fromName };
      state.to   = { stops: [{ sourceStopId: toId }],   name: toName };
      el('plan-from-text').textContent = fromName;
      el('plan-from-text').classList.add('filled');
      el('plan-to-text').textContent = toName;
      el('plan-to-text').classList.add('filled');
      syncFindBtn();
      findRoute();
    });
  });

  section.querySelectorAll('.saved-item__unsave').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { fromId, toId } = btn.dataset;
      await removeJourney(fromId, toId);
      renderSavedJourneys();
      const starBtn = el('plan-star-btn');
      if (starBtn &&
          state.from?.stops?.[0]?.sourceStopId === fromId &&
          state.to?.stops?.[0]?.sourceStopId   === toId) {
        starBtn.classList.remove('star-btn--saved');
      }
    });
  });
}

// ─── Swap ──────────────────────────────────────────────────
function swapStops() {
  [state.from, state.to] = [state.to, state.from];
  el('plan-from-text').textContent = state.from?.name ?? 'Choose origin';
  el('plan-from-text').classList.toggle('filled', !!state.from);
  el('plan-to-text').textContent = state.to?.name ?? 'Choose destination';
  el('plan-to-text').classList.toggle('filled', !!state.to);
  syncFindBtn();
}

// ─── Routing ───────────────────────────────────────────────
async function findRoute() {
  if (!state.from || !state.to) return;

  setResultState('loading');

  const router = getRouter();
  if (!router) {
    setResultState('error', 'Routing graph not loaded yet. Please wait.');
    return;
  }

  try {
    const depTime = Time.fromDate(new Date());
    let bestRoute = null;

    // Try every origin×destination stop combination — different physical stages
    // for the same name (e.g. 3 "Westlands" stops) may route differently.
    // Pick the combination that gives the earliest arrival.
    for (const from of state.from.stops) {
      for (const to of state.to.stops) {
        if (from.sourceStopId === to.sourceStopId) continue;
        try {
          const query = new Query.Builder()
            .from(from.sourceStopId)
            .to(to.sourceStopId)
            .departureTime(depTime)
            .maxTransfers(2)
            .build();
          const result = router.route(query);
          const route = result.bestRoute();
          if (route) {
            const arr = route.arrivalTime().toSeconds();
            if (!bestRoute || arr < bestRoute.arrivalTime().toSeconds()) {
              bestRoute = route;
            }
          }
        } catch { /* this stop pair has no route — try next */ }
      }
    }

    if (!bestRoute) {
      setResultState('no-route');
      return;
    }

    setResultState('results');
    renderRoute(bestRoute, depTime);
  } catch (err) {
    console.error('Routing error:', err);
    setResultState('error', 'Routing failed. Please try again.');
  }
}

// ─── Navigate to stage ─────────────────────────────────────
function navigateToStage(stop) {
  const { lat, lon, name } = stop;
  const label = encodeURIComponent(name);
  // geo: URI — Android opens the device's preferred maps app (chooser)
  // Google Maps URL — universal fallback, also deep-links into the app
  const geoUri  = `geo:${lat},${lon}?q=${lat},${lon}(${label})`;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&destination_place_id=${label}&travelmode=walking`;
  // Try geo: first; if the browser/webview can't handle it, fall back to Maps URL
  const a = document.createElement('a');
  a.href = geoUri;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Fallback: if still on the same page after 500ms, open Google Maps
  setTimeout(() => {
    if (!document.hidden) window.open(mapsUrl, '_blank');
  }, 500);
}

async function renderRoute(route, requestedTime) {
  const legs        = route.legs;
  const vehicleLegs = legs.filter(l => 'departureTime' in l);
  const transfers   = vehicleLegs.length - 1;
  const si          = getStopsIndex();
  const routeStops  = await getRouteStops();

  const durMins      = Math.round(route.totalDuration().toSeconds() / 60);
  const primaryLeg   = vehicleLegs[0];
  const fareId       = `plan-fare-${primaryLeg.route.name.replace(/[^a-z0-9]/gi, '-')}`;
  const routeNames   = vehicleLegs.map(l => l.route.name).join(' → ');
  const routeLabel   = vehicleLegs.length === 1 ? `Route ${routeNames}` : `Routes ${routeNames}`;
  const stopSeq      = [
    vehicleLegs[0].from.name,
    ...vehicleLegs.slice(1).map(l => l.from.name),
    vehicleLegs[vehicleLegs.length - 1].to.name,
  ].join(' → ');

  const corridor     = corridorChip(primaryLeg.route.name);
  const directChip   = transfers === 0 ? '<span class="chip chip-direct">Direct</span>' : '';
  const xferChip     = transfers > 0 ? `<span class="chip chip-xfer">${transfers} transfer${transfers > 1 ? 's' : ''}</span>` : '';
  const cardStepLine = buildCardStepLine(vehicleLegs);
  const stepLineHtml = renderStepLine(legs, routeStops, si);

  el('plan-results-list').innerHTML = `
    <div class="route-card best">
      <div class="card-top">
        <div class="card-tags">
          ${corridor}
          ${directChip}
          <span class="chip chip-best">Best</span>
          ${xferChip}
        </div>
        <span class="fare-badge" id="${fareId}">KSh —</span>
      </div>
      <div class="card-time-row">
        <div class="card-time">${durMins}</div>
        <div class="card-time-unit">min</div>
      </div>
      <div class="card-route-name">${routeLabel}</div>
      <div class="card-route-detail">${stopSeq}</div>
      ${cardStepLine}
      ${stepLineHtml}
      <div style="padding-top:10px;border-top:1px solid var(--surface-2)">
        <button id="plan-report-btn"
          style="display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--text-secondary);font-size:12px;cursor:pointer;padding:2px 0">
          <svg style="width:13px;height:13px;flex-shrink:0"><use href="#icon-warning"/></svg>
          Report a problem with this route
        </button>
      </div>
    </div>
  `;

  // Wire step-line navigate buttons (from step-line.js)
  wireStepNavButtons(el('plan-results-list'));

  // Wire leg taps (still supported via data-leg on step nodes if needed)
  el('plan-results-list').querySelectorAll('[data-leg]').forEach(btn => {
    btn.addEventListener('click', () => showLegDetail(legs[Number(btn.dataset.leg)]));
  });

  // Wire report button
  el('plan-report-btn')?.addEventListener('click', () => {
    showDeviationSheet(
      `R${primaryLeg.route.name}`,
      `Route ${primaryLeg.route.name} — ${primaryLeg.from.name} to ${primaryLeg.to.name}`
    );
  });

  enrichLegFares(legs);
}

// ─── P50 fare enrichment ───────────────────────────────────
async function enrichLegFares(legs) {
  const seen = new Set();
  for (const leg of legs) {
    if (!('departureTime' in leg)) continue;
    const routeId = `R${leg.route.name}`;
    if (seen.has(routeId)) continue;
    seen.add(routeId);
    try {
      const aggs = await fetchAggregates(routeId);
      if (!aggs.length) continue;
      const minP50 = Math.min(...aggs.map(a => a.p50_kes));
      const fareId = `plan-fare-${leg.route.name.replace(/[^a-z0-9]/gi, '-')}`;
      const fareEl = document.getElementById(fareId);
      if (fareEl) fareEl.textContent = `~KSh ${minP50}`;
    } catch { /* offline or no data — silent */ }
  }
}

// ─── Leg detail sheet ──────────────────────────────────────
let _detailRoute = null;

async function showLegDetail(leg) {
  const routeStops = await getRouteStops();
  const routeName  = leg.route.name;  // e.g. "105"
  const fromId     = leg.from.sourceStopId;
  const toId       = leg.to.sourceStopId;
  const depTime    = leg.departureTime;
  const arrTime    = leg.arrivalTime;

  // Find the slice of stops for this leg
  const allStops = routeStops[routeName] || [];
  const fromIdx  = allStops.findIndex(s => s.id === fromId);
  const toIdx    = allStops.findIndex(s => s.id === toId);

  let legStops;
  if (fromIdx !== -1 && toIdx !== -1 && fromIdx <= toIdx) {
    legStops = allStops.slice(fromIdx, toIdx + 1);
  } else {
    // Fallback: just show board and alight
    legStops = [
      { id: fromId, name: leg.from.name },
      { id: toId,   name: leg.to.name },
    ];
  }

  // Interpolate times linearly across stops
  const depSec = depTime.toMinutes() * 60;
  const arrSec = arrTime.toMinutes() * 60;
  const span   = arrSec - depSec;
  const n      = legStops.length - 1;

  const stopsHtml = legStops.map((stop, i) => {
    const sec     = n > 0 ? depSec + Math.round((i / n) * span) : depSec;
    const hrs     = Math.floor(sec / 3600) % 24;
    const mins    = Math.floor((sec % 3600) / 60);
    const timeStr = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
    const isBoard  = i === 0;
    const isAlight = i === legStops.length - 1;
    const dot = isBoard  ? 'detail-stop__dot--board'
              : isAlight ? 'detail-stop__dot--alight'
              : '';
    return `
      <div class="detail-stop ${isBoard ? 'detail-stop--board' : ''} ${isAlight ? 'detail-stop--alight' : ''}">
        <div class="detail-stop__line-col">
          <div class="detail-stop__dot ${dot}"></div>
          ${i < legStops.length - 1 ? '<div class="detail-stop__stem"></div>' : ''}
        </div>
        <div class="detail-stop__info">
          <span class="detail-stop__name">${stop.name}</span>
          <span class="detail-stop__time">${timeStr}</span>
        </div>
      </div>`;
  }).join('');

  const sheet = el('plan-leg-detail');
  sheet.innerHTML = `
    <div class="detail-sheet__handle"></div>
    <div class="detail-sheet__header">
      <button class="detail-sheet__close" id="plan-detail-close" aria-label="Close">
        <svg style="width:20px;height:20px"><use href="#icon-chevron-left"/></svg>
      </button>
      <div>
        <div class="detail-sheet__title">Route <strong>${routeName}</strong></div>
        <div class="detail-sheet__sub">${leg.from.name} → ${leg.to.name}</div>
      </div>
      <div class="detail-sheet__badge leg-badge leg-badge--bus">${routeName}</div>
    </div>
    <div class="detail-sheet__meta">
      <span>${fmt(depTime)} → ${fmt(arrTime)}</span>
      <span>${fmtDuration(arrTime.diff(depTime))}</span>
      <span>${legStops.length} stop${legStops.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="detail-sheet__stops" id="plan-detail-stops">
      ${stopsHtml}
    </div>
  `;
  sheet.hidden = false;
  sheet.classList.add('detail-sheet--open');

  el('plan-detail-close').addEventListener('click', closeLegDetail);
};

function closeLegDetail() {
  const sheet = el('plan-leg-detail');
  sheet.classList.remove('detail-sheet--open');
  setTimeout(() => { sheet.hidden = true; }, 260);
}

// ─── Drawer state machine ──────────────────────────────────
// States: idle | open | results
let _drawerState = 'idle';

function setDrawerState(state) {
  _drawerState = state;
  const drawer = el('plan-bottom-drawer');
  if (!drawer) return;
  drawer.className = `plan-drawer plan-drawer--${state}`;

  const pill    = el('plan-drawer-pill');
  const content = el('plan-drawer-content');
  if (pill)    pill.hidden    = (state !== 'idle');
  if (content) content.hidden = (state === 'idle');
}

function openDrawer() { setDrawerState('open'); }
function closeDrawer() { setDrawerState('idle'); }

// ─── Route map (static schematic fallback) ─────────────────
function renderRouteMapBg() {
  const mapDiv = el('plan-map-bg');
  if (!mapDiv) return;

  // Corridor colours matching app design tokens
  const SKY    = '#2EC4F0'; // Thika Rd
  const FLAME  = '#FF5722'; // Mombasa/Eastlands
  const GREEN  = '#1FB876'; // Ngong Rd
  const VIOLET = '#7B5CFF'; // Jogoo Rd
  const AMBER  = '#FFC400'; // Westlands/Kangemi

  const SW = 1.5; // stroke width for main lines
  const SB = 1.0; // stroke width for branches
  const SO = 0.10; // stroke opacity

  mapDiv.innerHTML = `<svg class="route-map-svg" viewBox="0 0 400 680"
    preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <style>
        .rm-stop { fill: none; stroke-width: 2; }
        .rm-lbl  { font-family: "Space Grotesk", sans-serif; font-size: 8px; font-weight: 600; }
      </style>
    </defs>

    <!-- ── THIKA ROAD CORRIDOR (NE) ── -->
    <g stroke="${SKY}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${SO}">
      <!-- Main trunk: CBD → NE diagonal → N → NE → terminus -->
      <path stroke-width="${SW}" d="M200,400 L260,340 L260,190 L320,130 L400,130"/>
      <!-- Branch 237/45: split at Roysambu junction -->
      <path stroke-width="${SB}" d="M260,250 L320,190 L400,190"/>
      <!-- Branch to Kahawa West/Sukari -->
      <path stroke-width="${SB}" d="M260,190 L220,150 L220,50"/>
      <!-- Branch 104 terminus spur -->
      <path stroke-width="${SB}" d="M320,130 L360,90 L400,90"/>
    </g>
    <!-- Thika Rd stops -->
    <g class="rm-stop" stroke="${SKY}" opacity="${SO + 0.04}">
      <circle cx="260" cy="340" r="3"/>
      <circle cx="260" cy="270" r="3"/>
      <circle cx="260" cy="210" r="3"/>
      <circle cx="220" cy="150" r="3"/>
      <circle cx="260" cy="190" r="2.5"/>
      <circle cx="320" cy="130" r="3"/>
      <circle cx="360" cy="90"  r="2.5"/>
    </g>
    <!-- Thika Rd labels -->
    <g class="rm-lbl" fill="${SKY}" opacity="${SO + 0.02}">
      <text x="266" y="285">237</text>
      <text x="266" y="215">104</text>
      <text x="224" y="130">145</text>
      <text x="326" y="115">45</text>
    </g>

    <!-- ── MOMBASA / EASTLANDS ROAD (E → SE) ── -->
    <g stroke="${FLAME}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${SO}">
      <!-- Main: CBD → E → SE → S (Kitengela) -->
      <path stroke-width="${SW}" d="M200,400 L310,400 L380,470 L380,580"/>
      <!-- Branch: E → NE (Eastleigh/Huruma) -->
      <path stroke-width="${SB}" d="M270,400 L330,340 L330,240 L400,240"/>
      <!-- Branch: SE → S (Mlolongo/Cabanas) -->
      <path stroke-width="${SB}" d="M310,400 L310,510 L370,570 L400,570"/>
    </g>
    <!-- Mombasa Rd stops -->
    <g class="rm-stop" stroke="${FLAME}" opacity="${SO + 0.04}">
      <circle cx="270" cy="400" r="3"/>
      <circle cx="310" cy="400" r="3"/>
      <circle cx="330" cy="340" r="2.5"/>
      <circle cx="380" cy="470" r="3"/>
      <circle cx="310" cy="510" r="2.5"/>
      <circle cx="380" cy="540" r="2.5"/>
    </g>
    <!-- Mombasa Rd labels -->
    <g class="rm-lbl" fill="${FLAME}" opacity="${SO + 0.02}">
      <text x="316" y="394">110</text>
      <text x="336" y="334">33</text>
      <text x="316" y="454">34</text>
    </g>

    <!-- ── NGONG ROAD (SW) ── -->
    <g stroke="${GREEN}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${SO}">
      <!-- Main: CBD → SW → S (Ngong/Kiserian) -->
      <path stroke-width="${SW}" d="M200,400 L130,470 L130,610"/>
      <!-- Branch west: Rongai -->
      <path stroke-width="${SB}" d="M165,435 L90,435 L30,495 L0,495"/>
      <!-- Branch east: Langata/Karen -->
      <path stroke-width="${SB}" d="M130,530 L190,590 L190,650"/>
    </g>
    <!-- Ngong Rd stops -->
    <g class="rm-stop" stroke="${GREEN}" opacity="${SO + 0.04}">
      <circle cx="165" cy="435" r="3"/>
      <circle cx="130" cy="470" r="3"/>
      <circle cx="90"  cy="435" r="2.5"/>
      <circle cx="130" cy="540" r="2.5"/>
      <circle cx="190" cy="590" r="2.5"/>
    </g>
    <!-- Ngong Rd labels -->
    <g class="rm-lbl" fill="${GREEN}" opacity="${SO + 0.02}">
      <text x="136" y="485">125</text>
      <text x="60"  y="428">126</text>
      <text x="136" y="555">111</text>
    </g>

    <!-- ── JOGOO ROAD (E) ── -->
    <g stroke="${VIOLET}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${SO}">
      <!-- Main: CBD → E (Buruburu/Umoja) -->
      <path stroke-width="${SW}" d="M200,400 L400,400"/>
      <!-- Branch S: Donholm/Kayole -->
      <path stroke-width="${SB}" d="M290,400 L290,490 L360,560 L400,560"/>
      <!-- Branch NE: Kasarani -->
      <path stroke-width="${SB}" d="M350,400 L400,350"/>
    </g>
    <!-- Jogoo Rd stops -->
    <g class="rm-stop" stroke="${VIOLET}" opacity="${SO + 0.04}">
      <circle cx="260" cy="400" r="3"/>
      <circle cx="320" cy="400" r="3"/>
      <circle cx="380" cy="400" r="2.5"/>
      <circle cx="290" cy="490" r="2.5"/>
      <circle cx="360" cy="560" r="2.5"/>
    </g>
    <!-- Jogoo Rd labels -->
    <g class="rm-lbl" fill="${VIOLET}" opacity="${SO + 0.02}">
      <text x="248" y="393">58</text>
      <text x="308" y="393">23</text>
      <text x="296" y="453">35</text>
    </g>

    <!-- ── WESTLANDS / KANGEMI (W → NW) ── -->
    <g stroke="${AMBER}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${SO}">
      <!-- Main: CBD → W → NW (Kangemi/Uthiru) -->
      <path stroke-width="${SW}" d="M200,400 L100,400 L40,340 L0,340"/>
      <!-- Branch N: Westlands/Ruaka -->
      <path stroke-width="${SB}" d="M100,400 L100,280 L60,240 L60,100"/>
      <!-- Branch NE from Westlands: Limuru Rd -->
      <path stroke-width="${SB}" d="M100,280 L150,230 L150,80 L200,30"/>
      <!-- Branch W: Kikuyu/Dagoretti -->
      <path stroke-width="${SB}" d="M40,340 L0,300"/>
    </g>
    <!-- Westlands stops -->
    <g class="rm-stop" stroke="${AMBER}" opacity="${SO + 0.04}">
      <circle cx="150" cy="400" r="3"/>
      <circle cx="100" cy="400" r="3"/>
      <circle cx="100" cy="330" r="2.5"/>
      <circle cx="100" cy="280" r="3"/>
      <circle cx="60"  cy="240" r="2.5"/>
      <circle cx="40"  cy="340" r="2.5"/>
      <circle cx="150" cy="230" r="2.5"/>
    </g>
    <!-- Westlands labels -->
    <g class="rm-lbl" fill="${AMBER}" opacity="${SO + 0.02}">
      <text x="140" y="394">30</text>
      <text x="68"  y="394">105</text>
      <text x="66"  y="260">107</text>
      <text x="46"  y="326">115</text>
    </g>

    <!-- ── CBD HUB ── -->
    <circle cx="200" cy="400" r="6" fill="none" stroke="#F5F3EE" stroke-width="1.5" opacity="0.18"/>
    <circle cx="200" cy="400" r="3" fill="#F5F3EE" opacity="0.15"/>
  </svg>`;
}

// ─── State machine ─────────────────────────────────────────
function setResultState(mode, message) {
  const resultsEl = el('plan-results');

  switch (mode) {
    case 'hidden':
      resultsEl.hidden = true;
      closeDrawer();
      break;

    case 'loading':
      setDrawerState('open');
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="results-section">
          <div class="skeleton-card">
            <div class="skel skel-pill"></div>
            <div style="display:flex;gap:8px">
              <div class="skel skel-time"></div>
              <div class="skel skel-time"></div>
            </div>
            <div class="skel skel-line"></div>
            <div class="skel skel-line short"></div>
          </div>
          <div class="skeleton-card" style="animation-delay:.15s">
            <div class="skel skel-pill"></div>
            <div style="display:flex;gap:8px">
              <div class="skel skel-time"></div>
              <div class="skel skel-time"></div>
            </div>
            <div class="skel skel-line"></div>
          </div>
        </div>`;
      break;

    case 'results': {
      const fromId = state.from.stops[0].sourceStopId;
      const toId   = state.to.stops[0].sourceStopId;
      setDrawerState('open');
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="results-section">
          <div class="results-header">
            <span class="results-title">Route found</span>
            <button class="star-btn" id="plan-star-btn" aria-label="Save journey">
              <svg viewBox="0 0 24 24" style="width:18px;height:18px">
                <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
              </svg>
            </button>
          </div>
          <div id="plan-results-list"></div>
        </div>`;
      isJourneySaved(fromId, toId).then(saved => {
        el('plan-star-btn')?.classList.toggle('star-btn--saved', saved);
      });
      el('plan-star-btn').addEventListener('click', async () => {
        const btn   = el('plan-star-btn');
        const saved = btn.classList.contains('star-btn--saved');
        if (saved) {
          await removeJourney(fromId, toId);
          btn.classList.remove('star-btn--saved');
        } else {
          await saveJourney(fromId, state.from.name, toId, state.to.name);
          btn.classList.add('star-btn--saved');
        }
        renderSavedJourneys();
      });
      break;
    }

    case 'no-route':
      setDrawerState('open');
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon"><svg><use href="#icon-warning"/></svg></div>
          <div class="empty-state__title">No route found</div>
          <p class="empty-state__sub">No matatu connection between these stops. Try a nearby stage name.</p>
        </div>`;
      break;

    case 'offline':
      break;

    case 'error':
      setDrawerState('open');
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon"><svg><use href="#icon-warning"/></svg></div>
          <div class="empty-state__title">Something went wrong</div>
          <p class="empty-state__sub">${message ?? 'Please try again.'}</p>
        </div>`;
      break;
  }
}

// ─── Deviation reporting ───────────────────────────────────
function showDeviationSheet(routeId, routeDisplay) {
  _devSubtype = null;
  const sheet = el('plan-deviation-sheet');

  sheet.innerHTML = `
    <div class="detail-sheet__handle"></div>
    <div class="detail-sheet__header">
      <button class="detail-sheet__close" id="plan-dev-close" aria-label="Close">
        <svg style="width:20px;height:20px"><use href="#icon-x"/></svg>
      </button>
      <div>
        <div class="detail-sheet__title">Report a problem</div>
        <div class="detail-sheet__sub">${esc(routeDisplay)}</div>
      </div>
    </div>
    <div style="padding:16px 16px 32px">
      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">What happened?</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px" id="plan-dev-options">
        ${[
          ['terminated_early', 'Matatu terminated early'],
          ['route_changed',    'Route changed'],
          ['other',            'Other'],
        ].map(([val, label]) => `
          <button class="dev-option" data-val="${val}"
            style="padding:12px 14px;border-radius:10px;border:1.5px solid var(--surface-2);background:var(--surface);color:var(--text-primary);font-size:14px;font-weight:500;cursor:pointer;text-align:left;transition:border-color .15s,background .15s">
            ${label}
          </button>
        `).join('')}
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Note (optional)</div>
      <textarea id="plan-dev-note" maxlength="140" placeholder="Any details? (140 chars max)"
        style="width:100%;box-sizing:border-box;background:var(--surface);border:1.5px solid var(--surface-2);border-radius:10px;padding:10px 12px;color:var(--text-primary);font-size:14px;font-family:inherit;resize:none;height:76px;outline:none;margin-bottom:4px"></textarea>
      <div id="plan-dev-chars" style="font-size:11px;color:var(--text-secondary);text-align:right;margin-bottom:16px">0 / 140</div>
      <button id="plan-dev-submit" disabled
        style="width:100%;padding:14px;background:var(--accent-flame);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:default;opacity:.4;transition:opacity .15s">
        Submit report
      </button>
    </div>
  `;

  sheet.hidden = false;
  sheet.classList.add('detail-sheet--open');

  function syncDevSubmit() {
    const btn = el('plan-dev-submit');
    if (!btn) return;
    btn.disabled = !_devSubtype;
    btn.style.opacity = _devSubtype ? '1' : '.4';
    btn.style.cursor  = _devSubtype ? 'pointer' : 'default';
  }

  sheet.querySelectorAll('.dev-option').forEach(btn => {
    btn.addEventListener('click', () => {
      sheet.querySelectorAll('.dev-option').forEach(b => {
        b.style.borderColor = 'var(--surface-2)';
        b.style.background  = 'var(--surface)';
      });
      btn.style.borderColor = 'var(--accent-flame)';
      btn.style.background  = 'rgba(255,87,34,.08)';
      _devSubtype = btn.dataset.val;
      syncDevSubmit();
    });
  });

  el('plan-dev-note').addEventListener('input', e => {
    el('plan-dev-chars').textContent = `${e.target.value.length} / 140`;
  });

  el('plan-dev-close').addEventListener('click', closeDeviationSheet);
  el('plan-dev-submit').addEventListener('click', () => handleDeviationSubmit(routeId));
}

function closeDeviationSheet() {
  const sheet = el('plan-deviation-sheet');
  sheet.classList.remove('detail-sheet--open');
  setTimeout(() => { sheet.hidden = true; }, 260);
}

async function handleDeviationSubmit(routeId) {
  const note    = el('plan-dev-note')?.value.trim() || undefined;
  const payload = {
    type:      'deviation',
    device_id: _deviceId ?? undefined,
    route_id:  routeId,
    subtype:   _devSubtype,
    note,
  };

  closeDeviationSheet();

  try {
    if (navigator.onLine) {
      await submitReport(payload);
    } else {
      await enqueue(payload);
    }
  } catch {
    await enqueue(payload).catch(() => {});
  }

  showPlanToast('Reported — thank you');
}

function showPlanToast(msg) {
  const toast = el('plan-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2000);
}

// ─── Render shell ──────────────────────────────────────────
function renderShell() {
  el('view-plan').innerHTML = `
    <!-- Interactive map (full-screen, z:1) -->
    <div id="plan-map-container" class="plan-map-container">
      <!-- Schematic fallback — visible while tiles load or offline -->
      <div class="plan-map-schematic" aria-hidden="true" id="plan-map-bg"></div>
    </div>

    <!-- Floating header over map -->
    <div class="plan-map-header">
      <span class="app-name">Matwana</span>
      <span class="gtfs-meta" id="plan-gtfs-meta">GTFS data · loading…</span>
    </div>

    <!-- Bottom drawer -->
    <div id="plan-bottom-drawer" class="plan-drawer plan-drawer--idle">
      <div class="plan-drawer__handle"></div>

      <!-- Collapsed: search pill -->
      <div id="plan-drawer-pill" class="plan-drawer__pill">
        <svg style="width:16px;height:16px;color:var(--text-secondary);flex-shrink:0"><use href="#icon-search"/></svg>
        <span style="flex:1;font-size:15px;color:var(--text-secondary)">Where to?</span>
      </div>

      <!-- Expanded: search + results -->
      <div id="plan-drawer-content" class="plan-drawer__content" hidden>
        <!-- Search card -->
        <div class="search-card" style="margin:0 0 8px">
          <div class="fields-with-swap">
            <div class="fields-stack">
              <button class="stop-field" id="plan-from-btn" aria-label="Choose origin stop">
                <div class="stop-field__dot stop-field__dot--from"></div>
                <span class="stop-field__text" id="plan-from-text">Choose origin</span>
              </button>
              <button class="stop-field" id="plan-to-btn" aria-label="Choose destination stop">
                <div class="stop-field__dot stop-field__dot--to"></div>
                <span class="stop-field__text" id="plan-to-text">Choose destination</span>
              </button>
            </div>
            <button class="swap-btn" id="plan-swap-btn" aria-label="Swap origin and destination">
              <svg><use href="#icon-swap"/></svg>
            </button>
          </div>
          <button class="find-btn" id="plan-find-btn" disabled>Find Route</button>
        </div>

        <!-- Saved journeys -->
        <div id="plan-saved" class="saved-section" hidden></div>

        <!-- Results -->
        <div id="plan-results" hidden></div>
      </div>
    </div>

    <!-- Leg detail sheet (z:20) -->
    <div class="detail-sheet" id="plan-leg-detail" hidden></div>

    <!-- Deviation report sheet (z:20) -->
    <div class="detail-sheet" id="plan-deviation-sheet" hidden></div>

    <!-- Toast (z:30) -->
    <div id="plan-toast" hidden
      style="position:absolute;bottom:84px;left:50%;transform:translateX(-50%);background:var(--surface-2);color:var(--text-primary);padding:10px 20px;border-radius:20px;font-size:13px;font-weight:500;z-index:200;white-space:nowrap;border:1px solid rgba(255,255,255,.08)">
    </div>

    <!-- Autocomplete overlay (z:40) -->
    <div class="autocomplete-overlay" id="plan-autocomplete" hidden>
      <div class="autocomplete-header">
        <button class="autocomplete-back" id="plan-ac-back" aria-label="Close search">
          <svg><use href="#icon-chevron-left"/></svg>
        </button>
        <div class="autocomplete-input-wrap">
          <svg style="width:16px;height:16px;color:var(--text-secondary);flex-shrink:0">
            <use href="#icon-search"/>
          </svg>
          <input class="autocomplete-field" id="plan-ac-input"
            type="search" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div class="autocomplete-body" id="plan-ac-list"></div>
    </div>
  `;

  // Pill → open drawer
  el('plan-drawer-pill').addEventListener('click', openDrawer);

  // Tap map area while drawer is open → close back to idle
  el('plan-map-container').addEventListener('click', () => {
    if (_drawerState === 'open') closeDrawer();
  });

  // Wire search events
  el('plan-from-btn').addEventListener('click', () => openAutocomplete('from'));
  el('plan-to-btn').addEventListener('click', () => openAutocomplete('to'));
  el('plan-swap-btn').addEventListener('click', swapStops);
  el('plan-find-btn').addEventListener('click', findRoute);
  el('plan-ac-back').addEventListener('click', closeAutocomplete);

  el('plan-ac-input').addEventListener('input', e => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderSuggestions(e.target.value), 180);
  });
  el('plan-ac-input').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAutocomplete();
  });
}

// ─── Public init ───────────────────────────────────────────
export function initPlan() {
  renderShell();
  renderSavedJourneys();

  // Schematic SVG into the fallback div (shows while Leaflet tiles load)
  renderRouteMapBg();

  // Pre-load supporting data before first keystroke
  loadRoutableStops();
  getRouteStops();

  // Initialise Leaflet map once the graph is ready (so we have stopsIndex + routeStops)
  document.addEventListener('graph:ready', async e => {
    const meta = e.detail;
    const synced   = new Date(meta.synced);
    const diffDays = Math.floor((Date.now() - synced.getTime()) / 86_400_000);
    el('plan-gtfs-meta').textContent = `GTFS data · last synced ${
      diffDays === 0 ? 'today' : diffDays === 1 ? 'yesterday' : `${diffDays} days ago`
    }`;

    const si         = getStopsIndex();
    const routeStops = await getRouteStops();
    const routable   = _routableStops;
    const container  = el('plan-map-container');
    if (container && si) {
      await initTransitMap(container, si, routeStops, routable);
    }
  });

  document.addEventListener('graph:error', () => {
    el('plan-gtfs-meta').textContent = 'GTFS data · unavailable offline';
  });
}
