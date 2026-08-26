// Shared loading indicator (a thin bar under the topbar, shown while any
// request is in flight) plus a visibility-aware polling helper. No build
// step in this repo, so this is a plain script include like geo.js/chart.js -
// load it before any page controller that calls LOADING.*.
const LOADING = (() => {
  let activeCount = 0;
  let barEl = null;

  function ensureBar() {
    if (barEl) return barEl;
    barEl = document.createElement("div");
    barEl.id = "loading-bar";
    barEl.className = "loading-bar";
    document.body.prepend(barEl);
    return barEl;
  }

  // Reference-counted so overlapping requests (e.g. misuse.html's detail
  // panel firing 3 fetches) don't flicker the bar off after the first one
  // finishes while others are still in flight.
  function start() {
    activeCount++;
    ensureBar().classList.add("is-active");
  }
  function stop() {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) ensureBar().classList.remove("is-active");
  }

  // Runs `fn` on `intervalMs`, but pauses entirely while the tab is hidden
  // (Page Visibility API) instead of a raw setInterval ticking forever in
  // the background - the single biggest unnecessary-DB-read source in this
  // dashboard: index.html/vehicle.html were polling every REFRESH_MS even
  // when no one had the tab open. Resumes with an immediate call the
  // moment the tab becomes visible again, so content is never silently
  // stale for longer than a glance.
  function pollWhileVisible(fn, intervalMs) {
    let timer = null;
    function startTimer() {
      if (timer) return;
      timer = setInterval(fn, intervalMs);
    }
    function stopTimer() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopTimer();
      } else {
        startTimer();
        fn(); // catch up immediately rather than waiting out a stale interval
      }
    });
    if (!document.hidden) {
      startTimer();
      fn(); // initial call - setInterval alone would wait a full intervalMs first
    }
  }

  return { start, stop, pollWhileVisible };
})();
