#!/usr/bin/env node
/**
 * DA-7 — Quality-gated anchor pool + per-group bipartite matching.
 * §7.2.3 quality gate; §7.2.2 matching; §7.2.6 render threshold; §7.2.5 R=1.0 km.
 * Reports: gated pool size, separation rate, residual count (infeasible + untruthful).
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

// ─── Geometry ─────────────────────────────────────────────────────────────────
function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function centroid(stops) {
  const valid = stops.filter(s => isFinite(parseFloat(s.stop_lat)) && isFinite(parseFloat(s.stop_lon)));
  if (!valid.length) return null;
  return {
    lat: valid.reduce((sum, s) => sum + parseFloat(s.stop_lat), 0) / valid.length,
    lon: valid.reduce((sum, s) => sum + parseFloat(s.stop_lon), 0) / valid.length,
  };
}

function diameter(stops) {
  const valid = stops.filter(s => isFinite(parseFloat(s.stop_lat)));
  let max = 0;
  for (let i = 0; i < valid.length; i++) {
    const a = { lat: parseFloat(valid[i].stop_lat), lon: parseFloat(valid[i].stop_lon) };
    for (let j = i + 1; j < valid.length; j++) {
      const b = { lat: parseFloat(valid[j].stop_lat), lon: parseFloat(valid[j].stop_lon) };
      const d = haversineM(a, b);
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

// ─── Normalization ────────────────────────────────────────────────────────────
function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// §6.1 generic-term vocabulary (bare terms that make a name non-referential as a landmark)
// These are road/infrastructure types that, when they constitute the entire name, describe
// a category or corridor rather than a place.
const GENERIC_TERMS = new Set([
  'highway', 'super highway', 'superhighway',
  'bypass', 'northern bypass', 'southern bypass', 'eastern bypass', 'western bypass',
  'ring road', 'expressway', 'motorway',
  'road', 'avenue', 'street', 'lane', 'drive', 'way',
  'junction', 'roundabout', 'stage', 'estate',
  'corner', 'kona', 'garage', 'car wash', 'carwash',
  'mosque', 'kanisani', 'church', 'school', 'hospital',
  'posta', 'post office', 'police', 'police station',
  'market', 'soko', 'sokoni', 'shops',
]);

function isGenericTerm(normalizedName) {
  // Exact match against bare generic vocabulary
  if (GENERIC_TERMS.has(normalizedName)) return true;
  // Also catch bare "<X> road" where X is a direction/ordinal and road is the substance
  if (/^(north|south|east|west|upper|lower|inner|outer|old|new)\s+(road|highway|bypass|avenue)$/.test(normalizedName)) return true;
  return false;
}

// ─── Cluster construction ─────────────────────────────────────────────────────
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

// ─── Hungarian minimum-cost bipartite matching ────────────────────────────────
// costMatrix[i][j] = cost of assigning left node i to right node j
// Returns assignment[i] = j, minimizing total cost
// O(n² × m) — n = left nodes (group size ≤ 13), m = right nodes (anchors)
function hungarian(costMatrix) {
  const n = costMatrix.length;    // left (group members)
  const m = costMatrix[0].length; // right (anchors)
  if (m < n) return null;         // infeasible

  const INF = 1e15;
  const u  = new Array(n + 1).fill(0);
  const v  = new Array(m + 1).fill(0);
  const p  = new Array(m + 1).fill(0);  // p[j] = left node at right node j (1-indexed)
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minV = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = -1;

      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const val = costMatrix[i0 - 1][j - 1] - u[i0] - v[j];
          if (val < minV[j]) { minV[j] = val; way[j] = j0; }
          if (minV[j] < delta) { delta = minV[j]; j1 = j; }
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minV[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }

  // Extract 0-indexed assignment
  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] !== 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Load
// ═══════════════════════════════════════════════════════════════════════════════
const stops    = parseCSV(readFileSync(join(GTFS, 'stops.txt'), 'utf8'));
const stopTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));

const routableIds = new Set(stopTimes.map(st => st.stop_id));
const routableStops = stops.filter(s => routableIds.has(s.stop_id));
const type1Stops = stops.filter(s => s.location_type === '1');
const type1Set = new Set(type1Stops.map(s => s.stop_id));

const allGroups = groupStops(routableStops, 500);

// Classify
const clustersByName = {};
for (const g of allGroups) {
  if (!clustersByName[g.name]) clustersByName[g.name] = [];
  clustersByName[g.name].push(g);
}

// Enrich each cluster with centroid and diameter
for (const g of allGroups) {
  g.centroid = centroid(g.stops);
  g.diameter = diameter(g.stops);
}

const unambiguousGroups = allGroups.filter(g => clustersByName[g.name].length === 1);
const ambiguousNames = Object.entries(clustersByName).filter(([, cs]) => cs.length > 1);

console.log(`Clusters: ${allGroups.length} total (${unambiguousGroups.length} unambiguous, ${ambiguousNames.reduce((s, [,c]) => s + c.length, 0)} ambiguous)`);
console.log(`Ambiguity groups: ${ambiguousNames.length} names`);

// ═══════════════════════════════════════════════════════════════════════════════
// Quality gate
// ═══════════════════════════════════════════════════════════════════════════════

// Diameter distribution for unambiguous clusters
const dists = unambiguousGroups.filter(g => g.centroid).map(g => g.diameter).sort((a, b) => a - b);
const pct = p => dists[Math.floor(p * (dists.length - 1))];

console.log('\n══════════════════════════════════════════════');
console.log('Unambiguous cluster diameter distribution');
console.log('══════════════════════════════════════════════');
console.log(`  Count: ${dists.length}`);
console.log(`  P50:  ${pct(0.50)} m`);
console.log(`  P75:  ${pct(0.75)} m`);
console.log(`  P90:  ${pct(0.90)} m`);
console.log(`  P95:  ${pct(0.95)} m`);
console.log(`  P99:  ${pct(0.99)} m`);
console.log(`  Max:  ${pct(1.00)} m`);

// Count clusters exceeding various diameter thresholds
for (const threshold of [100, 200, 300, 400, 500, 600]) {
  const n = dists.filter(d => d > threshold).length;
  console.log(`  > ${threshold} m: ${n} clusters (${(n/dists.length*100).toFixed(1)}%)`);
}

// Large-diameter outliers (potential corridors)
const largeAnchors = unambiguousGroups.filter(g => g.diameter > 400).sort((a, b) => b.diameter - a.diameter);
console.log(`\nUnambiguous clusters with diameter > 400 m (potential corridors):`);
largeAnchors.slice(0, 20).forEach(g => console.log(`  "${g.name}" — ${g.diameter} m, ${g.stops.length} stops`));
if (!largeAnchors.length) console.log('  None');

// Generic terms in unambiguous pool
const genericAnchors = unambiguousGroups.filter(g => isGenericTerm(g.name));
console.log(`\nUnambiguous clusters matching generic-term vocabulary: ${genericAnchors.length}`);
if (genericAnchors.length) genericAnchors.forEach(g => console.log(`  "${g.name}"`));

// ─── Apply gate at two diameter thresholds ────────────────────────────────────
function buildAnchorPool(diameterThreshold) {
  const pool = [];

  // Routable unambiguous clusters
  for (const g of unambiguousGroups) {
    if (!g.centroid) continue;
    if (g.diameter > diameterThreshold) continue;          // condition 2
    if (isGenericTerm(g.name)) continue;                   // condition 3
    pool.push({ name: g.name, centroid: g.centroid, diameter: g.diameter, isType1: false });
  }

  // location_type=1 nodes (condition 4 exemption — landmark status by definition)
  for (const s of type1Stops) {
    const lat = parseFloat(s.stop_lat);
    const lon = parseFloat(s.stop_lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    // Still apply conditions 2 and 3
    const name = normalize(s.stop_name);
    if (isGenericTerm(name)) continue;
    pool.push({ name, centroid: { lat, lon }, diameter: 0, isType1: true });
  }

  return pool;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Matching analysis
// ═══════════════════════════════════════════════════════════════════════════════

const R = 1000; // §7.2.5

function runMatching(anchorPool, renderThreshold, label) {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`${label}`);
  console.log(`Anchor pool size: ${anchorPool.length}`);
  console.log(`R = ${R} m, render threshold = ${renderThreshold} m`);
  console.log(`══════════════════════════════════════════════`);

  let successCount  = 0;
  let infeasible    = [];
  let untruthful    = [];

  for (const [groupName, members] of ambiguousNames) {
    const k = members.length;

    // Right set: all gated anchors within R of ANY group member
    const memberCentroids = members.map(g => g.centroid).filter(Boolean);
    if (!memberCentroids.length) {
      infeasible.push({ name: groupName, k, reason: 'no member centroid' });
      continue;
    }

    const candidateAnchors = anchorPool.filter(a =>
      a.name !== groupName &&  // can't use own name as anchor
      memberCentroids.some(mc => haversineM(mc, a.centroid) <= R)
    );

    if (candidateAnchors.length < k) {
      infeasible.push({ name: groupName, k, anchorsFound: candidateAnchors.length });
      continue;
    }

    // Build cost matrix: k members × m candidate anchors
    const costMatrix = members
      .filter(g => g.centroid)
      .map(g => candidateAnchors.map(a => haversineM(g.centroid, a.centroid)));

    const assignment = hungarian(costMatrix);
    if (!assignment) {
      infeasible.push({ name: groupName, k, reason: 'matching infeasible' });
      continue;
    }

    // Check truthfulness: any assignment beyond render threshold?
    const memberList = members.filter(g => g.centroid);
    const badAssignments = assignment
      .map((anchorIdx, memberIdx) => ({
        member: memberList[memberIdx],
        anchor: candidateAnchors[anchorIdx],
        dist: haversineM(memberList[memberIdx].centroid, candidateAnchors[anchorIdx].centroid),
      }))
      .filter(a => a.dist > renderThreshold);

    if (badAssignments.length > 0) {
      untruthful.push({
        name: groupName,
        k,
        badCount: badAssignments.length,
        worst: badAssignments.sort((a, b) => b.dist - a.dist)[0],
      });
    } else {
      successCount++;
    }
  }

  const total = ambiguousNames.length;
  const residual = infeasible.length + untruthful.length;

  console.log(`\nResults (${total} ambiguity groups):`);
  console.log(`  Fully matched + truthful: ${successCount} / ${total} (${(successCount/total*100).toFixed(1)}%)`);
  console.log(`  Infeasible:               ${infeasible.length}`);
  console.log(`  Untruthful:               ${untruthful.length}`);
  console.log(`  Total residual (manual):  ${residual} (${(residual/total*100).toFixed(1)}%)`);

  if (infeasible.length) {
    console.log(`\nInfeasible groups:`);
    infeasible.forEach(g => {
      const detail = g.reason ? g.reason : `only ${g.anchorsFound} anchor(s) within R for ${g.k} members`;
      console.log(`  "${g.name}" (${g.k} clusters) — ${detail}`);
    });
  }

  if (untruthful.length) {
    console.log(`\nUntruthful groups (matched anchor beyond render threshold):`);
    untruthful.forEach(g => {
      const w = g.worst;
      console.log(`  "${g.name}" (${g.k} clusters, ${g.badCount} bad) — worst: "${w.anchor.name}" @ ${Math.round(w.dist)} m`);
    });
  }

  return { successCount, infeasible: infeasible.length, untruthful: untruthful.length, residual };
}

// Run four combinations: two diameter gates × two render thresholds
const pool300 = buildAnchorPool(300);
const pool500 = buildAnchorPool(500);

const results = {};
results['300/600'] = runMatching(pool300, 600,  'Gate: diameter ≤ 300 m | Render threshold: 600 m');
results['300/800'] = runMatching(pool300, 800,  'Gate: diameter ≤ 300 m | Render threshold: 800 m');
results['500/600'] = runMatching(pool500, 600,  'Gate: diameter ≤ 500 m | Render threshold: 600 m');
results['500/800'] = runMatching(pool500, 800,  'Gate: diameter ≤ 500 m | Render threshold: 800 m');

// ─── Summary table ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('Summary (162 ambiguity groups, 451 clusters)');
console.log('══════════════════════════════════════════════');
console.log('Diameter gate | Render threshold | Pool | Matched | Infeasible | Untruthful | Residual');
console.log('─────────────────────────────────────────────────────────────────────────────────────');
const pSize = { '300': pool300.length, '500': pool500.length };
for (const [key, r] of Object.entries(results)) {
  const [diam, rend] = key.split('/');
  const pool = pSize[diam];
  console.log(`≤ ${diam} m         | ${rend} m            | ${pool}   | ${r.successCount}/${162}     | ${r.infeasible}          | ${r.untruthful}          | ${r.residual}`);
}
