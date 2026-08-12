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
  PARK_CENTER: { lat: 27.7367, lon: 85.3419 },
  PARK_RADIUS_M: 200,

  // A vehicle with no report in longer than this counts as "offline".
  STALE_MINUTES: 60,

  // How often the dashboard re-polls Supabase for new rows.
  REFRESH_MS: 60_000,

  // Default length of history pulled for charts/trails/distance.
  DEFAULT_WINDOW_HOURS: 3,
};
