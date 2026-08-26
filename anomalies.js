// GPS anomalies page controller (split out of analytics.html/analytics.js
// 2026-08 - see fleet-trends.js's file header for why). No live polling -
// loads once on open and on date-range change. Only 2 queries
// (vehicle_gps_anomalies + driver mappings, for the ranking chart's driver
// sub-labels) - doesn't need fetchLatest, since anomaly rows already carry
// vehicle_no directly (unlike vehicle_revenue_day_metrics).
(function () {
  "use strict";

  const MAX_TABLE_ROWS = 500;

  let anomalies = [];
  let driverByImei = new Map();
  let anomaliesSortState = { key: "detected_at", dir: -1 };
  let loading = false;

  function kathmanduToday() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.TIMEZONE });
  }
  function kathmanduDateShift(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
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

  async function loadAll() {
    const startDate = document.getElementById("range-start").value;
    const endDate = document.getElementById("range-end").value;
    const [anomaliesRaw, mappings] = await Promise.all([
      API.fetchAnomalies({ startDate, endDate }),
      API.fetchVehicleDriverMappings(),
    ]);
    anomalies = anomaliesRaw;
    driverByImei = API.currentDriverByImei(mappings);
    document.getElementById("truncation-warning").hidden = anomalies.length < 1000;
  }

  function renderRankingChart() {
    const counts = new Map(); // imei -> count
    const labels = new Map(); // imei -> label
    for (const a of anomalies) {
      counts.set(a.imei_no, (counts.get(a.imei_no) || 0) + 1);
      if (!labels.has(a.imei_no)) labels.set(a.imei_no, a.vehicle_no || a.imei_no);
    }
    const board = [...counts.entries()].map(([imei, count]) => ({
      label: labels.get(imei),
      sub: driverName(imei),
      value: count,
    }));
    CHART.barChart(document.getElementById("chart-lb-anomalies"), board, {
      valueLabel: (v) => String(Math.round(v)),
      tipUnit: "detections",
      color: "var(--critical)",
      limit: null,
    });
  }

  function anomaliesTableValueOf(row, key) {
    if (key === "detected_at") return row.detected_at ? new Date(row.detected_at).getTime() : 0;
    if (key === "vehicle_no") return row.vehicle_no || "";
    return row[key] ?? "";
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

  const ANOMALY_KIND_LABEL = { gps_jump: "GPS jump", frozen_while_moving: "Frozen while moving" };

  function renderTable() {
    const rows = sortRows(anomalies, anomaliesSortState, anomaliesTableValueOf).slice(0, MAX_TABLE_ROWS);
    const tbody = document.getElementById("anomalies-tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No anomalies detected in this range.</td></tr>';
      return;
    }
    for (const a of rows) {
      const tr = document.createElement("tr");
      const vehTd = document.createElement("td");
      vehTd.textContent = a.vehicle_no || a.imei_no;
      const whenTd = document.createElement("td");
      whenTd.textContent = fmtKathmanduDateTime(a.detected_at);
      const kindTd = document.createElement("td");
      const kindSpan = document.createElement("span");
      kindSpan.className = "leaderboard-value is-alerting";
      kindSpan.textContent = ANOMALY_KIND_LABEL[a.kind] || a.kind;
      kindTd.appendChild(kindSpan);
      const detailTd = document.createElement("td");
      detailTd.className = "location";
      detailTd.textContent = a.detail || "—";
      tr.append(vehTd, whenTd, kindTd, detailTd);
      tbody.appendChild(tr);
    }
  }

  function initTableSort() {
    document.querySelectorAll("#anomalies-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (anomaliesSortState.key === key) anomaliesSortState.dir *= -1;
        else {
          anomaliesSortState.key = key;
          anomaliesSortState.dir = 1;
        }
        document.querySelectorAll("#anomalies-table th[data-sort]").forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", anomaliesSortState.dir === 1 ? "ascending" : "descending");
        renderTable();
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
      if (anomalies.length) renderRankingChart();
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
