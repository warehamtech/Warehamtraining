import { el, mount, page, relativeDays } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, buttonLink, card, cardHeader, emptyState, progressBar, stat, table,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { getProgressForEnrollments } from "../progress.js";
import { roleLabels } from "../config.js";

/** Port of src/app/(app)/admin/learners/page.tsx. */

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  const [people, seats] = await Promise.all([
    sb.from("profiles")
      .select("id, name, email, role, job_title, last_active_at, organization:organizations ( name )")
      .order("name")
      .then(unwrap),
    sb.from("enrollments")
      .select(`
        id, user_id, status, last_seen_at,
        program:programs ( title ),
        certificates ( id, serial )
      `)
      .not("user_id", "is", null)
      .then(unwrap),
  ]);

  const progressMap = await getProgressForEnrollments(seats.map((s) => s.id));

  const seatsByUser = new Map();
  for (const seat of seats) {
    const list = seatsByUser.get(seat.user_id) ?? [];
    list.push(seat);
    seatsByUser.set(seat.user_id, list);
  }

  const certified = seats.filter((s) => (s.certificates ?? []).length).length;

  // A filter box rather than pagination — a training register of this size is
  // easier to scan than to page through.
  const search = el("input", {
    class: "control",
    type: "search",
    placeholder: "Filter by name, email or organisation…",
    "aria-label": "Filter learners",
  });

  const tbody = el("tbody");

  function rowsFor(term) {
    const needle = term.trim().toLowerCase();
    const matches = people.filter((person) =>
      !needle
      || person.name?.toLowerCase().includes(needle)
      || person.email?.toLowerCase().includes(needle)
      || person.organization?.name?.toLowerCase().includes(needle));

    if (!matches.length) {
      return [el("tr", {}, el("td", { colspan: 5, class: "subtle center", style: { padding: "2rem" } },
        "Nobody matches that filter."))];
    }

    return matches.map((person) => {
      const held = seatsByUser.get(person.id) ?? [];
      return el("tr", {}, [
        el("td", {}, [
          el("p", { class: "medium" }, person.name),
          el("p", { class: "subtle t-xs" }, person.email),
          person.job_title ? el("p", { class: "subtle t-xs" }, person.job_title) : null,
        ]),
        el("td", {}, [
          person.organization?.name
            ? el("p", { class: "t-sm" }, person.organization.name)
            : el("p", { class: "subtle t-sm" }, "Individual"),
          el("p", { class: "subtle t-xs" }, roleLabels[person.role]),
        ]),
        el("td", { style: { minWidth: "14rem" } },
          held.length
            ? el("div", { class: "stack--sm" }, held.map((seat) => {
                const progress = progressMap.get(seat.id);
                return el("div", {}, [
                  el("p", { class: "t-xs truncate" }, seat.program.title),
                  progressBar(progress?.percent ?? 0, {
                    size: "sm",
                    tone: progress?.complete ? "success" : "brand",
                  }),
                ]);
              }))
            : el("span", { class: "subtle t-xs" }, "No seats")),
        el("td", {},
          held.some((s) => (s.certificates ?? []).length)
            ? badge([icon("award", 14), "Certified"], "success")
            : held.length
              ? badge("In progress", "brand")
              : badge("—")),
        el("td", { class: "subtle t-xs tabular" },
          person.last_active_at ? relativeDays(person.last_active_at) : "never"),
      ]);
    });
  }

  search.addEventListener("input", () => {
    tbody.replaceChildren(...rowsFor(search.value));
  });
  tbody.replaceChildren(...rowsFor(""));

  mount("#app",
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "Learners"),
        el("p", {}, "Everyone with an account, and what they are working through."),
      ])),

    el("dl", { class: "grid grid--quarters" }, [
      stat("People", String(people.length)),
      stat("Seats held", String(seats.length)),
      stat("Certified", String(certified)),
      stat("Organisations",
        String(new Set(people.map((p) => p.organization?.name).filter(Boolean)).size)),
    ]),

    people.length
      ? card([
          cardHeader("Register", { action: search }),
          el("div", { class: "scroll-x" },
            el("table", { class: "table" }, [
              el("thead", {},
                el("tr", {}, ["Person", "Organisation", "Programmes", "Status", "Last active"]
                  .map((h) => el("th", {}, h)))),
              tbody,
            ])),
        ], { className: "mt-6" })
      : card(emptyState({
          iconName: "users",
          title: "No accounts yet",
          description: "People appear here as soon as they register or accept an invitation.",
          action: buttonLink("Back to invoices", "/admin/invoices.html"),
        }), { className: "mt-6" }));
});
