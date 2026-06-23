#!/usr/bin/env node
/**
 * Creates a synthetic Nairobi GTFS fixture for T5 spike testing.
 * Outputs: pipeline/nairobi-fixture.zip
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '_gtfs_tmp');
const OUT_ZIP = join(__dirname, 'nairobi-fixture.zip');

mkdirSync(TMP, { recursive: true });

// agency.txt
writeFileSync(join(TMP, 'agency.txt'), [
  'agency_id,agency_name,agency_url,agency_timezone,agency_lang',
  'GM,Githurai Matatu SACCO,https://digitalmatatus.com,Africa/Nairobi,sw',
  'UM,Umoinner SACCO,https://digitalmatatus.com,Africa/Nairobi,sw',
  'CH,Citi Hoppa SACCO,https://digitalmatatus.com,Africa/Nairobi,sw',
].join('\n'));

// stops.txt — Thika Rd corridor + Mombasa Rd
writeFileSync(join(TMP, 'stops.txt'), [
  'stop_id,stop_name,stop_lat,stop_lon',
  'citycab,City Cabanas,-1.28322,36.82441',
  'kencom,Kencom Bus Stop,-1.28642,36.82365',
  'archives,Archives Bus Stop,-1.28750,36.82096',
  'cbd_gpo,GPO / Kenyatta Ave,-1.28342,36.82041',
  'westlands,Westlands,-1.26312,36.80803',
  'parklands,Parklands,-1.26278,36.81489',
  'muthaiga,Muthaiga Roundabout,-1.25168,36.82178',
  'thika_mall,Thika Road Mall,-1.20490,36.87710',
  'githurai_rbt,Githurai Roundabout,-1.18438,36.89490',
  'githurai44,Githurai 44,-1.17261,36.90030',
  'kahawa_suk,Kahawa Sukari,-1.15472,36.90886',
  'jkia,JKIA Terminal 1,-1.31921,36.92752',
].join('\n'));

// routes.txt
writeFileSync(join(TMP, 'routes.txt'), [
  'route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
  'R104,GM,104,City Cabanas - Kahawa Sukari,3,FF5722',
  'R58,CH,58,CBD - JKIA,3,2EC4F0',
  'R237,UM,237,Githurai 44 - CBD,3,FFC400',
].join('\n'));

// calendar.txt
writeFileSync(join(TMP, 'calendar.txt'), [
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  'WKDY,1,1,1,1,1,0,0,20260101,20261231',
  'SAT,0,0,0,0,0,1,0,20260101,20261231',
].join('\n'));

// Route stop sequences with cumulative travel minutes
const routes = {
  R104: {
    service: 'WKDY',
    stops: ['citycab', 'kencom', 'archives', 'parklands', 'muthaiga', 'githurai_rbt', 'kahawa_suk'],
    minutes: [0, 5, 10, 20, 28, 40, 50],
  },
  R58: {
    service: 'WKDY',
    stops: ['cbd_gpo', 'citycab', 'jkia'],
    minutes: [0, 8, 25],
  },
  R237: {
    service: 'SAT',
    stops: ['githurai44', 'githurai_rbt', 'thika_mall', 'kencom', 'archives', 'cbd_gpo'],
    minutes: [0, 8, 20, 38, 43, 48],
  },
};

const tripRows = ['trip_id,route_id,service_id,trip_headsign'];
const stRows = ['trip_id,stop_id,arrival_time,departure_time,stop_sequence'];

let tripCounter = 0;
// Trips every 15 min from 05:00 to 22:00 = 69 trips
for (const [routeId, route] of Object.entries(routes)) {
  for (let startMin = 300; startMin <= 1320; startMin += 15) {
    const tripId = `T${++tripCounter}`;
    const headsign = route.stops[route.stops.length - 1];
    tripRows.push(`${tripId},${routeId},${route.service},${headsign}`);
    for (let s = 0; s < route.stops.length; s++) {
      const absMin = startMin + route.minutes[s];
      const h = Math.floor(absMin / 60).toString().padStart(2, '0');
      const m = (absMin % 60).toString().padStart(2, '0');
      const t = `${h}:${m}:00`;
      stRows.push(`${tripId},${route.stops[s]},${t},${t},${s + 1}`);
    }
  }
}

writeFileSync(join(TMP, 'trips.txt'), tripRows.join('\n'));
writeFileSync(join(TMP, 'stop_times.txt'), stRows.join('\n'));

// Zip using PowerShell Compress-Archive (available on Windows 10+)
try {
  execSync(`powershell -Command "Compress-Archive -Path '${TMP}\\*' -DestinationPath '${OUT_ZIP}' -Force"`, { stdio: 'inherit' });
  console.log(`\n✓ Fixture written to ${OUT_ZIP}`);
  console.log(`  Routes: ${Object.keys(routes).length}, Trips: ${tripCounter}, Stop-times: ${stRows.length - 1}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
