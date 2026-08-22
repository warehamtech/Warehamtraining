/**
 * Tiny, side-effect-free shared state between router.js and the page
 * modules for the still-real prerendered pages (home.js, programs.js,
 * verify.js). Split out of router.js specifically so those modules can
 * import it without also importing — and therefore executing — router.js's
 * own self-running navigation bootstrap (the click/popstate listeners and
 * the initial goTo() call at the bottom of that file), which assumes a real
 * browser DOM and crashes when it doesn't have one — exactly what happens
 * under build/prerender.mjs, which imports these page modules directly in
 * Node via linkedom.
 */

/**
 * Whether this page's own init() call — the very first one router.js has
 * made — hasn't finished yet. See the fuller comment where router.js flips
 * this, in its activateRoute().
 */
export let isFirstLoad = true;

export function markLoaded() {
  isFirstLoad = false;
}
