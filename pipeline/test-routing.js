#!/usr/bin/env node
/**
 * Validates routing for specific origin→destination pairs.
 * Uses minotor directly, bypassing the browser UI.
 *
 * Usage: node pipeline/test-routing.js
 */
import { Timetable, Router, StopsIndex, Query, Time } from 'minotor';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Load graph ────────────────────────────────────────────────
const meta = JSON.parse(readFileSync(join(ROOT, 'public/graph/meta.json'), 'utf8'));
console.log(`Graph: ${meta.version} (${meta.source || 'standard'})\n`);

const ttBuf    = readFileSync(join(ROOT, `public/graph/timetable-${meta.version}`));
const stopsBuf = readFileSync(join(ROOT, `public/graph/stops-${meta.version}`));
const si       = StopsIndex.fromData(new Uint8Array(stopsBuf));
const tt       = Timetable.fromData(new Uint8Array(ttBuf));
const router   = new Router(tt, si);

// ─── Helpers ───────────────────────────────────────────────────
function fmtTime(t) { return t?.toString().substring(0, 5) ?? '--:--'; }
function fmtDur(route) {
  const s = Math.round(route.totalDuration().toSeconds() / 60);
  return s < 60 ? `${s} min` : `${Math.floor(s/60)}h ${s%60}m`;
}

function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

// Group stops by name + 500m centroid proximity (mirrors plan.js logic)
function groupStopsByName(stops, maxMetres = 500) {
  const groups = [];
  for (const s of stops) {
    const name = s.name.trim();
    let placed = false;
    for (const g of groups) {
      if (g.name !== name) continue;
      if (!s.lat || !s.lon) { g.stops.push(s); placed = true; break; }
      const cLat = g.stops.reduce((sum, m) => sum + (m.lat || 0), 0) / g.stops.length;
      const cLon = g.stops.reduce((sum, m) => sum + (m.lon || 0), 0) / g.stops.length;
      if (haversineM({ lat: cLat, lon: cLon }, s) <= maxMetres) {
        g.stops.push(s); placed = true; break;
      }
    }
    if (!placed) groups.push({ name, stops: [s] });
  }
  return groups;
}

function findGroups(query) {
  const raw = si.findStopsByName(query);
  return groupStopsByName(raw);
}

// Route: try all from×to combinations, return best
function tryRoute(fromGroups, toGroups, depTime) {
  const results = [];
  for (const fg of fromGroups) {
    for (const tg of toGroups) {
      for (const from of fg.stops) {
        for (const to of tg.stops) {
          if (from.sourceStopId === to.sourceStopId) continue;
          try {
            const q = new Query.Builder()
              .from(from.sourceStopId)
              .to(to.sourceStopId)
              .departureTime(depTime)
              .maxTransfers(2)
              .build();
            const result = router.route(q);
            const route = result.bestRoute();
            if (route) {
              results.push({
                from: { id: from.sourceStopId, name: from.name, group: fg.name },
                to:   { id: to.sourceStopId,   name: to.name,   group: tg.name },
                route,
              });
            }
          } catch { /* no route for this pair */ }
        }
      }
    }
  }
  if (!results.length) return null;
  return results.sort((a, b) =>
    a.route.totalDuration().toSeconds() - b.route.totalDuration().toSeconds()
  )[0];
}

// ─── Test pairs ────────────────────────────────────────────────
const PAIRS = [
  ['Kikuyu', 'Kahawa Sukari'],
  ['Cabanas', 'Church Road'],
  ['Athi River', 'Utawala'],
  ['Thika', 'Kikuyu'],
];

const DEP = Time.fromDate(new Date(2026, 5, 26, 8, 0, 0)); // 08:00

console.log('Departure time: 08:00\n');
console.log('─'.repeat(60));

for (const [from, to] of PAIRS) {
  const fromGroups = findGroups(from);
  const toGroups   = findGroups(to);

  console.log(`\n${from} → ${to}`);
  console.log(`  Origin groups found: ${fromGroups.length} (${fromGroups.map(g=>g.name+'['+g.stops.length+']').join(', ')})`);
  console.log(`  Dest   groups found: ${toGroups.length} (${toGroups.map(g=>g.name+'['+g.stops.length+']').join(', ')})`);

  if (!fromGroups.length) { console.log('  ✗ No origin stops found'); continue; }
  if (!toGroups.length)   { console.log('  ✗ No destination stops found'); continue; }

  const best = tryRoute(fromGroups, toGroups, DEP);

  if (!best) {
    console.log('  ✗ No route found');
    continue;
  }

  const legs = best.route.legs.filter(l => 'departureTime' in l);
  const transfers = legs.length - 1;
  console.log(`  ✓ Route found — ${fmtDur(best.route)} | ${transfers === 0 ? 'Direct' : transfers + ' transfer' + (transfers>1?'s':'')}`);
  console.log(`    Depart: ${fmtTime(best.route.departureTime())} | Arrive: ${fmtTime(best.route.arrivalTime())}`);
  console.log(`    Via: ${legs.map(l => 'Route ' + l.route.name).join(' → ')}`);
  console.log(`    From stop: ${best.from.name} (${best.from.id})`);
  console.log(`    To stop:   ${best.to.name} (${best.to.id})`);
}

console.log('\n' + '─'.repeat(60));
