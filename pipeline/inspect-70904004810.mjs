#!/usr/bin/env node
/**
 * Step 1 & 2 inspection: report everything about route 70904004810 before touching it.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS = join(__dirname, '_gtfs_tmp/extracted');

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
    return row;
  });
}
function parseLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}

const routes   = parseCSV(readFileSync(join(GTFS, 'routes.txt'), 'utf8'));
const trips    = parseCSV(readFileSync(join(GTFS, 'trips.txt'), 'utf8'));
const stopTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));

const ROUTE_ID = '70904004810';

// ─── Route metadata ───────────────────────────────────────────────────────────
const route = routes.find(r => r.route_id === ROUTE_ID);
console.log('Route metadata:');
if (route) {
  Object.entries(route).forEach(([k, v]) => { if (v) console.log(`  ${k}: ${v}`); });
} else {
  console.log('  NOT FOUND in routes.txt');
}

// ─── Trips ────────────────────────────────────────────────────────────────────
const routeTrips = trips.filter(t => t.route_id === ROUTE_ID);
console.log(`\nTrips for route ${ROUTE_ID}: ${routeTrips.length}`);
routeTrips.forEach(t => {
  console.log(`\n  trip_id:        ${t.trip_id}`);
  console.log(`  direction_id:   ${t.direction_id}`);
  console.log(`  service_id:     ${t.service_id}`);
  console.log(`  trip_headsign:  ${t.trip_headsign}`);
  console.log(`  shape_id:       ${t.shape_id}`);
  console.log(`  block_id:       ${t.block_id || '(empty)'}`);
});

// ─── Stop sequences ───────────────────────────────────────────────────────────
for (const t of routeTrips) {
  const seq = stopTimes
    .filter(st => st.trip_id === t.trip_id)
    .sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));

  console.log(`\nStop times for trip ${t.trip_id} (direction_id=${t.direction_id}):`);
  console.log(`  ${seq.length} stops`);
  seq.forEach(st => {
    console.log(`  seq=${st.stop_sequence.padStart(3)} stop_id=${st.stop_id.padEnd(12)} arr=${st.arrival_time}  dep=${st.departure_time}`);
  });
}

// ─── Step 2: compare stop sequences between the two trips ────────────────────
if (routeTrips.length === 2) {
  const [t1, t2] = routeTrips.map(t =>
    stopTimes
      .filter(st => st.trip_id === t.trip_id)
      .sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence))
      .map(st => st.stop_id)
  );

  const seqMatch = t1.length === t2.length && t1.every((id, i) => id === t2[i]);
  console.log(`\nStep 2 — stop sequence comparison:`);
  console.log(`  Trip 1 stops: ${t1.length}`);
  console.log(`  Trip 2 stops: ${t2.length}`);
  console.log(`  Sequences identical: ${seqMatch}`);

  if (!seqMatch) {
    console.log('\n  SEQUENCES DIFFER — retrace assumption does NOT hold. Stop here.');
    const maxLen = Math.max(t1.length, t2.length);
    for (let i = 0; i < maxLen; i++) {
      const a = t1[i] || '(none)';
      const b = t2[i] || '(none)';
      const mark = a !== b ? ' <<<' : '';
      console.log(`  [${i}] ${a} | ${b}${mark}`);
    }
  } else {
    console.log('  SEQUENCES IDENTICAL — retrace assumption holds. Safe to proceed.');
  }
} else {
  console.log(`\nStep 2: cannot compare — expected 2 trips, found ${routeTrips.length}`);
}

// ─── Shapes ───────────────────────────────────────────────────────────────────
const shapeIds = [...new Set(routeTrips.map(t => t.shape_id).filter(Boolean))];
console.log(`\nShape IDs referenced: ${shapeIds.join(', ') || '(none)'}`);

if (shapeIds.length > 0) {
  try {
    const shapes = parseCSV(readFileSync(join(GTFS, 'shapes.txt'), 'utf8'));
    for (const sid of shapeIds) {
      const pts = shapes.filter(s => s.shape_id === sid).sort((a, b) => parseInt(a.shape_pt_sequence) - parseInt(b.shape_pt_sequence));
      console.log(`  shape ${sid}: ${pts.length} points, first=(${pts[0]?.shape_pt_lat},${pts[0]?.shape_pt_lon}) last=(${pts.at(-1)?.shape_pt_lat},${pts.at(-1)?.shape_pt_lon})`);
    }
  } catch { console.log('  shapes.txt not available'); }
}

// ─── Network-wide asymmetry (baseline before change) ─────────────────────────
const tripsByRoute = {};
for (const t of trips) {
  const key = `${t.route_id}|${t.direction_id}`;
  tripsByRoute[key] = (tripsByRoute[key] || 0) + 1;
}
const routeDirs = {};
for (const t of trips) {
  if (!routeDirs[t.route_id]) routeDirs[t.route_id] = new Set();
  routeDirs[t.route_id].add(t.direction_id);
}
const asymmetric = Object.entries(routeDirs).filter(([, dirs]) => dirs.size === 1);
console.log(`\nPre-change network asymmetry: ${asymmetric.length} route(s) with only one direction`);
asymmetric.forEach(([rid, dirs]) => console.log(`  ${rid} direction_id=${[...dirs][0]}`));

// ─── Total trip counts ────────────────────────────────────────────────────────
const d0 = trips.filter(t => t.direction_id === '0').length;
const d1 = trips.filter(t => t.direction_id === '1').length;
console.log(`\nPre-change total trips: dir0=${d0} dir1=${d1} total=${trips.length}`);
