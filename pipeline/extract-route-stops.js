#!/usr/bin/env node
/**
 * Generates public/route-stops.json — a map of route_short_name → ordered stop list
 * (canonical trip: direction 0, most stops). Used by the Plan leg-detail sheet.
 *
 * Usage: node pipeline/extract-route-stops.js
 */
import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync } from 'fs';

const BASE = 'C:/Users/muchu/.gstack/projects/muchu/GTFS_FEED_2019';
const OUT  = './public/route-stops.json';

// ─── Load tables ────────────────────────────────────────────
const routes    = parse(readFileSync(`${BASE}/routes.txt`, 'utf8'),    { columns: true, skip_empty_lines: true });
const trips     = parse(readFileSync(`${BASE}/trips.txt`, 'utf8'),     { columns: true, skip_empty_lines: true });
const stopTimes = parse(readFileSync(`${BASE}/stop_times.txt`, 'utf8'),{ columns: true, skip_empty_lines: true });
const stopsRaw  = parse(readFileSync(`${BASE}/stops.txt`, 'utf8'),     { columns: true, skip_empty_lines: true });

// ─── Build lookup maps ──────────────────────────────────────
const routeShortName = new Map();   // route_id → route_short_name
for (const r of routes) routeShortName.set(r.route_id, r.route_short_name);

const tripRoute = new Map();        // trip_id → { route_short_name, direction_id }
for (const t of trips) {
  tripRoute.set(t.trip_id, {
    short: routeShortName.get(t.route_id) || '',
    dir: t.direction_id,
  });
}

const stopName   = new Map();       // stop_id → stop_name
const stopParent = new Map();       // child_id → parent_id (or self if no parent)
for (const s of stopsRaw) {
  stopName.set(s.stop_id, s.stop_name);
  stopParent.set(s.stop_id, s.parent_station || s.stop_id);
}

// ─── Collect stop sequences per (route, direction) ──────────
// tripStops: trip_id → [{seq, stop_id}]  (sorted by stop_sequence)
const tripStops = new Map();
for (const st of stopTimes) {
  if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
  tripStops.get(st.trip_id).push({ seq: Number(st.stop_sequence), id: st.stop_id });
}

// ─── Pick canonical trip per route (dir=0, longest) ─────────
const canonical = new Map();        // route_short_name → [{id, name}]

for (const [tripId, meta] of tripRoute) {
  if (!meta.short) continue;
  const stops = tripStops.get(tripId);
  if (!stops) continue;

  const key = meta.short;
  const existing = canonical.get(key);

  // Prefer direction 0; among same direction, prefer longer sequences
  const isBetter = !existing ||
    (meta.dir === '0' && (!existing.dir || existing.dir !== '0')) ||
    (meta.dir === existing.dir && stops.length > existing.stops.length);

  if (isBetter) {
    canonical.set(key, { dir: meta.dir, stops });
  }
}

// ─── Build output ───────────────────────────────────────────
const output = {};
for (const [shortName, { stops }] of canonical) {
  // Resolve child stop IDs to parent IDs (minotor uses parent_station as sourceStopId)
  // Deduplicate consecutive entries that resolve to the same parent
  const sorted = stops
    .sort((a, b) => a.seq - b.seq)
    .map(s => {
      const canonId = stopParent.get(s.id) || s.id;
      const name    = stopName.get(canonId) || stopName.get(s.id) || s.id;
      return { id: canonId, name };
    })
    .filter((s, i, arr) => i === 0 || arr[i - 1].id !== s.id);
  output[shortName] = sorted;
}

writeFileSync(OUT, JSON.stringify(output));

const routeCount = Object.keys(output).length;
const stopCount  = Object.values(output).reduce((s, v) => s + v.length, 0);
const sizeKb     = Math.round(Buffer.byteLength(JSON.stringify(output)) / 1024);
console.log(`✓ ${routeCount} routes, ${stopCount} stops → ${OUT} (${sizeKb} KB)`);
