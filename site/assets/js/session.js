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
//
// What this window does NOT have to mean is "block on the network once it
// lapses". Past it, getUser({ allowStale: true }) hands back the old copy and
// re-reads behind the reader, so the header draws immediately and corrects
// itself if anything changed. The cost is one paint: a role or name changed by
// someone else can show its previous value until the background read lands.
// That is a display concern only — RLS decides what the database hands over,
// per the caveat at the top of this file — and the callers for whom it is not
// merely cosmetic (requireRole, and the already-signed-in checks on the login
// and register pages) stay on the strict path, where the window is enforced
// exactly as it always was.
const PROFILE_CACHE_KEY = "wha_profile_cache";
const PROFILE_CACHE_TTL_MS = 30_000;

function readProfileCache(userId) {
  try {
    const raw = sessionStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.userId !== userId) return null;
    // The age comes back with the profile rather than being enforced here, so
    // the caller can decide whether it is willing to take a stale copy.
    return { profile: entry.profile, savedAt: entry.savedAt };
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

/** Read the profile row. The one place the shape of `cached` is defined. */
async function fetchProfile(session) {
  // Role and organisation are read fresh from `profiles` rather than taken
  // from the JWT, so a role change takes effect within PROFILE_CACHE_TTL_MS
  // rather than whenever the token happens to be refreshed.
  const { data, error } = await sb
    .from("profiles")
    .select("id, email, name, role, job_title, organization_id, organizations(name)")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !data) return null;

  return {
    ...data,
    organizationName: data.organizations?.name ?? null,
    authEmail: session.user.email,
  };
}

/**
 * Fields a reader can actually see. Compared after a background revalidation
 * to decide whether anything on screen is now wrong — `job_title` and
 * `organization_id` are deliberately absent, because nothing in the chrome
 * draws them and a change to them should not cost a re-render.
 */
const VISIBLE = ["id", "name", "email", "role", "organizationName"];

function sameToTheReader(a, b) {
  if (!a || !b) return a === b;
  return VISIBLE.every((key) => a[key] === b[key]);
}

/**
 * The single in-flight background refresh, so a page whose header and body
 * both ask for the user does not fire two identical queries.
 *
 * `epoch` is what makes a sign-out safe. Dropping the promise would not stop
 * it: it is already in flight, and its `.then` would land afterwards and put
 * the profile it read straight back into `cached` — signing the reader back
 * in as far as every subsequent render is concerned. Stamping each
 * revalidation with the epoch it started in, and bumping the epoch on sign-out,
 * lets the late arrival recognise that it is answering a question nobody is
 * asking any more.
 */
let revalidating = null;
let epoch = 0;

function revalidate(session) {
  const startedIn = epoch;
  revalidating ??= fetchProfile(session)
    .then((profile) => {
      if (!profile || startedIn !== epoch) return;
      const changed = !sameToTheReader(cached, profile);
      cached = profile;
      cachedAt = Date.now();
      writeProfileCache(session.user.id, profile);
      // Anything drawn from the stale copy gets a chance to correct itself.
      // shell.js is the only listener; see renderPublicHeader/renderAppHeader.
      if (changed) window.dispatchEvent(new CustomEvent("wha:profilechange", { detail: profile }));
    })
    .catch(() => { /* the stale copy stands; nothing on screen is worse off */ })
    .finally(() => { revalidating = null; });
  return revalidating;
}

/**
 * The signed-in user's profile, or null.
 *
 * `allowStale` is the difference between "who is this, exactly" and "draw me a
 * header". With it, a cached profile of any age is returned immediately and
 * corrected in the background — which is what stops a returning learner
 * watching a blank header while a `profiles` query goes to Supabase and back
 * on every load past the 30-second window. Without it (the default) the TTL is
 * enforced as it always was, which is what requireRole() needs: a redirect
 * decided on a stale role sends someone to the wrong place, where a header
 * drawn from one merely looks briefly out of date.
 *
 * Serving stale deliberately does NOT bump `cachedAt`. Doing so would make the
 * stale copy look fresh for another full window and quietly strip requireRole()
 * of the guarantee above.
 */
export async function getUser({ refresh = false, allowStale = false } = {}) {
  if (cached !== undefined && !refresh && Date.now() - cachedAt < PROFILE_CACHE_TTL_MS) {
    return cached;
  }
  if (cached && !refresh && allowStale) {
    // In memory but past the window. Serve it, correct it behind the reader.
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return signedOut();
    revalidate(session);
    return cached;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) return signedOut();

  if (!refresh) {
    const entry = readProfileCache(session.user.id);
    if (entry) {
      const fresh = Date.now() - entry.savedAt <= PROFILE_CACHE_TTL_MS;
      if (fresh || allowStale) {
        cached = entry.profile;
        cachedAt = entry.savedAt;
        if (!fresh) revalidate(session);
        return cached;
      }
    }
  }

  const profile = await fetchProfile(session);
  cached = profile;
  cachedAt = Date.now();
  if (profile) writeProfileCache(session.user.id, profile);
  return cached;
}

function signedOut() {
  cached = null;
  cachedAt = Date.now();
  clearProfileCache();
  return null;
}

/** Send a signed-out visitor to the login page, remembering where they were. */
export async function requireUser({ allowStale = true } = {}) {
  // Stale by default. This only decides whether to redirect a signed-OUT
  // visitor, and that question is answered by sb.auth.getSession() — which is
  // read from local storage and is never stale — not by the profile row.
  const user = await getUser({ allowStale });
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
  // Strict: `roles` below is checked against user.role to decide a redirect,
  // and sending someone to the wrong area on a stale role is not cosmetic.
  const allowed = roles.flat(Infinity);
  const user = await requireUser({ allowStale: false });
  if (!allowed.includes(user.role)) {
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
  epoch += 1;
  revalidating = null;
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
