#!/usr/bin/env node
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const ZIP = 'C:\\Users\\muchu\\.gstack\\projects\\muchu\\GTFS_FEED_2019\\GTFS_FEED_2019.zip';

const zip = new AdmZip(ZIP);
const raw = zip.getEntry('routes.txt').getData().toString('utf8');
const rows = parse(raw, { columns: true, skip_empty_lines: true });

rows.sort((a, b) => {
  const na = Number(a.route_short_name) || 9999;
  const nb = Number(b.route_short_name) || 9999;
  return na - nb;
});

// Emit as JS array for copy-paste into fares.js
const lines = rows.map(r => {
  const id = `R${r.route_short_name}`;
  const name = r.route_long_name
    ? `Route ${r.route_short_name} — ${r.route_long_name}`
    : `Route ${r.route_short_name}`;
  return `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)} },`;
});

console.log(`// ${rows.length} routes from Digital Matatus GTFS 2019`);
console.log('const ROUTES = [');
lines.forEach(l => console.log(l));
console.log('];');
