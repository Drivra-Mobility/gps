// Fleet trends page controller (formerly analytics.html/analytics.js - split
// 2026-08 into fleet-trends/revenue/anomalies/maintenance so each page only
// fires the queries it actually needs; see revenue.js/anomalies.js/
// maintenance.js for the rest of what analytics.html used to show, and
// misuse.html for ride-corroboration/ride-match, which analytics.html used
// to duplicate as a "Lowest ride-corroborated %" ranking chart - dropped
// here rather than relocated, since misuse.html's own table already shows
// the same ride_corroborated_pct per vehicle and firing
// vehicle_ride_match_day_metrics (by far the heaviest RPC this page used to
// call) just to duplicate it wasn't worth it.
//
// No map, no live polling - this page loads once on open (and whenever the
// filters change), because the underlying data (daily aggregates from the
// vehicle_day_metrics RPC, see api.js and trackezz/supabase/schema.sql)
// changes on the timescale of minutes-to-days, not seconds.
(function () {
  "use strict";

  const MAX_TABLE_ROWS = 500;

  let latestRows = [];
  let dayMetrics = [];
  let driverByImei = new Map(); // imei -> current vehicle_driver_mapping row
  let daySortState = { key: "local_date", dir: -1 };
  let loading = false;

  // ---- formatting -------------------------------------------------------

  function kathmanduToday() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.TIMEZONE }); // sv-SE = ISO "YYYY-MM-DD"
  }
  function kathmanduDateShift(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function fmtHm(totalSeconds) {
    const s = Math.max(0, totalSeconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  function fmtKm(km) {
    return `${km.toFixed(km < 10 ? 1 : 0)} km`;
  }
  function fmtPct(p) {
    return `${Math.round(p)}%`;
  }
  function fmtDateLabel(isoDate) {
    return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  }
  function fmtKathmanduTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  function fmtKathmanduDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  // Average of local times-of-day (each as "minutes since local midnight"),
  // used for the "latest average morning departure" leaderboard. Averaging
  // clock times directly (not raw UTC millis) is what makes this correct
  // regardless of what UTC offset Kathmandu happens to be.
  function avgLocalMinutes(isoTimestamps) {
    const minutes = isoTimestamps.map((iso) => {
      const parts = new Date(iso).toLocaleTimeString("en-US", {
        timeZone: CONFIG.TIMEZONE,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });
      const [h, m] = parts.split(":").map(Number);
      return h * 60 + m;
    });
    return minutes.reduce((a, b) => a + b, 0) / minutes.length;
  }
  function fmtMinutesOfDay(totalMinutes) {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = Math.round(totalMinutes % 60);
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${period}`;
  }

  // ---- theme --------------------------------------------------------

  function initTheme() {
    const btn = document.getElementById("theme-toggle");
    const stored = localStorage.getItem("dashboard-theme");
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("dashboard-theme", next);
    });
  }

  // ---- animated numbers (tasteful motion polish) -------------------------

  function animateNumber(el, to, opts = {}) {
    const { ms = 500, format = (v) => String(Math.round(v)) } = opts;
    const from = Number(el.dataset.raw || 0);
    el.dataset.raw = to;
    if (!Number.isFinite(from) || from === to) {
      el.textContent = format(to);
      return;
    }
    const t0 = performance.now();
    function ease(p) {
      return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    }
    function tick(now) {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = format(from + (to - from) * ease(p));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---- data loading -------------------------------------------------

  function vehicleLabel(imei) {
    const row = latestRows.find((r) => r.imei_no === imei);
    return (row && (row.vehicle_no || row.vehicle_name)) || imei;
  }

  function driverName(imei) {
    const m = driverByImei.get(imei);
    return m ? m.driver_name || m.driver_phone : null;
  }

  function populateVehicleSelect(select, { includeAll }) {
    const prev = select.value;
    select.innerHTML = "";
    if (includeAll) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "All vehicles";
      select.appendChild(opt);
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Choose a vehicle…";
      select.appendChild(opt);
    }
    for (const row of latestRows) {
      const opt = document.createElement("option");
      opt.value = row.imei_no;
      opt.textContent = row.vehicle_no || row.vehicle_name || row.imei_no;
      select.appendChild(opt);
    }
    if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  }

  // 3 queries (vehicle roster, daily metrics, driver mappings), down from
  // the 8 this page used to fire before the analytics.html split - see the
  // file header.
  async function loadAll() {
    const startDate = document.getElementById("range-start").value;
    const endDate = document.getElementById("range-end").value;
    const [latest, days, mappings] = await Promise.all([
      API.fetchLatest(),
      API.fetchDailyMetrics({ startDate, endDate }),
      API.fetchVehicleDriverMappings(),
    ]);
    latestRows = latest;
    dayMetrics = days;
    driverByImei = API.currentDriverByImei(mappings);
    document.getElementById("truncation-warning").hidden = dayMetrics.length < 1000;

    populateVehicleSelect(document.getElementById("vehicle-filter"), { includeAll: true });
    populateVehicleSelect(document.getElementById("deep-dive-vehicle"), { includeAll: false });
  }

  // ---- ranking charts ---------------------------------------------------

  function groupDayMetricsByVehicle() {
    const byVehicle = new Map(); // imei -> { vehicle_no, rows: [] }
    for (const row of dayMetrics) {
      if (!byVehicle.has(row.imei_no)) byVehicle.set(row.imei_no, { vehicle_no: row.vehicle_no, rows: [] });
      byVehicle.get(row.imei_no).rows.push(row);
    }
    return byVehicle;
  }

  function renderRankingCharts() {
    const byVehicle = groupDayMetricsByVehicle();

    // Biggest optimisation opportunities: most idle + maintenance seconds.
    const opportunity = [...byVehicle.entries()]
      .map(([imei, v]) => ({
        label: v.vehicle_no || imei,
        sub: driverName(imei),
        value: v.rows.reduce((s, r) => s + (r.idle_seconds || 0) + (r.maintenance_seconds || 0), 0),
      }))
      .filter((x) => x.value > 0);
    CHART.barChart(document.getElementById("chart-lb-opportunity"), opportunity, {
      valueLabel: fmtHm,
      color: "var(--state-idle)",
      limit: null,
    });

    // Lowest utilisation (moving seconds / tracked seconds, weighted).
    const utilisation = [...byVehicle.entries()]
      .map(([imei, v]) => {
        const moving = v.rows.reduce((s, r) => s + (r.moving_seconds || 0), 0);
        const tracked = v.rows.reduce((s, r) => s + (r.tracked_seconds || 0), 0);
        return { label: v.vehicle_no || imei, sub: driverName(imei), value: tracked > 0 ? (100 * moving) / tracked : null };
      })
      .filter((x) => x.value != null);
    CHART.barChart(document.getElementById("chart-lb-utilisation"), utilisation, {
      valueLabel: fmtPct,
      ascending: true,
      color: "var(--state-moving)",
      limit: null,
    });

    // Latest average morning departure.
    const departure = [...byVehicle.entries()]
      .map(([imei, v]) => {
        const times = v.rows.map((r) => r.first_departure_from_parking).filter(Boolean);
        return { label: v.vehicle_no || imei, sub: driverName(imei), value: times.length ? avgLocalMinutes(times) : null };
      })
      .filter((x) => x.value != null);
    CHART.barChart(document.getElementById("chart-lb-departure"), departure, {
      valueLabel: fmtMinutesOfDay,
      tipUnit: "avg",
      color: "var(--state-parked)",
      limit: null,
    });

    // Parked-overnight compliance.
    const overnight = [...byVehicle.entries()]
      .map(([imei, v]) => {
        const nights = v.rows.length;
        const compliant = v.rows.filter((r) => r.parked_overnight).length;
        return { label: v.vehicle_no || imei, sub: driverName(imei), value: nights ? (100 * compliant) / nights : null };
      })
      .filter((x) => x.value != null);
    CHART.barChart(document.getElementById("chart-lb-overnight"), overnight, {
      valueLabel: fmtPct,
      ascending: true,
      color: "var(--state-parked)",
      limit: null,
    });
  }

  // ---- fleet trend charts -----------------------------------------------

  function renderCharts() {
    const byDate = new Map(); // local_date -> { distanceKm, moving, tracked }
    for (const row of dayMetrics) {
      if (!byDate.has(row.local_date)) byDate.set(row.local_date, { distanceKm: 0, moving: 0, tracked: 0 });
      const b = byDate.get(row.local_date);
      b.distanceKm += row.distance_km || 0;
      b.moving += row.moving_seconds || 0;
      b.tracked += row.tracked_seconds || 0;
    }
    const dates = [...byDate.keys()].sort();
    const dateLabel = (d) => fmtDateLabel(d.toISOString().slice(0, 10));

    CHART.lineChart(
      document.getElementById("chart-distance-day"),
      dates.map((d) => ({ x: new Date(`${d}T00:00:00Z`), y: byDate.get(d).distanceKm })),
      { valueLabel: (v) => v.toFixed(0), tipTitle: "Distance", xLabel: dateLabel }
    );
    CHART.lineChart(
      document.getElementById("chart-utilisation-day"),
      dates.map((d) => {
        const b = byDate.get(d);
        return { x: new Date(`${d}T00:00:00Z`), y: b.tracked > 0 ? (100 * b.moving) / b.tracked : 0 };
      }),
      { valueLabel: (v) => `${Math.round(v)}%`, tipTitle: "Utilisation", xLabel: dateLabel, color: "var(--state-idle)" }
    );
  }

  // ---- per-vehicle-per-day table ------------------------------------

  function dayTableValueOf(row, key) {
    if (key === "utilization") return row.tracked_seconds > 0 ? row.moving_seconds / row.tracked_seconds : -1;
    if (key === "first_departure_from_parking")
      return row.first_departure_from_parking ? new Date(row.first_departure_from_parking).getTime() : Infinity;
    if (key === "parked_overnight") return row.parked_overnight ? 1 : 0;
    if (key === "driver") return driverName(row.imei_no) || "";
    if (key === "local_date" || key === "vehicle_no") return row[key] || "";
    return row[key] ?? 0;
  }

  function sortRows(rows, state, valueOf) {
    const { key, dir } = state;
    return [...rows].sort((a, b) => {
      const av = valueOf(a, key);
      const bv = valueOf(b, key);
      if (typeof av === "string") return dir * av.localeCompare(bv);
      return dir * ((av ?? 0) - (bv ?? 0));
    });
  }

  function renderDayTable() {
    const filterImei = document.getElementById("vehicle-filter").value;
    const filtered = filterImei ? dayMetrics.filter((r) => r.imei_no === filterImei) : dayMetrics;
    const rows = sortRows(filtered, daySortState, dayTableValueOf).slice(0, MAX_TABLE_ROWS);
    const tbody = document.getElementById("day-tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">No data in this range.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      const util = r.tracked_seconds > 0 ? (100 * r.moving_seconds) / r.tracked_seconds : null;
      const cells = [
        fmtDateLabel(r.local_date),
        r.vehicle_no || r.imei_no,
        driverName(r.imei_no) || "—",
        fmtHm(r.moving_seconds),
        fmtHm(r.idle_seconds),
        fmtHm(r.parked_seconds),
        fmtHm(r.maintenance_seconds),
        fmtKm(r.distance_km || 0),
        r.reading_count < 2 || util == null ? "—" : fmtPct(util),
        fmtKathmanduTime(r.first_departure_from_parking),
        r.parked_overnight ? "Yes" : "No",
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i >= 3 && i <= 8) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function initTableSort(theadSelector, state, onSort) {
    document.querySelectorAll(theadSelector).forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.key === key) state.dir *= -1;
        else {
          state.key = key;
          state.dir = 1;
        }
        document.querySelectorAll(theadSelector).forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", state.dir === 1 ? "ascending" : "descending");
        onSort();
      });
    });
  }

  // ---- on-demand: compare to previous period -----------------------------

  async function runCompare() {
    const btn = document.getElementById("run-compare");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Running report…";
    LOADING.start();
    try {
      const startDate = document.getElementById("range-start").value;
      const endDate = document.getElementById("range-end").value;
      const lengthDays = Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000) + 1;
      const prevEnd = kathmanduDateShift(startDate, -1);
      const prevStart = kathmanduDateShift(prevEnd, -(lengthDays - 1));

      const prevDays = await API.fetchDailyMetrics({ startDate: prevStart, endDate: prevEnd });

      function aggregate(rows) {
        const byVehicle = new Map();
        for (const r of rows) {
          if (!byVehicle.has(r.imei_no)) byVehicle.set(r.imei_no, { vehicle_no: r.vehicle_no, moving: 0, tracked: 0, distance: 0, maint: 0 });
          const b = byVehicle.get(r.imei_no);
          b.moving += r.moving_seconds || 0;
          b.tracked += r.tracked_seconds || 0;
          b.distance += r.distance_km || 0;
          b.maint += r.maintenance_seconds || 0;
        }
        return byVehicle;
      }
      const current = aggregate(dayMetrics);
      const previous = aggregate(prevDays);
      const imeis = new Set([...current.keys(), ...previous.keys()]);

      const rowsOut = [...imeis].map((imei) => {
        const c = current.get(imei);
        const p = previous.get(imei);
        const cUtil = c && c.tracked > 0 ? (100 * c.moving) / c.tracked : null;
        const pUtil = p && p.tracked > 0 ? (100 * p.moving) / p.tracked : null;
        const cDist = c ? c.distance : 0;
        const pDist = p ? p.distance : 0;
        const cMaint = (c ? c.maint : 0) / 3600;
        const pMaint = (p ? p.maint : 0) / 3600;
        return {
          name: (c && c.vehicle_no) || (p && p.vehicle_no) || imei,
          utilDelta: cUtil != null && pUtil != null ? cUtil - pUtil : null,
          distDelta: cDist - pDist,
          maintDelta: cMaint - pMaint,
        };
      });
      rowsOut.sort((a, b) => (b.utilDelta ?? -999) - (a.utilDelta ?? -999));

      document.getElementById("compare-sub").textContent =
        `${startDate} → ${endDate} vs. ${prevStart} → ${prevEnd} (previous ${lengthDays}-day period)`;
      const tbody = document.getElementById("compare-tbody");
      tbody.innerHTML = "";
      for (const r of rowsOut) {
        const tr = document.createElement("tr");
        const nameTd = document.createElement("td");
        nameTd.textContent = r.name;
        const utilTd = document.createElement("td");
        utilTd.className = "num" + (r.utilDelta == null ? "" : r.utilDelta >= 0 ? " delta-good" : " delta-bad");
        utilTd.textContent = r.utilDelta == null ? "—" : `${r.utilDelta >= 0 ? "+" : ""}${r.utilDelta.toFixed(1)}pp`;
        const distTd = document.createElement("td");
        distTd.className = "num" + (r.distDelta >= 0 ? " delta-good" : " delta-bad");
        distTd.textContent = `${r.distDelta >= 0 ? "+" : ""}${r.distDelta.toFixed(1)} km`;
        const maintTd = document.createElement("td");
        maintTd.className = "num" + (r.maintDelta <= 0 ? " delta-good" : " delta-bad");
        maintTd.textContent = `${r.maintDelta >= 0 ? "+" : ""}${r.maintDelta.toFixed(1)}h`;
        tr.append(nameTd, utilTd, distTd, maintTd);
        tbody.appendChild(tr);
      }
      document.getElementById("compare-panel").hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
      LOADING.stop();
    }
  }

  // ---- on-demand: vehicle deep-dive --------------------------------------

  async function runDeepDive() {
    const imei = document.getElementById("deep-dive-vehicle").value;
    if (!imei) return;
    const btn = document.getElementById("run-deep-dive");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Running report…";
    LOADING.start();
    try {
      const days = Number(document.getElementById("deep-dive-days").value);
      const endDate = kathmanduToday();
      const startDate = kathmanduDateShift(endDate, -(days - 1));

      const [dayRows, visits] = await Promise.all([
        API.fetchDailyMetrics({ startDate, endDate, imei }),
        API.fetchMaintenanceVisits({ imei, startDate }),
      ]);

      const totalMoving = dayRows.reduce((s, r) => s + (r.moving_seconds || 0), 0);
      const totalTracked = dayRows.reduce((s, r) => s + (r.tracked_seconds || 0), 0);
      const totalDistance = dayRows.reduce((s, r) => s + (r.distance_km || 0), 0);
      const totalMaint = dayRows.reduce((s, r) => s + (r.maintenance_seconds || 0), 0);

      document.getElementById("deep-dive-title").textContent =
        `${vehicleLabel(imei)} — ${startDate} to ${endDate}`;

      const kpis = document.getElementById("deep-dive-kpis");
      kpis.innerHTML = "";
      const tiles = [
        ["Total runtime", totalMoving, fmtHm],
        ["Total distance", totalDistance, fmtKm],
        ["Utilisation", totalTracked > 0 ? (100 * totalMoving) / totalTracked : null, fmtPct],
        ["Maintenance time", totalMaint, fmtHm],
      ];
      for (const [label, value, format] of tiles) {
        const art = document.createElement("article");
        art.className = "kpi";
        const h2 = document.createElement("h2");
        h2.textContent = label;
        const p = document.createElement("p");
        p.className = "kpi-value";
        art.append(h2, p);
        kpis.appendChild(art);
        if (value == null) p.textContent = "—";
        else animateNumber(p, value, { format });
      }

      const sorted = [...dayRows].sort((a, b) => a.local_date.localeCompare(b.local_date));
      CHART.lineChart(
        document.getElementById("chart-deep-dive"),
        sorted.map((r) => ({
          x: new Date(`${r.local_date}T00:00:00Z`),
          y: r.tracked_seconds > 0 ? (100 * r.moving_seconds) / r.tracked_seconds : 0,
        })),
        {
          valueLabel: (v) => `${Math.round(v)}%`,
          tipTitle: "Utilisation",
          xLabel: (d) => fmtDateLabel(d.toISOString().slice(0, 10)),
        }
      );

      const visitsTbody = document.getElementById("deep-dive-visits-tbody");
      visitsTbody.innerHTML = "";
      if (!visits.length) {
        visitsTbody.innerHTML = '<tr><td colspan="3" class="empty">No maintenance visits in range.</td></tr>';
      } else {
        for (const v of visits) {
          const tr = document.createElement("tr");
          const startTd = document.createElement("td");
          startTd.textContent = fmtKathmanduDateTime(v.visit_start);
          const endTd = document.createElement("td");
          endTd.textContent = v.is_ongoing ? "Ongoing" : fmtKathmanduDateTime(v.visit_end);
          const durTd = document.createElement("td");
          durTd.className = "num";
          durTd.textContent = fmtHm(v.duration_seconds);
          tr.append(startTd, endTd, durTd);
          visitsTbody.appendChild(tr);
        }
      }
      document.getElementById("deep-dive-panel").hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
      LOADING.stop();
    }
  }

  // ---- orchestration --------------------------------------------------

  function renderAll() {
    renderRankingCharts();
    renderCharts();
    renderDayTable();
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
    LOADING.start();
    const statusEl = document.getElementById("status");
    try {
      await loadAll();
      renderAll();
      statusEl.textContent = `Loaded ${new Date().toLocaleTimeString()}`;
      statusEl.classList.remove("is-error");
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Load failed: ${err.message || err}`;
      statusEl.classList.add("is-error");
    } finally {
      document.body.classList.remove("is-refreshing");
      LOADING.stop();
      loading = false;
    }
  }

  function initDefaultRange() {
    const end = kathmanduToday();
    const start = kathmanduDateShift(end, -(CONFIG.ANALYTICS_DEFAULT_RANGE_DAYS - 1));
    document.getElementById("range-start").value = start;
    document.getElementById("range-end").value = end;
  }

  function start() {
    document.getElementById("sign-out").hidden = false;
    document.getElementById("sign-out").addEventListener("click", () => AUTH.signOut());

    initDefaultRange();
    document.getElementById("range-start").addEventListener("change", refresh);
    document.getElementById("range-end").addEventListener("change", refresh);
    document.getElementById("vehicle-filter").addEventListener("change", renderDayTable);

    document.getElementById("run-compare").addEventListener("click", runCompare);
    document.getElementById("run-deep-dive").addEventListener("click", runDeepDive);

    initTableSort("#day-table th[data-sort]", daySortState, renderDayTable);

    refresh();
    window.addEventListener("resize", () => {
      if (dayMetrics.length) {
        renderCharts();
        renderRankingCharts();
      }
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
