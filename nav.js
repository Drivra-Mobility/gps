// Shared top-nav links. No build step in this repo, so there's no template
// partial to share the topbar markup across pages - this is the next best
// thing: one array here instead of hand-editing every page's .topbar-right
// whenever a page is added, renamed, or removed. Each page keeps its own
// page-specific <h1>/<p class="sub"> (and breadcrumb, where present) in its
// own HTML; only the "jump to another page" links are generated here, into
// a `<span id="nav-links"></span>` placeholder inside .topbar-right.
//
// index.html IS listed (unlike the rest, self-omitted the same as every
// other page) - now that nav lives in a persistent sidenav rather than a
// squeezed topbar row, every subpage gets a "back to Fleet" entry here
// instead of relying only on its own hardcoded breadcrumb.
const NAV_PAGES = [
  { href: "index.html", label: "Fleet" },
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
    const a = document.createElement("a");
    a.href = page.href;
    a.className = "sidenav-link";
    if (page.href === current) a.classList.add("is-active");
    a.textContent = page.label;
    el.appendChild(a);
  }
})();
