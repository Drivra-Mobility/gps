// Minimal SVG chart primitives shared by the fleet and per-vehicle pages -
// a single-series line chart (with crosshair + tooltip) and a horizontal bar
// chart (with per-bar hover). No charting library: at this data volume
// (≤ ~200 points, ≤ 25 bars) hand-rolled SVG is less code than wiring one in,
// and it keeps this folder dependency-free per the brief.
//
// Mark specs follow the dataviz skill: 2px lines, ~10% area wash, hairline
// solid gridlines, ≥8px hover dots with a 2px surface ring, bars capped at
// 24px with a rounded data-end, endpoint/tip labels (never one per point).
const CHART = (() => {
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    const norm = v / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  // ---- Line chart -------------------------------------------------------
  // data: [{x: Date, y: number}], sorted ascending by x.
  function lineChart(svg, data, opts) {
    const {
      valueLabel = (v) => String(Math.round(v)),
      tipTitle = "",
      color,
      xLabel = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    } = opts;
    svg.innerHTML = "";
    const rootStyle = getComputedStyle(document.documentElement);
    const seriesColor = color || rootStyle.getPropertyValue("--state-moving").trim();

    const width = svg.clientWidth || 600;
    const height = svg.clientHeight || 260;
    const margin = { top: 16, right: 14, bottom: 26, left: 40 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    if (!data.length) {
      const t = el("text", {
        x: width / 2,
        y: height / 2,
        "text-anchor": "middle",
        class: "axis-label",
      });
      t.textContent = "No data in this window";
      svg.appendChild(t);
      return;
    }

    const xMin = data[0].x.getTime();
    const xMax = data[data.length - 1].x.getTime();
    const xSpan = Math.max(1, xMax - xMin);
    const yMax = niceMax(Math.max(...data.map((d) => d.y), 1));

    const xScale = (t) => margin.left + ((t - xMin) / xSpan) * innerW;
    const yScale = (v) => margin.top + innerH - (v / yMax) * innerH;

    const g = el("g");
    svg.appendChild(g);

    // Gridlines: 4 horizontal steps, hairline, solid, recessive.
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const v = (yMax / ySteps) * i;
      const y = yScale(v);
      g.appendChild(el("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "gridline" }));
      const label = el("text", { x: margin.left - 8, y: y + 4, "text-anchor": "end", class: "axis-label" });
      label.textContent = valueLabel(v);
      g.appendChild(label);
    }
    g.appendChild(
      el("line", {
        x1: margin.left,
        x2: margin.left,
        y1: margin.top,
        y2: margin.top + innerH,
        class: "axis-line",
      })
    );
    g.appendChild(
      el("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: margin.top + innerH,
        y2: margin.top + innerH,
        class: "axis-line",
      })
    );

    // X-axis: first / middle / last timestamp, short form.
    [0, Math.floor(data.length / 2), data.length - 1].forEach((i, idx) => {
      const d = data[i];
      const anchor = idx === 0 ? "start" : idx === 2 ? "end" : "middle";
      const t = el("text", { x: xScale(d.x.getTime()), y: height - 6, "text-anchor": anchor, class: "axis-label" });
      t.textContent = xLabel(d.x);
      g.appendChild(t);
    });

    // Area wash, then the line on top. The line draws in left-to-right on
    // first render (classic stroke-dashoffset trick, SMIL <animate> - no
    // dependency, consistent with this file's hand-rolled-SVG approach) so
    // a chart reads as something that just happened, not a static image.
    const linePoints = data.map((d) => `${xScale(d.x.getTime())},${yScale(d.y)}`).join(" ");
    const areaPoints = `${xScale(xMin)},${yScale(0)} ${linePoints} ${xScale(xMax)},${yScale(0)}`;
    const area = el("polygon", { points: areaPoints, class: "series-area", style: `fill:${seriesColor};opacity:0` });
    g.appendChild(area);
    area.appendChild(el("animate", { attributeName: "opacity", from: "0", to: "1", dur: "0.5s", begin: "0.2s", fill: "freeze" }));
    const line = el("polyline", { points: linePoints, class: "series-line", style: `stroke:${seriesColor}` });
    g.appendChild(line);
    const lineLength = line.getTotalLength ? line.getTotalLength() : 0;
    if (lineLength > 0) {
      line.setAttribute("stroke-dasharray", lineLength);
      line.setAttribute("stroke-dashoffset", lineLength);
      line.appendChild(
        el("animate", {
          attributeName: "stroke-dashoffset",
          from: lineLength,
          to: 0,
          dur: "0.6s",
          fill: "freeze",
          calcMode: "spline",
          keySplines: "0.4 0 0.2 1",
        })
      );
    }

    // Endpoint label - the one value labelled directly, per the "label
    // selectively" rule.
    const last = data[data.length - 1];
    g.appendChild(
      el("circle", {
        cx: xScale(last.x.getTime()),
        cy: yScale(last.y),
        r: 5,
        class: "focus-dot",
        style: `fill:${seriesColor}`,
      })
    );
    const endLabel = el("text", {
      x: Math.min(xScale(last.x.getTime()) + 6, width - margin.right - 2),
      y: yScale(last.y) - 8,
      class: "endpoint-label",
      "text-anchor": xScale(last.x.getTime()) > width - 60 ? "end" : "start",
    });
    endLabel.textContent = valueLabel(last.y);
    g.appendChild(endLabel);

    // Hover layer: crosshair snapped to nearest X, one tooltip for the series.
    const tipId = svg.dataset.tip;
    const tipEl = tipId ? document.getElementById(tipId) : null;
    const hitRect = el("rect", {
      x: margin.left,
      y: margin.top,
      width: innerW,
      height: innerH,
      fill: "transparent",
    });
    const crosshair = el("line", {
      x1: 0,
      x2: 0,
      y1: margin.top,
      y2: margin.top + innerH,
      class: "crosshair",
      visibility: "hidden",
    });
    const focusDot = el("circle", { r: 5, class: "focus-dot", visibility: "hidden", style: `fill:${seriesColor}` });
    g.appendChild(crosshair);
    g.appendChild(focusDot);
    g.appendChild(hitRect);

    function nearest(clientX) {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      const t = xMin + ((px - margin.left) / innerW) * xSpan;
      let best = 0;
      let bestDist = Infinity;
      data.forEach((d, i) => {
        const dist = Math.abs(d.x.getTime() - t);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    }

    function showAt(i, clientX, clientY) {
      const d = data[i];
      const x = xScale(d.x.getTime());
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");
      focusDot.setAttribute("cx", x);
      focusDot.setAttribute("cy", yScale(d.y));
      focusDot.setAttribute("visibility", "visible");
      if (tipEl) {
        tipEl.hidden = false;
        tipEl.innerHTML = `<div>${tipTitle}</div><div>${xLabel(d.x)} — <strong>${valueLabel(d.y)}</strong></div>`;
        // Viewport-relative (position: fixed), not container-relative - a
        // container-relative tip gets silently clipped by any ancestor
        // .card's overflow:hidden (rounded-corner containment) whenever the
        // tip would render past the card's edge.
        tipEl.style.left = `${clientX + 12}px`;
        tipEl.style.top = `${clientY - 12}px`;
      }
    }
    function hide() {
      crosshair.setAttribute("visibility", "hidden");
      focusDot.setAttribute("visibility", "hidden");
      if (tipEl) tipEl.hidden = true;
    }
    hitRect.addEventListener("pointermove", (e) => showAt(nearest(e.clientX), e.clientX, e.clientY));
    hitRect.addEventListener("pointerleave", hide);
  }

  // ---- Horizontal bar chart ----------------------------------------------
  // data: [{label: string, value: number, sub?: string}], any order (chart
  // sorts desc by default - pass ascending:true for "worst/lowest first"
  // rankings, e.g. utilisation or compliance percentages where a small bar
  // is the one that needs attention). `sub`, if given (e.g. a driver name),
  // shows as a second tooltip line under the label - never on the bar
  // itself, so it doesn't compete with the label column's fixed width.
  // `limit` caps how many bars render after sorting - default 10 (a quick
  // top-N read); pass null/Infinity to show every row (e.g. the whole
  // fleet).
  function barChart(svg, data, opts) {
    const { valueLabel = (v) => String(Math.round(v)), tipUnit = "", color, ascending = false, limit = 10 } = opts;
    svg.innerHTML = "";
    const rootStyle = getComputedStyle(document.documentElement);
    const barColor = color || rootStyle.getPropertyValue("--state-moving").trim();

    const sortFn = ascending ? (a, b) => a.value - b.value : (a, b) => b.value - a.value;
    const sorted = [...data].sort(sortFn).slice(0, limit == null ? data.length : limit);
    const width = svg.clientWidth || 600;
    const barH = 20;
    const gap = 10;
    const margin = { top: 8, right: 54, bottom: 8, left: 108 };
    const innerW = width - margin.left - margin.right;
    const height = margin.top + margin.bottom + sorted.length * (barH + gap);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;

    if (!sorted.length) {
      const t = el("text", { x: width / 2, y: 30, "text-anchor": "middle", class: "axis-label" });
      t.textContent = "No data in this window";
      svg.appendChild(t);
      return;
    }
    const max = niceMax(Math.max(...sorted.map((d) => d.value), 1));
    const xScale = (v) => (v / max) * innerW;

    const tipId = svg.dataset.tip;
    const tipEl = tipId ? document.getElementById(tipId) : null;

    sorted.forEach((d, i) => {
      const y = margin.top + i * (barH + gap);
      const w = Math.max(2, xScale(d.value));

      const label = el("text", {
        x: margin.left - 10,
        y: y + barH / 2 + 4,
        "text-anchor": "end",
        class: "axis-label",
      });
      label.textContent = d.label;
      svg.appendChild(label);

      const bar = el("rect", {
        x: margin.left,
        y,
        width: 0,
        height: barH,
        rx: 4,
        style: `fill:${barColor}`,
      });
      svg.appendChild(bar);
      bar.appendChild(
        el("animate", {
          attributeName: "width",
          from: "0",
          to: w,
          dur: "0.4s",
          begin: `${i * 0.03}s`,
          fill: "freeze",
          calcMode: "spline",
          keySplines: "0.3 0 0.2 1",
        })
      );

      // Value at the tip. If it wouldn't fit past the bar end, this chart's
      // bars never get that long relative to the label column, so tip
      // placement outside the bar is always safe here.
      const valEl = el("text", { x: margin.left + w + 6, y: y + barH / 2 + 4, class: "endpoint-label" });
      valEl.textContent = valueLabel(d.value);
      svg.appendChild(valEl);

      const hit = el("rect", {
        x: margin.left,
        y: y - gap / 2,
        width: innerW,
        height: barH + gap,
        fill: "transparent",
      });
      hit.style.cursor = "default";
      hit.addEventListener("pointermove", (e) => {
        bar.setAttribute("opacity", "0.85");
        if (tipEl) {
          tipEl.hidden = false;
          const subLine = d.sub ? `<div>${d.sub}</div>` : "";
          tipEl.innerHTML = `<div>${d.label}</div>${subLine}<div><strong>${valueLabel(d.value)}</strong> ${tipUnit}</div>`;
          // Viewport-relative (position: fixed) - see lineChart's showAt()
          // for why this can't be container-relative.
          tipEl.style.left = `${e.clientX + 12}px`;
          tipEl.style.top = `${e.clientY - 12}px`;
        }
      });
      hit.addEventListener("pointerleave", () => {
        bar.setAttribute("opacity", "1");
        if (tipEl) tipEl.hidden = true;
      });
      svg.appendChild(hit);
    });
  }

  // ---- Timeline (swimlane) chart -----------------------------------------
  // lanes: [{ label: string, segments: [{start: Date, end: Date, label:
  // string, sub?: string, color: css-color, texture?: boolean}] }]. Within a
  // lane, segments are drawn in the given order - later ones paint over
  // earlier ones, so pass background bands (e.g. a "GPS offline" gap) before
  // foreground ones that should sit on top of them. `texture: true` draws a
  // diagonal-hatch fill instead of a solid one - reserved for "absence of
  // data" (no reading at all), so it's never confusable at a glance with a
  // solid-filled "we have a classified reading here" segment, even when
  // both happen to use a similarly muted color. opts: { rangeStart: Date,
  // rangeEnd: Date }.
  function timelineChart(svg, lanes, opts) {
    const { rangeStart, rangeEnd } = opts;
    svg.innerHTML = "";
    const width = svg.clientWidth || 600;
    const laneH = 26;
    const laneGap = 16;
    const margin = { top: 10, right: 14, bottom: 26, left: 110 };
    const innerW = width - margin.left - margin.right;
    const height = margin.top + margin.bottom + lanes.length * (laneH + laneGap) - laneGap;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;

    const totalSegments = lanes.reduce((s, lane) => s + lane.segments.length, 0);
    if (!totalSegments) {
      const t = el("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "axis-label" });
      t.textContent = "No data in this window";
      svg.appendChild(t);
      return;
    }

    const hatchId = `${svg.id || "timeline"}-hatch`;
    const defs = el("defs");
    const pattern = el("pattern", {
      id: hatchId,
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    pattern.appendChild(el("rect", { width: 6, height: 6, style: "fill:var(--surface-1)" }));
    pattern.appendChild(el("line", { x1: 0, y1: 0, x2: 0, y2: 6, style: "stroke:var(--state-offline);stroke-width:2" }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const rMin = rangeStart.getTime();
    const rMax = rangeEnd.getTime();
    const rSpan = Math.max(1, rMax - rMin);
    const xScale = (t) => margin.left + ((t - rMin) / rSpan) * innerW;

    function fmtRange(start, end) {
      const timeOpts = { hour: "2-digit", minute: "2-digit" };
      const sameDay = start.toDateString() === end.toDateString();
      const startStr = start.toLocaleString([], sameDay ? timeOpts : { month: "short", day: "numeric", ...timeOpts });
      return `${startStr} – ${end.toLocaleTimeString([], timeOpts)}`;
    }

    // X-axis: first / middle / last timestamp.
    [rMin, rMin + rSpan / 2, rMax].forEach((t, idx) => {
      const anchor = idx === 0 ? "start" : idx === 2 ? "end" : "middle";
      const label = el("text", { x: xScale(t), y: height - 6, "text-anchor": anchor, class: "axis-label" });
      label.textContent = new Date(t).toLocaleString([], { month: "short", day: "numeric" });
      svg.appendChild(label);
    });

    const tipId = svg.dataset.tip;
    const tipEl = tipId ? document.getElementById(tipId) : null;

    lanes.forEach((lane, li) => {
      const y = margin.top + li * (laneH + laneGap);

      const laneLabel = el("text", {
        x: margin.left - 10,
        y: y + laneH / 2 + 4,
        "text-anchor": "end",
        class: "axis-label",
      });
      laneLabel.textContent = lane.label;
      svg.appendChild(laneLabel);

      svg.appendChild(
        el("rect", { x: margin.left, y, width: innerW, height: laneH, rx: 4, class: "timeline-track" })
      );

      for (const seg of lane.segments) {
        const x1 = Math.max(margin.left, xScale(seg.start.getTime()));
        const x2 = Math.min(margin.left + innerW, xScale(seg.end.getTime()));
        const w = Math.max(2, x2 - x1);
        const fill = seg.texture ? `url(#${hatchId})` : seg.color;
        const bar = el("rect", { x: x1, y, width: w, height: laneH, rx: 3, style: `fill:${fill}` });
        if (seg.texture) {
          bar.setAttribute("stroke", "var(--state-offline)");
          bar.setAttribute("stroke-width", "1");
        }
        svg.appendChild(bar);

        const hit = el("rect", { x: x1, y, width: w, height: laneH, fill: "transparent" });
        hit.style.cursor = "default";
        hit.addEventListener("pointermove", (e) => {
          bar.setAttribute("opacity", "0.8");
          if (tipEl) {
            tipEl.hidden = false;
            const subLine = seg.sub ? `<div>${seg.sub}</div>` : "";
            tipEl.innerHTML = `<div>${seg.label}</div>${subLine}<div>${fmtRange(seg.start, seg.end)}</div>`;
            tipEl.style.left = `${e.clientX + 12}px`;
            tipEl.style.top = `${e.clientY - 12}px`;
          }
        });
        hit.addEventListener("pointerleave", () => {
          bar.setAttribute("opacity", "1");
          if (tipEl) tipEl.hidden = true;
        });
        svg.appendChild(hit);
      }
    });

    // Scrub cursor: a vertical line tracking the pointer across the whole
    // plot (all lanes at once, not per-segment), reporting the exact
    // hovered time via opts.onScrub - e.g. to move a marker on a map to
    // "where was this vehicle at this instant." Listened for at the svg
    // level (not a dedicated hit-rect) so it fires everywhere in the plot
    // area, including over segment bars, without fighting their own
    // pointermove handlers for tooltips - both run off the same event.
    if (opts.onScrub) {
      const plotBottom = margin.top + lanes.length * (laneH + laneGap) - laneGap;
      const cursor = el("line", {
        x1: 0,
        x2: 0,
        y1: margin.top,
        y2: plotBottom,
        class: "timeline-cursor",
        visibility: "hidden",
      });
      svg.appendChild(cursor);

      svg.addEventListener("pointermove", (e) => {
        const rect = svg.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        const py = ((e.clientY - rect.top) / rect.height) * height;
        if (px < margin.left || px > margin.left + innerW || py < margin.top || py > plotBottom) {
          cursor.setAttribute("visibility", "hidden");
          opts.onScrub(null);
          return;
        }
        cursor.setAttribute("visibility", "visible");
        cursor.setAttribute("x1", px);
        cursor.setAttribute("x2", px);
        const t = rMin + ((px - margin.left) / innerW) * rSpan;
        opts.onScrub(new Date(t));
      });
      svg.addEventListener("pointerleave", () => {
        cursor.setAttribute("visibility", "hidden");
        opts.onScrub(null);
      });
    }
  }

  return { lineChart, barChart, timelineChart };
})();
