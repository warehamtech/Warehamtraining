import { el, mount, formatDate, relativeDays } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, emptyState,
  field, progressBar, stat, table, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";
import { getProgressForEnrollments } from "../progress.js";
import { sendMail } from "../mail.js";
import { SITE_URL } from "../env.js";

/** Port of src/app/(app)/team/page.tsx and team-forms.tsx. */

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Port of /api/team/progress.csv — built in the browser, same columns. */
function exportCsv(rows, organizationName) {
  const header = [
    "Name", "Email", "Job title", "Programme", "Status",
    "Lessons complete", "Lessons total", "Assessments passed",
    "Assessments total", "Percent", "Certificate serial", "Last seen",
  ];
  const body = rows.map((row) => [
    row.name, row.email, row.jobTitle ?? "", row.programTitle, row.status,
    row.completedLessons, row.totalLessons, row.passedAssessments,
    row.totalAssessments, row.percent, row.serial ?? "",
    row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : "",
  ]);

  const csv = [header, ...body].map((line) => line.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = el("a", {
    href: url,
    download: `${organizationName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-progress-${stamp}.csv`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function render(admin) {
  if (!admin.organization_id) {
    mount("#app", card(emptyState({
      title: "No organisation linked",
      description:
        "Your account isn't linked to a company yet. Buy seats as a company at checkout and we'll set this up.",
      action: buttonLink("Browse the catalogue", "/programs/index.html"),
    })));
    return;
  }

  const [organization, members, seats, invites] = await Promise.all([
    sb.from("organizations").select("id, name")
      .eq("id", admin.organization_id).single().then(unwrap),
    sb.from("profiles").select("id, name, email, job_title, role")
      .eq("organization_id", admin.organization_id)
      .order("name").then(unwrap),
    sb.from("enrollments")
      .select(`
        id, user_id, status, last_seen_at, created_at,
        program:programs ( id, title ),
        user:profiles ( id, name, email, job_title ),
        certificates ( id, serial ),
        order:orders!inner ( organization_id )
      `)
      .eq("order.organization_id", admin.organization_id)
      .in("status", ["ACTIVE", "COMPLETED"])
      .order("created_at").then(unwrap),
    sb.from("invites")
      .select("id, email, expires_at, created_at, token, program:programs ( title )")
      .eq("organization_id", admin.organization_id)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }).then(unwrap),
  ]);

  const assigned = seats.filter((seat) => seat.user_id);
  const progressMap = await getProgressForEnrollments(assigned.map((s) => s.id));

  // Seat pool per programme.
  const byProgram = new Map();
  for (const seat of seats) {
    const entry = byProgram.get(seat.program.id)
      ?? { title: seat.program.title, total: 0, free: 0 };
    entry.total += 1;
    if (!seat.user_id) entry.free += 1;
    byProgram.set(seat.program.id, entry);
  }
  const seatOptions = [...byProgram.entries()].map(([programId, entry]) => ({
    programId, title: entry.title, free: entry.free,
  }));

  const totalSeats = seats.length;
  const usedSeats = assigned.length;
  const certified = seats.filter((s) => (s.certificates ?? []).length).length;
  const membersWithoutSeats = members.filter(
    (member) => !assigned.some((seat) => seat.user_id === member.id));

  const csvRows = assigned.map((seat) => {
    const progress = progressMap.get(seat.id);
    return {
      name: seat.user?.name, email: seat.user?.email, jobTitle: seat.user?.job_title,
      programTitle: seat.program.title, status: seat.status,
      completedLessons: progress?.completedLessons ?? 0,
      totalLessons: progress?.totalLessons ?? 0,
      passedAssessments: progress?.passedAssessments ?? 0,
      totalAssessments: progress?.totalAssessments ?? 0,
      percent: progress?.percent ?? 0,
      serial: (seat.certificates ?? [])[0]?.serial,
      lastSeenAt: seat.last_seen_at,
    };
  });

  /* --- Invite form -------------------------------------------------------- */

  const programOptions = [
    { value: "", label: "No seat yet — just add them to the team" },
    ...seatOptions.filter((o) => o.free > 0).map((o) => ({
      value: o.programId,
      label: `${o.title} (${o.free} free ${o.free === 1 ? "seat" : "seats"})`,
    })),
  ];

  const inviteForm = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({ label: "Email address", name: "email", type: "email", required: true,
      autocomplete: "off", placeholder: "colleague@company.co.za" }),
    field({ label: "Allocate a seat", name: "programId", as: "select",
      options: programOptions,
      hint: "Optional — they can be given a seat later." }),
    el("button", { class: "btn btn--primary", type: "submit" },
      [icon("mail", 16), "Send invitation"]),
  ]);

  inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(inviteForm, null);
    setPending(inviteForm, true);

    const result = await rpc("create_invite", {
      p_email: inviteForm.elements.email.value.trim().toLowerCase(),
      p_program_id: inviteForm.elements.programId.value || null,
    });

    setPending(inviteForm, false);

    if (!result.ok) {
      setFormMessage(inviteForm, result.error);
      return;
    }

    await sendMail("invite", { token: result.token }).catch(() => {});
    setFormMessage(inviteForm, `Invitation sent to ${result.email}.`, "success");
    setTimeout(() => render(admin), 1200);
  });

  /* --- Page --------------------------------------------------------------- */

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, organization.name),
        el("p", {}, "Seats, invitations and progress across your team."),
      ]),
      el("div", { class: "row" }, [
        buttonLink("Payments and receipts", "/invoices.html", { variant: "secondary" }),
        button([icon("download", 16), "Export CSV"], {
          variant: "secondary",
          disabled: !csvRows.length,
          onClick: () => exportCsv(csvRows, organization.name),
        }),
      ]),
    ]),

    el("dl", { class: "grid grid--quarters" }, [
      stat("Seats purchased", String(totalSeats)),
      stat("Seats allocated", `${usedSeats} of ${totalSeats}`),
      stat("Certified", String(certified)),
      stat("Pending invitations", String(invites.length)),
    ]),

    totalSeats === 0
      ? card(emptyState({
          iconName: "users",
          title: "No seats yet",
          description:
            "Buy seats for your team from the catalogue. Once payment is confirmed they appear here for you to allocate.",
          action: buttonLink("Browse the catalogue", "/programs/index.html"),
        }), { className: "mt-6" })
      : null,

    // Progress table.
    assigned.length
      ? card([
          cardHeader("Progress", {
            description: "Live figures — the same numbers each learner sees.",
          }),
          table(
            ["Learner", "Programme", "Progress", "Status", "Last seen", ""],
            assigned.map((seat) => {
              const progress = progressMap.get(seat.id);
              const certificate = (seat.certificates ?? [])[0];
              return el("tr", {}, [
                el("td", {}, [
                  el("p", { class: "medium" }, seat.user?.name),
                  el("p", { class: "subtle t-xs" }, seat.user?.email),
                ]),
                el("td", {}, seat.program.title),
                el("td", { style: { minWidth: "10rem" } }, [
                  el("p", { class: "tabular t-xs subtle" },
                    `${progress?.completedSteps ?? 0} of ${progress?.totalSteps ?? 0} steps`),
                  progressBar(progress?.percent ?? 0, {
                    size: "sm",
                    className: "mt-1",
                    tone: progress?.complete ? "success" : "brand",
                  }),
                ]),
                el("td", {},
                  certificate
                    ? badge([icon("award", 14), "Certified"], "success")
                    : progress?.complete
                      ? badge("Ready to certify", "accent")
                      : badge("In progress", "brand")),
                el("td", { class: "tabular subtle t-xs" },
                  seat.last_seen_at ? relativeDays(seat.last_seen_at) : "—"),
                el("td", {},
                  certificate
                    ? el("span", { class: "subtle t-xs tabular" }, certificate.serial)
                    : button("Return seat", {
                        variant: "ghost",
                        size: "sm",
                        onClick: async (event) => {
                          const node = event.currentTarget;
                          node.disabled = true;
                          const result = await rpc("revoke_seat",
                            { p_enrollment_id: seat.id });
                          if (!result.ok) {
                            node.disabled = false;
                            node.after(el("p", { class: "t-xs", role: "alert",
                              style: { color: "var(--danger)" } }, result.error));
                            return;
                          }
                          render(admin);
                        },
                      })),
              ]);
            })),
          el("p", { class: "card__footer subtle t-xs" },
            "Returning a seat to the pool erases that learner's progress, so it is " +
            "blocked once a certificate has been issued."),
        ], { className: "mt-6" })
      : null,

    el("div", { class: "grid grid--halves mt-6" }, [
      // Members needing a seat.
      card([
        cardHeader("Team members", {
          description: membersWithoutSeats.length
            ? "These people have accounts but no seat yet."
            : "Everyone on your team has a seat.",
        }),
        membersWithoutSeats.length
          ? el("ul", { class: "divided" }, membersWithoutSeats.map((member) => {
              const free = seatOptions.filter((o) => o.free > 0);
              return el("li", { class: "row row--wrap" }, [
                el("div", { class: "grow" }, [
                  el("p", { class: "medium" }, member.name),
                  el("p", { class: "subtle t-xs" }, member.email),
                ]),
                free.length
                  ? el("form", {
                      class: "row",
                      onSubmit: async (event) => {
                        event.preventDefault();
                        const select = event.currentTarget.elements.programId;
                        const result = await rpc("assign_seat", {
                          p_member_id: member.id,
                          p_program_id: select.value,
                        });
                        if (!result.ok) {
                          setFormMessage(event.currentTarget, result.error);
                          return;
                        }
                        await sendMail("seat_assigned", {
                          member_id: member.id,
                          program_id: select.value,
                        }).catch(() => {});
                        render(admin);
                      },
                    }, [
                      el("select", { class: "control", name: "programId" },
                        free.map((option) =>
                          el("option", { value: option.programId },
                            `${option.title} (${option.free})`))),
                      el("button", { class: "btn btn--secondary btn--sm", type: "submit" },
                        "Allocate"),
                    ])
                  : el("span", { class: "subtle t-xs" }, "No free seats"),
              ]);
            }))
          : cardBody(el("p", { class: "subtle t-sm" },
              `${members.length} ${members.length === 1 ? "person" : "people"} on the team.`)),
      ]),

      // Invitations.
      card([
        cardHeader("Invite a colleague", {
          description: "They set their own password and can start immediately.",
        }),
        cardBody(inviteForm),
        invites.length
          ? el("div", {}, [
              el("p", { class: "card__footer section-label" }, "Outstanding invitations"),
              el("ul", { class: "divided" }, invites.map((invite) =>
                el("li", { class: "row row--wrap" }, [
                  icon("mail", 16, { class: "i-subtle" }),
                  el("div", { class: "grow" }, [
                    el("p", { class: "medium t-sm" }, invite.email),
                    el("p", { class: "subtle t-xs" }, [
                      invite.program?.title
                        ? `Seat on ${invite.program.title} · `
                        : "",
                      `expires ${relativeDays(invite.expires_at)}`,
                    ]),
                  ]),
                  button("Copy link", {
                    variant: "ghost",
                    size: "sm",
                    onClick: async (event) => {
                      const url = `${SITE_URL}/invite.html?token=${invite.token}`;
                      await navigator.clipboard?.writeText(url);
                      event.currentTarget.textContent = "Copied";
                      setTimeout(() => { event.currentTarget.textContent = "Copy link"; }, 2000);
                    },
                  }),
                ]))),
            ])
          : null,
      ]),
    ]));
}

export async function init() {
  const admin = await requireRole("ORG_ADMIN");
  appChrome(admin);
  await render(admin);
}
