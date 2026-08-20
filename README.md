# WHA Learning Portal

Online training platform for **Wareham & Associates** — learners or companies
buy a training programme, receive a VAT invoice, get activated on proof of
payment, work through video/written/PDF lessons against a live progress bar,
pass an assessment per course, and download a verifiable certificate.

Plain HTML, CSS and JavaScript, with **Supabase** as the entire backend and
**Netlify** for hosting. No framework, no bundler and no Node runtime in
production: `site/` is the website, served exactly as it sits on disk, and any
page still opens straight from the filesystem.

Two scripts under `build/` rewrite parts of the committed files in place —
they generate nothing new to deploy and there is no output directory. See
[Generated files](#generated-files); the short version is that you run
`npm run generate` after changing a page module's imports or the catalogue.

```
site/                the website — this is what Netlify serves
build/               scripts that rewrite parts of site/ in place
supabase/            database schema, security policies, functions
```

> **On Windows PowerShell**, `npm` and `npx` may fail with *"cannot be loaded
> because running scripts is disabled on this system"*. PowerShell is refusing
> to run npm's `.ps1` wrapper. Either call `npm.cmd` / `npx.cmd` instead — the
> batch shims are not PowerShell scripts, so the policy does not apply — or
> allow local scripts once, for your account only:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
>
> Note also that Windows PowerShell 5.1 has no `&&` operator. Commands joined
> with it in this README run fine through npm (npm hands them to `cmd.exe`) and
> in Git Bash, but typed directly into PowerShell 5.1 they need `;` instead.

---

## Setting it up

### 1. Create the Supabase project

Sign up at [supabase.com](https://supabase.com), create a project, and choose a
region close to your users.

### 2. Apply the database

In the Supabase dashboard, open **SQL Editor** and run these four files **in
order**, one at a time, from `supabase/migrations/`:

| File | What it creates |
| --- | --- |
| `0001_schema.sql` | Tables, enums, the profile trigger, invoice numbering |
| `0002_rls.sql` | Row level security — *this is the authorisation boundary* |
| `0003_functions.sql` | Marking, activation, certificates, seat movement |
| `0004_storage.sql` | The three private file buckets and their policies |

If you prefer the CLI:

```bash
npx supabase link --project-ref YOUR-PROJECT-REF
```

```bash
npx supabase db push
```

### 3. Point the site at the project

In Supabase, open **Settings → API** and copy the **Project URL** and the
**anon public** key into `site/assets/js/env.js`.

Both values are public by design. The anon key identifies the project and
nothing more — every table it can reach is protected by the policies in
`0002_rls.sql`. The **`service_role` key must never appear anywhere under
`site/`**; it bypasses all of them.

### 4. Create the first WHA administrator

There is no seed data and no default login. Register through the site like any
learner, then promote yourself once, in **SQL Editor**:

```sql
update public.profiles set role = 'WHA_ADMIN' where email = 'you@wha.co.za';
```

From then on the admin area at `/admin/invoices.html` is available, and you can
build the catalogue from `/admin/programs.html`.

### 5. Deploy the site

Connect the repository in Netlify, or drag the `site/` folder onto
[app.netlify.com/drop](https://app.netlify.com/drop). `netlify.toml` already
sets the publish directory, the build command and the security headers — there
is still no framework to detect, so decline if Netlify offers.

The build command only re-runs `build/prerender.mjs`, so that a deploy picks up
catalogue changes. It is deliberately written so it cannot fail a deploy: if
Supabase is unreachable the committed HTML ships as it stands. Dragging the
folder onto Netlify Drop skips the step entirely and still gives you a complete
site — just one whose public pages show the catalogue as of the last time
someone ran `npm run generate`.

Three things to update after the first deploy:

- Set **`WHA_SITE_URL`** in `netlify.toml` (and as an Edge Function secret) to
  the real domain. Canonical URLs, `og:` tags and `sitemap.xml` are absolute
  and are baked in at generate time, so until you do they point at
  `https://wha.co.za`.

- In `netlify.toml`, replace `*.supabase.co` in the `Content-Security-Policy`
  with your own project host if you want to tighten it.
- In Supabase, under **Authentication → URL Configuration**, set the **Site
  URL** to your Netlify domain and add it to the redirect allow-list, so
  password resets and email confirmations come back to the right place.

### 6. Deploy the functions

Invoice PDFs, certificate PDFs and transactional email run as Supabase Edge
Functions:

```bash
npx supabase functions deploy send-mail invoice-pdf certificate-pdf
```

Then set their secrets:

```bash
npx supabase secrets set RESEND_API_KEY=re_... MAIL_FROM="WHA Learning Portal <noreply@wha.co.za>" WHA_SITE_URL=https://your-domain.co.za
```

Without `RESEND_API_KEY` the portal still works — messages are logged and
skipped rather than sent, so you can go live and wire up mail afterwards.

---

## Before going live

- [ ] Replace the **placeholder VAT number, company registration number and
      bank account**. These live in two places, and both matter: the site
      shows them (`site/assets/js/config.js`) and the invoice PDF prints them
      (Edge Function secrets `WHA_VAT_NUMBER`, `WHA_REG_NUMBER`,
      `WHA_BANK_*` — see `supabase/functions/_shared/wha.ts`).
- [ ] Set `WHA_SITE_URL` to the real domain, in **both** places: the Edge
      Function secrets (certificate QR codes embed it) and `netlify.toml`
      (canonical URLs, `og:` tags and `sitemap.xml` are baked in at generate
      time). Then re-run `npm run generate` and commit.
- [ ] Set `RESEND_API_KEY` and `MAIL_FROM`, and verify the sending domain.
- [ ] Decide whether **Authentication → Email → Confirm email** is on. With it
      on, new accounts must click a link before they can sign in; the register
      and invite pages already handle both cases.
- [ ] Add the real lesson video URLs via **Programmes → lesson → Video source**.

---

## How the product works

**Buying.** Catalogue → programme → *Enrol*. Checkout captures individual or
company, seat count and billing details, then issues a numbered VAT invoice
(`WHA-INV-{year}-{seq}`, 15% VAT) as a PDF, emailed and downloadable.

**Activation.** The buyer uploads proof of payment; a WHA admin reviews it
beside the invoice at `/admin/invoices.html` and activates. That creates one
enrollment row per seat and writes an `audit_log` entry recording who approved
it. Individuals are auto-assigned their seat; company seats land in a pool for
the team administrator to allocate.

**Learning.** A split player: curriculum sidebar with per-lesson ticks and
per-course rings, content pane for video (embed URL *or* self-hosted file),
written HTML and PDFs with downloadable attachments, and a sticky
*Mark complete → Next lesson* bar that ticks optimistically.

**Assessment.** One assessment per course, one question per screen, review
before submit. **Marking happens entirely in the database** — see below.
Assessments unlock only once every lesson in the course is ticked off.

**Certificates.** When every course is complete the certificate issues with a
unique serial and a QR code pointing at `/verify/`, a public page anyone can
use to confirm it is genuine.

**Teams.** `/team/` shows seats purchased vs allocated, a live progress table,
CSV export, and invitations that can carry a seat allocation so a colleague is
ready to learn the moment they set a password.

### Progress rules

`site/assets/js/progress.js` is the single source of truth for every percentage
on screen — the dashboard, sidebar and team table all call it, so they cannot
disagree.

- lesson complete → a `lesson_progress` row exists
- course complete → every lesson ticked **and** its assessment passed
- programme complete → every course complete

The bar counts *steps* (one per lesson plus one per assessment), so it reaches
100% exactly when the certificate unlocks rather than sitting at 100% while a
failed assessment silently blocks it.

### Proof-of-payment storage

Every proof of payment stays in the private `proofs` Storage bucket for as
long as the order exists — **not** emailed instead of stored, and not deleted
after activation. South African tax law (SARS) requires financial records to
be kept for five years, and email is not an access-controlled, auditable
record tied to the order the way a Storage object gated by
[RLS](supabase/migrations/0004_storage.sql) is; it's a fine *notification*
channel (which is what `send-mail` uses it for), a poor system of record.

What actually controls the bucket's size is file size, not retention, so
`site/assets/js/image-compress.js` downscales and re-encodes image proofs
(screenshots, mostly) to a JPEG capped at 1600px on the long edge before
upload — typically a 50-90% reduction with no loss anyone reviewing a
reference number and an amount would notice. PDFs pass through untouched;
they're usually small already. The bucket's own 10 MB per-file cap
(`supabase/migrations/0004_storage.sql`) is the backstop.

In practice this keeps the bucket small on its own: at, say, 300 invoices a
year and ~150 KB per compressed proof, that's under 50 MB/year — Supabase's
free tier alone (1 GB) covers well over a decade of that, and the paid tiers'
overage pricing (a few cents per GB) makes this a non-problem even at much
higher volume. If it's ever genuinely worth revisiting — many years in, at a
much larger training business — the option is a scheduled job that moves
proofs attached to orders older than N years to cheaper cold storage, not a
change to what's kept.

---

## Generated files

Most of `site/` is hand-written and stays that way. A few regions of a few
files are produced by the two scripts in `build/`, each marked in the HTML with
a comment saying so. Both rewrite committed files in place — there is no output
directory, and `site/` remains the finished website either way.

```bash
npm run generate
```

```bash
npm run check
```

`check` re-derives everything and fails if what is committed differs. Worth
running in CI; it is the guard against someone hand-editing generated markup
and losing it on the next run.

### `build/preloads.mjs` — resource hints

Rewrites the `<!-- resource hints -->` block in every page's `<head>`: a
`preconnect` to Supabase, and a `modulepreload` for each module that page's
graph pulls in.

Without it the browser discovers those modules four levels deep — it fetches a
page module to learn it needs `shell.js`, parses that to learn it needs
`session.js`, and so on — so a page's dozen modules arrive in four serial
waves. Naming them up front collapses that to one, which is also what makes the
`no-cache` policy on `/assets/js/*` affordable (see `netlify.toml`).

**Run it after changing what a page module imports.** Forgetting costs a round
trip, never correctness: a missing hint is a module discovered the slow way, a
stale one is a module fetched slightly early and then used anyway.

### `build/prerender.mjs` — the public pages

Fills in the content of the landing page, the catalogue, and one file per
published programme, plus `sitemap.xml` and `robots.txt`.

The signed-in half of the portal can render itself in the browser and lose
nothing. The public half cannot: client-rendered, `/programs` ships the words
"Loading the catalogue…", and every programme shares one URL with one
hardcoded `<title>`, so a link pasted into WhatsApp or LinkedIn unfurls as
"Programme — WHA Learning Portal". Unfurlers and crawlers do not run
JavaScript.

It owns no markup of its own. It imports the same render functions the browser
runs — `programNodes()` from `pages/program.js`, `publicHeaderNodes()` from
`shell.js` — and runs them against a DOM in Node, so there is no second copy of
a template to drift. It queries through `catalog.js` for the same reason, using
the vendored Supabase build rather than a dependency of its own.

It runs as **anon**, so row level security hands it published programmes only.
That is deliberate: a draft gets no file, stays out of the sitemap, and remains
reachable at `/programs/program.html?slug=…` for the WHA staff who can see it.
Unpublish a programme and the next run deletes its file.

**Run it after changing the catalogue** — or let the Netlify deploy do it. The
pages still fetch and re-render in the browser, so a stale generated copy is a
stale first paint, never stale data.

---

## Security

The browser holds an anon key and can issue any query it likes. What stops it
is entirely in the database.

**Row level security** replaces what `requireUser()` and `requireRole()` did on
the server. `0002_rls.sql` is a direct port: an order is visible to the person
who placed it, to administrators of the organisation it was billed to, and to
WHA staff — nobody else, including other members of the same organisation.

**The answer key is unreachable.** `choices.is_correct` is granted to no client
role. It is a *column-level* grant, not a policy, because row level security
cannot hide one column of a row you are otherwise allowed to read — and not a
`REVOKE` after a table grant, because PostgreSQL keeps table and column
privileges separately and the revoke would silently do nothing. Postgres checks
column privileges in `WHERE` and `RETURNING` too, so filtering or grouping by it
fails the same way. Marking happens inside `submit_quiz_attempt()`; the admin
editor reads the key back through `admin_quiz()`, which checks `is_wha_admin()`.

**Nothing consequential is a client write.** There is no INSERT policy on
`orders`, `quiz_attempts`, `answer_records`, `certificates`, `invites` or
`audit_log`. Those rows only ever appear from inside a `SECURITY DEFINER`
function that re-checks its own gates: `create_order_with_invoice()` reads the
price from the programme rather than the request, `activate_order()` requires a
WHA admin, and `issue_certificate()` recomputes completion in SQL before it
mints a serial.

**Files are never public by URL.** All three storage buckets are private, and
the browser gets short-lived signed URLs whose issue is governed by the same
rules as the underlying rows.

### Checking it

`supabase/tests/run.mjs` rebuilds a database from the migrations and drives a
full purchase → activate → learn → assess → certify flow as the real roles,
probing each boundary above.

> **This destroys whatever database you point it at.** Its first statements are
> `drop schema public cascade`, followed by dropping the `auth` and `storage`
> schemas and the `anon`, `authenticated` and `service_role` roles — which
> `_stubs.sql` then replaces with stand-ins. Aimed at a Supabase project it
> would take the catalogue, the learners, the orders and the certificates with
> it, and leave the project itself broken. It wants a **local, throwaway
> Postgres and nothing else** — not production, and not a spare Supabase
> project either.
>
> It is also a Node script, not SQL. It cannot be pasted into the Supabase SQL
> Editor, and you would not want it to run there if it could.

The disposable Postgres, using [Docker](https://docs.docker.com/get-started/get-docker/).
`--rm` means the container and everything in it is thrown away on stop, which
is the property that makes this safe:

```bash
npm run db:start
```

Give it a few seconds the first time while Postgres initialises, then install
the test's own dependency and run it:

```bash
cd supabase/tests && npm install
```

```bash
npm test
```

```bash
npm run db:stop
```

The defaults in `run.mjs` (`127.0.0.1:5455`, user and password `postgres`)
match what `npm run db:start` creates, so nothing needs configuring. For any
other Postgres 14+, point it there instead — and re-read the warning above
before you do:

```bash
WHA_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres node supabase/tests/run.mjs
```

The auth and storage schemas are stubs, so this exercises the schema, the
policies and the RPCs rather than Supabase's own auth implementation. That part
only gets tested against a real project.

---

## Project layout

```
site/
  index.html              landing
  programs/               catalogue, programme detail
  verify/                 public certificate verification
  login.html  register.html  invite.html
  dashboard.html  certificates.html  checkout.html
  learn/                  programme overview, lesson, assessment
  orders/  team/  admin/
  assets/css/             tokens, base, layout, components, learn
  assets/js/              one module per page under pages/, shared modules above
  assets/vendor/          the Supabase library, vendored
  sitemap.xml  robots.txt      generated
build/
  preloads.mjs            rewrites the resource hints in every <head>
  prerender.mjs           fills in the public pages, sitemap and robots
supabase/
  migrations/             schema, RLS, functions, storage
  functions/              send-mail, invoice-pdf, certificate-pdf
  tests/                  security and behaviour checks
```

Each page is a small HTML shell that loads its own module from
`assets/js/pages/`. Shared behaviour lives one level up: `session.js` (who is
signed in), `supabase.js` (the client), `progress.js` (percentages), `ui.js`
(design-system primitives), `shell.js` (header and footer).
