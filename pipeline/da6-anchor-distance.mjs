#!/usr/bin/env node
/**
 * DA-6 — Nearest-anchor distance distribution for the 451 ambiguous clusters.
 * §7.2.4: if P90 < ~1.5 km, rule 1 carries nearly everything and rules 2–4 are rare fallbacks.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS = join(__dirname, '_gtfs_tmp/extracted');

// ─── CSV parser (quoted-comma-aware) ─────────────────────────────────────────
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
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}

function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

function centroid(group) {
  const valid = group.stops.filter(s => isFinite(parseFloat(s.stop_lat)) && isFinite(parseFloat(s.stop_lon)));
  if (!valid.length) return null;
  return {
    lat: valid.reduce((sum, s) => sum + parseFloat(s.stop_lat), 0) / valid.length,
    lon: valid.reduce((sum, s) => sum + parseFloat(s.stop_lon), 0) / valid.length,
  };
}

function percentile(sorted, p) {
  const i = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(i, sorted.length - 1)];
}

// ─── Load ─────────────────────────────────────────────────────────────────────
const stops = parseCSV(readFileSync(join(GTFS, 'stops.txt'), 'utf8'));
const stopTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));

const routableIds = new Set(stopTimes.map(st => st.stop_id));
const routableStops = stops.filter(s => routableIds.has(s.stop_id));
const allGroups = groupStops(routableStops, 500);

// ─── Classify clusters ────────────────────────────────────────────────────────
const clustersByName = {};
for (const g of allGroups) {
  if (!clustersByName[g.name]) clustersByName[g.name] = [];
  clustersByName[g.name].push(g);
}

const type1Ids = new Set(stops.filter(s => s.location_type === '1').map(s => s.stop_id));

// Anchor pool: unambiguous clusters + location_type=1 phantom nodes
const anchors = [];
const ambiguous = [];

for (const [, clusters] of Object.entries(clustersByName)) {
  for (const cl of clusters) {
    const c = centroid(cl);
    if (!c) continue;
    const clObj = { name: cl.name, centroid: c, stops: cl.stops };
    if (clusters.length === 1) {
      anchors.push(clObj);
    } else {
      ambiguous.push(clObj);
    }
  }
}

// Add location_type=1 phantom nodes as anchors (they are non-routable so won't appear in allGroups above)
const type1Anchors = stops.filter(s => s.location_type === '1');
for (const s of type1Anchors) {
  const lat = parseFloat(s.stop_lat);
  const lon = parseFloat(s.stop_lon);
  if (!isFinite(lat) || !isFinite(lon)) continue;
  anchors.push({ name: normalize(s.stop_name), centroid: { lat, lon }, stops: [s], isType1: true });
}

console.log(`Anchor pool: ${anchors.length} clusters (${anchors.length - type1Anchors.length} unambiguous + ${type1Anchors.length} type-1 nodes)`);
console.log(`Ambiguous clusters needing disambiguator: ${ambiguous.length}`);
console.log();

// ─── For each ambiguous cluster: find nearest anchor ─────────────────────────
const nearestDistances = [];
const unresolved = []; // anchors pool exhausted within some radius

for (const cl of ambiguous) {
  let minDist = Infinity;
  let nearestAnchor = null;
  for (const a of anchors) {
    // Skip anchors with the same normalized name (can't disambiguate with yourself)
    if (a.name === cl.name) continue;
    const d = haversineM(cl.centroid, a.centroid);
    if (d < minDist) { minDist = d; nearestAnchor = a; }
  }
  nearestDistances.push({ cluster: cl, dist: minDist, anchor: nearestAnchor });
}

// ─── Distribution ─────────────────────────────────────────────────────────────
const sorted = nearestDistances.map(r => r.dist).sort((a, b) => a - b);

const fmt = m => m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(2)} km`;

console.log('Nearest-anchor distance distribution (451 ambiguous clusters):');
console.log(`  Min:  ${fmt(sorted[0])}`);
console.log(`  P10:  ${fmt(percentile(sorted, 10))}`);
console.log(`  P25:  ${fmt(percentile(sorted, 25))}`);
console.log(`  P50:  ${fmt(percentile(sorted, 50))}`);
console.log(`  P75:  ${fmt(percentile(sorted, 75))}`);
console.log(`  P90:  ${fmt(percentile(sorted, 90))}`);
console.log(`  P95:  ${fmt(percentile(sorted, 95))}`);
console.log(`  P99:  ${fmt(percentile(sorted, 99))}`);
console.log(`  Max:  ${fmt(sorted[sorted.length - 1])}`);

// Bucket counts
const buckets = [100, 250, 500, 750, 1000, 1500, 2000, 5000, Infinity];
const labels  = ['< 100 m','100–250 m','250–500 m','500–750 m','750 m–1 km','1–1.5 km','1.5–2 km','2–5 km','> 5 km'];
let prev = 0;
console.log('\nBucket distribution:');
for (let i = 0; i < buckets.length; i++) {
  const count = sorted.filter(d => d >= prev && d < buckets[i]).length;
  const pct = ((count / sorted.length) * 100).toFixed(1);
  if (count > 0) console.log(`  ${labels[i].padEnd(14)}: ${count} (${pct}%)`);
  prev = buckets[i];
}

// Cumulative: what % are within 1 km, 1.5 km?
const within1k   = sorted.filter(d => d <= 1000).length;
const within15k  = sorted.filter(d => d <= 1500).length;
const within2k   = sorted.filter(d => d <= 2000).length;
console.log(`\nCumulative:`);
console.log(`  Within 1.0 km: ${within1k} / ${sorted.length} (${(within1k/sorted.length*100).toFixed(1)}%)`);
console.log(`  Within 1.5 km: ${within15k} / ${sorted.length} (${(within15k/sorted.length*100).toFixed(1)}%)`);
console.log(`  Within 2.0 km: ${within2k} / ${sorted.length} (${(within2k/sorted.length*100).toFixed(1)}%)`);

// ─── Ladder load analysis ─────────────────────────────────────────────────────
// Rule 1 can carry if there's a unique anchor within R.
// Check rule 1 uniqueness: does the nearest anchor name separate this cluster from all same-name siblings?
function rule1Separates(clObj, siblingClusters, anchors, R) {
  // Find all anchors within R (excluding same name)
  const nearbyAnchors = anchors.filter(a => a.name !== clObj.name && haversineM(clObj.centroid, a.centroid) <= R);
  if (!nearbyAnchors.length) return { separates: false, reason: 'no anchor within R' };

  // Pick nearest
  nearbyAnchors.sort((a, b) => haversineM(clObj.centroid, a.centroid) - haversineM(b.centroid, clObj.centroid));
  const nearest = nearbyAnchors[0];

  // Does any sibling also have the same nearest anchor?
  const siblings = siblingClusters.filter(s => s !== clObj);
  const collision = siblings.some(sib => {
    const sibAnchors = anchors
      .filter(a => a.name !== sib.name && haversineM(sib.centroid, a.centroid) <= R)
      .sort((a, b) => haversineM(sib.centroid, a.centroid) - haversineM(a.centroid, b.centroid));
    return sibAnchors.length > 0 && sibAnchors[0].name === nearest.name;
  });

  return { separates: !collision, anchor: nearest, dist: haversineM(clObj.centroid, nearest.centroid) };
}

const R = 1500; // test at 1.5 km
let rule1Count = 0, rule1Fail = 0;
const rule1Failures = [];

for (const [name, clusters] of Object.entries(clustersByName)) {
  if (clusters.length < 2) continue;
  for (const cl of clusters) {
    const c = centroid(cl);
    if (!c) continue;
    const clObj = { name, centroid: c, stops: cl.stops };
    const result = rule1Separates(clObj, clusters.map(g => ({ name, centroid: centroid(g), stops: g.stops })).filter(x => x.centroid), anchors, R);
    if (result.separates) {
      rule1Count++;
    } else {
      rule1Fail++;
      rule1Failures.push({ name, reason: result.reason, dist: nearestDistances.find(r => r.cluster.name === name)?.dist });
    }
  }
}

console.log(`\nLadder load analysis (R = ${R/1000} km):`);
console.log(`  Rule 1 separates:  ${rule1Count} / ${ambiguous.length} (${(rule1Count/ambiguous.length*100).toFixed(1)}%)`);
console.log(`  Rule 2+ needed:    ${rule1Fail} (${(rule1Fail/ambiguous.length*100).toFixed(1)}%)`);

if (rule1Failures.length && rule1Failures.length <= 30) {
  console.log('\nRule-1 failures:');
  rule1Failures.slice(0, 30).forEach(f => console.log(`  "${f.name}" — ${f.reason}`));
}

// ─── Worst cases: furthest anchors ───────────────────────────────────────────
console.log('\nTop 10 ambiguous clusters furthest from any anchor:');
nearestDistances
  .sort((a, b) => b.dist - a.dist)
  .slice(0, 10)
  .forEach(r => {
    console.log(`  "${r.cluster.name}" — nearest anchor: "${r.anchor?.name}" @ ${fmt(r.dist)}`);
  });
