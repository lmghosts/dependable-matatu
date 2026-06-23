import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { device_id, route_id, from_stop, to_stop, fare_kes } = body

  // Validate required fields
  if (!device_id || typeof device_id !== 'string' || device_id.length < 10) {
    return json({ error: 'Invalid device_id' }, 400)
  }
  if (!route_id || typeof route_id !== 'string') {
    return json({ error: 'Missing route_id' }, 400)
  }
  if (!from_stop || typeof from_stop !== 'string' || !to_stop || typeof to_stop !== 'string') {
    return json({ error: 'Missing from_stop or to_stop' }, 400)
  }
  if (!Number.isInteger(fare_kes) || (fare_kes as number) < 1 || (fare_kes as number) > 9999) {
    return json({ error: 'fare_kes must be an integer between 1 and 9999' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Rate limit: max 5 submissions per device per hour
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('fare_reports')
    .select('*', { count: 'exact', head: true })
    .eq('device_id', device_id)
    .gte('created_at', since)

  if (typeof count === 'number' && count >= 5) {
    return json({ error: 'Rate limit: max 5 fare reports per hour' }, 429)
  }

  const { error } = await supabase.from('fare_reports').insert({
    device_id:  String(device_id),
    route_id:   String(route_id).trim().slice(0, 50),
    from_stop:  String(from_stop).trim().toLowerCase().slice(0, 100),
    to_stop:    String(to_stop).trim().toLowerCase().slice(0, 100),
    fare_kes:   Number(fare_kes),
  })

  if (error) {
    console.error('Insert error:', error)
    return json({ error: 'Database error' }, 500)
  }

  return json({ ok: true }, 201)
})
