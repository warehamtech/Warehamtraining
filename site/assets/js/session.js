import { sb } from "./supabase.js";

/**
 * Who is signed in, and where they belong.
 *
 * Replaces src/lib/auth.ts. The caveat from the old proxy.ts applies to
 * everything here, and more strongly: THIS IS NOT THE AUTHORISATION BOUNDARY.
 * It decides what to render and where to redirect. Row level security decides
 * what the database will actually hand over. Someone who edits these functions
 * in their dev tools gets a differently-shaped page and exactly the same data.
 */

let cached;
let cachedAt;

// router.js keeps this module alive for the life of a tab, so the in-memory
// `cached` above survives client-side navigations rather than resetting on
// every page the way it used to under full page loads. Without a TTL on it
// too, `cached !== undefined` below would short-circuit forever after the
// first call, and a role or organisation change made by an admin would never
// be picked up by an already-open tab. Timestamping it with `cachedAt` keeps
// the same PROFILE_CACHE_TTL_MS staleness bound the sessionStorage copy always
// had: a role change still takes effect within this window, not "whenever the
// token happens to be refreshed" — just not necessarily on the very next
// click the way an uncached read would.
//
// sessionStorage still matters on top of this: it's what makes the *first*
// profile read of a fresh tab (or a hard reload) cheap when a cached copy
// from a recent tab is still within its window, which the in-memory `cached`
// can't help with since it starts undefined every time this module is
// re-evaluated from scratch.
const PROFILE_CACHE_KEY = "wha_profile_cache";
const PROFILE_CACHE_TTL_MS = 30_000;

function readProfileCache(userId) {
  try {
    const raw = sessionStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.userId !== userId || Date.now() - entry.savedAt > PROFILE_CACHE_TTL_MS) return null;
    return entry.profile;
  } catch {
    return null;
  }
}

function writeProfileCache(userId, profile) {
  try {
    sessionStorage.setItem(PROFILE_CACHE_KEY,
      JSON.stringify({ userId, savedAt: Date.now(), profile }));
  } catch {
    /* storage full or unavailable — caching is an optimisation, not a requirement */
  }
}

function clearProfileCache() {
  try { sessionStorage.removeItem(PROFILE_CACHE_KEY); } catch { /* ignore */ }
}

/**
 * The signed-in user's profile, or null. Cached in memory for
 * PROFILE_CACHE_TTL_MS so a header, a guard and the page body cost one
 * request between them, and in sessionStorage for the same window so a fresh
 * tab or a hard reload usually costs none at all.
 */
export async function getUser({ refresh = false } = {}) {
  if (cached !== undefined && !refresh && Date.now() - cachedAt < PROFILE_CACHE_TTL_MS) {
    return cached;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    cached = null;
    cachedAt = Date.now();
    clearProfileCache();
    return cached;
  }

  if (!refresh) {
    const fromCache = readProfileCache(session.user.id);
    if (fromCache) {
      cached = fromCache;
      cachedAt = Date.now();
      return cached;
    }
  }

  // Role and organisation are read fresh from `profiles` rather than taken
  // from the JWT, so a role change takes effect within PROFILE_CACHE_TTL_MS
  // rather than whenever the token happens to be refreshed.
  const { data, error } = await sb
    .from("profiles")
    .select("id, email, name, role, job_title, organization_id, organizations(name)")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !data) {
    cached = null;
    cachedAt = Date.now();
    return cached;
  }

  cached = {
    ...data,
    organizationName: data.organizations?.name ?? null,
    authEmail: session.user.email,
  };
  cachedAt = Date.now();
  writeProfileCache(session.user.id, cached);
  return cached;
}

/** Send a signed-out visitor to the login page, remembering where they were. */
export async function requireUser() {
  const user = await getUser();
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    location.replace(`/login.html?next=${encodeURIComponent(next)}`);
    // Never resolves — the page is being replaced, and callers should not
    // continue rendering against a null user.
    return new Promise(() => {});
  }
  return user;
}

/**
 * Guard an area by role. Sends the wrong role to their own home rather than to
 * an error, so the existence of the area is not advertised.
 */
export async function requireRole(...roles) {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    location.replace(homeFor(user.role));
    return new Promise(() => {});
  }
  return user;
}

export function homeFor(role) {
  switch (role) {
    case "WHA_ADMIN":
      return "/admin/invoices.html";
    case "ORG_ADMIN":
      return "/team/index.html";
    default:
      return "/dashboard.html";
  }
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    // Same message either way, so the form cannot be used to enumerate
    // accounts — the behaviour loginAction had.
    return { ok: false, error: "Those details don't match an account." };
  }
  await touchLastActive();
  return { ok: true };
}

export async function signUp({ email, password, name, jobTitle }) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    // Read by the handle_new_user() trigger to populate the profile row.
    options: { data: { name, job_title: jobTitle || null } },
  });

  if (error) {
    if (/already registered|already exists/i.test(error.message)) {
      return {
        ok: false,
        fieldErrors: {
          email: "An account with this email already exists. Sign in instead.",
        },
      };
    }
    return { ok: false, error: error.message };
  }

  // With email confirmation switched on there is no session yet, and the
  // caller needs to say "check your inbox" instead of redirecting.
  return { ok: true, needsConfirmation: !data.session };
}

export async function signOut() {
  await sb.auth.signOut();
  cached = undefined;
  cachedAt = undefined;
  clearProfileCache();
  location.href = "/login.html";
}

export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}/login.html`,
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Best-effort "they were here" stamp; never worth failing a page over. */
async function touchLastActive() {
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (user) {
      await sb.from("profiles").update({ last_active_at: new Date().toISOString() })
        .eq("id", user.id);
    }
  } catch {
    /* ignore */
  }
}

/** Where to go after signing in: an internal `next`, or the role's home. */
export function nextAfterLogin(role) {
  const next = new URLSearchParams(location.search).get("next");
  // Only same-origin relative paths, so `?next=https://evil.example` cannot
  // turn the login form into an open redirect.
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return homeFor(role);
}
