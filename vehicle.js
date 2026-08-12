// Per-vehicle detail page controller. Reads ?imei=<imei_no> from the URL -
// every link into this page (map popups, table rows on the fleet page)
// passes that parameter.
(function () {
  "use strict";

  const MAX_TABLE_ROWS = 500;
  const imei = new URLSearchParams(location.search).get("imei");

  let rows = [];
  let map;
  let marker;
  let trailLine;
  let loading = false;
  let geofencesDrawn = false;

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
  function compassLabel(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(deg / 45) % 8];
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

  async function loadAll() {
    const hours = Number(document.getElementById("window").value);
    rows = await API.fetchVehicleHistory(imei, hours);
  }

  function renderHeader(latest) {
    document.getElementById("veh-title").textContent = latest.vehicle_no || latest.vehicle_name || imei;
    const bits = [latest.company, latest.branch, latest.device_model, `IMEI ${latest.imei_no}`].filter(
      Boolean
    );
    document.getElementById("veh-sub").textContent = bits.join(" · ");
    document.title = `${latest.vehicle_no || imei} — Fleet dashboard`;
  }

  function renderKpis(latest, m, state) {
    const stateEl = document.getElementById("kpi-state");
    stateEl.innerHTML = "";
    const span = document.createElement("span");
    span.className = `state state-${state}`;
    span.textContent = MAP.STATE_LABEL[state];
    stateEl.appendChild(span);
    document.getElementById("kpi-state-note").textContent = latest.status
      ? `device status: ${latest.status}`
      : "—";

    document.getElementById("kpi-speed").textContent =
      state === "moving" ? fmtSpeed(latest.speed || 0) : "0 km/h";

    const angle = Number((latest.raw || {}).Angle);
    document.getElementById("kpi-heading").textContent = Number.isFinite(angle)
      ? `${Math.round(angle)}° ${compassLabel(angle)}`
      : "—";

    document.getElementById("kpi-gps").textContent = latest.gps || "—";
    document.getElementById("kpi-gps-note").textContent = latest.satellite_count
      ? `${latest.satellite_count} satellites`
      : "satellites";

    document.getElementById("kpi-distance").textContent = fmtKm(m.distanceKm);
    document.getElementById("kpi-avgspeed").textContent = m.avgSpeedKmh ? fmtSpeed(m.avgSpeedKmh) : "—";
    document.getElementById("kpi-maxspeed").textContent = m.maxSpeedKmh ? fmtSpeed(m.maxSpeedKmh) : "—";
    document.getElementById("kpi-movingpct").textContent = fmtPct(m.movingPct);

    const ageSec = API.ageSeconds(latest.device_datetime);
    const freshEl = document.getElementById("freshness");
    freshEl.textContent = `last report: ${fmtAge(ageSec)}`;
    freshEl.classList.toggle("is-stale", ageSec != null && ageSec > CONFIG.STALE_MINUTES * 60);
  }

  function renderMap(latest, state) {
    if (!map) map = MAP.init("map", { zoom: 14 });
    if (!geofencesDrawn) {
      MAP.addGeofenceCircles(map);
      geofencesDrawn = true;
    }
    const pts = rows.filter((r) => r.latitude != null).map((r) => [r.latitude, r.longitude]);

    if (trailLine) map.removeLayer(trailLine);
    if (pts.length > 1) {
      trailLine = L.polyline(pts, {
        color: getComputedStyle(document.documentElement).getPropertyValue("--baseline").trim(),
        weight: 2,
        opacity: 0.7,
      }).addTo(map);
      map.fitBounds(trailLine.getBounds(), { padding: [24, 24] });
    } else if (pts.length === 1) {
      map.setView(pts[0], 14);
    }

    if (latest.latitude == null) return;
    const angle = Number((latest.raw || {}).Angle);
    const vehicleType = MAP.vehicleTypeOf(latest);
    const icon = MAP.iconFor(state, state === "moving" && Number.isFinite(angle) ? angle : null, vehicleType);
    if (!marker) {
      marker = L.marker([latest.latitude, latest.longitude], { icon }).addTo(map);
    } else {
      MAP.animateMarkerTo(marker, [latest.latitude, latest.longitude]);
      marker.setIcon(icon);
    }
    const stateDuration = API.stateDurationFromHistory(rows, state);
    marker.bindPopup(MAP.buildPopup(latest, state, { stateDuration }));
  }

  function renderChart() {
    const series = rows
      .filter((r) => r.polled_at)
      .map((r) => ({ x: new Date(r.polled_at), y: r.speed || 0 }));
    CHART.lineChart(document.getElementById("chart-speed"), series, {
      valueLabel: (v) => `${Math.round(v)} km/h`,
      tipTitle: "Speed",
    });
  }

  // Only surfaces raw fields that are actually populated for this device -
  // most of the Trakzee payload is "--"/""/unset for this fleet's hardware.
  function renderExtra(latest) {
    const raw = latest.raw || {};
    const card = document.getElementById("extra-card");
    const grid = document.getElementById("extra-grid");
    grid.innerHTML = "";

    const entries = [];
    const volt = Number(raw.ExternalVolt);
    if (Number.isFinite(volt)) entries.push(["External power", `${volt.toFixed(1)} V`]);
    const batt = Number(raw.battery_percentage);
    if (Number.isFinite(batt) && batt > 0) entries.push(["Battery", `${batt}%`]);
    if (latest.satellite_count != null) entries.push(["Satellites", String(latest.satellite_count)]);
    if (raw.Power && raw.Power !== "--") entries.push(["External power state", raw.Power]);
    if (latest.ignition) entries.push(["Ignition", latest.ignition]);

    if (!entries.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    for (const [label, value] of entries) {
      const item = document.createElement("div");
      item.className = "extra-item";
      const l = document.createElement("div");
      l.className = "extra-label";
      l.textContent = label;
      const v = document.createElement("div");
      v.className = "extra-value";
      v.textContent = value;
      item.append(l, v);
      grid.appendChild(item);
    }
  }

  function renderTable() {
    const tbody = document.getElementById("tbody");
    const subEl = document.getElementById("history-sub");
    tbody.innerHTML = "";
    const ordered = [...rows].reverse(); // most recent first
    const shown = ordered.slice(0, MAX_TABLE_ROWS);
    subEl.textContent =
      ordered.length > MAX_TABLE_ROWS
        ? `showing the most recent ${MAX_TABLE_ROWS} of ${ordered.length} polls`
        : `${ordered.length} poll${ordered.length === 1 ? "" : "s"} in this window`;

    if (!shown.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No readings in this window.</td></tr>';
      return;
    }
    for (let i = 0; i < shown.length; i++) {
      const r = shown[i];
      const prev = ordered[i + 1]; // chronologically before r, since list is reversed
      const hopM = prev ? GEO.distanceMeters(prev.latitude, prev.longitude, r.latitude, r.longitude) : 0;

      const tr = document.createElement("tr");
      const tTd = document.createElement("td");
      tTd.textContent = r.polled_at ? new Date(r.polled_at).toLocaleString() : "—";
      const sTd = document.createElement("td");
      sTd.textContent = r.status || "—";
      const spTd = document.createElement("td");
      spTd.className = "num";
      spTd.textContent = `${Math.round(r.speed || 0)} km/h`;
      const hopTd = document.createElement("td");
      hopTd.className = "num";
      hopTd.textContent = hopM > 0 ? `${Math.round(hopM)} m` : "—";
      const locTd = document.createElement("td");
      locTd.className = "location";
      locTd.textContent = r.location || "—";

      tr.append(tTd, sTd, spTd, hopTd, locTd);
      tbody.appendChild(tr);
    }
  }

  function renderAll() {
    if (!rows.length) {
      document.getElementById("not-found").hidden = false;
      document.getElementById("veh-content").hidden = true;
      return;
    }
    document.getElementById("not-found").hidden = true;
    document.getElementById("veh-content").hidden = false;
    const latest = rows[rows.length - 1];
    const state = API.classify(latest);
    const m = API.vehicleMetrics(rows);
    renderHeader(latest);
    renderKpis(latest, m, state);
    renderMap(latest, state);
    renderChart();
    renderExtra(latest);
    renderTable();
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
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
      document.body.classList.remove("is-refreshing");
      loading = false;
    }
  }

  function start() {
    if (!imei) {
      document.getElementById("not-found").hidden = false;
      document.getElementById("veh-content").hidden = true;
      return;
    }
    document.getElementById("sign-out").hidden = false;
    document.getElementById("sign-out").addEventListener("click", () => AUTH.signOut());
    document.getElementById("window").addEventListener("change", refresh);
    refresh();
    setInterval(refresh, CONFIG.REFRESH_MS);
    window.addEventListener("resize", () => {
      if (rows.length) renderChart();
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
