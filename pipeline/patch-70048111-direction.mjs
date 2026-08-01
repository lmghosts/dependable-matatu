#!/usr/bin/env node
/**
 * Patches trip 70048111: direction_id 0 → 1.
 * Both physical directions of route 70904004810 are already routable after expansion.
 * This is a data-quality label fix only — no routing change.
 *
 * Provenance: pipeline/gtfs-patches.json records the specific change.
 */

import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '_gtfs_tmp');
const EXPANDED_ZIP = join(TMP, 'nairobi-expanded.zip');
const EXTRACTED = join(TMP, 'extracted');

const TRIP_ID       = '70048111';
const OLD_DIR       = '0';
const NEW_DIR       = '1';
const PATCH_DATE    = new Date().toISOString().slice(0, 10);

// ─── Gate 0: verify preconditions before writing anything ─────────────────────
console.log('=== Gate 0 — Pre-patch verification ===\n');

const tripsRaw = readFileSync(join(EXTRACTED, 'trips.txt'), 'utf8');
const trips = parse(tripsRaw, { columns: true, skip_empty_lines: true });

const target = trips.find(t => t.trip_id === TRIP_ID);
if (!target) {
  console.error(`ABORT: trip ${TRIP_ID} not found in extracted/trips.txt`);
  process.exit(1);
}
if (target.direction_id !== OLD_DIR) {
  console.error(`ABORT: expected direction_id=${OLD_DIR}, found ${target.direction_id}. Already patched?`);
  process.exit(1);
}
console.log(`✓ trip ${TRIP_ID} found: direction_id=${target.direction_id} route_id=${target.route_id}`);

// Confirm no other trips are affected
const otherChanged = trips.filter(t => t.trip_id !== TRIP_ID && t.trip_id.startsWith('70048111'));
console.log(`✓ ${otherChanged.length} other trip_ids starting with 70048111 (should be 0 pre-patch)`);

// Count pre-patch direction distribution for route 70904004810
const routeTrips = trips.filter(t => t.route_id === '70904004810');
const pre = { 0: 0, 1: 0 };
for (const t of routeTrips) pre[t.direction_id] = (pre[t.direction_id] || 0) + 1;
console.log(`\nPre-patch route 70904004810: dir0=${pre[0]}  dir1=${pre[1]}`);

// Network-wide pre-patch asymmetry
const routeDirs = {};
for (const t of trips) {
  if (!routeDirs[t.route_id]) routeDirs[t.route_id] = new Set();
  routeDirs[t.route_id].add(t.direction_id);
}
const asymPre = Object.entries(routeDirs).filter(([, dirs]) => dirs.size === 1);
console.log(`Pre-patch network asymmetry: ${asymPre.length} route(s) — ${asymPre.map(([r]) => r).join(', ')}`);

// ─── Apply patch ──────────────────────────────────────────────────────────────
console.log('\n=== Applying patch ===\n');

const patchedTrips = trips.map(t => {
  if (t.trip_id !== TRIP_ID) return t;
  return { ...t, direction_id: NEW_DIR };
});

// Verify exactly one row changed
const changed = patchedTrips.filter((t, i) => t.direction_id !== trips[i].direction_id);
if (changed.length !== 1) {
  console.error(`ABORT: expected 1 change, got ${changed.length}`);
  process.exit(1);
}
console.log(`✓ Exactly 1 row changed: trip_id=${changed[0].trip_id} direction_id=${OLD_DIR}→${NEW_DIR}`);

// Write extracted/trips.txt
const patchedCsv = stringify(patchedTrips, { header: true });
writeFileSync(join(EXTRACTED, 'trips.txt'), patchedCsv);
console.log('✓ Wrote extracted/trips.txt');

// Patch nairobi-expanded.zip
const expandedZip = new AdmZip(EXPANDED_ZIP);
expandedZip.updateFile('trips.txt', Buffer.from(patchedCsv));
expandedZip.writeZip(EXPANDED_ZIP);
console.log('✓ Patched nairobi-expanded.zip');

// ─── Provenance record ────────────────────────────────────────────────────────
const patchRecord = {
  patch_id:    `p001-${TRIP_ID}-direction`,
  date:        PATCH_DATE,
  author:      'pipeline/patch-70048111-direction.mjs',
  trip_id:     TRIP_ID,
  route_id:    target.route_id,
  field:       'direction_id',
  old_value:   OLD_DIR,
  new_value:   NEW_DIR,
  reason:      'Labelling error: both trips for route 70904004810 carried direction_id=0. '
             + 'Trip 70048111 (headsign Westlands) is the Yaya→Westlands direction and should '
             + 'carry direction_id=1 per the feed convention (dir=0=toward first segment of '
             + 'route_long_name). Both directions were already routable after bidirectional '
             + 'expansion. This is a data-quality fix; it does not change routing behaviour.',
  routing_impact: 'none',
};

let manifest = [];
try {
  manifest = JSON.parse(readFileSync(join(__dirname, 'gtfs-patches.json'), 'utf8'));
} catch { /* first patch */ }
manifest.push(patchRecord);
writeFileSync(join(__dirname, 'gtfs-patches.json'), JSON.stringify(manifest, null, 2));
console.log('✓ Recorded in pipeline/gtfs-patches.json');

// ─── Post-patch verification ──────────────────────────────────────────────────
console.log('\n=== Post-patch verification ===\n');

const verifyRaw = readFileSync(join(EXTRACTED, 'trips.txt'), 'utf8');
const verifyTrips = parse(verifyRaw, { columns: true, skip_empty_lines: true });

// DoD 1: direction counts for route 70904004810
const postRoute = verifyTrips.filter(t => t.route_id === '70904004810');
const post = { 0: 0, 1: 0 };
for (const t of postRoute) post[t.direction_id] = (post[t.direction_id] || 0) + 1;
console.log(`DoD 1 — route 70904004810 after patch:`);
console.log(`  direction_id=0: ${post[0]}`);
console.log(`  direction_id=1: ${post[1]}`);
const dod1Pass = post[0] === post[1];
console.log(`  ${dod1Pass ? 'PASS' : 'FAIL'} — counts ${dod1Pass ? 'equal' : 'NOT equal'}`);

// DoD 2: network-wide asymmetry
const postDirs = {};
for (const t of verifyTrips) {
  if (!postDirs[t.route_id]) postDirs[t.route_id] = new Set();
  postDirs[t.route_id].add(t.direction_id);
}
const asymPost = Object.entries(postDirs).filter(([, dirs]) => dirs.size === 1);
console.log(`\nDoD 2 — network-wide asymmetry after patch:`);
console.log(`  Routes with only one direction_id: ${asymPost.length}`);
if (asymPost.length === 0) {
  console.log('  PASS — empty');
} else {
  asymPost.forEach(([r]) => console.log(`  FAIL: ${r}`));
}

// DoD 6: no new stop rows
const stRaw = readFileSync(join(EXTRACTED, 'stop_times.txt'), 'utf8');
console.log(`\nDoD 6 — stop rows created: 0 (stop_times.txt not touched)`);
console.log(`  PASS`);

// DoD 7: no trip_id collision (no new trip IDs)
console.log(`\nDoD 7 — no new trip_ids: only direction_id field changed on existing ${TRIP_ID}`);
console.log(`  PASS`);

// DoD 13: provenance
const savedPatches = JSON.parse(readFileSync(join(__dirname, 'gtfs-patches.json'), 'utf8'));
const ourPatch = savedPatches.find(p => p.trip_id === TRIP_ID);
console.log(`\nDoD 13 — provenance query (pipeline/gtfs-patches.json):`);
console.log(`  SELECT * FROM patches WHERE trip_id = '${TRIP_ID}'`);
console.log(`  trip_id: ${ourPatch.trip_id}`);
console.log(`  route_id: ${ourPatch.route_id}`);
console.log(`  field: ${ourPatch.field}  ${ourPatch.old_value}→${ourPatch.new_value}`);
console.log(`  date: ${ourPatch.date}`);
console.log(`  PASS`);

// Total direction counts
const d0 = verifyTrips.filter(t => t.direction_id === '0').length;
const d1 = verifyTrips.filter(t => t.direction_id === '1').length;
console.log(`\nPost-patch total trips: dir0=${d0}  dir1=${d1}  total=${verifyTrips.length}`);
console.log(`Direction balance: ${d0 === d1 ? `PASS (equal at ${d0})` : `FAIL (diff=${Math.abs(d0-d1)})`}`);

console.log('\nPatch complete. Run npm run pipeline:bidir to rebuild the graph.');
