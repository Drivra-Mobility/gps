// Leaflet map helpers shared by the fleet map and the per-vehicle trail map.
// Marker SHAPE differs per state (arrow / rounded-square / circle / hollow
// circle), not just color - so identity survives colorblindness, greyscale
// printing, and the "offline" case where the state color is muted enough
// that color alone wouldn't read anyway.
const MAP = (() => {
  const STATE_LABEL = { moving: "Moving", parked: "In parking", idle: "Idle", offline: "Offline" };

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

  // headingDeg: only meaningful for "moving" (arrow shape); ignored otherwise.
  function iconFor(state, headingDeg) {
    const color = cssVar(`--state-${state}`);
    const size = 24;
    let shape;
    if (state === "moving") {
      const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
      shape = `<g transform="rotate(${rot} 12 12)"><path d="M12 3 L19 19 L12 15 L5 19 Z" fill="${color}"/></g>`;
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

  // Returns a detached DOM element (never an HTML string) so popup content
  // built from table data can only ever land as text, never markup.
  function buildPopup(row, state, opts = {}) {
    const box = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = row.vehicle_no || row.vehicle_name || "Vehicle";
    box.appendChild(title);

    const rows = [
      ["State", STATE_LABEL[state] || state],
      ["Speed", `${Math.round(row.speed || 0)} km/h`],
      ["Ignition", row.ignition || "—"],
      ["Last report", row.device_datetime ? new Date(row.device_datetime).toLocaleString() : "—"],
    ];
    if (row.location) rows.push(["Location", row.location]);

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

  return { init, iconFor, buildPopup, STATE_LABEL };
})();
