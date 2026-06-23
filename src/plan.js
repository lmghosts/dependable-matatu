import { Query, Time } from 'minotor';
import { getRouter, getStopsIndex } from './app.js';

// ─── State ─────────────────────────────────────────────────
const state = {
  from: null,  // { stop, name }
  to: null,
  activeField: null,  // 'from' | 'to'
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

  // Show loading state
  setResultState('loading');

  if (!navigator.onLine) {
    setResultState('offline');
    return;
  }

  const router = getRouter();
  if (!router) {
    setResultState('error', 'Routing graph not loaded yet. Please wait.');
    return;
  }

  try {
    const now = new Date();
    const depTime = Time.fromDate(now);

    const query = new Query.Builder()
      .from(state.from.stop.sourceStopId)
      .to(state.to.stop.sourceStopId)
      .departureTime(depTime)
      .maxTransfers(1)
      .build();

    const result = router.route(query);
    const route = result.bestRoute();

    if (!route) {
      setResultState('no-route');
      return;
    }

    setResultState('results');
    renderRoute(route);
  } catch (err) {
    console.error('Routing error:', err);
    setResultState('error', 'Routing failed. Please try again.');
  }
}

function renderRoute(route) {
  const legs = route.legs;
  const dep = fmt(route.departureTime());
  const arr = fmt(route.arrivalTime());
  const dur = fmtDuration(route.totalDuration());

  const vehicleLegs = legs.filter(l => 'departureTime' in l);
  const transfers = vehicleLegs.length - 1;

  const legsHtml = legs.map(leg => {
    if ('departureTime' in leg) {
      // VehicleLeg
      return `
        <div class="leg-row">
          <span class="leg-badge leg-badge--bus">${leg.route.name}</span>
          <span class="leg-stop"><strong>${leg.from.name}</strong> → ${leg.to.name}</span>
        </div>`;
    }
    // Transfer
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
  `;
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
          <p class="empty-state__sub">No matatu connection between these stops today. Try different stops.</p>
        </div>`;
      break;

    case 'offline':
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">
            <svg><use href="#icon-wifi-off"/></svg>
          </div>
          <div class="empty-state__title">You're offline</div>
          <p class="empty-state__sub">The routing graph is cached — but timetable data may be stale. Results shown from last sync.</p>
          <button class="empty-state__cta" id="plan-retry-offline">Try offline route</button>
        </div>`;
      el('plan-retry-offline')?.addEventListener('click', () => {
        // Attempt routing anyway — graph may be cached
        const router = getRouter();
        if (router) {
          findRoute();
        }
      });
      break;

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
