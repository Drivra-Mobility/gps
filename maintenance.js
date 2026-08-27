// Maintenance page controller (split out of analytics.html/analytics.js
// 2026-08 - see fleet-trends.js's file header for why). No live polling -
// loads once on open and on date-range change. 3 queries: ongoing visits
// (bounded by CONFIG.MAINTENANCE_ONGOING_LOOKBACK_DAYS, independent of the
// date-range control), ranged visits, and driver mappings for the ranking
// chart's sub-labels. No fetchLatest needed - visit rows already carry
// vehicle_no directly.
(function () {
  "use strict";

  const MAX_TABLE_ROWS = 500;

  let ongoingVisits = [];
  let recentVisits = [];
  let driverByImei = new Map();
  let allMappings = []; // full history (current + past), for point-in-time driver lookups
  let visitsSortState = { key: "duration_seconds", dir: -1 };
  let frequencySortState = { key: "visits", dir: -1 };
  let loading = false;

  function kathmanduToday() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.TIMEZONE });
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

  function driverName(imei) {
    const m = driverByImei.get(imei);
    return m ? m.driver_name || m.driver_phone : null;
  }

  // Point-in-time driver lookup, deliberately NOT "current driver" - the
  // frequency table below exists to spot rider-specific maintenance
  // patterns, and attributing a vehicle's whole history to whoever drives
  // it today would misattribute any visit from before a reassignment.
  function driverAtTime(imei, atIso) {
    const t = new Date(atIso).getTime();
    const m = allMappings.find(
      (m) =>
        m.imei_no === imei &&
        new Date(m.valid_from).getTime() <= t &&
        (m.valid_to === null || t < new Date(m.valid_to).getTime())
    );
    return m ? m.driver_name || m.driver_phone : null;
  }

  function frequencyRows() {
    const byImei = new Map();
    for (const v of recentVisits) {
      if (!byImei.has(v.imei_no)) {
        byImei.set(v.imei_no, { vehicle_no: v.vehicle_no, visits: 0, totalSeconds: 0, drivers: new Set() });
      }
      const b = byImei.get(v.imei_no);
      b.visits += 1;
      b.totalSeconds += v.duration_seconds || 0;
      const d = driverAtTime(v.imei_no, v.visit_start);
      if (d) b.drivers.add(d);
    }
    return [...byImei.entries()].map(([imei, b]) => ({
      imei,
      vehicle_no: b.vehicle_no || imei,
      // Most vehicles have one driver across the range; show it plainly. A
      // vehicle that changed hands mid-range shows every distinct driver
      // who had a visit, comma-joined - still correct, just not collapsed
      // to a single (potentially wrong) name.
      driver: b.drivers.size ? [...b.drivers].join(", ") : "—",
      visits: b.visits,
      totalSeconds: b.totalSeconds,
    }));
  }

  async function loadAll() {
    const startDate = document.getElementById("range-start").value;
    const endDate = document.getElementById("range-end").value || null;
    const [ongoingRaw, recent, mappings] = await Promise.all([
      API.fetchMaintenanceVisits({
        startDate: kathmanduDateShift(kathmanduToday(), -(CONFIG.MAINTENANCE_ONGOING_LOOKBACK_DAYS - 1)),
      }),
      API.fetchMaintenanceVisits({ startDate, endDate }),
      API.fetchVehicleDriverMappings(),
    ]);
    ongoingVisits = ongoingRaw.filter((v) => v.is_ongoing);
    recentVisits = recent;
    allMappings = mappings;
    driverByImei = API.currentDriverByImei(mappings);
  }

  function renderRankingChart() {
    const board = ongoingVisits.map((v) => ({
      label: v.vehicle_no || v.imei_no,
      sub: driverName(v.imei_no),
      value: v.duration_seconds,
    }));
    CHART.barChart(document.getElementById("chart-lb-maintenance-now"), board, {
      valueLabel: fmtHm,
      tipUnit: "so far",
      color: "var(--state-maintenance)",
      limit: null,
    });
  }

  function visitsTableValueOf(row, key) {
    if (key === "visit_start" || key === "visit_end") return row[key] ? new Date(row[key]).getTime() : Infinity;
    if (key === "vehicle_no") return row.vehicle_no || "";
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

  function renderTable() {
    const rows = sortRows(recentVisits, visitsSortState, visitsTableValueOf).slice(0, MAX_TABLE_ROWS);
    const tbody = document.getElementById("visits-tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No maintenance visits in this range.</td></tr>';
      return;
    }
    for (const v of rows) {
      const tr = document.createElement("tr");
      const cells = [
        v.vehicle_no || v.imei_no,
        fmtKathmanduDateTime(v.visit_start),
        v.is_ongoing ? "Ongoing" : fmtKathmanduDateTime(v.visit_end),
        fmtHm(v.duration_seconds),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 3) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function frequencyTableValueOf(row, key) {
    if (key === "vehicle_no" || key === "driver") return row[key] || "";
    return row[key] ?? 0;
  }

  function renderFrequencyTable() {
    const rows = sortRows(frequencyRows(), frequencySortState, frequencyTableValueOf);
    const tbody = document.getElementById("frequency-tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No maintenance visits in this range.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = [r.vehicle_no, r.driver, String(r.visits), fmtHm(r.totalSeconds)];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i >= 2) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function initTableSort() {
    document.querySelectorAll("#visits-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (visitsSortState.key === key) visitsSortState.dir *= -1;
        else {
          visitsSortState.key = key;
          visitsSortState.dir = 1;
        }
        document.querySelectorAll("#visits-table th[data-sort]").forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", visitsSortState.dir === 1 ? "ascending" : "descending");
        renderTable();
      });
    });
    document.querySelectorAll("#frequency-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (frequencySortState.key === key) frequencySortState.dir *= -1;
        else {
          frequencySortState.key = key;
          frequencySortState.dir = 1;
        }
        document.querySelectorAll("#frequency-table th[data-sort]").forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", frequencySortState.dir === 1 ? "ascending" : "descending");
        renderFrequencyTable();
      });
    });
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
    LOADING.start();
    const statusEl = document.getElementById("status");
    try {
      await loadAll();
      renderRankingChart();
      renderFrequencyTable();
      renderTable();
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
    initTableSort();
    refresh();
    window.addEventListener("resize", () => {
      if (ongoingVisits.length) renderRankingChart();
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
