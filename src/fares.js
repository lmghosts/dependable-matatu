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

// ─── Routes (Digital Matatus GTFS 2019 — 136 routes) ───────
const ROUTES = [
  { id: "R1", name: "Route 1 — Karen-Karinde-Dagoretti Market" },
  { id: "R2", name: "Route 2 — Railways-Ngong Road-Kawangware-Dagoretti Market" },
  { id: "R5", name: "Route 5 — Town-Kenyatta-Adams-Jamhuri" },
  { id: "R6", name: "Route 6 — Koja-Pangani Flyover-Guru Nanak-Pangani Girls-Mlango-Eastleigh" },
  { id: "R7", name: "Route 7 — Town-Kariokor DC-Gikomba" },
  { id: "R8", name: "Route 8 — Railways-Ngong Road-Kibera" },
  { id: "R10", name: "Route 10 — Muthurwa-Makadara-Maringo" },
  { id: "R11", name: "Route 11 — Bus Station-Industrial Area-South B-Hazina" },
  { id: "R14", name: "Route 14 — Ronald Ngala-Juja Road-Eastleigh-Huruma-Kariobangi" },
  { id: "R15", name: "Route 15 — Bus Station-Nyayo Stadium-Wilson-Langata" },
  { id: "R16", name: "Route 16 — Bus Station-Nyayo Stadium-T Mall-Highrise" },
  { id: "R20", name: "Route 20 — Mama Lucy Hospital-Kayole-Njiru-Mwiki" },
  { id: "R24", name: "Route 24 — Ambassadeur-Nyayo Stadium-Bomas-Hardy-Karen" },
  { id: "R25", name: "Route 25 — Odeon-Pangani-Alssops-Baba Dogo" },
  { id: "R26", name: "Route 26 — Makadara-Harambee-Outering-Kariobangi" },
  { id: "R0027", name: "Route 27 — Kariobangi North-Thika Road-Town" },
  { id: "R28", name: "Route 28 — Gikomba-Eastleigh-Huruma-Kariobangi" },
  { id: "R30", name: "Route 30 — Odeon-Westlands-Kangemi-Uthiru" },
  { id: "R36", name: "Route 36 — City Stadium-Buruburu-Kwa Mbao-Dandora" },
  { id: "R0039", name: "Route 39 — Bypass-Ruiru-City Cabanas" },
  { id: "R41", name: "Route 41 — Gikomba-Rounda-Dandora" },
  { id: "R42", name: "Route 42 — Allsops-Rounda-Dandora" },
  { id: "R43", name: "Route 43 — Bus Station-Pangani-Allsops-Ngumba" },
  { id: "R0048", name: "Route 48 — Yaya-Kasuku-Westlands" },
  { id: "R49", name: "Route 49 — Odeon-Pangani-Roysambu-Kasarani-Sunton" },
  { id: "R53", name: "Route 53 — Roasters-Thome-Maruirui" },
  { id: "R56", name: "Route 56 — Town-Yaya-Congo-Kanungaga" },
  { id: "R58", name: "Route 58 — Ambassadeur-Jogoo Road-Buruburu" },
  { id: "R69", name: "Route 69 — Muthurwa-Hillocks-GM" },
  { id: "R100", name: "Route 100 — OTC-Pangani-Muthaiga-Kiambu Road-Kiambu" },
  { id: "R102", name: "Route 102 — Railways-Ngong Road-Kawangware-Kikuyu" },
  { id: "R103", name: "Route 103 — Dagoretti Market-Uthiru-Kinoo-Wangige" },
  { id: "R105", name: "Route 105 — Odeon-Westlands-Kangemi-Kinoo-Kikuyu" },
  { id: "R106", name: "Route 106 — Koja-UN-Ruaka-Banana" },
  { id: "R107", name: "Route 107 — Odeon-UN-Ruaka-Ndenderu" },
  { id: "R108", name: "Route 108 — UN-New Muthaiga-Gachie-Gichagi" },
  { id: "R110", name: "Route 110 — Railways-Mombasa Road-Mlolongo-Kitengela" },
  { id: "R111", name: "Route 111 — Railways-Ngong Road-Karen-Ngong" },
  { id: "R115", name: "Route 115 — Koja-Westlands-Kangemi-Limuru" },
  { id: "R116", name: "Route 116 — Koja-Ngara-Banana-Limuru" },
  { id: "R118", name: "Route 118 — Koja-Westlands-Kabete-Wangige" },
  { id: "R119", name: "Route 119 — Koja-Westgate-Wangige" },
  { id: "R120", name: "Route 120 — Kaka-Pangani-Muthaiga-Kiambu-Githunguri" },
  { id: "R121", name: "Route 121 — Kaka-Pangani-Muthaiga-Kiambu-Ndumberi" },
  { id: "R125", name: "Route 125 — Railways-Langata Road-Bomas-Ongata Rongai" },
  { id: "R126", name: "Route 126 — Railways-Langata Road-Ongata Rongai-Kiserian" },
  { id: "R129", name: "Route 129 — Kikuyu-Magu-Kingeero-Wangige" },
  { id: "R135", name: "Route 135 — Kaka-Westlands-Kangemi-Limuru" },
  { id: "R145", name: "Route 145 — Munyu Road-Pangani-Roysambu-Githurai-KU-Ruiru" },
  { id: "R237", name: "Route 237 — Munyu Road-Pangani-Roysambu-Githurai-KU-Ruiru-Juja-Thika" },
  { id: "R405", name: "Route 405 — City Stadium-Nyayo Stadium" },
  { id: "R1960", name: "Route 1960 — OTC-Donholm-Kayole" },
  { id: "R2030", name: "Route 2030 — Allsops-Rounda" },
  { id: "R3738", name: "Route 3738 — Rounda-Saika-Ruai" },
  { id: "R107D", name: "Route 107D — Ruaka-Ruiru" },
  { id: "R114R", name: "Route 114R — Ngara-Rwaka-Ndenderu-Limuru" },
  { id: "R11A", name: "Route 11A — Odeon-Aga Khan-Highridge" },
  { id: "R11B", name: "Route 11B — Odeon-UN-Ruaka" },
  { id: "R23W", name: "Route 23W — Nation Building-Museum Hill-Westlands" },
  { id: "R45K", name: "Route 45K — Odeon-Pangani-Roysambu-Githurai-KU" },
  { id: "R45G", name: "Route 45G — Munyu Road-Pangani-Roysambu-Githurai" },
  { id: "R45P", name: "Route 45P — Githurai-Proggie" },
  { id: "R100A", name: "Route 100A — Ngara-Pangani-Muthaiga-Kiambu Hospital" },
  { id: "R145D", name: "Route 145D — Torrents-Membley-Ruiru" },
  { id: "R29/30", name: "Route 29/30 — Ngara-Pangani-Alssops-Drive In-Mathare" },
  { id: "R25A", name: "Route 25A — Odeon-Pangani-Alssops-Baba Dogo-Lucky Summer" },
  { id: "R17B", name: "Route 17B — Bus Station-Pangani-Roysambu-Kasarani-Mwiki" },
  { id: "R44G", name: "Route 44G — Odeon-Pangani-Roysambu-Githurai-KU" },
  { id: "R44Z", name: "Route 44Z — Odeon-Pangani-Roysambu-Zimmerman-KU" },
  { id: "R44K", name: "Route 44K — Roysambu-Githurai-KU" },
  { id: "R17B_2", name: "Route 17B — Roysambu-Sunton-Kasarani-Mwiki" },
  { id: "R46H", name: "Route 46H — Ronald Ngala-Juja Road-Eastleigh-Huruma" },
  { id: "R46B", name: "Route 46B — Ronald Ngala-Juja Road-Eastleigh-Rounda" },
  { id: "R11C", name: "Route 11C — Odeon-Pangani Flyover-Mlango-Pangani Terminus" },
  { id: "R3N", name: "Route 3N — Gikomba-Kariokor-Ngara" },
  { id: "R17Aky", name: "Route 17A — Eastleigh-Rounda-Umoja 2-Kayole" },
  { id: "R18C", name: "Route 18C — Eastleigh-Rounda-Dandora-Kayole" },
  { id: "R16/62", name: "Route 16/62 — Bus Station-Rounda-Dandora-Kayole" },
  { id: "R32D", name: "Route 32D — OTC-Kariokor-Mlango-Rounda-Dandora" },
  { id: "R33DP", name: "Route 33DP — Muthurwa-Donholm-Pipeline" },
  { id: "R6E", name: "Route 6E — Church Army-Biafra-Joster" },
  { id: "R23KS", name: "Route 23KS — Gill House-Jogoo Road-Buruburu-Kariobangi South" },
  { id: "R70/71", name: "Route 70/71 — Muthurwa-Likoni-Sinai-Lunga Lunga" },
  { id: "R26S", name: "Route 26S — Aquinas-Jerusalem-Outering-Kariobangi" },
  { id: "R33DC", name: "Route 33DC — Donholm-Rounda-Cabanas" },
  { id: "R34J", name: "Route 34J — Ambassadeur-Donholm-Rounda-JKIA" },
  { id: "R33C", name: "Route 33C — Commercial-Jogoo Road-Pipeline-Cabanas" },
  { id: "R33GTB", name: "Route 33GTB — Accra Road-Jogoo Road-Donholm-Fedha-Gate B" },
  { id: "R34B", name: "Route 34B — Ambassadeur-Donholm-Jacaranda" },
  { id: "R1961K", name: "Route 1961K — Landhies Road-Jogoo Road-Jacaranda-Kayole" },
  { id: "R1961Kd", name: "Route 1961Kd — Caltex Donholm-Jacaranda-Kayole" },
  { id: "R3560_2", name: "Route 3560 — Donholm-Mutindwa-Umoja 2" },
  { id: "R35/60", name: "Route 35/60 — Town-Donholm-Umoja" },
  { id: "R39SK", name: "Route 39SK — Ronald Ngala-Jogoo Road-Kangundo Road-Kayole Junction" },
  { id: "R17A", name: "Route 17A — Rounda-Umoja 2-Kayole" },
  { id: "R19Cdc", name: "Route 19C — Ambassadeur-Jogoo Road-Donholm-Komarocks" },
  { id: "R19C2", name: "Route 19C2 — Donholm-Caltex-Komarocks" },
  { id: "R38/39", name: "Route 38/39 — Town-Donholm-Njiru-Ruai" },
  { id: "R24BK", name: "Route 24BK — Bomas-Karen Hospital-Karen" },
  { id: "R11_2", name: "Route 11 — Town-Industrial Area-Mater-Balozi-Hazina" },
  { id: "R14A", name: "Route 14A — Bus Station-Nairobi West-Madaraka-Strathmore" },
  { id: "R14B", name: "Route 14B — Bus Station-Nairobi West-TMall" },
  { id: "R126RK", name: "Route 126RK — Ongata Rongai-Nkoroi-Kiserian" },
  { id: "R12C", name: "Route 12C — Bus Station-Red Cross-Mugoya" },
  { id: "R12D", name: "Route 12D — Bus Station-Red Cross-KPA-College Of Insurance-Amboseli" },
  { id: "R33IMR", name: "Route 33IMR — Commercial-Belleview-Imara Daima" },
  { id: "R33MKR", name: "Route 33MKR — Bus Station-Mombasa Road-Imara Daima-St.Bakhita" },
  { id: "R33UTW", name: "Route 33UTW — Utawala-Ambassadeur" },
  { id: "R145B", name: "Route 145B — Bypass-Ruiru Ndani-Ruiru" },
  { id: "R33H", name: "Route 33H — Cabanas-Utawala-Bypass" },
  { id: "R33TP", name: "Route 33TP — Commercial-Mombasa Road-Taj Mall-Pipeline" },
  { id: "R33FED", name: "Route 33FED — Commercial-Cabanas-Tuskys Village-Gate A-Posta" },
  { id: "R33B", name: "Route 33B — Commercial-Cabanas-Baraka" },
  { id: "R33J", name: "Route 33J — Cabanas-Utawala-Githunguri" },
  { id: "R110ATH", name: "Route 110ATH — Railways-Mombasa Road-Devki-Makadara" },
  { id: "R110AK", name: "Route 110AK — Athi River-Makadara-Kitengela" },
  { id: "R46Y", name: "Route 46Y — Kencom-Valley Road-Hurlingham-Yaya Centre" },
  { id: "R7C", name: "Route 7C — Kencom-Community-Equity Center-KNH" },
  { id: "R46K", name: "Route 46K — Kencom-Valley Road-Yaya Centre-Kawangware" },
  { id: "R3U/3", name: "Route 3U/3 — Dagoretti Corner-Naivasha Road-Uthiru" },
  { id: "R33NG", name: "Route 33NG — Racecourse Road-Ngong Road-KNH-Ngumo" },
  { id: "R34L", name: "Route 34L — KNH-Mbagathi Road-Wilson Airport-Langata" },
  { id: "R33SB", name: "Route 33SB — Ngumo-Highrise-Nairobi West-South C-South B" },
  { id: "R32A", name: "Route 32A — Kencom-Community-KNH-Ngong Road-Ayani" },
  { id: "R24C", name: "Route 24C — Kencom-Valley Road-Ngong Road-Karen-Hardy" },
  { id: "R126N", name: "Route 126N — Ngong-Kiserian" },
  { id: "R4W", name: "Route 4W — Railways-Ngong Road-Wanyee-Kaberia" },
  { id: "R046P", name: "Route 46P — Ambassadeur-Kabete-Kawangware" },
  { id: "R23KG", name: "Route 23KG — Odeon-Chiromo-Westlands-Kangemi" },
  { id: "R114W", name: "Route 114W — Ngara-Westlands-Kangemi-Limuru" },
  { id: "R119A", name: "Route 119A — Town-Westlands-Peponi Road-Spring Valley-ISK-Gathiga" },
  { id: "R48A", name: "Route 48A — Odeon-Chiromo-Strathmore School-Lavington" },
  { id: "R48O", name: "Route 48O — Odeon-Chiromo-Kileleshwa-Othaya Road" },
  { id: "R48B", name: "Route 48B — Odeon-Chiromo-Westlands Bypass-Methodist Guesthouse-Othaya Road" },
  { id: "R48K", name: "Route 48K — Westlands-ABC Place-Lavington-Kawangware" },
  { id: "R48C", name: "Route 48C — Odeon-Chiromo-Westlands-ByPass-Yaya" },
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

  setTimeout(() => el('fares-success')?.remove(), 5000);
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
      <div id="fares-search-area">
        <div class="form-card" style="position:relative">
          <input class="number-field" id="fares-route-search"
            type="text" placeholder="Search routes… e.g. Westlands or 104"
            autocomplete="off" style="margin-bottom:0" />
          <div id="fares-route-dropdown" class="route-dropdown" hidden></div>
        </div>
      </div>
      <div id="fares-route-chip" class="route-chip" hidden>
        <span id="fares-chip-label" class="route-chip__label"></span>
        <button class="route-chip__clear" id="fares-chip-clear" aria-label="Change route">✕</button>
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

  // Route search
  const searchInput = el('fares-route-search');
  const dropdown    = el('fares-route-dropdown');

  function showDropdown(query) {
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.hidden = true; return; }
    const matches = ROUTES.filter(r => r.name.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { dropdown.hidden = true; return; }
    dropdown.innerHTML = matches.map(r =>
      `<div class="route-option" data-id="${r.id}" data-name="${r.name.replace(/"/g,'&quot;')}">${r.name}</div>`
    ).join('');
    dropdown.hidden = false;
  }

  function selectRoute(id, name) {
    state.route = id;
    dropdown.hidden = true;
    el('fares-search-area').hidden = true;
    el('fares-chip-label').textContent = name;
    el('fares-route-chip').hidden = false;
    loadFareCard(id);
    syncSubmitBtn();
  }

  function clearRoute() {
    state.route = '';
    el('fares-route-chip').hidden = true;
    el('fares-search-area').hidden = false;
    el('fares-fare-card').hidden = true;
    searchInput.value = '';
    syncSubmitBtn();
  }

  el('fares-chip-clear').addEventListener('click', clearRoute);

  searchInput.addEventListener('input', e => {
    state.route = '';
    showDropdown(e.target.value);
    syncSubmitBtn();
  });

  dropdown.addEventListener('click', e => {
    const opt = e.target.closest('.route-option');
    if (opt) selectRoute(opt.dataset.id, opt.dataset.name);
  });

  document.addEventListener('click', e => {
    if (!el('fares-route-search')?.contains(e.target) &&
        !el('fares-route-dropdown')?.contains(e.target)) {
      if (dropdown) dropdown.hidden = true;
    }
  }, { once: false });
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
