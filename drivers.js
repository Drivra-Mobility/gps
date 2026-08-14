// Drivers page controller: vehicle<->phone mapping form, and the misuse
// review (Yango ride-corroboration) built on top of it. No live polling -
// like analytics.js, this loads once on open and whenever a filter changes,
// since the underlying data changes on the timescale of minutes-to-days,
// not seconds.
(function () {
  "use strict";

  let latestRows = []; // from fetchLatest() - the vehicle roster
  let mappings = []; // full history, all vehicles
  let dayMetrics = []; // vehicle_ride_match_day_metrics rows for the current lookback
  let scores = []; // computeConfidenceScores() output, one per vehicle
  let editingImei = null; // which mapping row is currently being edited, if any
  let expandedHistoryImei = null; // which vehicle's history is expanded, if any
  let selectedMisuseImei = null; // which misuse row's detail panel is open, if any
  let lastTimelineRender = null; // { lanes, rangeStart, rangeEnd } - so a resize can redraw without re-fetching
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
  function fmtKm(km) {
    return `${(km || 0).toFixed(km < 10 ? 1 : 0)} km`;
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Mirrors yapigo's app/core/security.py::normalise_phone() - MUST match,
  // or the join in vehicle_ride_match_day_metrics silently matches
  // nothing. gps_dashboard has zero other dependency on yapigo's codebase
  // by design; this is duplicated rather than imported.
  function normalisePhone(raw) {
    let digits = (raw || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("977") && digits.length > 10) digits = digits.slice(3);
    digits = digits.replace(/^0+/, "");
    return `+977${digits}`;
  }
  function isValidPhone(normalised) {
    return /^\+977\d{8,10}$/.test(normalised);
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

  function historyByImei(imei) {
    return mappings.filter((m) => m.imei_no === imei).sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from));
  }

  async function loadMappings() {
    const [latest, mappingRows] = await Promise.all([API.fetchLatest(), API.fetchVehicleDriverMappings()]);
    latestRows = latest;
    mappings = mappingRows;
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

  // ---- mapping table (section A) -----------------------------------

  function renderMappingTable() {
    const tbody = document.getElementById("mapping-tbody");
    tbody.innerHTML = "";
    if (!latestRows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No vehicles reporting.</td></tr>';
      return;
    }
    const current = API.currentDriverByImei(mappings);

    for (const row of latestRows) {
      const imei = row.imei_no;
      const label = row.vehicle_no || imei;
      const mapping = current.get(imei);

      if (editingImei === imei) {
        tbody.appendChild(buildEditingRow(imei, label, mapping));
        continue;
      }

      const tr = document.createElement("tr");
      const vehTd = document.createElement("td");
      vehTd.textContent = label;
      const nameTd = document.createElement("td");
      nameTd.textContent = mapping ? mapping.driver_name || "—" : "—";
      const phoneTd = document.createElement("td");
      phoneTd.textContent = mapping ? mapping.driver_phone : "—";
      const sinceTd = document.createElement("td");
      sinceTd.textContent = mapping ? fmtDate(mapping.valid_from) : "—";
      const actionsTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-quiet";
      editBtn.type = "button";
      editBtn.textContent = mapping ? "Edit" : "Assign";
      editBtn.addEventListener("click", () => {
        editingImei = imei;
        renderMappingTable();
      });
      actionsTd.appendChild(editBtn);
      const history = historyByImei(imei);
      if (history.length > 1) {
        const histBtn = document.createElement("button");
        histBtn.className = "btn btn-quiet";
        histBtn.type = "button";
        histBtn.textContent = expandedHistoryImei === imei ? "Hide history" : "History";
        histBtn.addEventListener("click", () => {
          expandedHistoryImei = expandedHistoryImei === imei ? null : imei;
          renderMappingTable();
        });
        actionsTd.appendChild(histBtn);
      }
      tr.append(vehTd, nameTd, phoneTd, sinceTd, actionsTd);
      tbody.appendChild(tr);

      if (expandedHistoryImei === imei && history.length > 1) {
        tbody.appendChild(buildHistoryRow(history));
      }
    }
  }

  function buildHistoryRow(history) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    const table = document.createElement("table");
    table.className = "table-nested";
    const tbody = document.createElement("tbody");
    for (const h of history) {
      const row = document.createElement("tr");
      const period = document.createElement("td");
      period.textContent = `${fmtDate(h.valid_from)} – ${h.valid_to ? fmtDate(h.valid_to) : "current"}`;
      const who = document.createElement("td");
      who.textContent = `${h.driver_name || "—"} (${h.driver_phone})`;
      row.append(period, who);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    td.appendChild(table);
    tr.appendChild(td);
    return tr;
  }

  function buildEditingRow(imei, label, mapping) {
    const tr = document.createElement("tr");
    tr.className = "mapping-row-editing";

    const vehTd = document.createElement("td");
    vehTd.textContent = label;

    const nameTd = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Driver name";
    nameInput.value = mapping ? mapping.driver_name || "" : "";
    nameTd.appendChild(nameInput);

    const phoneTd = document.createElement("td");
    const phoneInput = document.createElement("input");
    phoneInput.type = "tel";
    phoneInput.placeholder = "+977XXXXXXXXXX";
    phoneInput.value = mapping ? mapping.driver_phone : "";
    const phoneError = document.createElement("p");
    phoneError.className = "field-error";
    phoneError.hidden = true;
    phoneTd.append(phoneInput, phoneError);

    phoneInput.addEventListener("blur", async () => {
      const normalised = normalisePhone(phoneInput.value);
      if (!phoneInput.value.trim()) {
        phoneError.hidden = true;
        return;
      }
      if (!isValidPhone(normalised)) {
        phoneError.textContent = "Not a valid +977 phone number.";
        phoneError.hidden = false;
        return;
      }
      phoneInput.value = normalised;
      phoneError.hidden = true;
      if (!nameInput.value.trim()) {
        try {
          const driver = await API.lookupDriverByPhone(normalised);
          if (driver) nameInput.value = [driver.first_name, driver.last_name].filter(Boolean).join(" ");
        } catch (err) {
          console.error(err);
        }
      }
    });

    const sinceTd = document.createElement("td");
    sinceTd.textContent = mapping ? fmtDate(mapping.valid_from) : "—";

    const actionsTd = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => saveMapping(imei, phoneInput, nameInput, phoneError, saveBtn));
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-quiet";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      editingImei = null;
      renderMappingTable();
    });
    actionsTd.append(saveBtn, cancelBtn);
    if (mapping) {
      const unassignBtn = document.createElement("button");
      unassignBtn.className = "btn btn-quiet";
      unassignBtn.type = "button";
      unassignBtn.textContent = "Unassign";
      unassignBtn.addEventListener("click", () => saveMapping(imei, { value: "" }, { value: "" }, phoneError, unassignBtn));
      actionsTd.appendChild(unassignBtn);
    }

    tr.append(vehTd, nameTd, phoneTd, sinceTd, actionsTd);
    return tr;
  }

  async function saveMapping(imei, phoneInput, nameInput, phoneError, triggerBtn) {
    const rawPhone = phoneInput.value.trim();
    const phone = rawPhone ? normalisePhone(rawPhone) : "";
    if (rawPhone && !isValidPhone(phone)) {
      phoneError.textContent = "Not a valid +977 phone number.";
      phoneError.hidden = false;
      return;
    }
    triggerBtn.disabled = true;
    const original = triggerBtn.textContent;
    triggerBtn.textContent = "Saving…";
    try {
      await API.setVehicleDriver({
        imei,
        phone: phone || null,
        driverName: nameInput.value.trim() || null,
      });
      editingImei = null;
      await loadMappings();
      renderMappingTable();
    } catch (err) {
      console.error(err);
      phoneError.textContent = err.message || "Save failed.";
      phoneError.hidden = false;
      triggerBtn.disabled = false;
      triggerBtn.textContent = original;
    }
  }

  // ---- misuse review (section B) -------------------------------------

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

  // Classification -> timeline color/label. Reuses the same tokens the rest
  // of the app already assigns to these ideas (state-moving for "confirmed
  // good", state-parked for "explained", state-idle for "not resolved yet",
  // critical for "flagged") rather than introducing new hues.
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

  // Builds the "GPS activity" lane's offline-gap bands from raw position
  // history: any stretch with no reading at all for longer than
  // MAX_GAP_MINUTES (same threshold every other gap-sensitive computation
  // in this app already uses) is drawn as a gap, distinct from a genuine
  // unmatched movement segment - a device that simply wasn't reporting is
  // a different problem than one that was moving with no ride to show for it.
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

  // segments/rides are whatever already loaded for the full lookback -
  // reused here (filtered to the timeline's shorter recent window) rather
  // than re-fetched. Only the raw position history is a new fetch, since
  // that's the one thing neither existing query returns.
  async function renderMisuseTimeline(imei, segments, rides) {
    const svg = document.getElementById("chart-misuse-timeline");
    const hours = CONFIG.MISUSE_TIMELINE_HOURS;
    const rangeEnd = new Date();
    const rangeStart = new Date(rangeEnd.getTime() - hours * 3600000);
    document.getElementById("misuse-timeline-sub").textContent = `last ${Math.round(hours / 24)} days`;

    let history = [];
    try {
      history = await API.fetchVehicleHistory(imei, hours);
    } catch (err) {
      console.error(err);
    }

    const gpsSegments = computeOfflineGaps(history, rangeStart, rangeEnd).map((g) => ({
      start: g.start,
      end: g.end,
      label: "GPS offline",
      color: "var(--state-offline)",
    }));
    for (const s of segments) {
      const segEnd = new Date(s.segment_end);
      if (segEnd < rangeStart || segEnd > rangeEnd) continue;
      gpsSegments.push({
        start: new Date(s.segment_start),
        end: segEnd,
        label: CLASS_LABEL[s.classification] || s.classification,
        sub: `${fmtHm(s.duration_seconds)} · ${fmtKm(s.distance_km)}`,
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
    CHART.timelineChart(svg, lanes, { rangeStart, rangeEnd });
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

    const segTbody = document.getElementById("misuse-segments-tbody");
    segTbody.innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
    const ridesTbody = document.getElementById("misuse-rides-tbody");
    ridesTbody.innerHTML = '<tr><td colspan="3" class="empty">Loading…</td></tr>';

    let segments = [];
    try {
      segments = await API.fetchVehicleRideSegments({ imei, startDate, endDate });
      segTbody.innerHTML = "";
      if (!segments.length) {
        segTbody.innerHTML = '<tr><td colspan="5" class="empty">No movement segments in this range.</td></tr>';
      } else {
        for (const s of segments) {
          const tr = document.createElement("tr");
          const startTd = document.createElement("td");
          startTd.textContent = fmtDateTime(s.segment_start);
          const endTd = document.createElement("td");
          endTd.textContent = fmtDateTime(s.segment_end);
          const durTd = document.createElement("td");
          durTd.className = "num";
          durTd.textContent = fmtHm(s.duration_seconds);
          const distTd = document.createElement("td");
          distTd.className = "num";
          distTd.textContent = fmtKm(s.distance_km);
          const classTd = document.createElement("td");
          classTd.textContent = s.classification.replace(/_/g, " ");
          tr.append(startTd, endTd, durTd, distTd, classTd);
          segTbody.appendChild(tr);
        }
      }
    } catch (err) {
      console.error(err);
      segTbody.innerHTML = `<tr><td colspan="5" class="empty">Failed to load: ${err.message || err}</td></tr>`;
    }

    const current = API.currentDriverByImei(mappings);
    const mapping = current.get(imei);
    let rides = [];
    if (!mapping) {
      ridesTbody.innerHTML = '<tr><td colspan="3" class="empty">Vehicle is unmapped - no driver to look up rides for.</td></tr>';
    } else {
      try {
        rides = await API.fetchDriverRides({ phone: mapping.driver_phone, startDate, endDate });
        ridesTbody.innerHTML = "";
        if (!rides.length) {
          ridesTbody.innerHTML = '<tr><td colspan="3" class="empty">No rides in this range.</td></tr>';
        } else {
          for (const r of rides) {
            const tr = document.createElement("tr");
            const startTd = document.createElement("td");
            startTd.textContent = fmtDateTime(r.booked_at);
            const endTd = document.createElement("td");
            endTd.textContent = fmtDateTime(r.ended_at);
            const catTd = document.createElement("td");
            catTd.textContent = r.category || "—";
            tr.append(startTd, endTd, catTd);
            ridesTbody.appendChild(tr);
          }
        }
      } catch (err) {
        console.error(err);
        ridesTbody.innerHTML = `<tr><td colspan="3" class="empty">Failed to load: ${err.message || err}</td></tr>`;
      }
    }

    try {
      await renderMisuseTimeline(imei, segments, rides);
    } catch (err) {
      console.error(err);
    }
  }

  // ---- orchestration --------------------------------------------------

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
    const statusEl = document.getElementById("status");
    try {
      await Promise.all([loadMappings(), loadMisuse()]);
      renderMappingTable();
      renderMisuseTable();
      statusEl.textContent = `Loaded ${new Date().toLocaleTimeString()}`;
      statusEl.classList.remove("is-error");
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Load failed: ${err.message || err}`;
      statusEl.classList.add("is-error");
    } finally {
      document.body.classList.remove("is-refreshing");
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
      await loadMisuse();
      renderMisuseTable();
    });
    refresh();
    window.addEventListener("resize", () => {
      if (lastTimelineRender) {
        const { lanes, rangeStart, rangeEnd } = lastTimelineRender;
        CHART.timelineChart(document.getElementById("chart-misuse-timeline"), lanes, { rangeStart, rangeEnd });
      }
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
