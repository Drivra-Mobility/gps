// Drivers page controller: vehicle<->phone mapping form only. See misuse.js
// for the Yango ride-corroboration review built on top of this mapping.
// No live polling - loads once on open, since the underlying data changes
// on the timescale of minutes-to-days, not seconds.
(function () {
  "use strict";

  let latestRows = []; // from fetchLatest() - the vehicle roster
  let mappings = []; // full history, all vehicles
  let editingImei = null; // which mapping row is currently being edited, if any
  let expandedHistoryImei = null; // which vehicle's history is expanded, if any
  let loading = false;

  // ---- formatting -------------------------------------------------------

  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: CONFIG.TIMEZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
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

  // ---- mapping table --------------------------------------------------

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
    LOADING.start();
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
    } finally {
      LOADING.stop();
    }
  }

  // ---- orchestration --------------------------------------------------

  async function refresh() {
    if (loading) return;
    loading = true;
    document.body.classList.add("is-refreshing");
    LOADING.start();
    const statusEl = document.getElementById("status");
    try {
      await loadMappings();
      renderMappingTable();
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
    refresh();
  }

  initTheme();
  AUTH.requireAuth(start);
})();
