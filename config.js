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
  MAINTENANCE_CENTER: { lat: 27.7365952, lon: 85.3415691 },
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
};
