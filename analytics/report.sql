-- Run through authenticated Cloudflare D1 console/CLI, never from the website.
-- No manufactured history or filled-in dates: no row means no measurements.
WITH daily AS (
  SELECT day,
    coalesce(sum(total) FILTER (WHERE event = 'page_view'), 0) AS page_views,
    coalesce(sum(total) FILTER (WHERE event = 'wall_view'), 0) AS wall_views,
    coalesce(sum(total) FILTER (WHERE event = 'form_view'), 0) AS form_views,
    coalesce(sum(total) FILTER (WHERE event = 'form_start'), 0) AS form_starts,
    coalesce(sum(total) FILTER (WHERE event = 'submit_intent'), 0) AS submit_intents,
    coalesce(sum(total) FILTER (WHERE event = 'submit_attempt'), 0) AS submit_attempts,
    coalesce(sum(total) FILTER (WHERE event = 'submit_success'), 0) AS submit_successes,
    coalesce(sum(total) FILTER (WHERE event = 'validation_error'), 0) AS validation_errors,
    coalesce(sum(total) FILTER (WHERE event = 'security_blocked'), 0) AS security_blocks,
    coalesce(sum(total) FILTER (WHERE event = 'security_error'), 0) AS security_errors,
    coalesce(sum(total) FILTER (WHERE event = 'submit_error'), 0) AS submit_errors,
    coalesce(sum(total) FILTER (WHERE event = 'rate_limited'), 0) AS rate_limits
  FROM daily_counts GROUP BY day
)
SELECT daily.*, (SELECT collection_started_at FROM analytics_settings WHERE singleton = 1) AS collection_started_at,
  (SELECT group_concat(event) FROM daily_counts c WHERE c.day = daily.day
    AND c.total >= (SELECT daily_event_limit FROM analytics_settings WHERE singleton = 1)) AS capped_event_types,
  round(100.0 * form_starts / nullif(page_views, 0), 2) AS form_start_per_page_view_pct,
  round(100.0 * submit_successes / nullif(page_views, 0), 2) AS success_per_page_view_pct,
  round(100.0 * submit_successes / nullif(submit_attempts, 0), 2) AS success_per_attempt_pct
FROM daily ORDER BY day;
