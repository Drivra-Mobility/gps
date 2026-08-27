// Data access + derived analytics, shared by the fleet and per-vehicle pages.
// Every function here reads from Supabase via AUTH.client (auth.js), which
// carries the signed-in session automatically.
const API = (() => {
  function windowStartIso(hours) {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }

  // One row per vehicle - its most recent poll. Backed by the vehicle_latest
  // view (a DISTINCT ON, computed in Postgres) rather than pulling full
  // history and reducing client-side.
  async function fetchLatest() {
    const { data, error } = await AUTH.client
      .from("vehicle_latest")
      .select("*")
      .order("vehicle_no");
    if (error) throw error;
    return data;
  }

  // Full-fleet history within the window, ordered so it comes back
  // pre-grouped by vehicle. Drives the fleet time-series charts, the
  // distance-travelled leaderboard, and the trails on the map.
  async function fetchHistorySince(hours) {
    const { data, error } = await AUTH.client
      .from("vehicle_positions")
      .select(
        "imei_no, vehicle_no, latitude, longitude, speed, status, polled_at, device_datetime"
      )
      .gte("polled_at", windowStartIso(hours))
      .order("imei_no")
      .order("polled_at");
    if (error) throw error;
    return data;
  }

  // Single vehicle's full history (all columns) within the window, for the
  // detail page. Filtered at the database rather than pulling the fleet and
  // discarding 24/25 of it.
  async function fetchVehicleHistory(imei, hours) {
    const { data, error } = await AUTH.client
      .from("vehicle_positions")
      .select("*")
      .eq("imei_no", imei)
      .gte("polled_at", windowStartIso(hours))
      .order("polled_at");
    if (error) throw error;
    return data;
  }

  // Multi-day, per-vehicle-per-day analytics (moving/idle/parked/maintenance
  // seconds, distance, first departure from parking, parked-overnight) -
  // computed in Postgres, see trackezz/supabase/schema.sql's
  // vehicle_day_metrics(). Geofence coordinates and the fleet timezone are
  // passed through from CONFIG on every call, NOT duplicated in SQL -
  // config.js stays the one place that says where the yard/garage are.
  async function fetchDailyMetrics({ startDate, endDate, imei = null }) {
    const { data, error } = await AUTH.client.rpc("vehicle_day_metrics", {
      p_start_date: startDate, // "YYYY-MM-DD", Kathmandu calendar date, inclusive
      p_end_date: endDate, // inclusive
      p_park_lat: CONFIG.PARK_CENTER.lat,
      p_park_lon: CONFIG.PARK_CENTER.lon,
      p_park_radius_m: CONFIG.PARK_RADIUS_M,
      p_maint_lat: CONFIG.MAINTENANCE_CENTER.lat,
      p_maint_lon: CONFIG.MAINTENANCE_CENTER.lon,
      p_maint_radius_m: CONFIG.MAINTENANCE_RADIUS_M,
      p_imei: imei,
      p_overnight_start_hour: CONFIG.OVERNIGHT_START_HOUR,
      p_overnight_end_hour: CONFIG.OVERNIGHT_END_HOUR,
      p_max_gap_minutes: CONFIG.MAX_GAP_MINUTES,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // Discrete maintenance-visit episodes (start/end/duration), grouping
  // consecutive maintenance-state readings so a single repair spanning
  // multiple days is one row, not fragmented per-day. See schema.sql's
  // vehicle_maintenance_visits(). visit_end is null and is_ongoing is true
  // for a visit still in progress as of "now."
  //
  // startDate bounds how far back to scan (Kathmandu calendar date, or null
  // for no lower bound).
  async function fetchMaintenanceVisits({ imei = null, startDate = null } = {}) {
    const { data, error } = await AUTH.client.rpc("vehicle_maintenance_visits", {
      p_maint_lat: CONFIG.MAINTENANCE_CENTER.lat,
      p_maint_lon: CONFIG.MAINTENANCE_CENTER.lon,
      p_maint_radius_m: CONFIG.MAINTENANCE_RADIUS_M,
      p_imei: imei,
      p_since: startDate,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // GPS-jump / frozen-while-moving anomalies - see schema.sql's
  // vehicle_gps_anomalies(). No external data needed: this flags readings
  // that are internally inconsistent (implied speed too high to be real, or
  // "moving" reported while position doesn't change), which is the general
  // building block for "does the GPS agree with what's being reported"
  // fraud/tamper signals, independent of any external rides feed.
  async function fetchAnomalies({ startDate, endDate, imei = null }) {
    const { data, error } = await AUTH.client.rpc("vehicle_gps_anomalies", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_imei: imei,
      p_max_plausible_kmh: CONFIG.MAX_PLAUSIBLE_KMH,
      p_stuck_minutes: CONFIG.STUCK_MINUTES,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // Vehicle <-> driver phone mapping - full history (current + past), not
  // just today's assignment. currentDriverByImei() below splits current
  // (valid_to is null) from history client-side.
  //
  // imei is optional - pass it when the caller only ever wants ONE
  // vehicle's mapping (vehicle.html's single-vehicle page) so it isn't
  // pulling every vehicle's full mapping history just to read one row.
  // Omit it for pages that genuinely need the whole fleet (index.html's
  // table, misuse.html's ranked list, etc).
  async function fetchVehicleDriverMappings(imei = null) {
    let q = AUTH.client.from("vehicle_driver_mapping").select("*");
    if (imei) q = q.eq("imei_no", imei);
    const { data, error } = await q.order("imei_no").order("valid_from", { ascending: false });
    if (error) throw error;
    return data;
  }

  // imei_no -> current mapping row (valid_to is null), from an already-
  // fetched fetchVehicleDriverMappings() result. Shared by every page that
  // wants to show "who drives this vehicle" (map popups, tables, chart
  // tooltips) so the valid_to===null filter lives in exactly one place.
  function currentDriverByImei(mappings) {
    const map = new Map();
    for (const m of mappings) {
      if (m.valid_to === null) map.set(m.imei_no, m);
    }
    return map;
  }

  // Atomically closes any current mapping for imei and opens a new one (or,
  // if the phone is unchanged, updates driver_name/note in place) - see
  // schema.sql's set_vehicle_driver(). phone null/"" unassigns.
  async function setVehicleDriver({ imei, phone, driverName = null, note = null }) {
    const { data, error } = await AUTH.client.rpc("set_vehicle_driver", {
      p_imei: imei,
      p_phone: phone,
      p_driver_name: driverName,
      p_note: note,
    });
    if (error) throw error;
    return data;
  }

  // Exact-match driver lookup by phone - powers the mapping form's
  // "auto-suggest a name once a valid phone is entered."
  async function lookupDriverByPhone(phone) {
    const { data, error } = await AUTH.client.rpc("lookup_driver_by_phone", { p_phone: phone });
    if (error) throw error;
    return data[0] || null;
  }

  // Per-vehicle-per-day ride-corroboration rollup - see schema.sql's
  // vehicle_ride_match_day_metrics(). Same CONFIG-sourced geofence/tz/gap
  // params as fetchDailyMetrics(), so the two compose (join client-side on
  // imei_no + local_date) without re-fetching anything.
  async function fetchRideMatchDailyMetrics({ startDate, endDate, imei = null }) {
    const { data, error } = await AUTH.client.rpc("vehicle_ride_match_day_metrics", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_park_lat: CONFIG.PARK_CENTER.lat,
      p_park_lon: CONFIG.PARK_CENTER.lon,
      p_park_radius_m: CONFIG.PARK_RADIUS_M,
      p_maint_lat: CONFIG.MAINTENANCE_CENTER.lat,
      p_maint_lon: CONFIG.MAINTENANCE_CENTER.lon,
      p_maint_radius_m: CONFIG.MAINTENANCE_RADIUS_M,
      p_imei: imei,
      p_max_gap_minutes: CONFIG.MAX_GAP_MINUTES,
      p_ride_tolerance_minutes: CONFIG.RIDE_MATCH_TOLERANCE_MINUTES,
      p_pending_grace_minutes: CONFIG.RIDE_MATCH_PENDING_GRACE_MINUTES,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // On-demand, single-vehicle segment drill-down - see schema.sql's
  // vehicle_ride_segments(). Requires imei (no "all vehicles" mode),
  // mirrors analytics.js's deep-dive report pattern - not auto-loaded.
  async function fetchVehicleRideSegments({ imei, startDate, endDate }) {
    const { data, error } = await AUTH.client.rpc("vehicle_ride_segments", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_park_lat: CONFIG.PARK_CENTER.lat,
      p_park_lon: CONFIG.PARK_CENTER.lon,
      p_park_radius_m: CONFIG.PARK_RADIUS_M,
      p_maint_lat: CONFIG.MAINTENANCE_CENTER.lat,
      p_maint_lon: CONFIG.MAINTENANCE_CENTER.lon,
      p_maint_radius_m: CONFIG.MAINTENANCE_RADIUS_M,
      p_imei: imei,
      p_max_gap_minutes: CONFIG.MAX_GAP_MINUTES,
      p_ride_tolerance_minutes: CONFIG.RIDE_MATCH_TOLERANCE_MINUTES,
      p_pending_grace_minutes: CONFIG.RIDE_MATCH_PENDING_GRACE_MINUTES,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // Restricted read into the mapped fleet's Yango ride history - name/
  // phone/ride times/category only (see schema.sql's fleet_driver_orders
  // view; no price or payment method, by design).
  async function fetchDriverRides({ phone, startDate = null, endDate = null }) {
    let q = AUTH.client.from("fleet_driver_orders").select("*").eq("phone", phone);
    if (startDate) q = q.gte("booked_at", `${startDate}T00:00:00`);
    if (endDate) q = q.lte("ended_at", `${endDate}T23:59:59`);
    const { data, error } = await q.order("booked_at", { ascending: false });
    if (error) throw error;
    return data;
  }

  // Per-vehicle-per-day gross Yango revenue via the mapped driver - see
  // schema.sql's vehicle_revenue_day_metrics(). Mapped vehicles only;
  // unmapped periods contribute nothing (see analytics.js's revenue
  // tooltips). Same startDate/endDate/imei shape as fetchDailyMetrics()
  // so the two join client-side on imei_no + local_date.
  async function fetchVehicleRevenueDailyMetrics({ startDate, endDate, imei = null }) {
    const { data, error } = await AUTH.client.rpc("vehicle_revenue_day_metrics", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_imei: imei,
      p_tz: CONFIG.TIMEZONE,
    });
    if (error) throw error;
    return data;
  }

  // How long a vehicle has continuously been in its current classify()
  // state, estimated client-side from whatever history rows are already
  // loaded (no extra query) - walks backward from the latest reading while
  // the state stays the same, respecting the same MAX_GAP_MINUTES gap rule
  // as vehicleMetrics(). Returns { seconds, sinceStart } where sinceStart
  // is true if the streak runs all the way to the first loaded row (so the
  // real duration may be longer than what's reported - an "at least"
  // caveat, not a lower bound guarantee beyond the window).
  function stateDurationFromHistory(rows, currentState) {
    if (!rows.length) return { seconds: 0, sinceStart: false };
    let i = rows.length - 1;
    let seconds = 0;
    while (i > 0) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (classify(cur) !== currentState) break;
      const dtMs = new Date(cur.polled_at).getTime() - new Date(prev.polled_at).getTime();
      if (dtMs <= 0 || dtMs >= CONFIG.MAX_GAP_MINUTES * 60_000) break;
      seconds += dtMs / 1000;
      i--;
    }
    const sinceStart = i === 0 && classify(rows[0]) === currentState;
    return { seconds, sinceStart };
  }

  function groupByVehicle(rows) {
    const byVehicle = new Map();
    for (const row of rows) {
      if (!byVehicle.has(row.imei_no)) byVehicle.set(row.imei_no, []);
      byVehicle.get(row.imei_no).push(row);
    }
    return byVehicle;
  }

  // "moving" / "maintenance" / "parked" / "idle" / "offline" for one
  // latest-row. Offline takes priority over everything else - a stale
  // reading tells you nothing about where the vehicle is now. Maintenance
  // is checked before parked: the two geofences are ~3.4km apart in this
  // fleet's config so a reading can never legitimately match both, but if
  // that ever changes, "in for service" is the more decision-relevant
  // state to surface than "at the yard."
  function classify(row) {
    if (!row.device_datetime) return "offline";
    const ageMin = (Date.now() - new Date(row.device_datetime).getTime()) / 60000;
    if (ageMin > CONFIG.STALE_MINUTES) return "offline";
    if ((row.speed || 0) > 0) return "moving";
    if (GEO.isWithinMaintenance(row.latitude, row.longitude)) return "maintenance";
    if (GEO.isWithinParking(row.latitude, row.longitude)) return "parked";
    return "idle";
  }

  function ageSeconds(deviceDatetime) {
    if (!deviceDatetime) return null;
    return Math.max(0, (Date.now() - new Date(deviceDatetime).getTime()) / 1000);
  }

  // Distance, average/max speed, and moving-time share for one vehicle's
  // history rows (already time-ordered). All computed client-side from
  // lat/lon + timestamps already in hand - no extra query, no backend change.
  function vehicleMetrics(rows) {
    if (!rows.length) {
      return { distanceKm: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, movingPct: 0, points: 0 };
    }
    const points = rows.filter((r) => r.latitude != null && r.longitude != null);
    const distanceKm = GEO.metersToKm(GEO.pathDistanceMeters(points));

    let movingMs = 0;
    let totalMs = 0;
    let speedSum = 0;
    let speedN = 0;
    let maxSpeed = 0;
    for (let i = 0; i < rows.length; i++) {
      const speed = rows[i].speed || 0;
      if (speed > maxSpeed) maxSpeed = speed;
      if (rows[i].speed != null) {
        speedSum += speed;
        speedN++;
      }
      if (i > 0) {
        const dt =
          new Date(rows[i].polled_at).getTime() - new Date(rows[i - 1].polled_at).getTime();
        if (dt > 0 && dt < CONFIG.MAX_GAP_MINUTES * 60_000) {
          // ignore gaps > 10min (offline stretches) so they don't count as idle time
          totalMs += dt;
          if (speed > 0) movingMs += dt;
        }
      }
    }
    return {
      distanceKm,
      avgSpeedKmh: speedN ? speedSum / speedN : 0,
      maxSpeedKmh: maxSpeed,
      movingPct: totalMs ? (100 * movingMs) / totalMs : 0,
      points: rows.length,
    };
  }

  // Fleet-wide series for the "moving vehicles over time" and "average speed
  // over time" charts. Polls across vehicles land within a couple of seconds
  // of each other but not exactly together, so bucket to the minute.
  function fleetTimeSeries(historyRows) {
    const buckets = new Map(); // minuteKey -> { moving: Set, speedSum, speedN }
    for (const row of historyRows) {
      const t = new Date(row.polled_at);
      t.setSeconds(0, 0);
      const key = t.getTime();
      if (!buckets.has(key)) buckets.set(key, { moving: new Set(), speedSum: 0, speedN: 0 });
      const b = buckets.get(key);
      if ((row.speed || 0) > 0) {
        b.moving.add(row.imei_no);
        b.speedSum += row.speed;
        b.speedN += 1;
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({
        t: new Date(t),
        movingCount: b.moving.size,
        avgSpeed: b.speedN ? b.speedSum / b.speedN : 0,
      }));
  }

  return {
    fetchLatest,
    fetchHistorySince,
    fetchVehicleHistory,
    fetchDailyMetrics,
    fetchMaintenanceVisits,
    fetchAnomalies,
    fetchVehicleDriverMappings,
    currentDriverByImei,
    setVehicleDriver,
    lookupDriverByPhone,
    fetchRideMatchDailyMetrics,
    fetchVehicleRideSegments,
    fetchDriverRides,
    fetchVehicleRevenueDailyMetrics,
    groupByVehicle,
    classify,
    ageSeconds,
    vehicleMetrics,
    fleetTimeSeries,
    stateDurationFromHistory,
  };
})();
