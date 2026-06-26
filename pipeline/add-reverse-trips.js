#!/usr/bin/env node
/**
 * Makes all GTFS routes bidirectional by mirroring every trip in reverse.
 *
 * Kenyan matatu routes always run in both directions. The 2019 Digital Matatus
 * dataset captured each direction as a separate trip but only included one
 * direction's trips in the export. This script adds the missing reverse trips.
 *
 * Algorithm: for each trip A→B→C with departure times [t0, t1, t2]:
 *   - leg durations: [t1-t0, t2-t1]
 *   - reverse trip C→B→A starting at t0, with leg durations reversed: [t2-t1, t1-t0]
 *
 * Usage: node pipeline/add-reverse-trips.js
 * Output: updates public/graph/ and public/routable-stops.json
 */
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function toSec(t) {
  const [h, m, s] = String(t).split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}
function fromSec(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8);
}

const INPUT_ZIP  = join(__dirname, '_gtfs_tmp/nairobi-expanded.zip');
const OUTPUT_ZIP = join(__dirname, '_gtfs_tmp/nairobi-bidir.zip');
const TMP_DIR    = join(__dirname, '_gtfs_tmp');
const MINOTOR    = join(ROOT, 'node_modules/.bin/minotor');
const GRAPH_DATE = new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = join(ROOT, 'public/graph');

if (!existsSync(INPUT_ZIP)) {
  console.error('ERROR: nairobi-expanded.zip not found. Run npm run pipeline first.');
  process.exit(1);
}

// ─── Load GTFS ─────────────────────────────────────────────
console.log('[bidir] Loading GTFS…');
const zip      = new AdmZip(INPUT_ZIP);
const tripsRaw = zip.getEntry('trips.txt').getData().toString('utf8');
const stRaw    = zip.getEntry('stop_times.txt').getData().toString('utf8');

const trips     = parse(tripsRaw, { columns: true, skip_empty_lines: true });
const stopTimes = parse(stRaw,    { columns: true, skip_empty_lines: true, cast: false });

console.log(`[bidir] Loaded ${trips.length} trips, ${stopTimes.length} stop_times`);

// ─── Group stop_times by trip_id ───────────────────────────
const byTrip = {};
for (const row of stopTimes) {
  if (!byTrip[row.trip_id]) byTrip[row.trip_id] = [];
  byTrip[row.trip_id].push(row);
}
for (const arr of Object.values(byTrip)) {
  arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
}

// ─── Generate reverse trips ─────────────────────────────────
const newTrips     = [...trips];
const newStopTimes = [...stopTimes];
let reversed = 0;
let skipped  = 0;

for (const trip of trips) {
  const stops = byTrip[trip.trip_id];
  if (!stops || stops.length < 2) { skipped++; continue; }

  const revTripId = trip.trip_id + '_R';

  // Compute departure-to-departure leg durations
  const deps = stops.map(s => toSec(s.departure_time));
  const legDurs = [];
  for (let i = 1; i < stops.length; i++) {
    legDurs.push(Math.max(10, deps[i] - deps[i - 1])); // min 10s per leg
  }

  // Reverse stop order and leg durations
  const revStops    = stops.slice().reverse();
  const revLegDurs  = legDurs.slice().reverse();

  // Build reverse stop_times starting at same time as original first departure
  let t = deps[0];
  for (let i = 0; i < revStops.length; i++) {
    const tStr = fromSec(t);
    newStopTimes.push({
      trip_id:        revTripId,
      arrival_time:   tStr,
      departure_time: tStr,
      stop_id:        revStops[i].stop_id,
      stop_sequence:  i + 1,
    });
    if (i < revStops.length - 1) t += revLegDurs[i];
  }

  // Add trip row with flipped direction_id
  newTrips.push({
    ...trip,
    trip_id:      revTripId,
    direction_id: trip.direction_id === '0' ? '1' : '0',
    trip_headsign: revStops[revStops.length - 1].stop_id,
  });
  reversed++;
}

console.log(`[bidir] ${reversed} reverse trips added (${skipped} skipped — single-stop)`);
console.log(`[bidir] Totals: ${newTrips.length} trips, ${newStopTimes.length} stop_times`);

// ─── Write bidirectional zip ────────────────────────────────
console.log('[bidir] Writing nairobi-bidir.zip…');
const outZip = new AdmZip(INPUT_ZIP);
outZip.updateFile('trips.txt',      Buffer.from(stringify(newTrips,     { header: true })));
outZip.updateFile('stop_times.txt', Buffer.from(stringify(newStopTimes, { header: true })));
outZip.writeZip(OUTPUT_ZIP);
console.log('[bidir] Written.');

// ─── Rebuild minotor graph ──────────────────────────────────
const tmpTimetable = join(TMP_DIR, 'timetable-bidir');
const tmpStops     = join(TMP_DIR, 'stops-bidir');
for (const f of [tmpTimetable, tmpStops]) { try { unlinkSync(f); } catch {} }

console.log(`[bidir] Running minotor parse-gtfs for ${GRAPH_DATE}…`);
execSync(
  `"${MINOTOR}" parse-gtfs "${OUTPUT_ZIP}" -p standard -d ${GRAPH_DATE} -t "${tmpTimetable}" -s "${tmpStops}"`,
  { stdio: 'inherit' }
);

// ─── Copy to public/graph/ ──────────────────────────────────
mkdirSync(OUTPUT_DIR, { recursive: true });
const version        = `${GRAPH_DATE}-${sha256(tmpTimetable)}`;
const destTimetable  = join(OUTPUT_DIR, `timetable-${version}`);
const destStops      = join(OUTPUT_DIR, `stops-${version}`);
copyFileSync(tmpTimetable, destTimetable);
copyFileSync(tmpStops,     destStops);

const meta = {
  version,
  date:    GRAPH_DATE,
  synced:  new Date().toISOString(),
  source:  'nairobi-bidir.zip (bidirectional — all routes mirrored)',
};
writeFileSync(join(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`[bidir] Graph: ${destTimetable}`);
console.log(`[bidir] Stops: ${destStops}`);

// ─── Regenerate routable-stops.json ────────────────────────
// routable-stops maps stop_id → unique route count (used for autocomplete ranking).
// With reverse trips, every terminal stop now has departures — so they'll appear.
console.log('[bidir] Regenerating routable-stops.json…');

const routeForTrip = new Map(newTrips.map(t => [t.trip_id, t.route_id]));
const routesPerStop = {};

for (const st of newStopTimes) {
  const routeId = routeForTrip.get(st.trip_id);
  if (!routeId) continue;
  if (!routesPerStop[st.stop_id]) routesPerStop[st.stop_id] = new Set();
  routesPerStop[st.stop_id].add(routeId);
}

const routableOut = {};
for (const [stopId, routes] of Object.entries(routesPerStop)) {
  routableOut[stopId] = routes.size;
}

writeFileSync(join(ROOT, 'public/routable-stops.json'), JSON.stringify(routableOut));
const stopCount = Object.keys(routableOut).length;
console.log(`[bidir] routable-stops.json: ${stopCount} stops`);

// Write meta.json (update version refs in app.js if needed)
console.log(`\n✓ Done. version=${version}`);
console.log('  Restart the dev server to pick up the new graph.');
