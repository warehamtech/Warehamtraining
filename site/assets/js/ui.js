import { el, append } from "./dom.js";
import { icon } from "./icons.js";

/**
 * Builders for the design-system primitives. One function per component that
 * lived in src/components/ui/, producing the class names in
 * assets/css/components.css.
 */

/* --- Button --------------------------------------------------------------- */

function btnClass(variant = "primary", size = "md", extra = "") {
  const classes = ["btn", `btn--${variant}`];
  if (size !== "md") classes.push(`btn--${size}`);
  if (extra) classes.push(extra);
  return classes.join(" ");
}

export function button(label, { variant, size, className, onClick, type = "button", ...attrs } = {}) {
  return el(
    "button",
    { type, class: btnClass(variant, size, className), onClick, ...attrs },
    label,
  );
}

export function buttonLink(label, url, { variant, size, className, ...attrs } = {}) {
  return el("a", { href: url, class: btnClass(variant, size, className), ...attrs }, label);
}

/**
 * A submit button that disables itself and shows a spinner while its form is
 * in flight — the old SubmitButton, which used useFormStatus.
 */
export function submitButton(label, { variant = "primary", size, className } = {}) {
  const node = el("button", { type: "submit", class: btnClass(variant, size, className) }, label);
  node.dataset.label = label;
  return node;
}

/** Put a form into its pending state, and back again. */
export function setPending(form, pending) {
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  // Buttons built by submitButton() above already carry their label in
  // dataset.label. A plain <button type="submit">Sign in</button> written
  // directly in an HTML page doesn't — so capture it here, the first time
  // this runs, from the button's own text. Without this every such button
  // reverted to the hardcoded "Save" fallback after its first pending cycle,
  // regardless of what it actually said.
  if (submit.dataset.label === undefined) {
    submit.dataset.label = submit.textContent.trim();
  }
  submit.disabled = pending;
  if (pending) {
    submit.replaceChildren(el("span", { class: "btn__spinner" }), submit.dataset.label);
  } else {
    submit.replaceChildren(submit.dataset.label);
  }
}

/* --- Card ----------------------------------------------------------------- */

export function card(children, { className } = {}) {
  return el("section", { class: className ? `card ${className}` : "card" }, children);
}

export function cardHeader(title, { description, action } = {}) {
  return el("div", { class: "card__header" }, [
    el("div", {}, [
      el("h2", {}, title),
      description ? el("p", {}, description) : null,
    ]),
    action ? el("div", {}, action) : null,
  ]);
}

export function cardBody(children, { className } = {}) {
  return el("div", { class: className ? `card__body ${className}` : "card__body" }, children);
}

export function cardFooter(children) {
  return el("div", { class: "card__footer" }, children);
}

/** Neutral placeholder for "nothing here yet" states. */
export function emptyState({ iconName, title, description, action }) {
  return el("div", { class: "empty" }, [
    iconName ? el("div", { class: "empty__icon" }, icon(iconName, 28)) : null,
    el("p", { class: "empty__title" }, title),
    description ? el("p", { class: "empty__desc" }, description) : null,
    action ? el("div", { class: "empty__action" }, action) : null,
  ]);
}

/* --- Badge ---------------------------------------------------------------- */

export function badge(label, tone = "neutral") {
  return el(
    "span",
    { class: tone === "neutral" ? "badge" : `badge badge--${tone}` },
    label,
  );
}

/* --- Fields --------------------------------------------------------------- */

let uid = 0;
const nextId = () => `f${++uid}`;

/**
 * A labelled control.
 *
 *   field({ label: "Email", name: "email", type: "email", required: true })
 *   field({ label: "Notes", name: "note", as: "textarea", rows: 3 })
 *   field({ label: "Seats", name: "seats", as: "select", options: [...] })
 */
export function field({
  label, name, as = "input", hint, error, required, options, ...attrs
}) {
  const id = attrs.id ?? nextId();
  let control;

  if (as === "select") {
    control = el("select", { id, name, class: "control", required, ...attrs },
      (options ?? []).map((option) =>
        el("option", { value: option.value, selected: option.selected }, option.label)));
  } else if (as === "textarea") {
    // Unlike <input>, a <textarea>'s initial content is its text content, not
    // a `value` attribute — setAttribute("value", …) is silently ignored by
    // the browser, so an initial value has to go in as a child text node.
    const { value: initialValue, ...rest } = attrs;
    control = el("textarea", { id, name, class: "control", required, ...rest }, initialValue ?? "");
  } else {
    control = el("input", { id, name, class: "control", required, ...attrs });
  }

  if (error) control.setAttribute("aria-invalid", "true");

  return el("div", { class: "field" }, [
    el("label", { class: "field__label", for: id }, [
      label,
      required ? el("span", { class: "field__required" }, "*") : null,
    ]),
    control,
    error
      ? el("p", { class: "field__error" }, error)
      : hint
        ? el("p", { class: "field__hint" }, hint)
        : null,
  ]);
}

/** Inline form-level message, shown above the submit button. */
export function formError(message) {
  return message ? el("div", { class: "form-error", role: "alert" }, message) : null;
}

export function formSuccess(message) {
  return message ? el("div", { class: "form-success", role: "status" }, message) : null;
}

export function formNote(children) {
  return el("div", { class: "form-note" }, children);
}

/**
 * Show a message inside a form, replacing any previous one. Keeps the message
 * in a fixed slot so it does not shift the fields around.
 */
export function setFormMessage(form, message, tone = "error") {
  const slot = form.querySelector("[data-message]");
  if (!slot) return;
  slot.replaceChildren();
  if (!message) return;
  slot.append(tone === "error" ? formError(message) : formSuccess(message));
}

/** Paint per-field errors returned by a validator onto an existing form. */
export function setFieldErrors(form, errors = {}) {
  for (const node of form.querySelectorAll(".field__error")) node.remove();
  for (const node of form.querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");

  for (const [name, message] of Object.entries(errors)) {
    const control = form.elements[name];
    if (!control) continue;
    control.setAttribute("aria-invalid", "true");
    const hint = control.parentElement?.querySelector(".field__hint");
    hint?.remove();
    control.parentElement?.append(el("p", { class: "field__error" }, message));
  }
}

/* --- Progress ------------------------------------------------------------- */

/**
 * Linear progress bar. Always render it next to a countable label
 * ("8 of 24 lessons") — a bare percentage is less legible to a learner than a
 * count they can reconcile against the curriculum list.
 */
export function progressBar(value, { tone = "brand", size = "md", label, className } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const classes = ["progress"];
  if (size !== "md") classes.push(`progress--${size}`);
  if (tone === "success") classes.push("progress--success");
  if (className) classes.push(className);

  return el(
    "div",
    {
      class: classes.join(" "),
      role: "progressbar",
      "aria-valuenow": pct,
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-label": label ?? `${pct}% complete`,
    },
    el("div", { class: "progress__fill", style: { width: `${pct}%` } }),
  );
}

/**
 * Compact ring used on curriculum sidebar nodes and programme cards where a
 * full-width bar would not fit.
 */
export function progressRing(value, {
  size = 36, strokeWidth = 3, tone = "brand", showValue = true,
} = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);

  const circle = (className, extra = {}) => {
    const node = document.createElementNS(ns, "circle");
    node.setAttribute("cx", size / 2);
    node.setAttribute("cy", size / 2);
    node.setAttribute("r", radius);
    node.setAttribute("stroke-width", strokeWidth);
    node.setAttribute("class", className);
    for (const [key, value] of Object.entries(extra)) node.setAttribute(key, value);
    return node;
  };

  svg.append(
    circle("ring__track"),
    circle("ring__fill", {
      "stroke-dasharray": circumference,
      "stroke-dashoffset": offset,
    }),
  );

  const wrap = el("div", {
    class: tone === "success" ? "ring ring--success" : "ring",
    style: { width: `${size}px`, height: `${size}px` },
    role: "progressbar",
    "aria-valuenow": pct,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
  }, svg);

  if (showValue) wrap.append(el("span", { class: "ring__value" }, String(pct)));
  return wrap;
}

/* --- Table ---------------------------------------------------------------- */

/**
 * A table inside a horizontal scroller, so wide content never makes the page
 * body scroll sideways on a phone.
 */
export function table(headers, rows) {
  return el("div", { class: "scroll-x" },
    el("table", { class: "table" }, [
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
      el("tbody", {}, rows),
    ]));
}

export function row(cells, attrs = {}) {
  return el("tr", attrs, cells.map((cell) => el("td", {}, cell)));
}

/* --- Misc ----------------------------------------------------------------- */

export function definitionList(pairs) {
  return el("dl", { class: "dl" },
    pairs.filter(Boolean).map(([term, value]) =>
      el("div", {}, [el("dt", {}, term), el("dd", {}, value)])));
}

export function stat(label, value, { hint, hintTone } = {}) {
  return el("div", { class: "stat" }, [
    el("dt", {}, label),
    el("dd", { class: "tabular" }, value),
    hint
      ? el("p", { class: hintTone ? `stat__hint stat__hint--${hintTone}` : "stat__hint" }, hint)
      : null,
  ]);
}

export { el, append, icon };
