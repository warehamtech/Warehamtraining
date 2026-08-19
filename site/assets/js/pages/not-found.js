import { publicChrome } from "../shell.js";

/** The 404 page needs nothing but the chrome. */
export function init() {
  return publicChrome();
}
