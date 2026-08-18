// Dashboard configuration. This file is meant to be edited directly - there
// is no build step. Everything the dashboard needs to run lives here or in
// the other plain JS files in this folder; nothing depends on the parent
// trakzee-supabase-etl repo, so this folder can be copied out to its own
// project (its own git repo, its own GitHub Pages site) with no changes.
//
// The anon key below is safe to commit and safe to ship in browser source -
// it is designed to be public. It grants NOTHING by itself: every table read
// requires a signed-in Supabase Auth session (see auth.js), enforced by
// row-level security policies in supabase/schema.sql. Never put a
// service_role key in this file or anywhere in this folder.
const CONFIG = {
  SUPABASE_URL: "https://idrjiwdyrpgqwvyjkafv.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkcmppd2R5cnBncXd2eWprYWZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0NDEyMjcsImV4cCI6MjEwMjAxNzIyN30.8ElJMdztQQ8uiKTU43qznZvXxq9qCs6KPoJX8oS4ASs",

  // Vehicles within this radius (metres) of PARK_CENTER count as "in
  // parking" rather than "idle". Edit these two values to move the geofence -
  // there is deliberately no UI control for it.
  //
  // This default was inferred from the data, not guessed: it's the densest
  // cluster of stopped-vehicle readings (6+ vehicles, 2,900+ rows at time of
  // writing, reverse-geocoded by Trakzee as "Ganesh Basti, Chappal Karkhana,
  // Kathmandu") - almost certainly the actual yard. Confirm it and adjust if
  // the real depot is elsewhere.
  PARK_CENTER: { lat: 27.7262884, lon: 85.3482266 },
  PARK_RADIUS_M: 200,

  // A second geofence: where vehicles go to be serviced/repaired. Mirrors
  // PARK_CENTER/PARK_RADIUS_M exactly - edit these two values to move it,
  // no UI control for it, on purpose.
  //
  // UNLIKE PARK_CENTER, this radius is NOT inferred from data (there's no
  // equivalent "densest cluster of stopped readings" analysis run for this
  // spot yet) - it's a guess: a repair shop is typically a single small
  // compound, so a tighter radius than the 200m outdoor parking yard seemed
  // right. CONFIRM THIS once there's real data near this point, the same
  // way PARK_RADIUS_M was derived.
  MAINTENANCE_CENTER: { lat: 27.7365952, lon: 85.341527 },
  MAINTENANCE_RADIUS_M: 200, // GUESS - not data-derived, see comment above

  // A vehicle with no report in longer than this counts as "offline".
  STALE_MINUTES: 60,

  // How often the dashboard re-polls Supabase for new rows.
  REFRESH_MS: 60_000,

  // Default length of history pulled for charts/trails/distance.
  DEFAULT_WINDOW_HOURS: 3,

  // The fleet's timezone. Used by analytics.js (to compute "today", format
  // departure/visit times, and build date-range inputs in local terms) and
  // passed through to the day-metrics/maintenance-visits SQL functions as
  // p_tz - this file stays the single place that says "Kathmandu."
  TIMEZONE: "Asia/Kathmandu",

  // "Parked overnight" (analytics page): a vehicle counts as parked
  // overnight for local calendar day D if it has at least one parking-
  // geofence reading between OVERNIGHT_START_HOUR on day D and
  // OVERNIGHT_END_HOUR on day D+1, both local (Kathmandu) hours.
  OVERNIGHT_START_HOUR: 22, // 10pm
  OVERNIGHT_END_HOUR: 5, // 5am the following morning

  // Gap between consecutive polls larger than this is treated as an
  // offline stretch, not tracked time - single source of truth for the
  // convention api.js's vehicleMetrics() and the SQL day-metrics function
  // both use.
  MAX_GAP_MINUTES: 10,

  // Default length of the date range analytics.html loads on open. Kept
  // short deliberately: the day-metrics query returns one row per vehicle
  // per day, and a wide "all vehicles" range risks exceeding PostgREST's
  // default 1000-row response cap - the same ceiling that can already
  // silently truncate the "Last 24 hours" history option above for a large
  // enough fleet.
  ANALYTICS_DEFAULT_RANGE_DAYS: 14,

  // How far back to scan when checking which vehicles are CURRENTLY mid
  // maintenance-visit (analytics.html's "ongoing visits" fetch, independent
  // of the date-range control above). Bounded on purpose: p_since=null
  // scans public.vehicle_positions with no lower bound at all, and that
  // full-history scan is the kind of thing that gets slower as the table
  // grows until it eventually hits Supabase's statement timeout - it did,
  // in production (surfaced as an unhelpful 500 with no partial data,
  // before analytics.js's Promise.allSettled fallback existed). A visit
  // genuinely still ongoing after this many days is
  // vanishingly rare; if it happens, is_ongoing still reads correctly true,
  // only its visit_start/duration read from this window's edge instead of
  // the true start - a truncated number beats a blank page.
  MAINTENANCE_ONGOING_LOOKBACK_DAYS: 30,

  // Vehicle-type icon classification for the map (cosmetic only - purely
  // for choosing a marker glyph). There is no vehicle-type column in
  // vehicle_positions, so this matches vehicle_no/vehicle_name text against
  // regexes maintained here. GUESSES below - confirm against your real
  // vehicle_no/vehicle_name values (sign in and look at the table) and edit
  // the patterns to match. First matching rule wins; no match falls back to
  // the generic marker.
  VEHICLE_TYPE_RULES: [
    { type: "bike", pattern: /\b(bike|moto|scooter)\b/i },
    { type: "truck", pattern: /\b(truck|lorry)\b/i },
  ],

  // GPS anomaly detection (analytics page). No fraud/tamper signal here
  // needs an external data source - both are internal consistency checks on
  // the position stream itself. GUESSES below, tuned for a bike/scooter
  // delivery fleet in city traffic - raise MAX_PLAUSIBLE_KMH for a fleet
  // that includes highway trucking.
  MAX_PLAUSIBLE_KMH: 120, // implied speed above this between two readings = "gps_jump"
  STUCK_MINUTES: 30, // this long reporting speed>0 with ~no position change = "frozen_while_moving"

  // Vehicle <-> driver mapping (drivers.html) + Yango ride-corroboration
  // ("misuse detection", misuse.html). Cross-references GPS movement against
  // Yango ride records (synced by a separate app, yapigo, into this same
  // Supabase project's drivers/orders tables) via vehicle_ride_match_day_metrics/
  // vehicle_ride_segments (see schema.sql).
  //
  // RIDE_MATCH_TOLERANCE_MINUTES: padding on each side of a Yango order's
  // [booked_at, ended_at] window when checking whether a movement segment
  // overlaps it - covers clock skew and plausible pre-pickup/post-dropoff
  // movement.
  RIDE_MATCH_TOLERANCE_MINUTES: 10,
  // RIDE_MATCH_PENDING_GRACE_MINUTES: a movement segment ending more
  // recently than this is "pending," not "unmatched," regardless of
  // whether a match was found - covers Yango's own sync interval into
  // yapigo (~15 minutes) plus processing slack. Don't lower this below
  // that sync interval or freshly-finished legitimate rides will read as
  // misuse before their order has even landed.
  RIDE_MATCH_PENDING_GRACE_MINUTES: 20,

  // Confidence-score heuristic (misuse.js's computeConfidenceScores()) -
  // a transparent, hand-tunable set of thresholds in the same spirit as
  // MAX_PLAUSIBLE_KMH/STUCK_MINUTES above: guessed and documented, not
  // derived, meant to be retuned once real flagged-vs-confirmed cases
  // accumulate.
  MISUSE_LOOKBACK_DAYS: 30, // default trailing window fetched for scoring; 30/45/60 selectable
  MISUSE_RECENT_WINDOW_DAYS: 7, // the "did something change recently" window within the lookback
  MISUSE_MIN_MAPPED_SECONDS_RECENT: 1800, // below this much mapped moving time in the recent window, score reads "Insufficient data"
  MISUSE_MIN_DAY_MAPPED_SECONDS: 300, // a day needs at least this much mapped moving time to count toward the persistence check
  MISUSE_FLAG_DAY_RATE_THRESHOLD: 0.1, // a day's unmatched share above this counts as a "flagged day" for persistence
  MISUSE_MAX_EXPECTED_DELTA: 0.4, // recent-vs-baseline unmatched-rate delta that maps to a full-strength magnitude score
  MISUSE_TARGET_SEGMENT_SECONDS: 300, // unmatched segments averaging this long or more get full weight; shorter/noisier ones scale the score down
  MISUSE_SCORE_WEIGHTS: { magnitude: 0.5, persistence: 0.3, level: 0.2 },
  MISUSE_TIER_HIGH: 60,
  MISUSE_TIER_MEDIUM: 25,

  // Evidence timeline + map (misuse.html detail panel): raw per-vehicle
  // position history, fetched unaggregated to detect GPS-offline gaps
  // client-side - unlike everything else on that page, this isn't a
  // bounded Postgres aggregate, so it needs its own small window to stay
  // well under PostgREST's row cap. 72h matches vehicle.html's own longest
  // "history window" preset - the app's existing ceiling for a raw
  // per-vehicle fetch.
  MISUSE_TIMELINE_HOURS: 72,
};
