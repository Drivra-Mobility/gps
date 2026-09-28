// Maintenance page controller with Garow geofence detection (>= 15m dwell)
// and operator confirmation workflow.
(function () {
  "use strict";

  const MAX_TABLE_ROWS = 500;
  const MIN_CANDIDATE_SECONDS = (CONFIG.MAINTENANCE_MIN_CANDIDATE_MINUTES || 15) * 60;

  const DEFAULT_CATEGORIES = [
    "Full Servicing",
    "Battery",
    "Charging",
    "Brake",
    "Tyre",
    "Wheel",
    "Motor",
    "Controller",
    "Main Controller",
    "Electrical",
    "Light / Indicator",
    "Horn",
    "Suspension",
    "Body Damage",
    "Accident",
    "Key / Lock",
    "Display / Meter",
    "Throttle",
    "Stand",
    "MCB",
    "Bearing",
    "Front rotor",
    "Mirror",
    "Unusual Sound",
    "Other",
  ];
  const CATEGORIES_STORAGE_KEY = "drivra_custom_maintenance_categories_v1";

  let ongoingVisits = [];
  let recentVisits = [];
  let verifications = new Map(); // visitKey -> { visit_key, status, issue_type, details, cost, driver_name, updated_at }
  let driverByImei = new Map();
  let allMappings = []; // full history (current + past), for point-in-time driver lookups
  let visitsSortState = { key: "visit_start", dir: -1 };
  let frequencySortState = { key: "visits", dir: -1 };
  let loading = false;

  // ---- Category Management -------------------------------------------

  let apiCategories = [];

  function getStoredCustomCategories() {
    try {
      return JSON.parse(localStorage.getItem(CATEGORIES_STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function getAllCategories() {
    const custom = Array.from(new Set([...getStoredCustomCategories(), ...apiCategories]));
    const set = new Set([...DEFAULT_CATEGORIES, ...custom]);
    for (const ver of verifications.values()) {
      if (ver.issue_type && ver.issue_type !== "Not Maintenance") {
        set.add(ver.issue_type);
      }
    }
    return Array.from(set);
  }

  function renderCategoriesUI(selectedCategory = "") {
    const allCats = getAllCategories();
    const customStored = new Set(getStoredCustomCategories());
    const customCats = new Set([...customStored, ...apiCategories.filter((c) => !DEFAULT_CATEGORIES.includes(c))]);
    const selectEl = document.getElementById("modal-issue-type");
    const chipsEl = document.getElementById("category-chips-list");

    if (selectEl) {
      const currentVal = selectedCategory || selectEl.value;
      selectEl.innerHTML = '<option value="">Select category…</option>';
      for (const cat of allCats) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        if (cat === currentVal) opt.selected = true;
        selectEl.appendChild(opt);
      }
    }

    if (chipsEl) {
      chipsEl.innerHTML = "";
      for (const cat of allCats) {
        const chip = document.createElement("div");
        const isCustom = customCats.has(cat);
        chip.className = `category-chip ${isCustom ? "is-custom" : ""}`;

        const label = document.createElement("span");
        label.textContent = cat;
        chip.appendChild(label);

        if (isCustom) {
          const rmBtn = document.createElement("button");
          rmBtn.className = "category-chip-remove";
          rmBtn.type = "button";
          rmBtn.innerHTML = "&times;";
          rmBtn.title = `Remove custom category "${cat}"`;
          rmBtn.addEventListener("click", async () => {
            rmBtn.disabled = true;
            try {
              const updated = getStoredCustomCategories().filter((c) => c !== cat);
              localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(updated));
              apiCategories = apiCategories.filter((c) => c !== cat);
              await API.deleteMaintenanceCategory(cat).catch(() => {});
              renderCategoriesUI(selectEl ? selectEl.value : "");
            } catch (err) {
              console.error(err);
            }
          });
          chip.appendChild(rmBtn);
        }
        chipsEl.appendChild(chip);
      }
    }
  }

  async function addCategory(rawName, autoSelectInModal = false) {
    const name = (rawName || "").trim();
    if (!name) return null;
    try {
      const stored = getStoredCustomCategories();
      if (!stored.includes(name) && !DEFAULT_CATEGORIES.includes(name)) {
        stored.push(name);
        localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(stored));
      }
      if (!apiCategories.includes(name)) {
        apiCategories.push(name);
      }
      await API.saveMaintenanceCategory(name).catch(() => {});
      renderCategoriesUI(autoSelectInModal ? name : undefined);
      return name;
    } catch (err) {
      console.error("Category add note:", err);
      renderCategoriesUI(autoSelectInModal ? name : undefined);
      return name;
    }
  }

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
    if (h === 0) return `${m}m`;
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

  // Point-in-time driver lookup: attributes visit to whoever drove it at visit time
  function driverAtTime(imei, atIso) {
    if (!atIso) return driverName(imei);
    const t = new Date(atIso).getTime();
    const m = allMappings.find(
      (m) =>
        m.imei_no === imei &&
        new Date(m.valid_from).getTime() <= t &&
        (m.valid_to === null || t < new Date(m.valid_to).getTime())
    );
    return m ? m.driver_name || m.driver_phone : driverName(imei) || "—";
  }

  function getVisitKey(v) {
    return `${v.imei_no}_${v.visit_start}`;
  }

  function getVerification(v) {
    const key = getVisitKey(v);
    return verifications.get(key) || null;
  }

  function getVisitStatus(v) {
    const ver = getVerification(v);
    if (ver) return ver.status; // 'confirmed' or 'rejected'
    return "pending"; // All visits to Garow can be reviewed and confirmed as maintenance
  }

  function getCandidateVisits() {
    // Visits in range that meet >= 15 min dwell and are still pending confirmation
    return recentVisits.filter((v) => {
      const status = getVisitStatus(v);
      return status === "pending";
    });
  }

  function getConfirmedVisits() {
    return recentVisits.filter((v) => {
      const ver = getVerification(v);
      return ver && ver.status === "confirmed";
    });
  }

  function frequencyRows() {
    const byImei = new Map();
    const confirmed = getConfirmedVisits();
    for (const v of confirmed) {
      if (!byImei.has(v.imei_no)) {
        byImei.set(v.imei_no, { vehicle_no: v.vehicle_no, visits: 0, totalSeconds: 0, drivers: new Set() });
      }
      const b = byImei.get(v.imei_no);
      b.visits += 1;
      b.totalSeconds += v.duration_seconds || 0;
      const d = driverAtTime(v.imei_no, v.visit_start);
      if (d && d !== "—") b.drivers.add(d);
    }
    return [...byImei.entries()].map(([imei, b]) => ({
      imei,
      vehicle_no: b.vehicle_no || imei,
      driver: b.drivers.size ? [...b.drivers].join(", ") : "—",
      visits: b.visits,
      totalSeconds: b.totalSeconds,
    }));
  }

  async function loadAll() {
    const startDate = document.getElementById("range-start").value;
    const endDate = document.getElementById("range-end").value || null;
    const [ongoingRaw, recent, mappings, verifMap, fetchedCats] = await Promise.all([
      API.fetchMaintenanceVisits({
        startDate: kathmanduDateShift(kathmanduToday(), -(CONFIG.MAINTENANCE_ONGOING_LOOKBACK_DAYS - 1)),
      }),
      API.fetchMaintenanceVisits({ startDate, endDate }),
      API.fetchVehicleDriverMappings(),
      API.fetchMaintenanceVerifications(),
      API.fetchMaintenanceCategories(),
    ]);
    ongoingVisits = ongoingRaw.filter((v) => v.is_ongoing);
    recentVisits = recent;
    allMappings = mappings;
    driverByImei = API.currentDriverByImei(mappings);
    verifications = verifMap;
    apiCategories = fetchedCats || [];
  }

  function renderKPIs() {
    const candidates = getCandidateVisits();
    const confirmed = getConfirmedVisits();
    const totalConfirmedSeconds = confirmed.reduce((acc, v) => acc + (v.duration_seconds || 0), 0);

    const pendingEl = document.getElementById("kpi-pending");
    const pendingNoteEl = document.getElementById("kpi-pending-note");
    const ongoingEl = document.getElementById("kpi-ongoing");
    const confirmedEl = document.getElementById("kpi-confirmed");
    const totalTimeEl = document.getElementById("kpi-total-time");

    pendingEl.textContent = String(candidates.length);
    if (candidates.length > 0) {
      pendingEl.style.color = "var(--state-maintenance)";
      pendingNoteEl.innerHTML = '<strong style="color:var(--state-maintenance)">Action required</strong>';
    } else {
      pendingEl.style.color = "inherit";
      pendingNoteEl.textContent = "All reviewed";
    }

    ongoingEl.textContent = String(ongoingVisits.length);
    confirmedEl.textContent = String(confirmed.length);
    totalTimeEl.textContent = fmtHm(totalConfirmedSeconds);
  }

  function renderCandidatesTable() {
    const candidates = getCandidateVisits();
    const tbody = document.getElementById("candidates-tbody");
    tbody.innerHTML = "";

    if (!candidates.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">✓ No pending maintenance candidates. All visits &ge; 15m in this range have been reviewed.</td></tr>';
      return;
    }

    for (const v of candidates) {
      const tr = document.createElement("tr");
      const driver = driverAtTime(v.imei_no, v.visit_start);

      const vehTd = document.createElement("td");
      vehTd.innerHTML = `<strong>${v.vehicle_no || v.imei_no}</strong>`;

      const driverTd = document.createElement("td");
      driverTd.textContent = driver;

      const startTd = document.createElement("td");
      startTd.textContent = fmtKathmanduDateTime(v.visit_start);

      const endTd = document.createElement("td");
      endTd.textContent = v.is_ongoing ? "Ongoing" : fmtKathmanduDateTime(v.visit_end);

      const durTd = document.createElement("td");
      durTd.className = "num";
      durTd.textContent = fmtHm(v.duration_seconds);

      const actionsTd = document.createElement("td");
      actionsTd.className = "table-actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "btn btn-primary btn-xs";
      confirmBtn.type = "button";
      confirmBtn.textContent = "Confirm Maintenance";
      confirmBtn.addEventListener("click", () => openConfirmModal(v));

      const rejectBtn = document.createElement("button");
      rejectBtn.className = "btn btn-quiet btn-xs";
      rejectBtn.type = "button";
      rejectBtn.textContent = "Not Maintenance";
      rejectBtn.addEventListener("click", () => markAsNotMaintenance(v, rejectBtn));

      actionsTd.append(confirmBtn, rejectBtn);
      tr.append(vehTd, driverTd, startTd, endTd, durTd, actionsTd);
      tbody.appendChild(tr);
    }
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
    if (key === "driver") return driverAtTime(row.imei_no, row.visit_start);
    if (key === "status") {
      const ver = getVerification(row);
      return ver ? ver.status : "pending";
    }
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

  function renderRecentVisitsTable() {
    const rows = sortRows(recentVisits, visitsSortState, visitsTableValueOf).slice(0, MAX_TABLE_ROWS);
    const tbody = document.getElementById("visits-tbody");
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No Garow workshop visits in this range.</td></tr>';
      return;
    }

    for (const v of rows) {
      const tr = document.createElement("tr");
      const ver = getVerification(v);
      const driver = driverAtTime(v.imei_no, v.visit_start);

      // Vehicle
      const vehTd = document.createElement("td");
      vehTd.innerHTML = `<strong>${v.vehicle_no || v.imei_no}</strong>`;

      // Driver
      const driverTd = document.createElement("td");
      driverTd.textContent = driver;

      // Status / Category badge
      const statusTd = document.createElement("td");
      if (ver && ver.status === "confirmed") {
        statusTd.innerHTML = `<span class="badge badge-confirmed">Confirmed</span> <span class="badge badge-category">${ver.issue_type || "Maintenance"}</span>`;
      } else if (ver && ver.status === "rejected") {
        statusTd.innerHTML = '<span class="badge badge-rejected">Not Maintenance</span>';
      } else {
        statusTd.innerHTML = '<span class="badge badge-pending">Needs Review</span>';
      }

      // Details
      const detailsTd = document.createElement("td");
      detailsTd.className = "location";
      if (ver && ver.status === "confirmed") {
        const parts = [ver.details];
        if (ver.cost) parts.push(`NPR ${Number(ver.cost).toLocaleString()}`);
        detailsTd.textContent = parts.filter(Boolean).join(" · ") || "—";
      } else if (ver && ver.status === "rejected") {
        detailsTd.textContent = "Dismissed by operator";
      } else {
        detailsTd.textContent = "—";
      }

      // Start & End
      const startTd = document.createElement("td");
      startTd.textContent = fmtKathmanduDateTime(v.visit_start);

      const endTd = document.createElement("td");
      endTd.textContent = v.is_ongoing ? "Ongoing" : fmtKathmanduDateTime(v.visit_end);

      // Duration
      const durTd = document.createElement("td");
      durTd.className = "num";
      durTd.textContent = fmtHm(v.duration_seconds);

      // Actions
      const actionsTd = document.createElement("td");
      actionsTd.className = "table-actions";
      if (ver) {
        const editBtn = document.createElement("button");
        editBtn.className = "btn btn-quiet btn-xs";
        editBtn.type = "button";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => openConfirmModal(v, ver));

        const resetBtn = document.createElement("button");
        resetBtn.className = "btn btn-quiet btn-xs";
        resetBtn.type = "button";
        resetBtn.textContent = "Reopen";
        resetBtn.title = "Reset to pending review";
        resetBtn.addEventListener("click", () => resetVerification(v, resetBtn));

        actionsTd.append(editBtn, resetBtn);
      } else {
        const confirmBtn = document.createElement("button");
        confirmBtn.className = "btn btn-primary btn-xs";
        confirmBtn.type = "button";
        confirmBtn.textContent = "Confirm";
        confirmBtn.addEventListener("click", () => openConfirmModal(v));

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "btn btn-quiet btn-xs";
        rejectBtn.type = "button";
        rejectBtn.textContent = "Dismiss";
        rejectBtn.addEventListener("click", () => markAsNotMaintenance(v, rejectBtn));

        actionsTd.append(confirmBtn, rejectBtn);
      }

      tr.append(vehTd, driverTd, statusTd, detailsTd, startTd, endTd, durTd, actionsTd);
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
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No confirmed maintenance visits in this range.</td></tr>';
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

  // ---- Modal & Verification Handlers ------------------------------------

  function openConfirmModal(v, existingVer = null) {
    const modal = document.getElementById("confirm-modal");
    const driver = driverAtTime(v.imei_no, v.visit_start);
    const titleEl = document.getElementById("modal-title");
    const subtitleEl = document.getElementById("modal-subtitle");

    titleEl.textContent = `Confirm Maintenance — ${v.vehicle_no || v.imei_no}`;
    subtitleEl.textContent = `Entry: ${fmtKathmanduDateTime(v.visit_start)} · Dwell: ${fmtHm(v.duration_seconds)} · Driver: ${driver}`;

    document.getElementById("modal-visit-key").value = getVisitKey(v);
    document.getElementById("modal-imei").value = v.imei_no;
    document.getElementById("modal-vehicle-no").value = v.vehicle_no || v.imei_no;
    document.getElementById("modal-start").value = v.visit_start;
    document.getElementById("modal-end").value = v.visit_end || "";
    document.getElementById("modal-duration").value = String(v.duration_seconds || 0);
    document.getElementById("modal-driver").value = driver;

    renderCategoriesUI(existingVer?.issue_type || "");

    document.getElementById("modal-details").value = existingVer?.details || "";
    document.getElementById("modal-cost").value = existingVer?.cost || "";

    modal.hidden = false;
    document.getElementById("modal-issue-type").focus();
  }

  function closeConfirmModal() {
    document.getElementById("confirm-modal").hidden = true;
    document.getElementById("confirm-form").reset();
  }

  async function handleConfirmSubmit(e) {
    e.preventDefault();
    const submitBtn = document.getElementById("modal-submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    LOADING.start();

    const record = {
      visit_key: document.getElementById("modal-visit-key").value,
      imei_no: document.getElementById("modal-imei").value,
      vehicle_no: document.getElementById("modal-vehicle-no").value,
      visit_start: document.getElementById("modal-start").value,
      visit_end: document.getElementById("modal-end").value || null,
      duration_seconds: Number(document.getElementById("modal-duration").value) || 0,
      driver_name: document.getElementById("modal-driver").value,
      status: "confirmed",
      issue_type: document.getElementById("modal-issue-type").value,
      details: document.getElementById("modal-details").value.trim(),
      cost: document.getElementById("modal-cost").value ? Number(document.getElementById("modal-cost").value) : null,
      updated_at: new Date().toISOString(),
    };

    try {
      await API.saveMaintenanceVerification(record);
      verifications.set(record.visit_key, record);
      closeConfirmModal();
      renderAllViews();
    } catch (err) {
      console.error(err);
      alert(`Failed to save maintenance record: ${err.message || err}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Maintenance Record";
      LOADING.stop();
    }
  }

  async function markAsNotMaintenance(v, btn) {
    btn.disabled = true;
    const driver = driverAtTime(v.imei_no, v.visit_start);
    const record = {
      visit_key: getVisitKey(v),
      imei_no: v.imei_no,
      vehicle_no: v.vehicle_no || v.imei_no,
      visit_start: v.visit_start,
      visit_end: v.visit_end || null,
      duration_seconds: v.duration_seconds || 0,
      driver_name: driver,
      status: "rejected",
      issue_type: "Not Maintenance",
      details: "Marked as non-maintenance by operator",
      cost: null,
      updated_at: new Date().toISOString(),
    };

    LOADING.start();
    try {
      await API.saveMaintenanceVerification(record);
      verifications.set(record.visit_key, record);
      renderAllViews();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
    } finally {
      LOADING.stop();
    }
  }

  async function resetVerification(v, btn) {
    btn.disabled = true;
    const key = getVisitKey(v);
    LOADING.start();
    try {
      await API.deleteMaintenanceVerification(key);
      verifications.delete(key);
      renderAllViews();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
    } finally {
      LOADING.stop();
    }
  }

  function renderAllViews() {
    renderKPIs();
    renderCandidatesTable();
    renderRankingChart();
    renderFrequencyTable();
    renderRecentVisitsTable();
    renderCategoriesUI();
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
        renderRecentVisitsTable();
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
      renderAllViews();
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
    const startEl = document.getElementById("range-start");
    const endEl = document.getElementById("range-end");
    startEl.value = start;
    startEl.max = end;
    endEl.value = end;
    endEl.max = end;
  }

  function start() {
    document.getElementById("sign-out").hidden = false;
    document.getElementById("sign-out").addEventListener("click", () => AUTH.signOut());
    initDefaultRange();
    document.getElementById("range-start").addEventListener("change", refresh);
    document.getElementById("range-end").addEventListener("change", refresh);
    initTableSort();

    // Modal listeners
    document.getElementById("modal-close-btn").addEventListener("click", closeConfirmModal);
    document.getElementById("modal-cancel-btn").addEventListener("click", closeConfirmModal);
    document.getElementById("confirm-form").addEventListener("submit", handleConfirmSubmit);
    document.getElementById("confirm-modal").addEventListener("click", (e) => {
      if (e.target.id === "confirm-modal") closeConfirmModal();
    });

    // Category Manager section form at top
    const catForm = document.getElementById("category-add-form");
    if (catForm) {
      catForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("category-name-input");
        const submitBtn = catForm.querySelector('button[type="submit"]');
        if (input && input.value.trim()) {
          const val = input.value.trim();
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Adding…";
          }
          await addCategory(val);
          input.value = "";
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "+ Add Category";
          }
        }
      });
    }

    refresh();
    window.addEventListener("resize", () => {
      if (ongoingVisits.length) renderRankingChart();
    });
  }

  initTheme();
  AUTH.requireAuth(start);
})();
