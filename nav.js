// Shared top-nav links. No build step in this repo, so there's no template
// partial to share the topbar markup across pages - this is the next best
// thing: one array here instead of hand-editing every page's .topbar-right
// whenever a page is added, renamed, or removed. Each page keeps its own
// page-specific <h1>/<p class="sub"> (and breadcrumb, where present) in its
// own HTML; only the "jump to another page" links are generated here, into
// a `<span id="nav-links"></span>` placeholder inside .topbar-right.
//
// index.html is deliberately not listed - every other page already has a
// "← Fleet dashboard" breadcrumb for that, and index.html doesn't need a
// link to itself.
const NAV_PAGES = [
  { href: "fleet-trends.html", label: "Analytics" },
  { href: "revenue.html", label: "Revenue" },
  { href: "anomalies.html", label: "Anomalies" },
  { href: "maintenance.html", label: "Maintenance" },
  { href: "drivers.html", label: "Drivers" },
  { href: "misuse.html", label: "Misuse review" },
];

(function renderNav() {
  const el = document.getElementById("nav-links");
  if (!el) return;
  const current = location.pathname.split("/").pop() || "index.html";
  for (const page of NAV_PAGES) {
    if (page.href === current) continue;
    const a = document.createElement("a");
    a.href = page.href;
    a.className = "btn btn-quiet";
    a.textContent = page.label;
    el.appendChild(a);
  }
})();
