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

  function groupByVehicle(rows) {
    const byVehicle = new Map();
    for (const row of rows) {
      if (!byVehicle.has(row.imei_no)) byVehicle.set(row.imei_no, []);
      byVehicle.get(row.imei_no).push(row);
    }
    return byVehicle;
  }

  // "moving" / "parked" / "idle" / "offline" for one latest-row. Offline
  // takes priority over speed/geofence - a stale reading tells you nothing
  // about where the vehicle is now, only where it was last seen.
  function classify(row) {
    if (!row.device_datetime) return "offline";
    const ageMin = (Date.now() - new Date(row.device_datetime).getTime()) / 60000;
    if (ageMin > CONFIG.STALE_MINUTES) return "offline";
    if ((row.speed || 0) > 0) return "moving";
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
        if (dt > 0 && dt < 10 * 60_000) {
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
    groupByVehicle,
    classify,
    ageSeconds,
    vehicleMetrics,
    fleetTimeSeries,
  };
})();
