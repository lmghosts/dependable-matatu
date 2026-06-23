import { getDeviceId }          from './lib/device-id.js';
import { enqueue, flushQueue }  from './lib/offline-queue.js';
import { fetchAggregates, submitReport } from './lib/supabase.js';

const el = id => document.getElementById(id);

// ─── State ─────────────────────────────────────────────────
const state = {
  route:    '',
  from:     '',
  to:       '',
  fare:     '',
  deviceId: null,
};

// ─── Routes ────────────────────────────────────────────────
const ROUTES = [
  { id: 'R104', name: 'Route 104 — City Cabanas → Kahawa Sukari' },
  { id: 'R58',  name: 'Route 58 — CBD → JKIA' },
  { id: 'R237', name: 'Route 237 — Githurai 44 → CBD' },
  { id: 'R33',  name: 'Route 33 — Westlands → CBD' },
  { id: 'R45',  name: 'Route 45 — Githurai → Kasarani' },
];

// ─── Fare card ─────────────────────────────────────────────
function renderFareCardLoading() {
  return `<div class="fare-info-card" style="text-align:center;padding:18px">
    <div class="spinner" style="margin:0 auto 8px"></div>
    <span style="font-size:12px;color:var(--text-secondary)">Loading fares…</span>
  </div>`;
}

function renderFareCardEmpty() {
  return `
    <div class="empty-state" style="padding:20px 16px">
      <div class="empty-state__icon"><svg><use href="#icon-info"/></svg></div>
      <div class="empty-state__title">No reports yet</div>
      <p class="empty-state__sub">
        Be the first to report a fare on this route!
        Minimum 3 reports needed before a P50 fare is shown.
      </p>
    </div>`;
}

function renderFareCardData(aggregates) {
  if (!aggregates.length) return renderFareCardEmpty();

  const total = aggregates.reduce((s, r) => s + r.sample_count, 0);
  const rows = aggregates.slice(0, 5).map(r => `
    <div class="breakdown-row">
      <span class="breakdown-amount" style="min-width:140px;font-size:11px">
        ${r.from_stop} → ${r.to_stop}
      </span>
      <span style="font-size:13px;font-weight:600;color:var(--text-primary)">
        KSh ${r.p50_kes}
      </span>
      <span class="breakdown-pct">${r.sample_count}×</span>
    </div>`).join('');

  return `
    <div class="fare-info-card">
      <div class="fare-info-card__route">Crowd-sourced fares (P50)</div>
      <div style="margin-top:4px;margin-bottom:12px">
        <div class="breakdown-card">${rows}</div>
      </div>
      <p style="font-size:11px;color:var(--text-secondary);margin:0">
        ${total} report${total === 1 ? '' : 's'} · updated daily
      </p>
    </div>`;
}

async function loadFareCard(routeId) {
  const card = el('fares-fare-card');
  if (!card) return;
  card.hidden = false;
  card.innerHTML = renderFareCardLoading();

  try {
    const aggs = await fetchAggregates(routeId);
    if (card.parentElement) card.innerHTML = renderFareCardData(aggs);
  } catch {
    if (card.parentElement) card.innerHTML = renderFareCardEmpty();
  }
}

// ─── Submit ────────────────────────────────────────────────
function syncSubmitBtn() {
  const btn = el('fares-submit');
  if (!btn) return;
  const valid = state.route && state.from.trim() && state.to.trim()
    && state.fare && Number(state.fare) >= 10 && Number(state.fare) <= 999;
  btn.disabled = !valid;
}

async function handleSubmit() {
  const btn = el('fares-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  const payload = {
    device_id: state.deviceId,
    route_id:  state.route,
    from_stop: state.from.trim().toLowerCase(),
    to_stop:   state.to.trim().toLowerCase(),
    fare_kes:  Number(state.fare),
  };

  let queued = false;
  try {
    if (navigator.onLine) {
      await submitReport(payload);
    } else {
      await enqueue(payload);
      queued = true;
    }
  } catch (err) {
    // Network error or server error — queue for retry
    console.warn('[fares] submit failed, queuing:', err.message);
    await enqueue(payload).catch(() => {});
    queued = true;
  }

  showSuccess(payload.fare_kes, queued);
}

function showSuccess(fare, queued) {
  const section = el('fares-form-section');
  section.innerHTML = `
    <div class="success-card" id="fares-success">
      <div class="success-card__icon"><svg><use href="#icon-check"/></svg></div>
      <div class="success-card__title">KSh ${fare} reported</div>
      <p class="success-card__sub">
        ${queued
          ? 'Saved offline — will sync when you reconnect.'
          : 'Thank you! Your report helps other commuters.'}
      </p>
    </div>
    <div style="padding:0 16px;margin-bottom:12px">
      <button class="submit-btn" id="fares-report-another">Report another fare</button>
    </div>
  `;
  el('fares-report-another').addEventListener('click', renderForm);

  setTimeout(() => el('fares-success')?.remove(), 3000);
}

// ─── Form ──────────────────────────────────────────────────
function renderForm() {
  state.route = '';
  state.from  = '';
  state.to    = '';
  state.fare  = '';

  el('fares-form-section').innerHTML = `
    <div class="form-section">
      <div class="form-label">Select route</div>
      <div class="form-card">
        <select class="select-field" id="fares-route-select">
          <option value="">Choose a route…</option>
          ${ROUTES.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
        </select>
      </div>

      <div id="fares-fare-card" hidden></div>

      <div class="form-label" style="margin-top:12px">Report a fare</div>
      <div class="form-card">
        <div style="margin-bottom:10px">
          <div class="form-label" style="margin-bottom:4px">From stop</div>
          <input class="number-field" id="fares-from" type="text"
            placeholder="e.g. City Cabanas" autocomplete="off" style="margin-bottom:0" />
        </div>
        <div style="margin-bottom:10px">
          <div class="form-label" style="margin-bottom:4px">To stop</div>
          <input class="number-field" id="fares-to" type="text"
            placeholder="e.g. Kahawa Sukari" autocomplete="off" style="margin-bottom:0" />
        </div>
        <div>
          <div class="form-label" style="margin-bottom:4px">Fare paid</div>
          <div class="fare-row">
            <span class="fare-ksh">KSh</span>
            <input class="number-field" id="fares-amount" type="number"
              min="10" max="999" step="5" placeholder="0" />
          </div>
        </div>
      </div>

      <button class="submit-btn" id="fares-submit" disabled>Submit report</button>
      <p style="font-size:11px;color:var(--text-secondary);text-align:center;margin-top:8px;padding:0 16px">
        Reports are anonymous. Fares are shown once 3+ reports exist per segment.
      </p>
    </div>
  `;

  el('fares-route-select').addEventListener('change', e => {
    state.route = e.target.value;
    if (state.route) loadFareCard(state.route);
    else { const c = el('fares-fare-card'); if (c) c.hidden = true; }
    syncSubmitBtn();
  });
  el('fares-from').addEventListener('input',   e => { state.from = e.target.value;  syncSubmitBtn(); });
  el('fares-to').addEventListener('input',     e => { state.to   = e.target.value;  syncSubmitBtn(); });
  el('fares-amount').addEventListener('input', e => { state.fare  = e.target.value; syncSubmitBtn(); });
  el('fares-submit').addEventListener('click', handleSubmit);
}

// ─── Shell ─────────────────────────────────────────────────
function renderShell() {
  el('view-fares').innerHTML = `
    <div class="view-header">
      <span class="app-name">Dependable <em>Matatu</em></span>
    </div>
    <div id="fares-form-section" class="pb-safe"></div>
  `;
  renderForm();
}

// ─── Public init ───────────────────────────────────────────
export async function initFares() {
  renderShell();

  // T9: Initialise stable anonymous device ID
  try {
    state.deviceId = await getDeviceId();
  } catch (e) {
    console.warn('[fares] device-id unavailable, using session fallback');
    state.deviceId = `session-${crypto.randomUUID()}`;
  }

  // Flush any offline-queued reports if online
  if (navigator.onLine) {
    flushQueue(submitReport).catch(() => {});
  }

  // Re-flush when connectivity returns
  window.addEventListener('online', () => {
    flushQueue(submitReport).catch(() => {});
  });
}
