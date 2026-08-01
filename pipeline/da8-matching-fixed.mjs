#!/usr/bin/env node
/**
 * DA-8 — Corrected per-group bipartite matching.
 *
 * Fix from DA-7: the render threshold is a hard edge constraint, not a post-hoc audit.
 * Any (member, anchor) pair beyond the threshold gets no feasible edge.
 * Hungarian then maximises cardinality among truthful edges first (via FORBIDDEN cost),
 * then minimises total distance among all-truthful solutions.
 * Unmatched members collapse into one honest "infeasible" bucket.
 *
 * R is retired as a separate discovery parameter — any anchor that can't be truthfully
 * assigned is useless, so the candidate set is anchors within renderThreshold of any member.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS = join(__dirname, '_gtfs_tmp/extracted');

// ─── CSV parser ───────────────────────────────────────────────────────────────
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
  const valid = stops.filter(s => isFinite(parseFloat(s.stop_lat)));
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
      const d = haversineM(a, { lat: parseFloat(valid[j].stop_lat), lon: parseFloat(valid[j].stop_lon) });
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

// ─── Normalization + quality gate ─────────────────────────────────────────────
function normalize(name) { return name.trim().toLowerCase().replace(/\s+/g, ' '); }

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
function isGeneric(name) {
  if (GENERIC_TERMS.has(name)) return true;
  if (/^(north|south|east|west|upper|lower|inner|outer|old|new)\s+(road|highway|bypass|avenue)$/.test(name)) return true;
  return false;
}

// ─── Clustering ───────────────────────────────────────────────────────────────
function groupStops(stops, maxM = 500) {
  const groups = [];
  for (const s of stops) {
    const name = normalize(s.stop_name);
    const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon);
    let placed = false;
    for (const g of groups) {
      if (g.name !== name) continue;
      if (!isFinite(lat) || !isFinite(lon)) { g.stops.push(s); placed = true; break; }
      const cLat = g.stops.reduce((sum, m) => sum + (parseFloat(m.stop_lat) || 0), 0) / g.stops.length;
      const cLon = g.stops.reduce((sum, m) => sum + (parseFloat(m.stop_lon) || 0), 0) / g.stops.length;
      if (haversineM({ lat: cLat, lon: cLon }, { lat, lon }) <= maxM) { g.stops.push(s); placed = true; break; }
    }
    if (!placed) groups.push({ name, stops: [s] });
  }
  return groups;
}

// ─── Hungarian min-cost assignment ────────────────────────────────────────────
// cost[i][j] = edge weight (may be FORBIDDEN for invalid edges)
// Returns assignment[i] = j (0-indexed). Always produces a complete assignment.
// When FORBIDDEN >> total valid cost, this maximises cardinality-of-valid-edges
// then minimises total valid distance — the max-cardinality-min-cost objective.
function hungarian(costMatrix) {
  const n = costMatrix.length, m = costMatrix[0].length;
  if (m < n) return null;
  const INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minV = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]; let delta = INF, j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const val = costMatrix[i0 - 1][j - 1] - u[i0] - v[j];
          if (val < minV[j]) { minV[j] = val; way[j] = j0; }
          if (minV[j] < delta) { delta = minV[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minV[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) { if (p[j] !== 0) assignment[p[j] - 1] = j - 1; }
  return assignment;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Load + build clusters
// ═══════════════════════════════════════════════════════════════════════════════
const stops     = parseCSV(readFileSync(join(GTFS, 'stops.txt'), 'utf8'));
const stopTimes = parseCSV(readFileSync(join(GTFS, 'stop_times.txt'), 'utf8'));
const type1Stops = stops.filter(s => s.location_type === '1');

const routableIds = new Set(stopTimes.map(st => st.stop_id));
const allGroups   = groupStops(stops.filter(s => routableIds.has(s.stop_id)), 500);

for (const g of allGroups) { g.centroid = centroid(g.stops); g.diameter = diameter(g.stops); }

const clustersByName = {};
for (const g of allGroups) { if (!clustersByName[g.name]) clustersByName[g.name] = []; clustersByName[g.name].push(g); }

const unambiguous    = allGroups.filter(g => clustersByName[g.name].length === 1);
const ambiguousNames = Object.entries(clustersByName).filter(([, cs]) => cs.length > 1);

// ─── Anchor pool (diameter gate 1,000 m per §7.2.3 correction) ───────────────
function buildPool(diamThreshold) {
  const pool = [];
  for (const g of unambiguous) {
    if (!g.centroid) continue;
    if (g.diameter > diamThreshold) continue;
    if (isGeneric(g.name)) continue;
    pool.push({ name: g.name, centroid: g.centroid });
  }
  for (const s of type1Stops) {
    const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const name = normalize(s.stop_name);
    if (isGeneric(name)) continue;
    pool.push({ name, centroid: { lat, lon } });
  }
  return pool;
}

// ─── Matching with truthfulness as hard constraint ────────────────────────────
function runMatching(anchorPool, renderThreshold, label) {
  // FORBIDDEN cost: larger than the maximum possible sum of valid distances,
  // so Hungarian prefers any valid edge over any forbidden edge.
  const FORBIDDEN = renderThreshold * (ambiguousNames.length * 15);

  let successGroups = 0;
  const infeasibleGroups = [];  // groups where ≥1 member has no valid anchor
  let infeasibleClusters = 0, totalClusters = 0;

  for (const [groupName, members] of ambiguousNames) {
    const k = members.length;
    totalClusters += k;
    const memberList = members.filter(g => g.centroid);
    if (!memberList.length) { infeasibleGroups.push({ name: groupName, k, bad: k, reason: 'no centroids' }); infeasibleClusters += k; continue; }

    // Candidate anchors: all pool anchors within renderThreshold of at least one member
    const candidates = anchorPool.filter(a =>
      a.name !== groupName &&
      memberList.some(m => haversineM(m.centroid, a.centroid) <= renderThreshold)
    );

    if (!candidates.length) {
      infeasibleGroups.push({ name: groupName, k, bad: memberList.length, reason: 'no anchors within threshold' });
      infeasibleClusters += memberList.length;
      continue;
    }

    // Cost matrix: FORBIDDEN for pairs beyond threshold
    const costMatrix = memberList.map(m =>
      candidates.map(a => {
        const d = haversineM(m.centroid, a.centroid);
        return d <= renderThreshold ? d : FORBIDDEN;
      })
    );

    // Pad right side if fewer candidates than members
    // (Hungarian needs m ≥ n; but we need n valid edges for success)
    const n = memberList.length, m = candidates.length;
    // If m < n, pad with all-FORBIDDEN columns to allow full assignment then count forbidden
    let effectiveCost = costMatrix;
    if (m < n) {
      effectiveCost = costMatrix.map(row => [...row, ...Array(n - m).fill(FORBIDDEN)]);
    }

    const assignment = hungarian(effectiveCost);
    if (!assignment) { infeasibleGroups.push({ name: groupName, k, bad: memberList.length, reason: 'matching failed' }); infeasibleClusters += memberList.length; continue; }

    // Count forbidden assignments (no valid truthful anchor for this member)
    const badAssignments = assignment.filter((anchorIdx, memberIdx) => {
      if (anchorIdx >= candidates.length) return true; // padded phantom
      return haversineM(memberList[memberIdx].centroid, candidates[anchorIdx].centroid) > renderThreshold;
    });

    if (badAssignments.length > 0) {
      infeasibleGroups.push({ name: groupName, k, bad: badAssignments.length, reason: 'insufficient distinct anchors' });
      infeasibleClusters += badAssignments.length;
    } else {
      successGroups++;
    }
  }

  const totalGroups = ambiguousNames.length;
  const residualGroups = infeasibleGroups.length;

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`${label}`);
  console.log(`Anchor pool: ${anchorPool.length} | Render threshold: ${renderThreshold} m`);
  console.log(`══════════════════════════════════════════════`);
  console.log(`\nGroups:   ${successGroups} / ${totalGroups} fully matched (${(successGroups/totalGroups*100).toFixed(1)}%)`);
  console.log(`Residual: ${residualGroups} groups, ${infeasibleClusters} clusters → manual`);
  console.log(`\nResidual groups (infeasible after hard-constraint matching):`);
  infeasibleGroups.forEach(g => {
    const clusterNote = g.bad < g.k ? `${g.bad}/${g.k} clusters unmatched` : `all ${g.k} clusters`;
    console.log(`  "${g.name}" — ${clusterNote} (${g.reason})`);
  });

  return { successGroups, residualGroups, infeasibleClusters, totalGroups };
}

// ─── Run with corrected diameter gate (1,000 m) ───────────────────────────────
const pool1000 = buildPool(1000);
console.log(`\nAnchor pool (diameter ≤ 1,000 m, generic terms excluded): ${pool1000.length}`);
console.log(`Excluded vs raw 2,276: ${2276 - (pool1000.length - type1Stops.length)} routable clusters gated out`);

const r800 = runMatching(pool1000, 800,  'Diameter ≤ 1,000 m | Render threshold 800 m (provisional)');
const r600 = runMatching(pool1000, 600,  'Diameter ≤ 1,000 m | Render threshold 600 m');

// Summary
console.log('\n══════════════════════════════════════════════');
console.log('DA-8 Summary');
console.log('══════════════════════════════════════════════');
console.log(`Render threshold | Matched groups | Residual groups | Residual clusters`);
console.log(`─────────────────────────────────────────────────────────────────────`);
console.log(`800 m            | ${r800.successGroups}/${r800.totalGroups}          | ${r800.residualGroups}               | ${r800.infeasibleClusters}`);
console.log(`600 m            | ${r600.successGroups}/${r600.totalGroups}          | ${r600.residualGroups}               | ${r600.infeasibleClusters}`);
console.log('\nNote: residual clusters is the unit for manual work estimation (DoD 18).');
console.log('Render threshold remains provisional pending Q9 (usage-facing phrasing study).');
