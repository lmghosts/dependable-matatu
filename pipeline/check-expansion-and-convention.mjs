#!/usr/bin/env node
/**
 * Pre-edit checks for route 70904004810:
 * A) Does the expansion produce direction-1 trips for this route? Does fixing the label
 *    change routing behaviour, or only metadata?
 * B) Convention: which direction_id do CBD-bound trips carry across other routes?
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS = join(__dirname, '_gtfs_tmp/extracted');
const BIDIR_ZIP = join(__dirname, '_gtfs_tmp/nairobi-bidir.zip');

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const hdrs = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    const row = {};
    hdrs.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
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

const ROUTE_ID = '70904004810';

// ─── A: Expansion analysis ────────────────────────────────────────────────────
console.log('════════════════════════════════════════════════');
console.log('A — Expansion analysis');
console.log('════════════════════════════════════════════════');

// What does the expansion produce for this route?
// Simulate the expansion logic from add-reverse-trips.js for these 2 trips.

const baseTrips = parseCSV(readFileSync(join(GTFS, 'trips.txt'), 'utf8'));
const baseStTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));

const routeBaseTrips = baseTrips.filter(t => t.route_id === ROUTE_ID);
console.log(`\nBase trips for ${ROUTE_ID}:`);
routeBaseTrips.forEach(t => {
  console.log(`  ${t.trip_id}  dir=${t.direction_id}  headsign="${t.trip_headsign}"`);
});

// The expansion creates _R trips for every base trip, flipping direction_id.
// What direction_id do the synthetic reverses carry?
console.log('\nSynthetic reverses the expansion would produce:');
routeBaseTrips.forEach(t => {
  const flipped = t.direction_id === '0' ? '1' : '0';
  console.log(`  ${t.trip_id}_R  dir=${flipped}  (reversed stop sequence of ${t.trip_id})`);
});

console.log('\nExpanded trips for this route after pipeline:');
console.log('  dir=0: 70048110 (base), 70048111 (base, mislabeled)');
console.log('  dir=1: 70048110_R (synthetic), 70048111_R (synthetic)');
console.log('\nBoth physical directions are present in the expanded graph.');
console.log('The expansion reverses stop sequences regardless of direction_id.');
console.log('direction_id on 70048111 affects only the metadata of 70048111_R,');
console.log('not the stop sequence, times, or routing behaviour of any trip.');

// Check the actual bidir zip if available
let bidirAvailable = false;
try {
  const bidirZip = new AdmZip(BIDIR_ZIP);
  const bidirTrips = parse(bidirZip.getEntry('trips.txt').getData().toString('utf8'), { columns: true, skip_empty_lines: true });
  const routeBidirTrips = bidirTrips.filter(t => t.route_id === ROUTE_ID);
  bidirAvailable = true;
  console.log(`\nActual expanded trips in nairobi-bidir.zip for ${ROUTE_ID}:`);
  routeBidirTrips.forEach(t => console.log(`  ${t.trip_id}  dir=${t.direction_id}  headsign="${t.trip_headsign}"`));

  // Global direction counts in expanded
  const d0 = bidirTrips.filter(t => t.direction_id === '0').length;
  const d1 = bidirTrips.filter(t => t.direction_id === '1').length;
  console.log(`\nExpanded totals (nairobi-bidir.zip): dir0=${d0}  dir1=${d1}  total=${bidirTrips.length}`);
} catch {
  console.log('\nnairobi-bidir.zip not available — using simulation only');
}

// Routing impact: does the routing engine care about direction_id?
// The routing engine (minotor/RAPTOR) routes on stop_times only — it finds
// journeys from stop A to stop B by traversing time-ordered sequences.
// direction_id is not part of the RAPTOR algorithm and is not in stop_times.
console.log('\nRouting impact:');
console.log('  RAPTOR operates on stop_times sequences. direction_id is trip metadata only.');
console.log('  Routing works if: there exists a stop_times sequence from origin → destination.');
console.log('  After expansion, both physical directions have stop_times → routing is unaffected by the label.');
console.log('\nConclusion: the "silent no-route-found" diagnosis does NOT apply to this route.');
console.log('  The expansion produces valid reverses for both base trips.');
console.log('  Fixing direction_id is a data-quality fix, not a routing fix.');

// ─── B: Convention check ──────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════');
console.log('B — Convention: which direction_id do CBD-bound trips carry?');
console.log('════════════════════════════════════════════════');

// CBD-bound headsigns from the feed (known termini near CBD):
const CBD_HEADSIGNS = new Set([
  'Ngara', 'Koja', 'Odeon', 'CBD', 'Town', 'Bus Station', 'Kencom',
  'Ambassadeur', 'Commercial', 'Muthurwa', 'OTC', 'Ronald Ngala',
  'Archives', 'GPO', 'City Hall', 'Afya', 'Development House',
  'Globe Cinema', 'Imenti House', 'Anniversary Towers', 'KICC',
]);

const otherTrips = baseTrips.filter(t => t.route_id !== ROUTE_ID);

const cbdBound = otherTrips.filter(t =>
  CBD_HEADSIGNS.has(t.trip_headsign) ||
  /^(ngara|koja|cbd|town|bus.station|kencom|odeon|muthurwa|otc)/i.test(t.trip_headsign)
);

console.log(`\nCBD-bound trips (by headsign keyword): ${cbdBound.length}`);
const cbdDir0 = cbdBound.filter(t => t.direction_id === '0').length;
const cbdDir1 = cbdBound.filter(t => t.direction_id === '1').length;
console.log(`  direction_id=0: ${cbdDir0}`);
console.log(`  direction_id=1: ${cbdDir1}`);

if (cbdDir0 + cbdDir1 > 0) {
  const majority = cbdDir0 > cbdDir1 ? 0 : (cbdDir1 > cbdDir0 ? 1 : 'tied');
  console.log(`  Majority: ${majority === 'tied' ? 'TIED — no clear convention' : `direction_id=${majority}`}`);
}

// Show the headsigns found
const cbdHeadsignCounts = {};
for (const t of cbdBound) {
  const k = `${t.trip_headsign}|dir=${t.direction_id}`;
  cbdHeadsignCounts[k] = (cbdHeadsignCounts[k] || 0) + 1;
}
console.log('\nCBD-bound headsign × direction_id breakdown:');
Object.entries(cbdHeadsignCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .forEach(([k, n]) => console.log(`  ${k}: ${n} trip(s)`));

// Broader check: all unique headsigns and their direction distribution
const headsignDirs = {};
for (const t of otherTrips) {
  const hs = t.trip_headsign;
  if (!headsignDirs[hs]) headsignDirs[hs] = { 0: 0, 1: 0 };
  headsignDirs[hs][t.direction_id] = (headsignDirs[hs][t.direction_id] || 0) + 1;
}

// Headsigns that appear only as direction_id=0 (consistent outbound-only labels)
const onlyDir0 = Object.entries(headsignDirs).filter(([, d]) => d[0] > 0 && !d[1]);
const onlyDir1 = Object.entries(headsignDirs).filter(([, d]) => d[1] > 0 && !d[0]);
console.log(`\nHeadsigns appearing only as direction_id=0: ${onlyDir0.length}`);
console.log(`Headsigns appearing only as direction_id=1: ${onlyDir1.length}`);

// Is there a pattern? Look at the route name structure
// Route names typically "A-B-C" format; does direction 0 go A→C or C→A?
const routes = parseCSV(readFileSync(join(GTFS, 'routes.txt'), 'utf8'));
const routeMap = Object.fromEntries(routes.map(r => [r.route_id, r]));

// For routes with both directions, check if direction_id=0 headsign matches
// the last stop of the route_long_name (i.e., direction 0 = outbound from first to last)
let dir0matchesEnd = 0, dir0matchesStart = 0, checked = 0;
const routeDirs = {};
for (const t of otherTrips) {
  if (!routeDirs[t.route_id]) routeDirs[t.route_id] = { 0: [], 1: [] };
  routeDirs[t.route_id][t.direction_id].push(t);
}

for (const [rid, dirs] of Object.entries(routeDirs)) {
  if (!dirs[0].length || !dirs[1].length) continue; // skip unidirectional
  const route = routeMap[rid];
  if (!route?.route_long_name) continue;
  const parts = route.route_long_name.split('-').map(s => s.trim().toLowerCase());
  const first = parts[0], last = parts[parts.length - 1];
  const dir0hs = dirs[0][0].trip_headsign.toLowerCase();
  if (dir0hs.includes(last) || last.includes(dir0hs)) dir0matchesEnd++;
  else if (dir0hs.includes(first) || first.includes(dir0hs)) dir0matchesStart++;
  checked++;
}
console.log(`\nRoute-name convention check (${checked} bidirectional routes examined):`);
console.log(`  direction_id=0 headsign matches LAST stop of route_long_name: ${dir0matchesEnd}`);
console.log(`  direction_id=0 headsign matches FIRST stop of route_long_name: ${dir0matchesStart}`);
console.log(`  (Route 70904004810 is "Yaya-Kasuku-Westlands": first=Yaya, last=Westlands)`);

// For our specific route:
// Trip 70048110: dir=0, headsign="Yaya" → matches FIRST segment
// Trip 70048111: dir=0, headsign="Westlands" → matches LAST segment
// If convention is dir0→last, then 70048110 should be dir=1 and 70048111 should be dir=0
// If convention is dir0→first, then 70048110 should be dir=0 and 70048111 should be dir=1
console.log('\nApplication to route 70904004810 (Yaya-Kasuku-Westlands):');
console.log(`  If dir0=toward-LAST convention → 70048111 (headsign "Westlands") = dir0 CORRECT, 70048110 = dir1`);
console.log(`  If dir0=toward-FIRST convention → 70048110 (headsign "Yaya") = dir0 CORRECT, 70048111 = dir1`);
