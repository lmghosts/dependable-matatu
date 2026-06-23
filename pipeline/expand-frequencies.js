#!/usr/bin/env node
/**
 * Expand frequency-based GTFS trips into explicit departure trips.
 *
 * The Digital Matatus GTFS (and many other African feeds) uses frequencies.txt
 * to define headway-based service. Minotor's RAPTOR implementation only reads
 * stop_times.txt and ignores frequencies.txt, so without expansion it only sees
 * the single 6:00 AM template trip per route — nothing routes after 6 AM.
 *
 * This module accepts a zip file path, extracts it in memory, expands the
 * frequency trips into explicit stop_time rows, and returns a new zip buffer.
 *
 * Usage:
 *   const newZip = await expandFrequenciesZip('/path/to/gtfs.zip');
 *   // newZip is a Buffer; write it to a file and pass to minotor parse-gtfs
 */
import { readFileSync, writeFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import AdmZip from 'adm-zip';

// ─── Helpers ───────────────────────────────────────────────
function toSec(t) {
  const parts = String(t).split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}
function fromSec(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function parseFile(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return entry.getData().toString('utf8');
}

// ─── Main export ───────────────────────────────────────────
export async function expandFrequenciesZip(zipPath) {
  const zip = new AdmZip(zipPath);

  const freqRaw = parseFile(zip, 'frequencies.txt');
  if (!freqRaw) return null; // no frequencies to expand

  const freqRows = parse(freqRaw, { columns: true, skip_empty_lines: true });
  if (!freqRows.length) return null;

  const stRaw  = parseFile(zip, 'stop_times.txt');
  const trRaw  = parseFile(zip, 'trips.txt');

  const stRows = parse(stRaw,  { columns: true, skip_empty_lines: true, cast: true });
  const trRows = parse(trRaw,  { columns: true, skip_empty_lines: true });
  const tripMeta = Object.fromEntries(trRows.map(r => [r.trip_id, r]));

  // Group stop_times by trip_id
  const stopsByTrip = {};
  for (const row of stRows) {
    if (!stopsByTrip[row.trip_id]) stopsByTrip[row.trip_id] = [];
    stopsByTrip[row.trip_id].push(row);
  }

  // Group frequency rows by trip_id
  const freqByTrip = {};
  for (const row of freqRows) {
    if (!freqByTrip[row.trip_id]) freqByTrip[row.trip_id] = [];
    freqByTrip[row.trip_id].push(row);
  }

  const newStRows = [];
  const newTrRows = [];
  const expandedTripIds = new Set();

  for (const [tripId, windows] of Object.entries(freqByTrip)) {
    const template = stopsByTrip[tripId];
    if (!template || !template.length) continue;

    const meta = tripMeta[tripId] || {};
    const templateFirstDep = toSec(template[0].departure_time);

    let idx = 0;
    for (const window of windows) {
      const winStart = toSec(window.start_time);
      const winEnd   = toSec(window.end_time);
      const headway  = Number(window.headway_secs);

      for (let dep = winStart; dep < winEnd; dep += headway) {
        const offset = dep - templateFirstDep;
        const newId  = `${tripId}_F${idx++}`;

        newTrRows.push({ ...meta, trip_id: newId });
        expandedTripIds.add(newId);

        for (const st of template) {
          newStRows.push({
            ...st,
            trip_id:        newId,
            arrival_time:   fromSec(toSec(st.arrival_time) + offset),
            departure_time: fromSec(toSec(st.departure_time) + offset),
          });
        }
      }
    }
  }

  // Keep any non-frequency trips as-is
  const freqTripIds = new Set(Object.keys(freqByTrip));
  for (const st of stRows)  { if (!freqTripIds.has(st.trip_id))  newStRows.push(st); }
  for (const tr of trRows)  { if (!freqTripIds.has(tr.trip_id))  newTrRows.push(tr); }

  const origCount = Object.keys(freqByTrip).length;
  const newCount  = newTrRows.filter(r => expandedTripIds.has(r.trip_id)).length;
  console.log(`[expand-frequencies] ${origCount} frequency trips → ${newCount} explicit trips (${newStRows.length} stop_time rows)`);

  // Build new zip with patched files
  const outZip = new AdmZip(zipPath); // start from original
  outZip.updateFile('stop_times.txt', Buffer.from(stringify(newStRows, { header: true })));
  outZip.updateFile('trips.txt',       Buffer.from(stringify(newTrRows, { header: true })));
  // Zero out frequencies.txt so minotor won't try to use it
  outZip.updateFile('frequencies.txt', Buffer.from('trip_id,start_time,end_time,headway_secs\n'));

  return outZip.toBuffer();
}
