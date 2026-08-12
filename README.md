# Fleet dashboard

A plain HTML/CSS/JS dashboard for the vehicle position data collected by the
`trakzee-supabase-etl` Lambda. No build step, no framework, no bundler -
open `index.html` in a browser (via a local server - see below) or deploy
this folder as-is to any static host, including GitHub Pages.

**This folder is self-contained on purpose** - it only talks to Supabase
over its REST API and depends on nothing else in the parent repo. It is
meant to be extracted into its own git repository/project; when you do that,
copy the folder as-is and everything below still applies unchanged.

## What it shows

- **Fleet overview** (`index.html`): live map (state-coloured, heading-aware
  markers, optional movement trails), fleet status tiles (moving / parked /
  idle / offline), activity tiles (distance travelled, average speed, time
  utilisation), two time-series charts, a top-distance-travelled chart, and a
  sortable table of every vehicle.
- **Per-vehicle detail** (`vehicle.html?imei=<imei_no>`), linked from every
  map marker and table row: that vehicle's trail, speed-over-time chart,
  activity stats, any populated raw device fields (external power voltage,
  battery, satellites), and full poll-by-poll history for the window.

"Parked" vs "idle" is a geofence: a vehicle within `PARK_RADIUS_M` metres of
`PARK_CENTER` (both in `config.js`) counts as parked. There's no UI control
for this on purpose - edit those two values directly.

## Running locally

Any static file server works - there's nothing to build:

```bash
cd dashboard
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploying to GitHub Pages

1. Push this folder's contents to a repo (as the repo root, or via
   Settings → Pages → "Deploy from a branch" → `/dashboard` as the folder).
2. Enable Pages in the repo settings. No secrets to configure - see
   "Configuration" below for why the key in `config.js` is safe to commit.
3. That's it. No Actions workflow, no build step.

## Configuration

Everything lives in `config.js` - edit it directly, there's no `.env`:

| Constant | What it controls |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Which Supabase project to read from |
| `PARK_CENTER`, `PARK_RADIUS_M` | The parking geofence |
| `STALE_MINUTES` | How old a reading must be to count as "offline" |
| `REFRESH_MS` | Auto-refresh interval |
| `DEFAULT_WINDOW_HOURS` | Default history window on load |

**The anon key is safe to commit and safe to ship in page source** - it's
designed to be public. It grants nothing by itself: every table read
requires row-level security to pass, and the only RLS policy on
`vehicle_positions`/`vehicle_latest` is for the `authenticated` role (see
`../supabase/schema.sql`). Never put a `service_role` key anywhere in this
folder - that key bypasses RLS entirely.

## Authentication

The dashboard is gated behind Supabase Auth email/password sign-in
(`auth.js`) - there is no anonymous read access and no self-service sign-up.

**Create a user** via Supabase Dashboard → Authentication → Users → Add
user (set a password directly, or send an invite email). Repeat for anyone
else who needs access.

**Disable public sign-ups**, or anyone who finds the URL can register their
own account: Supabase Dashboard → Authentication → Providers → Email →
turn off "Allow new users to sign up". This dashboard never calls
`signUp()`, but the setting is a project-wide default and worth checking
explicitly.

If this dashboard is extracted to its own Supabase project, or you want a
different table/database, re-apply `../supabase/schema.sql`'s policy
section against the new database - the exact policy is what makes the login
meaningful rather than decorative.

## Browser support / dependencies

Loaded from CDN (no local copies to keep updated): `@supabase/supabase-js@2`
and `leaflet@1.9.4` with OpenStreetMap tiles. Everything else is vanilla
JS/CSS - no framework, no build step, nothing to `npm install`.
