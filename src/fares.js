const el = id => document.getElementById(id);

// ─── State ─────────────────────────────────────────────────
const state = {
  route: '',
  from: '',
  to: '',
  fare: '',
};

// ─── Known routes for the form ─────────────────────────────
const ROUTES = [
  { id: 'R104', name: 'Route 104 — City Cabanas → Kahawa Sukari' },
  { id: 'R58',  name: 'Route 58 — CBD → JKIA' },
  { id: 'R237', name: 'Route 237 — Githurai 44 → CBD' },
  { id: 'R33',  name: 'Route 33 — Westlands → CBD' },
  { id: 'R45',  name: 'Route 45 — Githurai → Kasarani' },
];

// ─── Fake crowdsourced data (Phase 2 will pull from Supabase) ──
const FARE_DATA = {
  R104: { min: 50, max: 80, mode: 70, reports: 24, confidence: 76,
    breakdown: [
      { amount: 50, count: 3 }, { amount: 60, count: 5 },
      { amount: 70, count: 11 }, { amount: 80, count: 5 },
    ]},
  R58:  { min: 100, max: 150, mode: 120, reports: 11, confidence: 54,
    breakdown: [
      { amount: 100, count: 4 }, { amount: 120, count: 5 }, { amount: 150, count: 2 },
    ]},
};

// ─── Render fare card from cached data ─────────────────────
function renderFareCard(routeId) {
  const data = FARE_DATA[routeId];
  if (!data || data.reports < 5) {
    return `
      <div class="empty-state" style="padding:20px 16px">
        <div class="empty-state__icon"><svg><use href="#icon-info"/></svg></div>
        <div class="empty-state__title">Not enough reports yet</div>
        <p class="empty-state__sub">
          At least 5 fare reports are needed before a range is shown.
          Be the first to report this route!
        </p>
      </div>`;
  }

  const { min, max, confidence, reports, breakdown } = data;
  const maxCount = Math.max(...breakdown.map(r => r.count));

  return `
    <div class="fare-info-card">
      <div class="fare-info-card__route">${routeId.replace('R', 'Route ')}</div>
      <div class="fare-range">
        KSh ${min}<span class="fare-range__sep">–</span>${max}
      </div>
      <div class="confidence-bar-wrap">
        <div class="confidence-bar">
          <div class="confidence-fill" style="width:${confidence}%"></div>
        </div>
        <span class="confidence-pct">${confidence}%</span>
      </div>
      <p style="font-size:11px;color:var(--text-secondary);margin-top:6px">${reports} crowd-sourced reports</p>
    </div>

    <div class="breakdown-section" style="padding:0 16px 12px">
      <div class="breakdown-header">Fare breakdown</div>
      <div class="breakdown-card">
        ${breakdown.map(row => `
          <div class="breakdown-row">
            <span class="breakdown-amount">KSh ${row.amount}</span>
            <div class="breakdown-bar-outer">
              <div class="breakdown-bar-inner" style="width:${Math.round(row.count / maxCount * 100)}%"></div>
            </div>
            <span class="breakdown-pct">${Math.round(row.count / reports * 100)}%</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ─── Form validation ───────────────────────────────────────
function syncSubmitBtn() {
  const btn = el('fares-submit');
  if (!btn) return;
  const valid = state.route && state.from && state.to && state.fare
    && Number(state.fare) >= 10 && Number(state.fare) <= 999;
  btn.disabled = !valid;
}

// ─── Submit handler ────────────────────────────────────────
function handleSubmit() {
  const fare = Number(state.fare);
  const routeId = state.route;
  const now = Date.now();

  // Optimistic local update
  const data = FARE_DATA[routeId];
  if (data) {
    const existing = data.breakdown.find(r => r.amount === fare);
    if (existing) {
      existing.count++;
    } else {
      data.breakdown.push({ amount: fare, count: 1 });
      data.breakdown.sort((a, b) => a.amount - b.amount);
    }
    data.reports++;
    data.confidence = Math.min(99, data.confidence + 2);
  }

  // Show success state
  showSuccess(routeId, fare);

  // TODO (Phase 2): enqueue to Supabase via Background Sync
  // offlineQueue.push({ routeId, from: state.from, to: state.to, fare, ts: now });
}

function showSuccess(routeId, fare) {
  const section = el('fares-form-section');

  // Re-render with updated fare card + success message
  section.innerHTML = `
    ${renderFareCard(routeId)}
    <div class="success-card" id="fares-success">
      <div class="success-card__icon">
        <svg><use href="#icon-check"/></svg>
      </div>
      <div class="success-card__title">KSh ${fare} reported</div>
      <p class="success-card__sub">
        Thank you! Your report helps other commuters know what to expect.
      </p>
    </div>
    <div style="padding:0 16px;margin-bottom:12px">
      <button class="submit-btn" id="fares-report-another">Report another fare</button>
    </div>
  `;

  el('fares-report-another').addEventListener('click', () => {
    renderForm();
  });

  // Auto-clear after 3 s
  setTimeout(() => {
    el('fares-success')?.remove();
  }, 3000);
}

// ─── Form rendering ────────────────────────────────────────
function renderForm() {
  state.route = '';
  state.from = '';
  state.to = '';
  state.fare = '';

  el('fares-form-section').innerHTML = `
    <div class="form-section">
      <div class="form-label">Select route</div>
      <div class="form-card">
        <select class="select-field" id="fares-route-select">
          <option value="">Choose a route…</option>
          ${ROUTES.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
        </select>
      </div>

      <div id="fares-fare-card" hidden>
        <!-- Fare card injected when route is selected -->
      </div>

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
        Reports are anonymous. Minimum 5 needed before fare ranges are shown.
      </p>
    </div>
  `;

  el('fares-route-select').addEventListener('change', e => {
    state.route = e.target.value;
    const card = el('fares-fare-card');
    if (state.route) {
      card.hidden = false;
      card.innerHTML = renderFareCard(state.route);
    } else {
      card.hidden = true;
    }
    syncSubmitBtn();
  });

  el('fares-from').addEventListener('input', e => { state.from = e.target.value; syncSubmitBtn(); });
  el('fares-to').addEventListener('input', e => { state.to = e.target.value; syncSubmitBtn(); });
  el('fares-amount').addEventListener('input', e => { state.fare = e.target.value; syncSubmitBtn(); });
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
export function initFares() {
  renderShell();
}
