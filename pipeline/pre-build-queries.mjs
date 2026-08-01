#!/usr/bin/env node
/**
 * Three pre-build queries for L2-TRANSIT-003 v0.2 review:
 * Q1 — Name-ambiguity count: how many normalized names → ≥2 clusters after grouping?
 * Q2 — ACK re-parse: proper CSV verification of stop 0800ACB's location_type
 * Q3 — Direction asymmetry: which route_ids lack a direction_id=1 trip (or have extras)?
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS = join(__dirname, '_gtfs_tmp/extracted');

// ─── CSV parser (handles quoted commas) ───────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').trim(); });
    return row;
  });
}

function parseLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ─── Haversine ────────────────────────────────────────────────────────────────
function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

// ─── Normalize stop name (mirrors groupStopsByName intent) ────────────────────
function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Group stops by name + 500m centroid proximity ───────────────────────────
function groupStops(stops, maxM = 500) {
  const groups = [];
  for (const s of stops) {
    const name = normalize(s.stop_name);
    const lat = parseFloat(s.stop_lat);
    const lon = parseFloat(s.stop_lon);
    let placed = false;
    for (const g of groups) {
      if (g.name !== name) continue;
      if (!isFinite(lat) || !isFinite(lon)) { g.stops.push(s); placed = true; break; }
      const cLat = g.stops.reduce((sum, m) => sum + (parseFloat(m.stop_lat) || 0), 0) / g.stops.length;
      const cLon = g.stops.reduce((sum, m) => sum + (parseFloat(m.stop_lon) || 0), 0) / g.stops.length;
      if (haversineM({ lat: cLat, lon: cLon }, { lat, lon }) <= maxM) {
        g.stops.push(s); placed = true; break;
      }
    }
    if (!placed) groups.push({ name, stops: [s] });
  }
  return groups;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Load data
// ═══════════════════════════════════════════════════════════════════════════════

const stops = parseCSV(readFileSync(join(GTFS, 'stops.txt'), 'utf8'));
const trips = parseCSV(readFileSync(join(GTFS, 'trips.txt'), 'utf8'));
const stopTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));

console.log(`Loaded: ${stops.length} stops, ${trips.length} trips, ${stopTimes.length} stop_time rows\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// Q2 — ACK re-parse (do before clustering so we have the raw data visible)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('══════════════════════════════════════════════');
console.log('Q2 — ACK / 0800ACB re-parse with proper CSV');
console.log('══════════════════════════════════════════════');

const ackStop = stops.find(s => s.stop_id === '0800ACB');
if (ackStop) {
  console.log('Raw fields:');
  Object.entries(ackStop).forEach(([k, v]) => console.log(`  ${k}: "${v}"`));
} else {
  console.log('Stop 0800ACB not found');
}

// Also show all stops with non-empty, non-integer location_type
const badLocType = stops.filter(s => {
  const v = s.location_type;
  if (!v || v === '' || v === '0' || v === '1') return false;
  return true;
});
console.log(`\nStops with unexpected location_type (not blank/0/1):`);
badLocType.forEach(s => console.log(`  ${s.stop_id} "${s.stop_name}": location_type="${s.location_type}"`));
if (!badLocType.length) console.log('  None');

// ═══════════════════════════════════════════════════════════════════════════════
// Q1 — Name-ambiguity count
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════');
console.log('Q1 — Name-ambiguity count (≥2 clusters per normalized name)');
console.log('══════════════════════════════════════════════');

// Only stops that appear in stop_times (routable stops)
const routableIds = new Set(stopTimes.map(st => st.stop_id));
const routableStops = stops.filter(s => routableIds.has(s.stop_id));
console.log(`Routable stops (appear in stop_times): ${routableStops.length} of ${stops.length}`);

const allGroups = groupStops(routableStops, 500);
console.log(`Total clusters after 500m grouping: ${allGroups.length}`);

// Count clusters per normalized name
const clustersByName = {};
for (const g of allGroups) {
  if (!clustersByName[g.name]) clustersByName[g.name] = [];
  clustersByName[g.name].push(g);
}

const ambiguous = Object.entries(clustersByName)
  .filter(([, clusters]) => clusters.length >= 2)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`\nNames with ≥2 clusters (require disambiguator): ${ambiguous.length}`);
console.log(`Total clusters that need a disambiguator: ${ambiguous.reduce((s, [, c]) => s + c.length, 0)}`);
console.log(`\nTop 20 most-ambiguous names:`);
for (const [name, clusters] of ambiguous.slice(0, 20)) {
  console.log(`  "${name}" — ${clusters.length} clusters:`);
  for (const cl of clusters) {
    const lat = parseFloat(cl.stops[0].stop_lat).toFixed(5);
    const lon = parseFloat(cl.stops[0].stop_lon).toFixed(5);
    console.log(`    [${cl.stops.length} stops] near (${lat}, ${lon})`);
  }
}

// Distribution of cluster counts per name
const dist = {};
for (const [, clusters] of Object.entries(clustersByName)) {
  const n = clusters.length;
  dist[n] = (dist[n] || 0) + 1;
}
console.log('\nCluster-count distribution across all names:');
Object.entries(dist).sort((a, b) => +a[0] - +b[0]).forEach(([k, v]) => {
  console.log(`  ${k} cluster(s): ${v} name(s)`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Q3 — Direction asymmetry
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════');
console.log('Q3 — Direction asymmetry (trips per route×direction)');
console.log('══════════════════════════════════════════════');

// Count trips per route_id × direction_id
const tripCounts = {};
for (const t of trips) {
  const key = `${t.route_id}|${t.direction_id}`;
  tripCounts[key] = (tripCounts[key] || 0) + 1;
}

// Find route_ids present for only one direction_id
const routeDirections = {};
for (const t of trips) {
  if (!routeDirections[t.route_id]) routeDirections[t.route_id] = new Set();
  routeDirections[t.route_id].add(t.direction_id);
}

const missingReturn = Object.entries(routeDirections)
  .filter(([, dirs]) => dirs.size === 1)
  .sort((a, b) => a[0].localeCompare(b[0]));

console.log(`Routes with only one direction_id: ${missingReturn.length}`);
if (missingReturn.length) {
  missingReturn.forEach(([routeId, dirs]) => {
    console.log(`  route_id=${routeId} direction_id=${[...dirs][0]}`);
  });
}

// Also catch routes with an imbalance (different trip counts per direction)
const routeDir0 = {}, routeDir1 = {};
for (const t of trips) {
  if (t.direction_id === '0') routeDir0[t.route_id] = (routeDir0[t.route_id] || 0) + 1;
  if (t.direction_id === '1') routeDir1[t.route_id] = (routeDir1[t.route_id] || 0) + 1;
}

const bothDirRoutes = Object.keys(routeDirections).filter(r => routeDirections[r].size === 2);
const imbalanced = bothDirRoutes.filter(r => routeDir0[r] !== routeDir1[r]);
console.log(`\nRoutes with both directions but unequal trip counts: ${imbalanced.length}`);
if (imbalanced.length) {
  imbalanced.forEach(r => {
    console.log(`  route_id=${r} dir0=${routeDir0[r]} dir1=${routeDir1[r]}`);
  });
}

// Confirm the 137/135 split
const total0 = Object.values(routeDir0).reduce((s, v) => s + v, 0);
const total1 = Object.values(routeDir1).reduce((s, v) => s + v, 0);
console.log(`\nTotal trips: dir0=${total0}, dir1=${total1}`);

// Also check stop_times for location_type=1 references
console.log('\n══════════════════════════════════════════════');
console.log('Bonus — do any stop_times reference location_type=1 stops?');
console.log('══════════════════════════════════════════════');

const type1Ids = new Set(stops.filter(s => s.location_type === '1').map(s => s.stop_id));
const type1InStopTimes = stopTimes.filter(st => type1Ids.has(st.stop_id));
console.log(`location_type=1 stop IDs: ${[...type1Ids].join(', ')}`);
console.log(`stop_times rows referencing them: ${type1InStopTimes.length}`);
if (type1InStopTimes.length) {
  const uniq = new Set(type1InStopTimes.map(st => st.stop_id));
  console.log(`Distinct type-1 stops with service: ${[...uniq].join(', ')}`);
}
