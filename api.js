// Data access + derived analytics, shared by the fleet and per-vehicle pages.
// Every function here reads from Supabase via AUTH.client (auth.js), which
// carries the signed-in session automatically.
const API = (() => {
  const DEFAULT_TIMEOUT_MS = 12_000;

  function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = "Query") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
      ),
    ]);
  }

  function windowStartIso(hours) {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }

  // One row per vehicle - its most recent poll. Backed by the vehicle_latest
  // view (a DISTINCT ON, computed in Postgres) rather than pulling full
  // history and reducing client-side.
  async function fetchLatest() {
    return withTimeout(
      AUTH.client
        .from("vehicle_latest")
        .select("*")
        .order("vehicle_no")
        .then(({ data, error }) => {
          if (error) throw error;
          return data;
        }),
      8000,
      "fetchLatest"
    );
  }

  // Full-fleet history within the window, ordered so it comes back
  // pre-grouped by vehicle. Drives the fleet time-series charts, the
  // distance-travelled leaderboard, and the trails on the map.
  async function fetchHistorySince(hours) {
    return withTimeout(
      AUTH.client
        .from("vehicle_positions")
        .select(
          "imei_no, vehicle_no, latitude, longitude, speed, status, polled_at, device_datetime"
        )
        .gte("polled_at", windowStartIso(hours))
        .order("imei_no")
        .order("polled_at")
        .then(({ data, error }) => {
          if (error) throw error;
          return data;
        }),
      12000,
      "fetchHistorySince"
    );
  }

  // Same shape as fetchHistorySince, but only rows strictly newer than
  // sinceIso - for a page that's already polling on a timer and just wants
  // what's new since its last poll, not the whole window again every time.
  async function fetchHistoryDelta(sinceIso) {
    let q = AUTH.client
      .from("vehicle_positions")
      .select(
        "imei_no, vehicle_no, latitude, longitude, speed, status, polled_at, device_datetime"
      )
      .order("imei_no")
      .order("polled_at");
    if (sinceIso) q = q.gt("polled_at", sinceIso);
    return withTimeout(
      q.then(({ data, error }) => {
        if (error) throw error;
        return data;
      }),
      10000,
      "fetchHistoryDelta"
    );
  }

  // Folds a delta fetch into an existing history array: de-dupes by
  // (imei_no, polled_at) - cheap insurance against a boundary row being
  // re-fetched rather than something to rely on - re-sorts to the same
  // imei_no-then-polled_at order the server always returns (vehicleMetrics()
  // below assumes its input is time-ordered per vehicle; skipping this step
  // after a merge would silently corrupt every distance/speed number), and
  // drops anything that's aged out of the window. windowHours=null skips
  // trimming (caller doesn't want a window cutoff applied).
  function mergeHistoryRows(existing, incoming, windowHours) {
    const seen = new Map();
    for (const r of existing) seen.set(`${r.imei_no}|${r.polled_at}`, r);
    for (const r of incoming) seen.set(`${r.imei_no}|${r.polled_at}`, r);
    let merged = [...seen.values()];
    if (windowHours != null) {
      const cutoff = windowStartIso(windowHours);
      merged = merged.filter((r) => r.polled_at >= cutoff);
    }
    merged.sort((a, b) => {
      if (a.imei_no !== b.imei_no) return a.imei_no < b.imei_no ? -1 : 1;
      return a.polled_at < b.polled_at ? -1 : a.polled_at > b.polled_at ? 1 : 0;
    });
    return merged;
  }

  // Newest polled_at across a set of rows (already-fetched history, or a
  // fresh delta) - the cursor fetchHistoryDelta's next call should pass as
  // sinceIso. String comparison is safe: PostgREST always returns polled_at
  // in the same ISO-8601 format, which sorts lexicographically same as
  // chronologically.
  function maxPolledAt(rows) {
    let max = null;
    for (const r of rows) {
      if (r.polled_at && (!max || r.polled_at > max)) max = r.polled_at;
    }
    return max;
  }

  // Single vehicle's full history (all columns) within the window, for the
  // detail page. Filtered at the database rather than pulling the fleet and
  // discarding 24/25 of it.
  async function fetchVehicleHistory(imei, hours) {
    return withTimeout(
      AUTH.client
        .from("vehicle_positions")
        .select("*")
        .eq("imei_no", imei)
        .gte("polled_at", windowStartIso(hours))
        .order("polled_at")
        .then(({ data, error }) => {
          if (error) throw error;
          return data || [];
        }),
      10000,
      "fetchVehicleHistory"
    ).catch((err) => {
      console.warn("[API] fetchVehicleHistory failed:", err?.message || err);
      return [];
    });
  }

  // Single vehicle's history within an arbitrary date range (Kathmandu calendar dates).
  async function fetchVehicleHistoryRange(imei, startDate, endDate) {
    let q = AUTH.client
      .from("vehicle_positions")
      .select("*")
      .eq("imei_no", imei);
    if (startDate) q = q.gte("polled_at", `${startDate}T00:00:00+05:45`);
    if (endDate) q = q.lte("polled_at", `${endDate}T23:59:59+05:45`);
    return withTimeout(
      q.order("polled_at").then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
      12000,
      "fetchVehicleHistoryRange"
    ).catch((err) => {
      console.warn("[API] fetchVehicleHistoryRange failed:", err?.message || err);
      return [];
    });
  }

  // Delta version of fetchVehicleHistory - see fetchHistoryDelta() above,
  // same idea scoped to one vehicle. Pair with mergeHistoryRows().
  async function fetchVehicleHistoryDelta(imei, sinceIso) {
    let q = AUTH.client.from("vehicle_positions").select("*").eq("imei_no", imei).order("polled_at");
    if (sinceIso) q = q.gt("polled_at", sinceIso);
    return withTimeout(
      q.then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
      8000,
      "fetchVehicleHistoryDelta"
    ).catch((err) => {
      console.warn("[API] fetchVehicleHistoryDelta failed:", err?.message || err);
      return [];
    });
  }

  function getDaysInRange(startDate, endDate) {
    if (!startDate || !endDate) return [];
    const days = [];
    let curr = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    while (curr <= end && days.length <= 60) {
      days.push(curr.toISOString().slice(0, 10));
      curr.setUTCDate(curr.getUTCDate() + 1);
    }
    return days;
  }

  // Executes an RPC call with timeout protection. If PostgreSQL throws error 57014
  // (statement timeout) or a query times out, and the call spans multiple days,
  // automatically breaks the query into 1-day slices to avoid database timeouts.
  async function callRpcWithDailyFallback(fnName, baseParams, startDate, endDate, startKey = "p_start_date", endKey = "p_end_date") {
    const isMultiDay = startDate && endDate && startDate !== endDate;
    const callSingle = (s, e) => {
      const params = { ...baseParams };
      if (s !== undefined) params[startKey] = s;
      if (e !== undefined) params[endKey] = e;
      return withTimeout(
        AUTH.client.rpc(fnName, params).then(({ data, error }) => {
          if (error) throw error;
          return data || [];
        }),
        10000,
        fnName
      );
    };

    try {
      return await callSingle(startDate, endDate);
    } catch (err) {
      const isTimeout =
        err?.code === "57014" ||
        /statement timeout|timed out|57014/i.test(err?.message || "");

      if (isTimeout && isMultiDay) {
        console.warn(`[API] ${fnName} timed out for range ${startDate}..${endDate}. Falling back to daily chunked queries...`);
        const days = getDaysInRange(startDate, endDate);
        const results = [];
        const BATCH_SIZE = 3;
        for (let i = 0; i < days.length; i += BATCH_SIZE) {
          const batch = days.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.allSettled(
            batch.map((day) => callSingle(day, day))
          );
          for (const res of batchResults) {
            if (res.status === "fulfilled" && Array.isArray(res.value)) {
              results.push(...res.value);
            } else if (res.status === "rejected") {
              console.warn(`[API] ${fnName} failed for day chunk:`, res.reason);
            }
          }
        }
        return results;
      }

      console.warn(`[API] ${fnName} failed:`, err?.message || err);
      return [];
    }
  }

  // Multi-day, per-vehicle-per-day analytics (moving/idle/parked/maintenance
  // seconds, distance, first departure from parking, parked-overnight) -
  // computed in Postgres, see trackezz/supabase/schema.sql's
  // vehicle_day_metrics(). Geofence coordinates and the fleet timezone are
  // passed through from CONFIG on every call, NOT duplicated in SQL -
  // config.js stays the one place that says where the yard/garage are.
  async function fetchDailyMetrics({ startDate, endDate, imei = null }) {
    const params = {
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
    };
    return callRpcWithDailyFallback("vehicle_day_metrics", params, startDate, endDate, "p_start_date", "p_end_date");
  }

  // Discrete maintenance-visit episodes (start/end/duration), grouping
  // consecutive maintenance-state readings so a single repair spanning
  // multiple days is one row, not fragmented per-day. See schema.sql's
  // vehicle_maintenance_visits(). visit_end is null and is_ongoing is true
  // for a visit still in progress as of "now."
  //
  // startDate bounds how far back to scan (Kathmandu calendar date, or null
  // for no lower bound). endDate bounds how far forward (inclusive; or null
  // for no upper bound - a visit is included if it STARTED on or before
  // endDate, even if still ongoing past it).
  async function fetchMaintenanceVisits({ imei = null, startDate = null, endDate = null } = {}) {
    const params = {
      p_maint_lat: CONFIG.MAINTENANCE_CENTER.lat,
      p_maint_lon: CONFIG.MAINTENANCE_CENTER.lon,
      p_maint_radius_m: CONFIG.MAINTENANCE_RADIUS_M,
      p_imei: imei,
      p_tz: CONFIG.TIMEZONE,
    };
    return callRpcWithDailyFallback("vehicle_maintenance_visits", params, startDate, endDate, "p_since", "p_until");
  }

  // GPS-jump / frozen-while-moving anomalies - see schema.sql's
  // vehicle_gps_anomalies(). No external data needed: this flags readings
  // that are internally inconsistent (implied speed too high to be real, or
  // "moving" reported while position doesn't change), which is the general
  // building block for "does the GPS agree with what's being reported"
  // fraud/tamper signals, independent of any external rides feed.
  async function fetchAnomalies({ startDate, endDate, imei = null }) {
    const params = {
      p_imei: imei,
      p_max_plausible_kmh: CONFIG.MAX_PLAUSIBLE_KMH,
      p_stuck_minutes: CONFIG.STUCK_MINUTES,
      p_tz: CONFIG.TIMEZONE,
    };
    return callRpcWithDailyFallback("vehicle_gps_anomalies", params, startDate, endDate, "p_start_date", "p_end_date");
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
    return withTimeout(
      q.order("imei_no").order("valid_from", { ascending: false }).then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
      8000,
      "fetchVehicleDriverMappings"
    ).catch((err) => {
      console.warn("[API] fetchVehicleDriverMappings failed:", err?.message || err);
      return [];
    });
  }

  // imei_no -> current mapping row (valid_to is null), from an already-
  // fetched fetchVehicleDriverMappings() result. Shared by every page that
  // wants to show "who drives this vehicle" (map popups, tables, chart
  // tooltips) so the valid_to===null filter lives in exactly one place.
  function currentDriverByImei(mappings) {
    const map = new Map();
    for (const m of (mappings || [])) {
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
    const params = {
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
    };
    return callRpcWithDailyFallback("vehicle_ride_match_day_metrics", params, startDate, endDate, "p_start_date", "p_end_date");
  }

  // On-demand, single-vehicle segment drill-down - see schema.sql's
  // vehicle_ride_segments(). Requires imei (no "all vehicles" mode),
  // mirrors analytics.js's deep-dive report pattern - not auto-loaded.
  async function fetchVehicleRideSegments({ imei, startDate, endDate }) {
    const params = {
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
    };
    return callRpcWithDailyFallback("vehicle_ride_segments", params, startDate, endDate, "p_start_date", "p_end_date");
  }

  // Restricted read into the mapped fleet's Yango ride history - name/
  // phone/ride times/category only (see schema.sql's fleet_driver_orders
  // view; no price or payment method, by design).
  async function fetchDriverRides({ phone, startDate = null, endDate = null }) {
    let q = AUTH.client.from("fleet_driver_orders").select("*").eq("phone", phone);
    if (startDate) q = q.gte("booked_at", `${startDate}T00:00:00`);
    if (endDate) q = q.lte("ended_at", `${endDate}T23:59:59`);
    return withTimeout(
      q.order("booked_at", { ascending: false }).then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
      8000,
      "fetchDriverRides"
    ).catch((err) => {
      console.warn("[API] fetchDriverRides failed:", err?.message || err);
      return [];
    });
  }

  // Per-vehicle-per-day gross Yango revenue via the mapped driver - see
  // schema.sql's vehicle_revenue_day_metrics(). Mapped vehicles only;
  // unmapped periods contribute nothing (see analytics.js's revenue
  // tooltips). Same startDate/endDate/imei shape as fetchDailyMetrics()
  // so the two join client-side on imei_no + local_date.
  async function fetchVehicleRevenueDailyMetrics({ startDate, endDate, imei = null }) {
    const params = {
      p_imei: imei,
      p_tz: CONFIG.TIMEZONE,
    };
    return callRpcWithDailyFallback("vehicle_revenue_day_metrics", params, startDate, endDate, "p_start_date", "p_end_date");
  }

  // classify()'s 4 non-offline branches, WITHOUT the "is this reading old
  // relative to right now" check - see stateDurationFromHistory() below
  // for why that check must not run on historical rows.
  function classifyIgnoringStaleness(row) {
    if (GEO.isWithinMaintenance(row.latitude, row.longitude)) return "maintenance";
    if (GEO.isWithinParking(row.latitude, row.longitude)) return "parked";
    if ((row.speed || 0) > 0) return "moving";
    return "idle";
  }

  // How long a vehicle has continuously been in its current classify()
  // state, estimated client-side from whatever history rows are already
  // loaded (no extra query) - walks backward from the latest reading while
  // the state stays the same, respecting the same MAX_GAP_MINUTES gap rule
  // as vehicleMetrics(). Returns { seconds, sinceStart } where sinceStart
  // is true if the streak runs all the way to the first loaded row (so the
  // real duration may be longer than what's reported - an "at least"
  // caveat, not a lower bound guarantee beyond the window).
  //
  // Deliberately does NOT call classify() on the historical rows it walks
  // (except when currentState is itself "offline") - classify()'s offline
  // check compares a row's device_datetime against Date.now(), which is
  // right for judging whether the LATEST reading is fresh, but wrong for a
  // historical row: a row from 65 minutes ago is not "newly offline" just
  // because 65 minutes of wall-clock time have now passed since it was
  // polled - it was a perfectly good reading when it arrived. Re-running
  // that check here made every streak silently cap at ~STALE_MINUTES
  // regardless of how much history was actually loaded (found while
  // testing the Inactive threshold, which sits exactly at that boundary -
  // a 70-minute idle streak measured as 60 minutes before this fix,
  // gapped by the walk mistaking its own 61st-minute-old row for offline).
  // Genuine reporting gaps are already caught by the dtMs/MAX_GAP_MINUTES
  // check right below - that's the correct tool for "was there a gap",
  // not classify()'s now-relative staleness branch.
  function stateDurationFromHistory(rows, currentState) {
    if (!rows.length) return { seconds: 0, sinceStart: false };
    // classify() never returns "inactive" (only classifyState() does, by
    // promoting a long-enough "idle" streak) - normalize so a caller can
    // pass either "idle" or "inactive" and get the same underlying streak,
    // instead of silently walking zero rows.
    const target = currentState === "inactive" ? "idle" : currentState;
    const classifyFor = target === "offline" ? classify : classifyIgnoringStaleness;
    let i = rows.length - 1;
    let seconds = 0;
    while (i > 0) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (classifyFor(cur) !== target) break;
      const dtMs = new Date(cur.polled_at).getTime() - new Date(prev.polled_at).getTime();
      if (dtMs <= 0 || dtMs >= CONFIG.MAX_GAP_MINUTES * 60_000) break;
      seconds += dtMs / 1000;
      i--;
    }
    const sinceStart = i === 0 && classifyFor(rows[0]) === target;
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
  // reading tells you nothing about where the vehicle is now. Geofence
  // membership beats movement (2026-08-27 requirement, from the fleet
  // operators): a vehicle driving around inside the yard or the
  // maintenance area still counts as "In parking"/"In maintenance", not
  // "Moving" - location is what those two states are about, not whether
  // the wheels are turning. Maintenance is checked before parked: the two
  // geofences are ~3.4km apart in this fleet's config so a reading can
  // never legitimately match both, but if that ever changes, "in for
  // service" is the more decision-relevant state to surface than "at the
  // yard."
  function classify(row) {
    if (!row.device_datetime) return "offline";
    const ageMin = (Date.now() - new Date(row.device_datetime).getTime()) / 60000;
    if (ageMin > CONFIG.STALE_MINUTES) return "offline";
    if (GEO.isWithinMaintenance(row.latitude, row.longitude)) return "maintenance";
    if (GEO.isWithinParking(row.latitude, row.longitude)) return "parked";
    if ((row.speed || 0) > 0) return "moving";
    return "idle";
  }

  // classify(), promoted: "idle" becomes "inactive" once the vehicle has
  // been continuously idle (per stateDurationFromHistory(), which already
  // resets on any movement/state change) for CONFIG.INACTIVE_MINUTES or
  // more. Needs history, unlike classify() itself - callers should pass
  // the CONFIG.INACTIVE_LOOKBACK_HOURS duration-tracking row set, not
  // whatever's loaded for the display window (see app.js/vehicle.js for
  // why those are kept separate).
  function classifyState(row, durationHistoryRows) {
    const base = classify(row);
    if (base !== "idle") return base;
    const { seconds } = stateDurationFromHistory(durationHistoryRows || [], "idle");
    return seconds >= CONFIG.INACTIVE_MINUTES * 60 ? "inactive" : "idle";
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
    fetchHistoryDelta,
    mergeHistoryRows,
    maxPolledAt,
    fetchVehicleHistory,
    fetchVehicleHistoryRange,
    fetchVehicleHistoryDelta,
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
    classifyState,
    ageSeconds,
    vehicleMetrics,
    fleetTimeSeries,
    stateDurationFromHistory,
  };
})();
