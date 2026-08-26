// Revenue page controller (split out of analytics.html/analytics.js 2026-08
// - see fleet-trends.js's file header for why). No live polling - loads
// once on open and on date-range change, same reasoning as fleet-trends.js.
(function () {
  "use strict";

  let latestRows = [];
  let dayMetrics = []; // needed only for each vehicle's moving_seconds, to compute revenue/hour
  let revenueMetrics = [];
  let driverByImei = new Map();
  let loading = false;

  function kathmanduToday() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.TIMEZONE });
  }
  function kathmanduDateShift(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function fmtDateLabel(isoDate) {
    return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  }
  function fmtNpr(v) {
    return `Rs ${Math.round(v).toLocaleString("en-US")}`;
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

  function vehicleLabel(imei) {
    // vehicle_revenue_day_metrics doesn't return vehicle_no (see
    // schema.sql's own comment on why) - resolve it from the roster.
    const row = latestRows.find((r) => r.imei_no === imei);
    return (row && (row.vehicle_no || row.vehicle_name)) || imei;
  }

  function driverName(imei) {
    const m = driverByImei.get(imei);
    return m ? m.driver_name || m.driver_phone : null;
  }

  async function loadAll() {
    const startDate = document.getElementById("range-start").value;
    const endDate = document.getElementById("range-end").value;
    const [latest, days, revenue, mappings] = await Promise.all([
      API.fetchLatest(),
      API.fetchDailyMetrics({ startDate, endDate }),
      API.fetchVehicleRevenueDailyMetrics({ startDate, endDate }),
      API.fetchVehicleDriverMappings(),
    ]);
    latestRows = latest;
    dayMetrics = days;
    revenueMetrics = revenue;
    driverByImei = API.currentDriverByImei(mappings);
  }

  function renderCharts() {
    const byDate = new Map();
    for (const r of revenueMetrics) {
      byDate.set(r.local_date, (byDate.get(r.local_date) || 0) + (r.gross_revenue || 0));
    }
    // Dates come from dayMetrics (one row per vehicle per tracked day), not
    // just revenueMetrics, so the trend line doesn't gap on genuinely
    // zero-revenue days.
    const dates = [...new Set(dayMetrics.map((r) => r.local_date))].sort();
    CHART.lineChart(
      document.getElementById("chart-revenue-day"),
      dates.map((d) => ({ x: new Date(`${d}T00:00:00Z`), y: byDate.get(d) || 0 })),
      { valueLabel: fmtNpr, tipTitle: "Revenue", xLabel: (d) => fmtDateLabel(d.toISOString().slice(0, 10)), color: "var(--series-revenue)" }
    );
  }

  function renderRankingCharts() {
    const revenueByImei = new Map();
    for (const r of revenueMetrics) {
      revenueByImei.set(r.imei_no, (revenueByImei.get(r.imei_no) || 0) + (r.gross_revenue || 0));
    }
    const revenueBoard = [...revenueByImei.entries()].map(([imei, revenue]) => ({
      label: vehicleLabel(imei),
      sub: driverName(imei),
      value: revenue,
    }));
    CHART.barChart(document.getElementById("chart-revenue-vehicle"), revenueBoard, {
      valueLabel: fmtNpr,
      color: "var(--series-revenue)",
      limit: null,
    });

    const movingSecondsByImei = new Map();
    for (const r of dayMetrics) {
      movingSecondsByImei.set(r.imei_no, (movingSecondsByImei.get(r.imei_no) || 0) + (r.moving_seconds || 0));
    }
    const perHourBoard = [...revenueByImei.entries()]
      .map(([imei, revenue]) => {
        const movingSeconds = movingSecondsByImei.get(imei) || 0;
        return {
          label: vehicleLabel(imei),
          sub: driverName(imei),
          value: movingSeconds >= 1800 ? revenue / (movingSeconds / 3600) : null,
        };
      })
      .filter((x) => x.value != null);
    CHART.barChart(document.getElementById("chart-revenue-per-hour"), perHourBoard, {
      valueLabel: fmtNpr,
      tipUnit: "/ moving hour",
      ascending: true,
      color: "var(--series-revenue)",
      limit: null,
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
      renderCharts();
      renderRankingCharts();
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
    refresh();
    window.addEventListener("resize", () => {
      if (revenueMetrics.length) {
        renderCharts();
        renderRankingCharts();
      }
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
