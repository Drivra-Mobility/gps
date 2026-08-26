// Fleet overview page controller. Loads once the login gate in auth.js
// confirms a session, then polls Supabase every CONFIG.REFRESH_MS.
(function () {
  "use strict";

  let latestRows = [];
  let historyRows = [];
  let driverByImei = new Map(); // imei -> current vehicle_driver_mapping row
  let grouped = new Map();
  let metrics = new Map(); // imei -> vehicleMetrics()
  let markers = new Map(); // imei -> Leaflet marker
  let prevStates = new Map(); // imei -> last-rendered classify() state, for the pulse-on-change effect
  let trailLayers = [];
  let map;
  let geofencesDrawn = false;
  let sortState = { key: "vehicle_no", dir: 1 };
  let loading = false;

  // ---- formatting ---------------------------------------------------

  function fmtKm(km) {
    return `${km.toFixed(km < 10 ? 1 : 0)} km`;
  }
  function fmtSpeed(kmh) {
    return `${Math.round(kmh)} km/h`;
  }
  function fmtPct(p) {
    return `${Math.round(p)}%`;
  }
  function fmtAge(sec) {
    if (sec == null) return "never";
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // Tweens a KPI tile's displayed number from its previous value (stashed on
  // the element itself) to `to`, so a refresh reads as a count changing
  // rather than a flat replace. `format` renders the interpolated value at
  // each frame - pass the same formatter used elsewhere (fmtKm, fmtPct...)
  // so the animated frames look like the real thing, not a bare number.
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

  // ---- theme ----------------------------------------------------------

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

  // ---- data loading -----------------------------------------------------

  async function loadAll() {
    const hours = Number(document.getElementById("window").value);
    const [latest, history, mappings] = await Promise.all([
      API.fetchLatest(),
      API.fetchHistorySince(hours),
      API.fetchVehicleDriverMappings(),
    ]);
    latestRows = latest;
    historyRows = history;
    driverByImei = API.currentDriverByImei(mappings);
    grouped = API.groupByVehicle(history);
    metrics = new Map();
    for (const [imei, rows] of grouped.entries()) {
      metrics.set(imei, API.vehicleMetrics(rows));
    }
  }

  function rowState(row) {
    return API.classify(row);
  }

  function driverName(imei) {
    const m = driverByImei.get(imei);
    return m ? m.driver_name || m.driver_phone : null;
  }

  // ---- KPIs ---------------------------------------------------------

  function renderKpis() {
    const states = latestRows.map((r) => ({ row: r, state: rowState(r) }));
    const count = (s) => states.filter((x) => x.state === s).length;

    animateNumber(document.getElementById("kpi-total"), latestRows.length);
    document.getElementById("kpi-total-note").textContent = `of ${latestRows.length} vehicles`;
    animateNumber(document.getElementById("kpi-moving"), count("moving"));
    animateNumber(document.getElementById("kpi-maintenance"), count("maintenance"));
    animateNumber(document.getElementById("kpi-parked"), count("parked"));
    animateNumber(document.getElementById("kpi-idle"), count("idle"));
    const offline = count("offline");
    animateNumber(document.getElementById("kpi-offline"), offline);
    document.getElementById("kpi-offline-card").classList.toggle("is-alerting", offline > 0);

    let totalKm = 0;
    let speedSum = 0;
    let speedN = 0;
    let movingSum = 0;
    let movingN = 0;
    for (const m of metrics.values()) {
      totalKm += m.distanceKm;
      if (m.avgSpeedKmh > 0) {
        speedSum += m.avgSpeedKmh;
        speedN++;
      }
      movingSum += m.movingPct;
      movingN++;
    }
    animateNumber(document.getElementById("kpi-distance"), totalKm, { format: fmtKm });
    const avgSpeedEl = document.getElementById("kpi-avgspeed");
    if (speedN) animateNumber(avgSpeedEl, speedSum / speedN, { format: fmtSpeed });
    else {
      avgSpeedEl.textContent = "—";
      avgSpeedEl.dataset.raw = 0;
    }
    const utilEl = document.getElementById("kpi-utilisation");
    if (movingN) animateNumber(utilEl, movingSum / movingN, { format: fmtPct });
    else {
      utilEl.textContent = "—";
      utilEl.dataset.raw = 0;
    }

    const newest = latestRows
      .map((r) => (r.device_datetime ? new Date(r.device_datetime).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const freshEl = document.getElementById("freshness");
    if (newest) {
      const ageSec = (Date.now() - newest) / 1000;
      freshEl.textContent = `newest report: ${fmtAge(ageSec)}`;
      freshEl.classList.toggle("is-stale", ageSec > CONFIG.STALE_MINUTES * 60);
    }
  }

  // ---- needs attention -------------------------------------------------
  // Deliberately built from data this page already fetches every refresh
  // (latestRows/grouped/metrics) rather than a new query - see analytics.js
  // for the multi-day equivalents, which do call the dedicated RPCs.

  function fmtDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function renderLeaderboardList(elId, items) {
    const el = document.getElementById(elId);
    el.innerHTML = "";
    if (!items.length) {
      el.innerHTML = '<p class="leaderboard-empty">Nothing to flag right now.</p>';
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      const rank = document.createElement("span");
      rank.className = "leaderboard-rank";
      rank.textContent = `${i + 1}.`;
      const name = document.createElement("span");
      name.className = "leaderboard-name";
      name.textContent = item.name;
      const value = document.createElement("span");
      value.className = "leaderboard-value is-alerting";
      value.textContent = item.value;
      row.append(rank, name, value);
      el.appendChild(row);
    });
  }

  function labelWithDriver(row) {
    const base = row.vehicle_no || row.imei_no;
    const driver = driverName(row.imei_no);
    return driver ? `${base} · ${driver}` : base;
  }

  function renderAttention() {
    const durations = [];
    for (const row of latestRows) {
      const state = rowState(row);
      if (state !== "idle" && state !== "maintenance") continue;
      const d = API.stateDurationFromHistory(grouped.get(row.imei_no) || [], state);
      if (d.seconds <= 0) continue;
      durations.push({
        name: labelWithDriver(row),
        seconds: d.seconds,
        value: `${fmtDuration(d.seconds)}${d.sinceStart ? "+" : ""} ${state}`,
      });
    }
    durations.sort((a, b) => b.seconds - a.seconds);
    renderLeaderboardList(
      "attention-duration",
      durations.slice(0, 5).map((x) => ({ name: x.name, value: x.value }))
    );

    const utilisation = [];
    for (const row of latestRows) {
      const m = metrics.get(row.imei_no);
      if (!m || m.points < 2) continue;
      utilisation.push({ name: labelWithDriver(row), pct: m.movingPct });
    }
    utilisation.sort((a, b) => a.pct - b.pct);
    renderLeaderboardList(
      "attention-utilisation",
      utilisation.slice(0, 5).map((x) => ({ name: x.name, value: fmtPct(x.pct) }))
    );
  }

  // ---- map ------------------------------------------------------------

  function headingOf(row) {
    const raw = row.raw || {};
    const angle = Number(raw.Angle);
    return Number.isFinite(angle) ? angle : null;
  }

  function renderMap() {
    if (!map) map = MAP.init("map");
    if (!geofencesDrawn) {
      MAP.addGeofenceCircles(map);
      geofencesDrawn = true;
    }

    for (const [, layer] of trailLayers) map.removeLayer(layer);
    trailLayers = [];
    const showTrails = document.getElementById("trails").checked;
    if (showTrails) {
      for (const [imei, rows] of grouped.entries()) {
        const pts = rows.filter((r) => r.latitude != null).map((r) => [r.latitude, r.longitude]);
        if (pts.length < 2) continue;
        const line = L.polyline(pts, {
          color: getComputedStyle(document.documentElement).getPropertyValue("--baseline").trim(),
          weight: 2,
          opacity: 0.6,
        }).addTo(map);
        trailLayers.push([imei, line]);
      }
    }

    const seen = new Set();
    for (const row of latestRows) {
      seen.add(row.imei_no);
      const state = rowState(row);
      const vehicleType = MAP.vehicleTypeOf(row);
      const icon = MAP.iconFor(state, state === "moving" ? headingOf(row) : null, vehicleType);
      if (row.latitude == null || row.longitude == null) continue;

      const prevState = prevStates.get(row.imei_no);
      let marker = markers.get(row.imei_no);
      let justChangedState = false;
      if (!marker) {
        marker = L.marker([row.latitude, row.longitude], { icon }).addTo(map);
        markers.set(row.imei_no, marker);
      } else {
        MAP.animateMarkerTo(marker, [row.latitude, row.longitude]);
        marker.setIcon(icon);
        justChangedState = prevState != null && prevState !== state;
      }
      prevStates.set(row.imei_no, state);
      if (justChangedState) {
        const el = marker.getElement();
        if (el) {
          el.classList.remove("marker-pulse");
          // Force reflow so re-adding the class restarts the animation even
          // if two state changes land in quick succession.
          void el.offsetWidth;
          el.classList.add("marker-pulse");
        }
      }

      const stateDuration = API.stateDurationFromHistory(grouped.get(row.imei_no) || [], state);
      marker.bindPopup(
        MAP.buildPopup(row, state, {
          link: `vehicle.html?imei=${encodeURIComponent(row.imei_no)}`,
          stateDuration,
          driverName: driverName(row.imei_no),
        })
      );
    }
    for (const [imei, marker] of markers.entries()) {
      if (!seen.has(imei)) {
        map.removeLayer(marker);
        markers.delete(imei);
      }
    }
  }

  // ---- charts -----------------------------------------------------------

  function renderCharts() {
    const series = API.fleetTimeSeries(historyRows);
    CHART.lineChart(
      document.getElementById("chart-moving"),
      series.map((s) => ({ x: s.t, y: s.movingCount })),
      { valueLabel: (v) => String(Math.round(v)), tipTitle: "Moving" }
    );
    CHART.lineChart(
      document.getElementById("chart-speed"),
      series.map((s) => ({ x: s.t, y: s.avgSpeed })),
      { valueLabel: (v) => `${Math.round(v)} km/h`, tipTitle: "Avg speed", color: "var(--state-idle)" }
    );

    const byVehicle = new Map(latestRows.map((r) => [r.imei_no, r.vehicle_no || r.imei_no]));
    const distanceData = [...metrics.entries()]
      .filter(([, m]) => m.distanceKm > 0)
      .map(([imei, m]) => ({ label: byVehicle.get(imei) || imei, value: m.distanceKm, sub: driverName(imei) }));
    CHART.barChart(document.getElementById("chart-distance"), distanceData, {
      valueLabel: (v) => v.toFixed(1),
      tipUnit: "km",
    });
  }

  // ---- table --------------------------------------------------------

  function tableRows() {
    return latestRows.map((row) => {
      const state = rowState(row);
      const m = metrics.get(row.imei_no) || { distanceKm: 0 };
      return {
        imei: row.imei_no,
        vehicle_no: row.vehicle_no || row.imei_no,
        driver: driverName(row.imei_no) || "—",
        state,
        speed: row.speed || 0,
        distance: m.distanceKm,
        ageSec: API.ageSeconds(row.device_datetime),
        location: row.location ? API.shortLocation(row.location) : "—",
      };
    });
  }

  function sortRows(rows) {
    const { key, dir } = sortState;
    return [...rows].sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (key === "ageSec") {
        av = av == null ? Infinity : av;
        bv = bv == null ? Infinity : bv;
      }
      if (typeof av === "string") return dir * av.localeCompare(bv);
      return dir * ((av ?? 0) - (bv ?? 0));
    });
  }

  function renderTable() {
    const tbody = document.getElementById("tbody");
    const rows = sortRows(tableRows());
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No vehicles reporting.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement("tr");

      const vehTd = document.createElement("td");
      const link = document.createElement("a");
      link.href = `vehicle.html?imei=${encodeURIComponent(r.imei)}`;
      link.textContent = r.vehicle_no;
      vehTd.appendChild(link);

      const driverTd = document.createElement("td");
      driverTd.textContent = r.driver;

      const stateTd = document.createElement("td");
      const stateSpan = document.createElement("span");
      stateSpan.className = `state state-${r.state}`;
      stateSpan.textContent = MAP.STATE_LABEL[r.state];
      stateTd.appendChild(stateSpan);

      const speedTd = document.createElement("td");
      speedTd.className = "num";
      speedTd.textContent = r.state === "moving" ? fmtSpeed(r.speed) : "—";

      const distTd = document.createElement("td");
      distTd.className = "num";
      distTd.textContent = r.distance > 0 ? fmtKm(r.distance) : "—";

      const ageTd = document.createElement("td");
      ageTd.className = "num";
      ageTd.textContent = fmtAge(r.ageSec);

      const locTd = document.createElement("td");
      locTd.className = "location";
      locTd.textContent = r.location;

      tr.append(vehTd, driverTd, stateTd, speedTd, distTd, ageTd, locTd);
      tbody.appendChild(tr);
    }
  }

  function initTableSort() {
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortState.key === key) {
          sortState.dir *= -1;
        } else {
          sortState = { key, dir: 1 };
        }
        document.querySelectorAll("th[data-sort]").forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", sortState.dir === 1 ? "ascending" : "descending");
        renderTable();
      });
    });
  }

  // ---- orchestration --------------------------------------------------

  function renderAll() {
    renderKpis();
    renderAttention();
    renderMap();
    renderCharts();
    renderTable();
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    const root = document.body;
    root.classList.add("is-refreshing");
    LOADING.start();
    const statusEl = document.getElementById("status");
    try {
      await loadAll();
      renderAll();
      statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      statusEl.classList.remove("is-error");
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Refresh failed: ${err.message || err}`;
      statusEl.classList.add("is-error");
    } finally {
      root.classList.remove("is-refreshing");
      LOADING.stop();
      loading = false;
    }
  }

  function start() {
    document.getElementById("sign-out").hidden = false;
    document.getElementById("sign-out").addEventListener("click", () => AUTH.signOut());
    document.getElementById("window").addEventListener("change", refresh);
    document.getElementById("trails").addEventListener("change", renderMap);
    initTableSort();
    // Pauses while the tab is hidden instead of polling forever in the
    // background - see loading.js's pollWhileVisible() for why.
    LOADING.pollWhileVisible(refresh, CONFIG.REFRESH_MS);
    window.addEventListener("resize", () => {
      if (latestRows.length) renderCharts();
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
