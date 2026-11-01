-- Apply only to the dedicated analytics D1 database after approval.
-- No visitor-level rows, identifiers or raw event history.
CREATE TABLE analytics_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  collection_started_at TEXT,
  daily_event_limit INTEGER NOT NULL DEFAULT 50000 CHECK (daily_event_limit BETWEEN 1 AND 1000000),
  CHECK (enabled = 0 OR collection_started_at IS NOT NULL)
) STRICT;
INSERT INTO analytics_settings(singleton) VALUES (1);

CREATE TABLE daily_counts (
  day TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'page_view', 'wall_view', 'form_view', 'form_start', 'submit_intent',
    'validation_error', 'security_blocked', 'submit_attempt', 'submit_success',
    'submit_error', 'security_error', 'rate_limited'
  )),
  total INTEGER NOT NULL CHECK (total > 0),
  PRIMARY KEY (day, event)
) STRICT;
