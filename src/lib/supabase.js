const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const authHeaders = {
  'apikey': KEY,
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

export async function fetchAggregates(routeId) {
  const res = await fetch(
    `${URL}/rest/v1/fare_aggregates` +
    `?route_id=eq.${encodeURIComponent(routeId)}` +
    `&select=from_stop,to_stop,p50_kes,sample_count` +
    `&order=sample_count.desc&limit=10`,
    { headers: authHeaders }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

export async function submitReport(payload) {
  const res = await fetch(`${URL}/functions/v1/submit-report`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
