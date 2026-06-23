import { Timetable, Router, StopsIndex } from 'minotor';
import { initPlan } from './plan.js';
import { initDiscover } from './discover.js';
import { initFares } from './fares.js';

// ─── Graph state ───────────────────────────────────────────
let _router = null;
let _stopsIndex = null;
let _graphMeta = null;

export const getRouter = () => _router;
export const getStopsIndex = () => _stopsIndex;
export const getGraphMeta = () => _graphMeta;

// ─── Graph loading ─────────────────────────────────────────
const GRAPH_META_URL = '/graph/meta.json';

async function loadGraph() {
  const banner = document.getElementById('graph-banner');
  banner.hidden = false;
  try {
    const meta = await fetch(GRAPH_META_URL, { cache: 'no-cache' }).then(r => r.json());
    const [ttBuf, stopsBuf] = await Promise.all([
      fetch(`/graph/timetable-${meta.version}`).then(r => r.arrayBuffer()),
      fetch(`/graph/stops-${meta.version}`).then(r => r.arrayBuffer()),
    ]);
    _stopsIndex = StopsIndex.fromData(new Uint8Array(stopsBuf));
    const timetable = Timetable.fromData(new Uint8Array(ttBuf));
    _router = new Router(timetable, _stopsIndex);
    _graphMeta = meta;
    banner.hidden = true;
    document.dispatchEvent(new CustomEvent('graph:ready', { detail: meta }));
  } catch (err) {
    banner.hidden = true;
    console.warn('Graph load failed:', err.message);
    document.dispatchEvent(new CustomEvent('graph:error', { detail: err }));
  }
}

// ─── Offline indicator ─────────────────────────────────────
function syncOnlineStatus() {
  const bar = document.getElementById('status-bar');
  bar.hidden = navigator.onLine;
}

// ─── Tab routing ───────────────────────────────────────────
const TABS = ['plan', 'discover', 'fares'];

function activateTab(name) {
  TABS.forEach(t => {
    const tab = document.getElementById(`tab-${t}`);
    const view = document.getElementById(`view-${t}`);
    const active = t === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    view.hidden = !active;
  });
  window.location.hash = name === 'plan' ? '' : `#${name}`;
}

// ─── Init ──────────────────────────────────────────────────
function init() {
  // Tab click handlers
  TABS.forEach(name => {
    document.getElementById(`tab-${name}`).addEventListener('click', () => activateTab(name));
  });

  // Restore tab from hash
  const hash = window.location.hash.replace('#', '');
  if (TABS.includes(hash)) activateTab(hash);

  // Offline indicator
  syncOnlineStatus();
  window.addEventListener('online', syncOnlineStatus);
  window.addEventListener('offline', syncOnlineStatus);

  // Initialize views
  initPlan();
  initDiscover();
  initFares();

  // Load routing graph
  loadGraph();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(console.warn);
  }
}

init();
