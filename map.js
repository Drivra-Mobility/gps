// Leaflet map helpers shared by the fleet map and the per-vehicle trail map.
// Marker SHAPE differs per state (arrow / rounded-square / circle / hollow
// circle), not just color - so identity survives colorblindness, greyscale
// printing, and the "offline" case where the state color is muted enough
// that color alone wouldn't read anyway.
const MAP = (() => {
  const STATE_LABEL = {
    moving: "Moving",
    maintenance: "In maintenance",
    parked: "In parking",
    idle: "Idle",
    offline: "Offline",
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function init(elementId, opts = {}) {
    const map = L.map(elementId, { scrollWheelZoom: true }).setView(
      [CONFIG.PARK_CENTER.lat, CONFIG.PARK_CENTER.lon],
      opts.zoom || 12
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    return map;
  }

  // Draws the two geofences as visible circles - dashed outline, light
  // fill, tinted to match each state's color - so "parked"/"maintenance"
  // aren't just invisible math, they're something you can see on the map.
  // Call once per map, right after init().
  function addGeofenceCircles(map) {
    L.circle([CONFIG.PARK_CENTER.lat, CONFIG.PARK_CENTER.lon], {
      radius: CONFIG.PARK_RADIUS_M,
      color: cssVar("--state-parked"),
      weight: 1.5,
      dashArray: "4 3",
      fillOpacity: 0.06,
      interactive: false,
    })
      .addTo(map)
      .bindTooltip("Parking geofence");
    L.circle([CONFIG.MAINTENANCE_CENTER.lat, CONFIG.MAINTENANCE_CENTER.lon], {
      radius: CONFIG.MAINTENANCE_RADIUS_M,
      color: cssVar("--state-maintenance"),
      weight: 1.5,
      dashArray: "4 3",
      fillOpacity: 0.06,
      interactive: false,
    })
      .addTo(map)
      .bindTooltip("Maintenance geofence");
  }

  // Smoothly interpolates a marker to a new position over `ms` milliseconds
  // instead of jumping there, so a refresh reads as movement rather than a
  // blink. No plugin - a small requestAnimationFrame tween is enough at
  // this data rate (one marker move per vehicle per refresh).
  function animateMarkerTo(marker, latlng, ms = 800) {
    const start = marker.getLatLng();
    const end = L.latLng(latlng);
    if (start.equals(end)) return;
    const t0 = performance.now();
    function ease(p) {
      return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    }
    function tick(now) {
      const p = Math.min(1, (now - t0) / ms);
      const e = ease(p);
      marker.setLatLng([start.lat + (end.lat - start.lat) * e, start.lng + (end.lng - start.lng) * e]);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Cosmetic-only vehicle-type classification for marker glyphs, driven by
  // CONFIG.VEHICLE_TYPE_RULES (see config.js for why this can't come from
  // the data itself). Returns a type string or null if nothing matched.
  function vehicleTypeOf(row) {
    const haystack = `${row.vehicle_no || ""} ${row.vehicle_name || ""}`;
    for (const rule of CONFIG.VEHICLE_TYPE_RULES || []) {
      if (rule.pattern.test(haystack)) return rule.type;
    }
    return null;
  }

  // Unrotated, 24x24-centered silhouettes for known vehicle types, filled
  // with `color` (the state color) via currentColor. Only used for
  // stationary states - a moving vehicle keeps the heading arrow, since
  // direction of travel matters more than silhouette while it's en route.
  function typeGlyph(type, color) {
    if (type === "bike") {
      return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="7" cy="17" r="3.2"/>
        <circle cx="17" cy="17" r="3.2"/>
        <path d="M7 17 L11 9 L15 9 M11 9 L14 17 M17 17 L14.5 12"/>
      </g>`;
    }
    if (type === "truck") {
      return `<g fill="${color}">
        <rect x="3" y="9" width="11" height="8" rx="1"/>
        <path d="M14 12h4l2.5 3v2H14z" opacity="0.7"/>
        <circle cx="7.5" cy="19" r="2" />
        <circle cx="17.5" cy="19" r="2" />
      </g>`;
    }
    return null;
  }

  // headingDeg: only meaningful for "moving" (arrow shape); ignored otherwise.
  // vehicleType: from vehicleTypeOf() - swaps the plain state shape for a
  // type silhouette (still colored by state) when known and not moving.
  function iconFor(state, headingDeg, vehicleType) {
    const color = cssVar(`--state-${state}`);
    const size = 24;
    let shape;
    if (state === "moving") {
      const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
      shape = `<g transform="rotate(${rot} 12 12)"><path d="M12 3 L19 19 L12 15 L5 19 Z" fill="${color}"/></g>`;
    } else if (vehicleType && typeGlyph(vehicleType, color)) {
      shape = typeGlyph(vehicleType, color);
    } else if (state === "maintenance") {
      shape = `<rect x="7" y="7" width="10" height="10" rx="2" transform="rotate(45 12 12)" fill="${color}"/>`;
    } else if (state === "parked") {
      shape = `<rect x="6" y="6" width="12" height="12" rx="3" fill="${color}"/>`;
    } else if (state === "idle") {
      shape = `<circle cx="12" cy="12" r="7" fill="${color}"/>`;
    } else {
      shape = `<circle cx="12" cy="12" r="7" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 2"/>`;
    }
    const html = `<span class="marker"><svg width="${size}" height="${size}" viewBox="0 0 24 24">${shape}</svg></span>`;
    return L.divIcon({ html, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function fmtDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // Returns a detached DOM element (never an HTML string) so popup content
  // built from table data can only ever land as text, never markup.
  //
  // opts.stateDuration, if provided ({ seconds, sinceStart }), comes from
  // API.stateDurationFromHistory() run against whatever history window the
  // caller already has loaded - no extra query for this. sinceStart means
  // the streak runs to the edge of that window, so the true duration may be
  // longer than reported ("at least", not exact). opts.driverName, if
  // provided, is the vehicle's current mapped driver (see
  // API.currentDriverByImei()) - shown first, above State.
  function buildPopup(row, state, opts = {}) {
    const box = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = row.vehicle_no || row.vehicle_name || "Vehicle";
    box.appendChild(title);

    const rows = [];
    if (opts.driverName) rows.push(["Driver", opts.driverName]);
    rows.push(["State", STATE_LABEL[state] || state]);
    if (opts.stateDuration && opts.stateDuration.seconds > 0) {
      const prefix = opts.stateDuration.sinceStart ? "at least " : "";
      rows.push(["Time in state", `${prefix}${fmtDuration(opts.stateDuration.seconds)}`]);
    }
    rows.push(
      ["Speed", `${Math.round(row.speed || 0)} km/h`],
      ["Ignition", row.ignition || "—"],
      ["Last report", row.device_datetime ? new Date(row.device_datetime).toLocaleString() : "—"]
    );
    if (row.location) rows.push(["Location", API.shortLocation(row.location)]);

    for (const [k, v] of rows) {
      const line = document.createElement("div");
      line.className = "popup-row";
      const kEl = document.createElement("span");
      kEl.textContent = k;
      const vEl = document.createElement("span");
      vEl.textContent = v;
      line.append(kEl, vEl);
      box.appendChild(line);
    }
    if (opts.link) {
      const a = document.createElement("a");
      a.href = opts.link;
      a.textContent = "View vehicle details →";
      a.style.display = "inline-block";
      a.style.marginTop = "8px";
      box.appendChild(a);
    }
    return box;
  }

  return {
    init,
    addGeofenceCircles,
    animateMarkerTo,
    vehicleTypeOf,
    iconFor,
    buildPopup,
    STATE_LABEL,
  };
})();
