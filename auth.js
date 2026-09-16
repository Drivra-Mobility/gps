// Login gate, shared by index.html and vehicle.html.
//
// This is real access control, not decoration: RLS on vehicle_positions and
// vehicle_latest only has a policy for the "authenticated" role (see
// supabase/schema.sql). The anon key in config.js grants zero rows on its
// own - only a signed-in Supabase Auth session satisfies the policy, and
// supabase-js attaches that session's token to every request automatically
// once signed in.
//
// There is no self-service sign-up here on purpose. Create users via
// Supabase Dashboard > Authentication > Users (see dashboard/README.md), and
// disable public email sign-ups in Authentication > Providers > Email so a
// stranger with the URL can't just register their own account.
const AUTH = (() => {
  const client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  let overlay = null;

  function injectOverlay() {
    if (overlay) return overlay;
    const el = document.createElement("div");
    el.id = "auth-overlay";
    el.className = "auth-overlay";
    el.innerHTML = `
      <form class="auth-card" id="auth-form">
        <h1>Fleet dashboard</h1>
        <p class="auth-sub">Sign in to view vehicle positions.</p>
        <label for="auth-email">Email</label>
        <input id="auth-email" type="email" autocomplete="username" required />
        <label for="auth-password">Password</label>
        <input id="auth-password" type="password" autocomplete="current-password" required />
        <button type="submit" class="btn btn-primary" id="auth-submit">Sign in</button>
        <p class="auth-error" id="auth-error" hidden></p>
      </form>`;
    document.body.appendChild(el);
    overlay = el;
    return el;
  }

  function showOverlay() {
    const el = injectOverlay();
    el.hidden = false;
    const form = el.querySelector("#auth-form");
    const errEl = el.querySelector("#auth-error");
    const submitBtn = el.querySelector("#auth-submit");

    form.onsubmit = async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
      const email = el.querySelector("#auth-email").value.trim();
      const password = el.querySelector("#auth-password").value;
      const { error } = await client.auth.signInWithPassword({ email, password });
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      if (error) {
        errEl.textContent = error.message || "Sign-in failed.";
        errEl.hidden = false;
      }
      // On success, onAuthStateChange (registered in requireAuth) hides the
      // overlay and starts the app - no need to duplicate that here.
    };
  }

  function hideOverlay() {
    if (overlay) overlay.hidden = true;
  }

  async function signOut() {
    await client.auth.signOut();
  }

  // Calls onReady(session) once signed in, and again on every subsequent
  // sign-in (e.g. after a sign-out). Shows/hides the login overlay to match.
  function requireAuth(onReady) {
    client.auth.onAuthStateChange((event, session) => {
      if (session) {
        hideOverlay();
        onReady(session);
      } else {
        showOverlay();
      }
    });
    client.auth.getSession().then(({ data }) => {
      if (data.session) {
        hideOverlay();
        onReady(data.session);
      } else {
        showOverlay();
      }
    });
  }

  return { client, requireAuth, signOut };
})();
