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
  // Custom fetch with timeout to prevent auth network requests from hanging indefinitely
  const fetchWithTimeout = (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    return fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    }).finally(() => clearTimeout(timeoutId));
  };

  const client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: fetchWithTimeout,
    },
  });

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
    let initialized = false;

    const handleSession = (session) => {
      if (initialized) return;
      if (session) {
        initialized = true;
        hideOverlay();
        onReady(session);
      } else {
        initialized = true;
        showOverlay();
      }
    };

    client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        showOverlay();
      } else if (session) {
        hideOverlay();
        if (!initialized) {
          initialized = true;
          onReady(session);
        }
      }
    });

    // Handle initial session with a 4s safety timeout fallback
    client.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) {
          console.warn("Auth getSession error:", error);
          handleSession(null);
        } else {
          handleSession(data.session);
        }
      })
      .catch((err) => {
        console.warn("Auth getSession exception:", err);
        handleSession(null);
      });

    setTimeout(() => {
      if (!initialized) {
        console.warn("Auth check timed out, prompting login overlay");
        handleSession(null);
      }
    }, 4000);
  }

  return { client, requireAuth, signOut };
})();
