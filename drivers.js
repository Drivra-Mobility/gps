// Drivers page controller: vehicle<->phone mapping form only. See misuse.js
// for the Yango ride-corroboration review built on top of this mapping.
// No live polling - loads once on open, since the underlying data changes
// on the timescale of minutes-to-days, not seconds.
(function () {
  "use strict";

  let latestRows = []; // from fetchLatest() - the vehicle roster
  let mappings = []; // full history, all vehicles
  let suggestions = new Map(); // imei_no -> suggest_vehicle_driver_matches() row, unmapped vehicles only
  let attributesByImei = new Map(); // imei_no -> vehicle_attributes row, if registered
  let editingImei = null; // which mapping row is currently being edited, if any
  let expandedHistoryImei = null; // which vehicle's history is expanded, if any
  let editingAttrsImei = null; // which vehicle-attributes row is currently being edited, if any
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

  // Mirrors app.js's fmtAge() - same "Xm/Xh/Xd ago" convention as the main
  // fleet table, paired with API.ageSeconds(device_datetime). Duplicated
  // rather than imported, same reasoning as normalisePhone() above: this
  // page has zero dependency on any other page's JS by design.
  function fmtAge(sec) {
    if (sec == null) return "never";
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
    return `${Math.floor(sec / 86400)}d ago`;
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
    const [latest, mappingRows, suggestionRows, attributeRows] = await Promise.all([
      API.fetchLatest(),
      API.fetchVehicleDriverMappings(),
      API.suggestVehicleDriverMatches(),
      API.fetchVehicleAttributes(),
    ]);
    latestRows = latest;
    mappings = mappingRows;
    suggestions = new Map(suggestionRows.map((s) => [s.imei_no, s]));
    attributesByImei = API.vehicleAttributesByImei(attributeRows);
  }

  // ---- mapping table --------------------------------------------------

  function renderMappingTable() {
    const tbody = document.getElementById("mapping-tbody");
    tbody.innerHTML = "";
    if (!latestRows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No vehicles reporting.</td></tr>';
      return;
    }
    const current = API.currentDriverByImei(mappings);

    for (const row of latestRows) {
      const imei = row.imei_no;
      const label = row.vehicle_no || imei;
      const mapping = current.get(imei);

      const suggestion = suggestions.get(imei);

      if (editingImei === imei) {
        tbody.appendChild(buildEditingRow(imei, label, mapping, suggestion, row));
        continue;
      }

      const tr = document.createElement("tr");
      const vehTd = document.createElement("td");
      vehTd.textContent = label;
      const imeiTd = document.createElement("td");
      imeiTd.textContent = imei;
      const lastHeardTd = document.createElement("td");
      lastHeardTd.textContent = fmtAge(API.ageSeconds(row.device_datetime));
      const nameTd = document.createElement("td");
      const phoneTd = document.createElement("td");
      if (mapping) {
        nameTd.textContent = mapping.driver_name || "—";
        phoneTd.textContent = mapping.driver_phone;
      } else if (suggestion) {
        // Plate-matched against Yango's roster, not yet confirmed -- see
        // suggest_vehicle_driver_matches() in schema.sql. Shown as a hint,
        // not filled into the table like a real mapping, since nobody has
        // clicked Save yet.
        const suggestedName =
          [suggestion.suggested_first_name, suggestion.suggested_last_name].filter(Boolean).join(" ") || "—";
        const nameHint = document.createElement("p");
        nameHint.className = "hint";
        nameHint.textContent = `Suggested: ${suggestedName}`;
        nameTd.appendChild(nameHint);
        const phoneHint = document.createElement("p");
        phoneHint.className = "hint";
        phoneHint.textContent = suggestion.suggested_driver_phone;
        phoneTd.appendChild(phoneHint);
      } else {
        nameTd.textContent = "—";
        phoneTd.textContent = "—";
      }
      const sinceTd = document.createElement("td");
      sinceTd.textContent = mapping ? fmtDate(mapping.valid_from) : "—";
      const actionsTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-quiet";
      editBtn.type = "button";
      editBtn.textContent = mapping ? "Edit" : suggestion ? "Review suggestion" : "Assign";
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
      tr.append(vehTd, imeiTd, lastHeardTd, nameTd, phoneTd, sinceTd, actionsTd);
      tbody.appendChild(tr);

      if (expandedHistoryImei === imei && history.length > 1) {
        tbody.appendChild(buildHistoryRow(history));
      }
    }
  }

  function buildHistoryRow(history) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
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

  function buildEditingRow(imei, label, mapping, suggestion, row) {
    const tr = document.createElement("tr");
    tr.className = "mapping-row-editing";

    const vehTd = document.createElement("td");
    vehTd.textContent = label;
    const imeiTd = document.createElement("td");
    imeiTd.textContent = imei;
    const lastHeardTd = document.createElement("td");
    lastHeardTd.textContent = fmtAge(API.ageSeconds(row?.device_datetime));

    // A suggestion only ever pre-fills an UNMAPPED vehicle's form -- once
    // `mapping` exists, editing it is a real reassignment and must start
    // from what's actually saved, never from a plate-match guess.
    const prefillName = mapping
      ? mapping.driver_name || ""
      : suggestion
        ? [suggestion.suggested_first_name, suggestion.suggested_last_name].filter(Boolean).join(" ")
        : "";
    const prefillPhone = mapping ? mapping.driver_phone : suggestion ? suggestion.suggested_driver_phone : "";

    const nameTd = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Driver name";
    nameInput.value = prefillName;
    nameTd.appendChild(nameInput);

    const phoneTd = document.createElement("td");
    const phoneInput = document.createElement("input");
    phoneInput.type = "tel";
    phoneInput.placeholder = "+977XXXXXXXXXX";
    phoneInput.value = prefillPhone;
    const phoneError = document.createElement("p");
    phoneError.className = "field-error";
    phoneError.hidden = true;
    phoneTd.append(phoneInput, phoneError);
    if (!mapping && suggestion) {
      const suggestHint = document.createElement("p");
      suggestHint.className = "hint";
      suggestHint.textContent = suggestion.already_mapped_elsewhere
        ? `Plate matches this driver's Yango vehicle (${suggestion.suggested_vehicle_number}), but they're already assigned to another vehicle here — check before saving.`
        : `Pre-filled: plate matches this driver's Yango vehicle (${suggestion.suggested_vehicle_number}). Verify before saving.`;
      phoneTd.appendChild(suggestHint);
    }

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

    tr.append(vehTd, imeiTd, lastHeardTd, nameTd, phoneTd, sinceTd, actionsTd);
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
      renderAttributesTable();
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

  // ---- vehicle type & fuel table ----------------------------------------
  // Simpler than the mapping table above: one row per vehicle, no history
  // and no suggestion pre-fill (neither GPS provider reports fuel type, so
  // there's nothing to suggest it from) - just a plain upsert.

  const FUEL_TYPES = ["electric", "petrol"];

  function renderAttributesTable() {
    const tbody = document.getElementById("attributes-tbody");
    tbody.innerHTML = "";
    if (!latestRows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No vehicles reporting.</td></tr>';
      return;
    }
    for (const row of latestRows) {
      const imei = row.imei_no;
      const label = row.vehicle_no || imei;
      const attrs = attributesByImei.get(imei);

      if (editingAttrsImei === imei) {
        tbody.appendChild(buildAttributesEditingRow(imei, label, row, attrs));
        continue;
      }

      const tr = document.createElement("tr");
      const vehTd = document.createElement("td");
      vehTd.textContent = label;
      const imeiTd = document.createElement("td");
      imeiTd.textContent = imei;
      const typeTd = document.createElement("td");
      typeTd.textContent = (attrs && attrs.vehicle_type) || "—";
      const fuelTd = document.createElement("td");
      fuelTd.textContent = (attrs && attrs.fuel_type) || "—";
      const noteTd = document.createElement("td");
      noteTd.textContent = (attrs && attrs.note) || "—";
      const actionsTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-quiet";
      editBtn.type = "button";
      editBtn.textContent = attrs ? "Edit" : "Register";
      editBtn.addEventListener("click", () => {
        editingAttrsImei = imei;
        renderAttributesTable();
      });
      actionsTd.appendChild(editBtn);
      tr.append(vehTd, imeiTd, typeTd, fuelTd, noteTd, actionsTd);
      tbody.appendChild(tr);
    }
  }

  function buildAttributesEditingRow(imei, label, row, attrs) {
    const tr = document.createElement("tr");
    tr.className = "mapping-row-editing";

    const vehTd = document.createElement("td");
    vehTd.textContent = label;
    const imeiTd = document.createElement("td");
    imeiTd.textContent = imei;

    const typeTd = document.createElement("td");
    const typeInput = document.createElement("input");
    typeInput.type = "text";
    typeInput.placeholder = "e.g. scooter, bike";
    typeInput.value = (attrs && attrs.vehicle_type) || "";
    typeTd.appendChild(typeInput);

    const fuelTd = document.createElement("td");
    const fuelSelect = document.createElement("select");
    const blankOption = document.createElement("option");
    blankOption.value = "";
    blankOption.textContent = "Select…";
    fuelSelect.appendChild(blankOption);
    for (const ft of FUEL_TYPES) {
      const opt = document.createElement("option");
      opt.value = ft;
      opt.textContent = ft[0].toUpperCase() + ft.slice(1);
      fuelSelect.appendChild(opt);
    }
    fuelSelect.value = (attrs && attrs.fuel_type) || "";
    const fuelError = document.createElement("p");
    fuelError.className = "field-error";
    fuelError.hidden = true;
    fuelTd.append(fuelSelect, fuelError);

    const noteTd = document.createElement("td");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.placeholder = "Note (optional)";
    noteInput.value = (attrs && attrs.note) || "";
    noteTd.appendChild(noteInput);

    const actionsTd = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () =>
      saveAttributes(imei, row.vehicle_no || null, typeInput, fuelSelect, noteInput, fuelError, saveBtn)
    );
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-quiet";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      editingAttrsImei = null;
      renderAttributesTable();
    });
    actionsTd.append(saveBtn, cancelBtn);

    tr.append(vehTd, imeiTd, typeTd, fuelTd, noteTd, actionsTd);
    return tr;
  }

  async function saveAttributes(imei, vehicleNo, typeInput, fuelSelect, noteInput, fuelError, triggerBtn) {
    const fuelType = fuelSelect.value;
    if (!fuelType) {
      fuelError.textContent = "Fuel type is required.";
      fuelError.hidden = false;
      return;
    }
    triggerBtn.disabled = true;
    const original = triggerBtn.textContent;
    triggerBtn.textContent = "Saving…";
    LOADING.start();
    try {
      await API.upsertVehicleAttributes({
        imei,
        vehicleNo,
        vehicleType: typeInput.value.trim() || null,
        fuelType,
        note: noteInput.value.trim() || null,
      });
      editingAttrsImei = null;
      await loadMappings();
      renderMappingTable();
      renderAttributesTable();
    } catch (err) {
      console.error(err);
      fuelError.textContent = err.message || "Save failed.";
      fuelError.hidden = false;
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
      renderAttributesTable();
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
