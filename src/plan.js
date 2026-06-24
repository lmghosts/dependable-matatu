import { Query, Time } from 'minotor';
import { getRouter, getStopsIndex } from './app.js';
import { saveJourney, removeJourney, listJourneys, isJourneySaved } from './journeys.js';
import { fetchAggregates } from './lib/supabase.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ─── Route stops (lazy-loaded) ─────────────────────────────
let _routeStops = null;
async function getRouteStops() {
  if (_routeStops) return _routeStops;
  try {
    const res = await fetch('/route-stops.json');
    _routeStops = await res.json();
  } catch {
    _routeStops = {};
  }
  return _routeStops;
}

// ─── State ─────────────────────────────────────────────────
const state = {
  from: null,        // { stop, name }
  to: null,
  activeField: null, // 'from' | 'to'
};

// ─── DOM helpers ───────────────────────────────────────────
const el = id => document.getElementById(id);

function fmt(time) {
  return time.toString().substring(0, 5);  // "HH:MM"
}

function fmtDuration(dur) {
  const total = Math.round(dur.toSeconds() / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
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

  if (trimmed.length < 1) {
    // Show first ~8 stops from the index as a browse list
    const nearby = getAllStops(si).slice(0, 8);
    if (!nearby.length) {
      list.innerHTML = `<p class="autocomplete-empty">Type to search for stops</p>`;
      return;
    }
    list.innerHTML = `
      <div class="autocomplete-section-hd">All stops</div>
      ${nearby.map(stop => `
        <button class="autocomplete-item" data-id="${stop.sourceStopId}" data-name="${stop.name}">
          <div class="autocomplete-item__icon"><svg><use href="#icon-pin"/></svg></div>
          <div>
            <div class="autocomplete-item__name">${stop.name}</div>
            <div class="autocomplete-item__sub">${stop.locationType === 'PARENT_STATION' ? 'Station' : 'Bus stop'}</div>
          </div>
        </button>
      `).join('')}
    `;
    list.querySelectorAll('.autocomplete-item').forEach(btn => {
      const stop = nearby.find(s => s.sourceStopId === btn.dataset.id);
      btn.addEventListener('click', () => selectStop(stop, btn.dataset.name));
    });
    return;
  }

  const results = si.findStopsByName(trimmed);

  if (!results.length) {
    list.innerHTML = `<p class="autocomplete-empty">No stops found for "${trimmed}"</p>`;
    return;
  }

  const isRecent = false;
  list.innerHTML = `
    <div class="autocomplete-section-hd">${isRecent ? 'Nearby stops' : 'Results'}</div>
    ${results.slice(0, 8).map(stop => `
      <button class="autocomplete-item" data-id="${stop.sourceStopId}" data-name="${stop.name}">
        <div class="autocomplete-item__icon">
          <svg><use href="#icon-pin"/></svg>
        </div>
        <div>
          <div class="autocomplete-item__name">${stop.name}</div>
          <div class="autocomplete-item__sub">${stop.locationType.replace(/_/g, ' ').toLowerCase()}</div>
        </div>
      </button>
    `).join('')}
  `;

  list.querySelectorAll('.autocomplete-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const stop = results.find(s => s.sourceStopId === btn.dataset.id);
      selectStop(stop, btn.dataset.name);
    });
  });
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

function selectStop(stop, name) {
  if (state.activeField === 'from') {
    state.from = { stop, name };
    el('plan-from-text').textContent = name;
    el('plan-from-text').classList.add('filled');
  } else {
    state.to = { stop, name };
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
      state.from = { stop: { sourceStopId: fromId }, name: fromName };
      state.to   = { stop: { sourceStopId: toId },   name: toName };
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
          state.from?.stop.sourceStopId === fromId &&
          state.to?.stop.sourceStopId   === toId) {
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

    const query = new Query.Builder()
      .from(state.from.stop.sourceStopId)
      .to(state.to.stop.sourceStopId)
      .departureTime(depTime)
      .maxTransfers(2)
      .build();

    const result = router.route(query);
    const route = result.bestRoute();

    if (!route) {
      setResultState('no-route');
      return;
    }

    setResultState('results');
    renderRoute(route, depTime);
  } catch (err) {
    console.error('Routing error:', err);
    setResultState('error', 'Routing failed. Please try again.');
  }
}

function renderRoute(route, requestedTime) {
  const legs = route.legs;
  const dep = fmt(route.departureTime());
  const arr = fmt(route.arrivalTime());
  const dur = fmtDuration(route.totalDuration());

  const vehicleLegs = legs.filter(l => 'departureTime' in l);
  const transfers = vehicleLegs.length - 1;

  const legsHtml = legs.map((leg, i) => {
    if ('departureTime' in leg) {
      const legDur  = fmtDuration(leg.arrivalTime.diff(leg.departureTime));
      const fareId  = `plan-fare-${leg.route.name.replace(/[^a-z0-9]/gi, '-')}`;
      return `
        <button class="leg-row leg-row--tappable" data-leg="${i}" aria-label="See stops for Route ${leg.route.name}">
          <span class="leg-badge leg-badge--bus">${leg.route.name}</span>
          <div class="leg-body">
            <span class="leg-stop"><strong>${leg.from.name}</strong> → ${leg.to.name}</span>
            <span class="leg-meta">${fmt(leg.departureTime)} · ${legDur}<span class="leg-fare" id="${fareId}"></span></span>
          </div>
          <svg class="leg-chevron" style="width:14px;height:14px;flex-shrink:0;color:var(--text-secondary)"><use href="#icon-chevron-right"/></svg>
        </button>`;
    }
    return `
      <div class="leg-row">
        <span class="leg-badge">Walk</span>
        <span class="leg-stop">${leg.from.name} → ${leg.to.name}</span>
      </div>`;
  }).join('');

  el('plan-results-list').innerHTML = `
    <div class="route-card">
      <div class="route-card__times">
        <span class="route-time route-time--dep">${dep}</span>
        <span class="route-arrow">→</span>
        <span class="route-time route-time--arr">${arr}</span>
        <span class="route-duration">
          <svg style="width:12px;height:12px;vertical-align:middle;margin-right:3px"><use href="#icon-clock"/></svg>
          ${dur}
        </span>
      </div>
      <div class="route-legs">${legsHtml}</div>
      ${transfers > 0 ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary)">
        <svg style="width:12px;height:12px;vertical-align:middle;margin-right:4px"><use href="#icon-transfer"/></svg>
        ${transfers} transfer${transfers > 1 ? 's' : ''}
      </div>` : ''}
    </div>
    <p style="font-size:11px;color:var(--text-secondary);text-align:center;margin:8px 0 0">Tap a route leg to see stops</p>
  `;

  // Wire leg taps
  el('plan-results-list').querySelectorAll('[data-leg]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.leg);
      showLegDetail(legs[idx]);
    });
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
      if (fareEl) fareEl.textContent = `from ~KSh ${minP50}`;
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

// ─── Route map background (empty-state decoration) ─────────
async function renderRouteMapBg() {
  const mapDiv = el('plan-map-bg');
  if (!mapDiv) return;
  const si = getStopsIndex();
  if (!si) return;

  const routeStops = await getRouteStops();

  // Build id → [lat, lon] by looking up each unique stop name directly
  // (avoids the letter-prefix coverage gap of the autocomplete strategy)
  const idToPos = new Map();
  const unique = new Map(); // id → name
  for (const stops of Object.values(routeStops)) {
    for (const s of stops) {
      if (!unique.has(s.id)) unique.set(s.id, s.name);
    }
  }

  for (const [id, name] of unique) {
    const hits = si.findStopsByName(name.slice(0, 6));
    for (const r of hits) {
      if (r.lat && r.lon && r.name.toLowerCase() === name.toLowerCase()) {
        idToPos.set(id, [r.lat, r.lon]);
        break;
      }
    }
    // Fallback: accept any hit with the same sourceStopId
    if (!idToPos.has(id)) {
      const exact = si.findStopsByName(name).find(r => r.sourceStopId === id && r.lat);
      if (exact) idToPos.set(id, [exact.lat, exact.lon]);
    }
  }

  if (idToPos.size < 20) return;

  const LAT_MIN = -1.46, LAT_MAX = -1.07;
  const LON_MIN = 36.67, LON_MAX = 37.12;
  const W = 400, H = 650;
  const toX = lon => ((lon - LON_MIN) / (LON_MAX - LON_MIN) * W).toFixed(1);
  const toY = lat => ((1 - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * H).toFixed(1);

  const paths = [];
  for (const stops of Object.values(routeStops)) {
    const pts = stops.map(s => idToPos.get(s.id)).filter(Boolean);
    if (pts.length < 2) continue;
    const d = pts.map(([lat, lon], i) => `${i ? 'L' : 'M'}${toX(lon)},${toY(lat)}`).join('');
    paths.push(`<path d="${d}"/>`);
  }
  if (!paths.length) return;

  mapDiv.innerHTML = `<svg class="route-map-svg" viewBox="0 0 ${W} ${H}"
    preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="none" stroke="var(--accent-sky)" stroke-width="1"
       stroke-linecap="round" stroke-linejoin="round">
      ${paths.join('')}
    </g>
  </svg>`;
}

// ─── State machine ─────────────────────────────────────────
function setResultState(mode, message) {
  const resultsEl = el('plan-results');
  const mapEl = el('plan-map-bg');
  if (mapEl) mapEl.hidden = (mode !== 'hidden');

  switch (mode) {
    case 'hidden':
      resultsEl.hidden = true;
      break;

    case 'loading':
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
      const fromId = state.from.stop.sourceStopId;
      const toId   = state.to.stop.sourceStopId;
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="results-section">
          <div class="results-header">
            <span class="results-title">Best route</span>
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
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">
            <svg><use href="#icon-warning"/></svg>
          </div>
          <div class="empty-state__title">No route found</div>
          <p class="empty-state__sub">No matatu connection between these stops.</p>
        </div>`;
      break;

    case 'offline':
      break; // unused — routing always attempted if graph is loaded

    case 'error':
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

// ─── Render shell ──────────────────────────────────────────
function renderShell() {
  el('view-plan').innerHTML = `
    <!-- App header -->
    <div class="view-header">
      <span class="app-name">Dependable <em>Matatu</em></span>
      <span class="gtfs-meta" id="plan-gtfs-meta">GTFS data · loading…</span>
    </div>

    <!-- Search card -->
    <div class="search-card">
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
      <button class="find-btn" id="plan-find-btn" disabled>
        Find Route
      </button>
    </div>

    <!-- Route map background (empty state) -->
    <div id="plan-map-bg" class="plan-map-bg" aria-hidden="true"></div>

    <!-- Saved journeys -->
    <div id="plan-saved" class="saved-section" hidden></div>

    <!-- Results container -->
    <div id="plan-results" hidden></div>

    <!-- Leg detail sheet -->
    <div class="detail-sheet" id="plan-leg-detail" hidden></div>

    <!-- Autocomplete overlay -->
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

  // Wire events
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

  // Update GTFS meta when graph loads + render map background
  document.addEventListener('graph:ready', e => {
    const meta = e.detail;
    const synced = new Date(meta.synced);
    const diffMs = Date.now() - synced.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    const label = diffDays === 0 ? 'today'
      : diffDays === 1 ? 'yesterday'
      : `${diffDays} days ago`;
    el('plan-gtfs-meta').textContent = `GTFS data · last synced ${label}`;
    renderRouteMapBg();
  });

  document.addEventListener('graph:error', () => {
    el('plan-gtfs-meta').textContent = 'GTFS data · unavailable offline';
  });
}
