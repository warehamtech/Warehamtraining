import { page } from "../dom.js";
import { publicChrome } from "../shell.js";

/** The 404 page needs nothing but the chrome. */
page(() => publicChrome());
