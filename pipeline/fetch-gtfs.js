#!/usr/bin/env node
/**
 * T1: GTFS pipeline
 *
 * 1. Download the Digital Matatus GTFS zip from GTFS_URL
 * 2. Run `minotor parse-gtfs` to produce timetable + stops binaries
 * 3. Hash the output files and rename to versioned filenames
 * 4. Write /public/graph/meta.json with version + synced timestamp
 * 5. On any failure: keep the last-good graph intact (fail-safe)
 *
 * Env vars:
 *   GTFS_URL         — GTFS zip download URL (required)
 *   GRAPH_DATE       — Date to parse (yyyy-MM-dd, default: today)
 *   OUTPUT_DIR       — Where to place graph files (default: public/graph)
 */
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import https from 'https';
import http from 'http';
import { expandFrequenciesZip } from './expand-frequencies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const GTFS_URL = process.env.GTFS_URL;
const GRAPH_DATE = process.env.GRAPH_DATE
  || new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = join(ROOT, process.env.OUTPUT_DIR || 'public/graph');
const MINOTOR = join(ROOT, 'node_modules/.bin/minotor');

// ─── Helpers ───────────────────────────────────────────────
function log(msg) { console.log(`[pipeline] ${msg}`); }
function err(msg) { console.error(`[pipeline:error] ${msg}`); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = createWriteStream(dest);
    mod.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function sha256File(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function lastGoodVersion() {
  const metaPath = join(OUTPUT_DIR, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf8')); }
  catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────
async function main() {
  if (!GTFS_URL) {
    err('GTFS_URL env var is required. Set it to the Digital Matatus GTFS zip URL.');
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const existing = lastGoodVersion();
  const tmpZip = join(tmpdir(), `nairobi-gtfs-${Date.now()}.zip`);
  const tmpTimetable = join(tmpdir(), `minotor-timetable-${Date.now()}`);
  const tmpStops = join(tmpdir(), `minotor-stops-${Date.now()}`);

  // 1. Download
  log(`Downloading GTFS from ${GTFS_URL}…`);
  try {
    await download(GTFS_URL, tmpZip);
    log(`Downloaded OK`);
  } catch (e) {
    err(`Download failed: ${e.message}`);
    if (existing) {
      log(`Keeping last-good graph: version ${existing.version} (synced ${existing.synced})`);
      process.exit(0);
    }
    process.exit(1);
  }

  // 2a. Expand frequency-based trips into explicit departure trips
  try {
    const expandedBuf = await expandFrequenciesZip(tmpZip);
    if (expandedBuf) {
      writeFileSync(tmpZip, expandedBuf);
      log(`Frequencies expanded`);
    } else {
      log(`No frequencies.txt found — using stop_times as-is`);
    }
  } catch (e) {
    err(`Frequency expansion failed: ${e.message}`);
    log(`Continuing without expansion (frequency-based trips may not route correctly)`);
  }

  // 2b. Parse with minotor
  log(`Parsing GTFS for date ${GRAPH_DATE}…`);
  try {
    execSync(
      `"${MINOTOR}" parse-gtfs "${tmpZip}" -p standard -d ${GRAPH_DATE} -t "${tmpTimetable}" -s "${tmpStops}"`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    err(`minotor parse-gtfs failed: ${e.message}`);
    if (existing) {
      log(`Keeping last-good graph: version ${existing.version}`);
      process.exit(0);
    }
    process.exit(1);
  }

  // 3. Hash + rename
  let version;
  try {
    const ttHash = sha256File(tmpTimetable);
    const stHash = sha256File(tmpStops);
    version = `${GRAPH_DATE}-${ttHash.slice(0, 8)}`;

    const destTimetable = join(OUTPUT_DIR, `timetable-${version}`);
    const destStops = join(OUTPUT_DIR, `stops-${version}`);

    copyFileSync(tmpTimetable, destTimetable);
    copyFileSync(tmpStops, destStops);

    log(`Graph files written:`);
    log(`  ${destTimetable}`);
    log(`  ${destStops}`);
  } catch (e) {
    err(`File processing failed: ${e.message}`);
    if (existing) {
      log(`Keeping last-good graph: version ${existing.version}`);
      process.exit(0);
    }
    process.exit(1);
  }

  // 4. Write meta.json
  const meta = {
    version,
    date: GRAPH_DATE,
    synced: new Date().toISOString(),
    source: GTFS_URL,
  };
  writeFileSync(join(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  log(`meta.json updated: version=${version}`);

  // 5. Clean up old versioned files (keep last 2)
  // (skip cleanup in CI — let the deploy pipeline handle stale assets)

  // Clean up temp files
  try { unlinkSync(tmpZip); } catch {}
  try { unlinkSync(tmpTimetable); } catch {}
  try { unlinkSync(tmpStops); } catch {}

  log(`Pipeline complete.`);
}

main().catch(e => {
  err(e.message);
  process.exit(1);
});
