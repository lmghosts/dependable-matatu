#!/usr/bin/env node
/**
 * DoD 10/11/12 routing verification — uses name lookup (not guessed IDs)
 * and departure time matched to trip schedules.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Timetable, Router, StopsIndex, Query, Time } from 'minotor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const meta   = JSON.parse(readFileSync(join(ROOT, 'public/graph/meta.json'), 'utf8'));
const ttBuf  = readFileSync(join(ROOT, `public/graph/timetable-${meta.version}`));
const stpBuf = readFileSync(join(ROOT, `public/graph/stops-${meta.version}`));
const si     = StopsIndex.fromData(new Uint8Array(stpBuf));
const tt     = Timetable.fromData(new Uint8Array(ttBuf));
const router = new Router(tt, si);

console.log(`Graph: ${meta.version}\n`);

// Helper: try all from×to combinations
function tryPairs(fromStops, toStops, dep) {
  for (const f of fromStops) {
    for (const t of toStops) {
      if (f.sourceStopId === t.sourceStopId) continue;
      try {
        const q = new Query.Builder()
          .from(f.sourceStopId).to(t.sourceStopId)
          .departureTime(dep).maxTransfers(2).build();
        const r = router.route(q).bestRoute();
        if (r) return { route: r, from: f, to: t };
      } catch { /* no route for this pair */ }
    }
  }
  return null;
}

function fmtResult(res, label) {
  if (res) {
    const dur = Math.round(res.route.totalDuration().toSeconds() / 60);
    console.log(`  ✓ ${label}: ${res.from.name}(${res.from.sourceStopId}) → ${res.to.name}(${res.to.sourceStopId})`);
    console.log(`    dep=${res.route.departureTime().toString().slice(0,5)} arr=${res.route.arrivalTime().toString().slice(0,5)} (${dur} min)`);
    return true;
  } else {
    console.log(`  ✗ ${label}: NO ROUTE`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Route 70904004810 trips start at 06:00. Use 05:30 (like the after-hours fallback)
// so the router sees the trip as upcoming.
// ────────────────────────────────────────────────────────────────────────────────
const dep0530 = Time.fromDate(new Date(2026, 7, 1, 5, 30, 0));
const dep0800 = Time.fromDate(new Date(2026, 7, 1, 8, 0, 0));

console.log('DoD 10 & 11 — route 70904004810 journey queries');
console.log('Trip schedule: 06:00–06:14. Using dep=05:30 to catch the service.\n');

// Forward: Westlands-area → Yaya-area (trip 70048110)
const fwdStops  = si.findStopsByName('Yaya');
const wstlStops = si.findStopsByName('Westlands');
console.log(`  'Yaya' lookup: ${fwdStops.length} stops — ${fwdStops.map(s => s.sourceStopId).join(', ')}`);
console.log(`  'Westlands' lookup: ${wstlStops.length} stops — ${wstlStops.map(s => s.sourceStopId).join(', ')}`);

// The stops on trip 70048110 start with 0710PBW (Westlands side) and end at 0710AAY (Yaya side).
// Use direct stop IDs to test this specific route.
const pbwStops = [{ sourceStopId: '0710PBW', name: 'Westlands (PBW)' }];
const aayStops = [{ sourceStopId: '0710AAY', name: 'Yaya (AAY)' }];

const fwdRes = tryPairs(pbwStops, aayStops, dep0530);
console.log('\nDoD 11 — Forward (Westlands→Yaya, trip 70048110):');
const dod11 = fmtResult(fwdRes, 'Forward 0710PBW→0710AAY at 05:30');

// Reverse: Yaya-area → Westlands-area (trip 70048111, now dir=1)
const ayyStops = [{ sourceStopId: '0700AYY', name: 'Yaya (AYY)' }];
const lneStops = [{ sourceStopId: '0710LNE', name: 'Westlands (LNE)' }];

const revRes = tryPairs(ayyStops, lneStops, dep0530);
console.log('\nDoD 10 — Reverse (Yaya→Westlands, trip 70048111):');
const dod10 = fmtResult(revRes, 'Reverse 0700AYY→0710LNE at 05:30');

// Also confirm neither works at 08:00 (no service after 06:14 on this route)
console.log('\n  Confirming no-service at 08:00 (single trip departs at 06:00):');
const fwdAt8 = tryPairs(pbwStops, aayStops, dep0800);
const revAt8 = tryPairs(ayyStops, lneStops, dep0800);
console.log(`  Forward at 08:00: ${fwdAt8 ? 'ROUTE FOUND (unexpected)' : 'NO ROUTE (expected — trip already departed)'}`);
console.log(`  Reverse at 08:00: ${revAt8 ? 'ROUTE FOUND (unexpected)' : 'NO ROUTE (expected — trip already departed)'}`);

// ────────────────────────────────────────────────────────────────────────────────
// DoD 12 — Regression on three unrelated routes
// Using name lookup, not hardcoded IDs.
// ────────────────────────────────────────────────────────────────────────────────
console.log('\nDoD 12 — Regression: three unrelated routes (dep=08:00)');
const regressionPairs = [
  ['Kikuyu', 'Kahawa Sukari', 'Route 105 corridor'],
  ['Cabanas', 'Church Road',   'Route 34J corridor'],
  ['Thika',  'Kikuyu',        'Long-haul cross-city'],
];

const results = [];
for (const [fromName, toName, label] of regressionPairs) {
  const from = si.findStopsByName(fromName);
  const to   = si.findStopsByName(toName);
  console.log(`\n  ${label}: "${fromName}" (${from.length} stops) → "${toName}" (${to.length} stops)`);
  const res = tryPairs(from, to, dep0800);
  results.push(fmtResult(res, `${fromName}→${toName}`));
}

// ────────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────');
const dodResults = [dod10, dod11, ...results];
const passed = dodResults.filter(Boolean).length;
console.log(`Routing checks: ${passed}/${dodResults.length} PASS`);
if (passed < dodResults.length) console.log('FAIL items need investigation.');
