// Misuse review page controller: Yango ride-corroboration built on top of
// the vehicle<->driver mapping (see drivers.html/drivers.js for the mapping
// form itself - this page only reads it). No live polling - loads once on
// open and whenever the lookback changes, since the underlying data changes
// on the timescale of minutes-to-days, not seconds.
(function () {
  "use strict";

  let mappings = []; // full history, all vehicles - only used for driver name/phone lookups here
  let dayMetrics = []; // vehicle_ride_match_day_metrics rows for the current lookback
  let scores = []; // computeConfidenceScores() output, one per vehicle
  let selectedMisuseImei = null; // which misuse row's detail panel is open, if any
  let lastTimelineRender = null; // { lanes, rangeStart, rangeEnd } - so a resize can redraw without re-fetching
  let misuseMap = null;
  let misuseMapLayers = [];
  let scrubMarker = null;
  let currentHistory = []; // raw position pings for the vehicle currently open in the detail panel
  let loading = false;

  // ---- formatting -------------------------------------------------------

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
  function fmtPct(p) {
    return `${Math.round(p)}%`;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // "var(--x)" -> the resolved colour, for contexts (Leaflet's `color`
  // option) that set an SVG presentation attribute directly rather than a
  // style string, and so can't use a raw CSS custom-property reference the
  // way chart.js's inline SVG can.
  function resolveVar(value) {
    const m = /^var\((--[\w-]+)\)$/.exec(value);
    return m ? cssVar(m[1]) : value;
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

  // ---- data loading -----------------------------------------------------

  async function loadMappings() {
    mappings = await API.fetchVehicleDriverMappings();
  }

  async function loadMisuse() {
    const lookbackDays = Number(document.getElementById("misuse-lookback").value);
    const endDate = kathmanduToday();
    const startDate = kathmanduDateShift(endDate, -(lookbackDays - 1));
    const rows = await API.fetchRideMatchDailyMetrics({ startDate, endDate });
    dayMetrics = rows;
    document.getElementById("misuse-truncation-warning").hidden = rows.length < 1000;
    scores = computeConfidenceScores(rows, endDate);
  }

  // ---- confidence score ---------------------------------------------
  //
  // Transparent, hand-tunable heuristic (same spirit as MAX_PLAUSIBLE_KMH/
  // STUCK_MINUTES elsewhere in config.js) - not a trained model. Splits the
  // lookback into a short "recent" window and a "baseline" (the rest),
  // both from data already fetched (no extra query):
  //   - magnitude: how far the recent unmatched rate is from the vehicle's
  //     OWN baseline rate (falls back to the fleet-wide median baseline
  //     when a vehicle has no evaluable baseline days yet - assuming 0
  //     would make any nonzero recent rate look like an "unprecedented
  //     spike," guaranteeing a false alarm on day one of mapping).
  //   - persistence: recurring across multiple recent days vs. a one-off.
  //   - level: the absolute recent rate - a vehicle steady at 60% unmatched
  //     is concerning even without a jump.
  //   - quality_weight: short/noisy unmatched segments scale the whole
  //     score down rather than being excluded outright.
  //
  // Known blind spot, not modelled here: a device that's simply offline a
  // lot (faulty hardware, poor signal) can also inflate the unmatched rate,
  // since this score has no notion of GPS coverage - only the detail
  // panel's Timeline (raw position pings) can distinguish that from real
  // unexplained movement. See the page intro copy and the Risk tooltip.
  function computeConfidenceScores(rows, endDate) {
    const recentCutoff = kathmanduDateShift(endDate, -(CONFIG.MISUSE_RECENT_WINDOW_DAYS - 1));
    const byVehicle = new Map();
    for (const r of rows) {
      if (!byVehicle.has(r.imei_no)) {
        byVehicle.set(r.imei_no, {
          vehicle_no: r.vehicle_no,
          recent: [],
          baseline: [],
          totalMapped: 0,
          totalRideMatched: 0,
          totalExplained: 0,
          totalUnmatched: 0,
          totalUnmapped: 0,
        });
      }
      const v = byVehicle.get(r.imei_no);
      v.vehicle_no = r.vehicle_no || v.vehicle_no;
      v.totalMapped += r.mapped_moving_seconds || 0;
      v.totalRideMatched += r.ride_matched_seconds || 0;
      v.totalExplained += r.explained_near_base_seconds || 0;
      v.totalUnmatched += r.unmatched_seconds || 0;
      v.totalUnmapped += r.unmapped_moving_seconds || 0;
      if ((r.mapped_moving_seconds || 0) > 0) {
        if (r.local_date >= recentCutoff) v.recent.push(r);
        else v.baseline.push(r);
      }
    }

    const baselineRates = [];
    for (const v of byVehicle.values()) {
      const mapped = v.baseline.reduce((s, r) => s + r.mapped_moving_seconds, 0);
      const unmatched = v.baseline.reduce((s, r) => s + r.unmatched_seconds, 0);
      v.baselineRate = mapped > 0 ? unmatched / mapped : null;
      if (v.baselineRate != null) baselineRates.push(v.baselineRate);
    }
    baselineRates.sort((a, b) => a - b);
    const fleetMedianBaseline = baselineRates.length ? baselineRates[Math.floor(baselineRates.length / 2)] : 0;

    const results = [];
    for (const [imei, v] of byVehicle.entries()) {
      const ridePct = v.totalMapped > 0 ? (100 * v.totalRideMatched) / v.totalMapped : null;
      const base = {
        imei_no: imei,
        vehicle_no: v.vehicle_no,
        rideCorroboratedPct: ridePct,
        totalUnmatched: v.totalUnmatched,
        totalExplained: v.totalExplained,
        totalUnmapped: v.totalUnmapped,
        totalMapped: v.totalMapped,
      };

      const recentMapped = v.recent.reduce((s, r) => s + r.mapped_moving_seconds, 0);
      const recentUnmatched = v.recent.reduce((s, r) => s + r.unmatched_seconds, 0);
      const recentSegCount = v.recent.reduce((s, r) => s + (r.unmatched_segment_count || 0), 0);

      if (v.totalMapped === 0) {
        results.push({ ...base, tier: "unmapped", score: null });
        continue;
      }
      if (recentMapped < CONFIG.MISUSE_MIN_MAPPED_SECONDS_RECENT) {
        results.push({ ...base, tier: "insufficient", score: null });
        continue;
      }

      const recentRate = recentUnmatched / recentMapped;
      const baselineRate = v.baselineRate != null ? v.baselineRate : fleetMedianBaseline;
      const delta = recentRate - baselineRate;
      const magnitude = clamp(delta / CONFIG.MISUSE_MAX_EXPECTED_DELTA, 0, 1) * 100;

      const evaluableDays = v.recent.filter((r) => r.mapped_moving_seconds >= CONFIG.MISUSE_MIN_DAY_MAPPED_SECONDS);
      const flaggedDays = evaluableDays.filter(
        (r) => r.unmatched_seconds / r.mapped_moving_seconds > CONFIG.MISUSE_FLAG_DAY_RATE_THRESHOLD
      );
      const persistence = (evaluableDays.length ? flaggedDays.length / evaluableDays.length : 0) * 100;

      const level = recentRate * 100;

      const avgSegSeconds = recentSegCount > 0 ? recentUnmatched / recentSegCount : 0;
      const qualityWeight = clamp(avgSegSeconds / CONFIG.MISUSE_TARGET_SEGMENT_SECONDS, 0, 1);

      const w = CONFIG.MISUSE_SCORE_WEIGHTS;
      const raw = w.magnitude * magnitude + w.persistence * persistence + w.level * level;
      const score = Math.round(clamp(raw, 0, 100) * qualityWeight);
      const tier = score >= CONFIG.MISUSE_TIER_HIGH ? "high" : score >= CONFIG.MISUSE_TIER_MEDIUM ? "medium" : "low";

      results.push({ ...base, tier, score });
    }

    const tierRank = { high: 0, medium: 1, low: 2, insufficient: 3, unmapped: 4 };
    results.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || (b.score || 0) - (a.score || 0));
    return results;
  }

  // ---- misuse table -----------------------------------------------------

  function riskLabel(row) {
    if (row.tier === "unmapped") return { text: "Unmapped", cls: "risk-unscored" };
    if (row.tier === "insufficient") return { text: "Insufficient data", cls: "risk-unscored" };
    if (row.tier === "high") return { text: `High (${row.score})`, cls: "risk-high" };
    if (row.tier === "medium") return { text: `Medium (${row.score})`, cls: "risk-medium" };
    return { text: `Low (${row.score})`, cls: "risk-low" };
  }

  function renderMisuseTable() {
    const current = API.currentDriverByImei(mappings);
    const tbody = document.getElementById("misuse-tbody");
    tbody.innerHTML = "";
    if (!scores.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No movement data in this range.</td></tr>';
      return;
    }
    for (const row of scores) {
      const tr = document.createElement("tr");
      tr.className = "is-clickable";
      if (row.imei_no === selectedMisuseImei) tr.classList.add("is-selected");
      tr.addEventListener("click", () => selectMisuseRow(row.imei_no));

      const mapping = current.get(row.imei_no);
      const risk = riskLabel(row);

      const vehTd = document.createElement("td");
      vehTd.textContent = row.vehicle_no || row.imei_no;
      const driverTd = document.createElement("td");
      driverTd.textContent = mapping ? mapping.driver_name || mapping.driver_phone : "—";
      const riskTd = document.createElement("td");
      riskTd.className = risk.cls;
      riskTd.textContent = risk.text;
      const pctTd = document.createElement("td");
      pctTd.className = "num";
      pctTd.textContent = row.rideCorroboratedPct == null ? "—" : fmtPct(row.rideCorroboratedPct);
      const unmatchedTd = document.createElement("td");
      unmatchedTd.className = "num";
      unmatchedTd.textContent = fmtHm(row.totalUnmatched);
      const explainedTd = document.createElement("td");
      explainedTd.className = "num";
      explainedTd.textContent = fmtHm(row.totalExplained);
      const unmappedTd = document.createElement("td");
      unmappedTd.className = "num";
      unmappedTd.textContent = fmtHm(row.totalUnmapped);

      tr.append(vehTd, driverTd, riskTd, pctTd, unmatchedTd, explainedTd, unmappedTd);
      tbody.appendChild(tr);
    }
  }

  // ---- evidence: timeline + map -----------------------------------------
  //
  // Classification -> color. Reuses the same tokens the rest of the app
  // already assigns to these ideas (state-moving for "confirmed good",
  // state-parked for "explained", state-idle for "not resolved yet",
  // critical for "flagged") rather than introducing new hues. GPS-offline
  // is deliberately NOT a solid fill here - see CHART.timelineChart's
  // `texture` option - because --state-offline happens to equal
  // --text-muted, and a solid fill in that color reads as just another
  // muted classification rather than "we have no data at all."
  const CLASS_COLOR = {
    ride_matched: "var(--state-moving)",
    explained_near_base: "var(--state-parked)",
    pending: "var(--state-idle)",
    unmatched: "var(--critical)",
    unmapped: "var(--text-muted)",
  };
  const CLASS_LABEL = {
    ride_matched: "Ride matched",
    explained_near_base: "Explained (near base)",
    pending: "Pending",
    unmatched: "Unmatched",
    unmapped: "Unmapped",
  };

  // Any stretch with no reading at all for longer than MAX_GAP_MINUTES
  // (same threshold every other gap-sensitive computation in this app
  // already uses) is a gap - distinct from a genuine unmatched movement
  // segment, since a device that simply wasn't reporting is a different
  // problem (hardware/coverage) than one that was moving with no ride to
  // show for it.
  function computeOfflineGaps(history, rangeStart, rangeEnd) {
    const gaps = [];
    if (!history.length) {
      gaps.push({ start: rangeStart, end: rangeEnd });
      return gaps;
    }
    const threshold = CONFIG.MAX_GAP_MINUTES * 60000;
    const first = new Date(history[0].polled_at);
    if (first.getTime() - rangeStart.getTime() > threshold) gaps.push({ start: rangeStart, end: first });
    for (let i = 1; i < history.length; i++) {
      const prev = new Date(history[i - 1].polled_at);
      const cur = new Date(history[i].polled_at);
      if (cur.getTime() - prev.getTime() > threshold) gaps.push({ start: prev, end: cur });
    }
    const last = new Date(history[history.length - 1].polled_at);
    if (rangeEnd.getTime() - last.getTime() > threshold) gaps.push({ start: last, end: rangeEnd });
    return gaps;
  }

  function renderMisuseTimeline(segments, rides, history, rangeStart, rangeEnd) {
    const svg = document.getElementById("chart-misuse-timeline");

    const gpsSegments = computeOfflineGaps(history, rangeStart, rangeEnd).map((g) => ({
      start: g.start,
      end: g.end,
      label: "GPS offline (no data)",
      texture: true,
    }));
    for (const s of segments) {
      const segEnd = new Date(s.segment_end);
      if (segEnd < rangeStart || segEnd > rangeEnd) continue;
      gpsSegments.push({
        start: new Date(s.segment_start),
        end: segEnd,
        label: CLASS_LABEL[s.classification] || s.classification,
        sub: `${fmtHm(s.duration_seconds)} · ${(s.distance_km || 0).toFixed(1)} km`,
        color: CLASS_COLOR[s.classification] || "var(--text-muted)",
      });
    }

    const rideSegments = rides
      .filter((r) => r.booked_at && r.ended_at)
      .filter((r) => new Date(r.ended_at) >= rangeStart && new Date(r.booked_at) <= rangeEnd)
      .map((r) => ({
        start: new Date(r.booked_at),
        end: new Date(r.ended_at),
        label: "Yango ride",
        sub: r.category || undefined,
        color: "var(--series-revenue)",
      }));

    const lanes = [
      { label: "GPS activity", segments: gpsSegments },
      { label: "Yango rides", segments: rideSegments },
    ];
    lastTimelineRender = { lanes, rangeStart, rangeEnd };
    CHART.timelineChart(svg, lanes, { rangeStart, rangeEnd, onScrub: handleScrub });
  }

  function fmtScrubTime(date) {
    return date.toLocaleString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const SCRUB_DEFAULT_TEXT = "the highlighted dot below follows the exact moment you're pointing at";

  // Called continuously while hovering the timeline (see chart.js's
  // timelineChart onScrub option) - finds the raw position ping closest to
  // the hovered time and moves a marker there, so "when" and "where" read
  // together instead of needing to mentally cross-reference two panels.
  // date is null when the pointer isn't over the plot area at all.
  function handleScrub(date) {
    const readout = document.getElementById("misuse-scrub-readout");
    if (!date || !currentHistory.length || !misuseMap) {
      if (scrubMarker) {
        misuseMap.removeLayer(scrubMarker);
        scrubMarker = null;
      }
      if (readout) readout.textContent = SCRUB_DEFAULT_TEXT;
      return;
    }

    let nearest = null;
    let bestDiffMs = Infinity;
    for (const p of currentHistory) {
      if (p.latitude == null) continue;
      const diffMs = Math.abs(new Date(p.polled_at).getTime() - date.getTime());
      if (diffMs < bestDiffMs) {
        bestDiffMs = diffMs;
        nearest = p;
      }
    }

    // Scrubbing into a GPS-offline gap: there's genuinely no position to
    // show, so say that rather than snapping to a stale, misleadingly
    // precise-looking dot from well outside this moment.
    if (!nearest || bestDiffMs > CONFIG.MAX_GAP_MINUTES * 60000) {
      if (scrubMarker) {
        misuseMap.removeLayer(scrubMarker);
        scrubMarker = null;
      }
      if (readout) readout.textContent = `no GPS data around ${fmtScrubTime(date)}`;
      return;
    }

    const latlng = [nearest.latitude, nearest.longitude];
    if (!scrubMarker) {
      scrubMarker = L.circleMarker(latlng, {
        radius: 8,
        color: cssVar("--critical"),
        weight: 3,
        fillColor: cssVar("--critical"),
        fillOpacity: 0.9,
      }).addTo(misuseMap);
    } else {
      scrubMarker.setLatLng(latlng);
    }
    if (readout) readout.textContent = `showing position at ${fmtScrubTime(new Date(nearest.polled_at))}`;
  }

  // Draws the raw trail (grey, broken at the same gaps the timeline shows -
  // never a straight line across a stretch with no data), then overlays
  // each classified segment's portion of that trail in its timeline color,
  // so "where" complements "when": an unmatched segment that stays right
  // around the yard reads differently than one that goes across town.
  function renderMisuseMap(segments, history, rangeStart) {
    if (!misuseMap) {
      misuseMap = MAP.init("misuse-map", { zoom: 13 });
      MAP.addGeofenceCircles(misuseMap);
    }
    for (const layer of misuseMapLayers) misuseMap.removeLayer(layer);
    misuseMapLayers = [];
    if (scrubMarker) {
      misuseMap.removeLayer(scrubMarker);
      scrubMarker = null;
    }

    const pts = history.filter((r) => r.latitude != null && new Date(r.polled_at) >= rangeStart);
    if (!pts.length) return;

    const thresholdMs = CONFIG.MAX_GAP_MINUTES * 60000;
    const runs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      const gapMs = new Date(pts[i].polled_at) - new Date(pts[i - 1].polled_at);
      if (gapMs > thresholdMs) runs.push([]);
      runs[runs.length - 1].push(pts[i]);
    }
    const baseColor = cssVar("--baseline");
    for (const run of runs) {
      if (run.length < 2) continue;
      const line = L.polyline(
        run.map((p) => [p.latitude, p.longitude]),
        { color: baseColor, weight: 2, opacity: 0.5 }
      ).addTo(misuseMap);
      misuseMapLayers.push(line);
    }

    for (const s of segments) {
      const segStart = new Date(s.segment_start).getTime();
      const segEnd = new Date(s.segment_end).getTime();
      const segPts = pts.filter((p) => {
        const t = new Date(p.polled_at).getTime();
        return t >= segStart && t <= segEnd;
      });
      if (segPts.length < 2) continue;
      const color = resolveVar(CLASS_COLOR[s.classification] || "var(--text-muted)");
      const line = L.polyline(
        segPts.map((p) => [p.latitude, p.longitude]),
        { color, weight: 4, opacity: 0.9 }
      ).addTo(misuseMap);
      line.bindTooltip(CLASS_LABEL[s.classification] || s.classification);
      misuseMapLayers.push(line);
    }

    misuseMap.fitBounds(
      pts.map((p) => [p.latitude, p.longitude]),
      { padding: [24, 24] }
    );
  }

  async function selectMisuseRow(imei) {
    selectedMisuseImei = imei;
    renderMisuseTable();

    const panel = document.getElementById("misuse-detail-panel");
    panel.hidden = false;
    const row = scores.find((s) => s.imei_no === imei);
    document.getElementById("misuse-detail-title").textContent = row.vehicle_no || imei;

    const lookbackDays = Number(document.getElementById("misuse-lookback").value);
    const endDate = kathmanduToday();
    const startDate = kathmanduDateShift(endDate, -(lookbackDays - 1));
    document.getElementById("misuse-detail-sub").textContent = `${startDate} to ${endDate}`;

    const hours = CONFIG.MISUSE_TIMELINE_HOURS;
    const rangeEnd = new Date();
    const rangeStart = new Date(rangeEnd.getTime() - hours * 3600000);
    document.getElementById("misuse-timeline-sub").textContent = `last ${Math.round(hours / 24)} days`;

    LOADING.start();
    let segments = [];
    try {
      segments = await API.fetchVehicleRideSegments({ imei, startDate, endDate });
    } catch (err) {
      console.error(err);
    }

    const current = API.currentDriverByImei(mappings);
    const mapping = current.get(imei);
    let rides = [];
    if (mapping) {
      try {
        rides = await API.fetchDriverRides({ phone: mapping.driver_phone, startDate, endDate });
      } catch (err) {
        console.error(err);
      }
    }

    let history = [];
    try {
      history = await API.fetchVehicleHistory(imei, hours);
    } catch (err) {
      console.error(err);
    } finally {
      LOADING.stop();
    }

    currentHistory = history; // scrub lookups (handleScrub) read this
    renderMisuseMap(segments, history, rangeStart);
    renderMisuseTimeline(segments, rides, history, rangeStart, rangeEnd);
  }

  // ---- orchestration --------------------------------------------------

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
    LOADING.start();
    const statusEl = document.getElementById("status");
    try {
      await Promise.all([loadMappings(), loadMisuse()]);
      renderMisuseTable();
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

  function start() {
    document.getElementById("sign-out").hidden = false;
    document.getElementById("sign-out").addEventListener("click", () => AUTH.signOut());
    document.getElementById("misuse-lookback").addEventListener("change", async () => {
      selectedMisuseImei = null;
      lastTimelineRender = null;
      document.getElementById("misuse-detail-panel").hidden = true;
      LOADING.start();
      try {
        await loadMisuse();
        renderMisuseTable();
      } finally {
        LOADING.stop();
      }
    });
    refresh();
    window.addEventListener("resize", () => {
      if (lastTimelineRender) {
        const { lanes, rangeStart, rangeEnd } = lastTimelineRender;
        CHART.timelineChart(document.getElementById("chart-misuse-timeline"), lanes, { rangeStart, rangeEnd, onScrub: handleScrub });
      }
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
