-- T6: Fare reports + aggregates schema
-- ─────────────────────────────────────────────────────────────

-- Individual fare submissions from commuters
CREATE TABLE public.fare_reports (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  device_id   text        NOT NULL,
  route_id    text        NOT NULL,
  from_stop   text        NOT NULL,
  to_stop     text        NOT NULL,
  fare_kes    integer     NOT NULL CHECK (fare_kes BETWEEN 1 AND 9999),
  created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX fare_reports_route_idx   ON public.fare_reports (route_id);
CREATE INDEX fare_reports_device_idx  ON public.fare_reports (device_id, created_at DESC);
CREATE INDEX fare_reports_segment_idx ON public.fare_reports (route_id, from_stop, to_stop);

-- P50 fare per route segment, rebuilt daily by pg_cron
CREATE TABLE public.fare_aggregates (
  route_id      text    NOT NULL,
  from_stop     text    NOT NULL,
  to_stop       text    NOT NULL,
  p50_kes       integer NOT NULL,
  sample_count  integer NOT NULL DEFAULT 0,
  updated_at    timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (route_id, from_stop, to_stop)
);

-- ─── Row-Level Security ───────────────────────────────────────

ALTER TABLE public.fare_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fare_aggregates ENABLE ROW LEVEL SECURITY;

-- Anon can INSERT reports (anonymous crowd-sourcing)
CREATE POLICY "anon_insert_fare_reports"
  ON public.fare_reports
  FOR INSERT TO anon
  WITH CHECK (true);

-- Anon can SELECT aggregates (read P50 fares)
CREATE POLICY "anon_select_fare_aggregates"
  ON public.fare_aggregates
  FOR SELECT TO anon
  USING (true);

-- Service role bypasses RLS (Edge Function + cron use service role key)
CREATE POLICY "service_all_fare_reports"
  ON public.fare_reports
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_all_fare_aggregates"
  ON public.fare_aggregates
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── T8: Aggregation function + pg_cron schedule ─────────────

CREATE OR REPLACE FUNCTION public.aggregate_fares()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.fare_aggregates
    (route_id, from_stop, to_stop, p50_kes, sample_count, updated_at)
  SELECT
    route_id,
    from_stop,
    to_stop,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY fare_kes))::integer AS p50_kes,
    COUNT(*)::integer AS sample_count,
    now()
  FROM public.fare_reports
  WHERE created_at > now() - interval '90 days'
  GROUP BY route_id, from_stop, to_stop
  HAVING COUNT(*) >= 3
  ON CONFLICT (route_id, from_stop, to_stop)
  DO UPDATE SET
    p50_kes      = EXCLUDED.p50_kes,
    sample_count = EXCLUDED.sample_count,
    updated_at   = EXCLUDED.updated_at;
END;
$$;

-- Schedule: daily at 23:00 UTC (02:00 EAT)
-- Requires pg_cron extension — enable via Dashboard → Database → Extensions
SELECT cron.schedule(
  'aggregate-fares',
  '0 23 * * *',
  'SELECT public.aggregate_fares()'
);
