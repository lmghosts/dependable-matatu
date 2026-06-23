import { Query, Time } from 'minotor';
import { getRouter, getStopsIndex } from './app.js';

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
            <div class="autocomplete-item__sub">${stop.sourceStopId}</div>
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
      const legDur = fmtDuration(leg.arrivalTime.diff(leg.departureTime));
      return `
        <button class="leg-row leg-row--tappable" data-leg="${i}" aria-label="See stops for Route ${leg.route.name}">
          <span class="leg-badge leg-badge--bus">${leg.route.name}</span>
          <span class="leg-stop"><strong>${leg.from.name}</strong> → ${leg.to.name}</span>
          <span class="leg-meta">${fmt(leg.departureTime)} · ${legDur}</span>
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

// ─── State machine ─────────────────────────────────────────
function setResultState(state, message) {
  const resultsEl = el('plan-results');

  switch (state) {
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

    case 'results':
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="results-section">
          <div class="results-header">
            <span class="results-title">Best route</span>
          </div>
          <div id="plan-results-list"></div>
        </div>`;
      break;

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

  // Update GTFS meta when graph loads
  document.addEventListener('graph:ready', e => {
    const meta = e.detail;
    const synced = new Date(meta.synced);
    const diffMs = Date.now() - synced.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    const label = diffDays === 0 ? 'today'
      : diffDays === 1 ? 'yesterday'
      : `${diffDays} days ago`;
    el('plan-gtfs-meta').textContent = `GTFS data · last synced ${label}`;
  });

  document.addEventListener('graph:error', () => {
    el('plan-gtfs-meta').textContent = 'GTFS data · unavailable offline';
  });
}
