// Security and behaviour check for the WHA schema.
//
// Drives a full purchase → activate → learn → assess → certify flow through the
// RPCs as the real roles, and probes the boundaries that must hold: the answer
// key, cross-tenant order visibility, self-promotion, forged quiz attempts and
// early certificates.
//
// Runs against a throwaway Postgres — it DROPs and rebuilds the schema, so
// never point it at anything you care about.
//
//   node supabase/tests/run.mjs
//
// See that file for how the database is prepared.
import pg from "pg";

const c = new pg.Client(
  process.env.WHA_TEST_DATABASE_URL ?? {
    host: "127.0.0.1", port: 5455, user: "postgres",
    password: "postgres", database: "postgres",
  },
);
await c.connect();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

/**
 * A submit_quiz_attempt() answers payload for multiple-choice questions:
 * { "<question id>": { "choice_id": "<choice id>" }, … } — the shape
 * 0008_quiz_engine_v2.sql's submit_quiz_attempt() expects and quiz.js sends
 * (assets/js/pages/quiz.js: `answers[question.id] = { choice_id: choice.id }`).
 * Wrapped here so every call site stays in step with that shape by
 * construction, rather than each spelling out the object literal by hand.
 */
const mcAnswers = (pairs) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(pairs).map(([questionId, choiceId]) => [questionId, { choice_id: choiceId }]),
    ),
  );

// Run a block as a given role + user id, the way PostgREST would.
async function as(role, uid, fn) {
  await c.query("begin");
  await c.query(`set local role ${role}`);
  if (uid) await c.query(`set local request.jwt.claim.sub = '${uid}'`);
  try { return await fn(); }
  finally { await c.query("commit").catch(() => c.query("rollback")); }
}
async function expectError(role, uid, sql, params = []) {
  try {
    await as(role, uid, () => c.query(sql, params));
    return null;
  } catch (e) { return e; }
}

console.log("\n— Setup —");
const mk = async (email, name) => {
  const { rows } = await c.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [email, JSON.stringify({ name })]
  );
  return rows[0].id;
};
const admin = await mk("admin@wha.co.za", "WHA Admin");
const buyer = await mk("buyer@example.com", "Buyer Person");
const other = await mk("other@example.com", "Unrelated Person");
await c.query(`update public.profiles set role = 'WHA_ADMIN' where id = $1`, [admin]);
ok("auth.users trigger created profiles",
  (await c.query("select count(*)::int n from public.profiles")).rows[0].n === 3);

// Catalogue, authored as the WHA admin through the normal table writes.
const prog = await as("authenticated", admin, async () => {
  const { rows } = await c.query(
    `insert into public.programs (slug, title, summary, description, standard, price_cents, published)
     values ('iso-9001', 'ISO 9001 Foundation', 'Summary', 'Description', 'ISO 9001', 450000, true)
     returning id`);
  return rows[0].id;
});
ok("WHA admin can create a programme", !!prog);

const { course, lesson, quiz, q1, q2, right1, wrong1, right2 } =
  await as("authenticated", admin, async () => {
    const course = (await c.query(
      `insert into public.courses (program_id, title, position) values ($1,'Course One',1) returning id`,
      [prog])).rows[0].id;
    const lesson = (await c.query(
      `insert into public.lessons (course_id, title, position, type, body_html)
       values ($1,'Lesson One',1,'TEXT','<p>hi</p>') returning id`, [course])).rows[0].id;
    const quiz = (await c.query(
      `insert into public.quizzes (course_id, pass_mark_percent, max_attempts)
       values ($1, 70, 3) returning id`, [course])).rows[0].id;
    const q1 = (await c.query(
      `insert into public.questions (quiz_id, prompt, position) values ($1,'Q1',1) returning id`,
      [quiz])).rows[0].id;
    const q2 = (await c.query(
      `insert into public.questions (quiz_id, prompt, position) values ($1,'Q2',2) returning id`,
      [quiz])).rows[0].id;
    const right1 = (await c.query(
      `insert into public.choices (question_id, text, is_correct, position)
       values ($1,'right',true,1) returning id`, [q1])).rows[0].id;
    const wrong1 = (await c.query(
      `insert into public.choices (question_id, text, is_correct, position)
       values ($1,'wrong',false,2) returning id`, [q1])).rows[0].id;
    const right2 = (await c.query(
      `insert into public.choices (question_id, text, is_correct, position)
       values ($1,'right',true,1) returning id`, [q2])).rows[0].id;
    return { course, lesson, quiz, q1, q2, right1, wrong1, right2 };
  });
ok("curriculum authored", !!(course && lesson && quiz && q1 && right1));

console.log("\n— The answer key must not be readable —");
{
  const e = await expectError("authenticated", admin, "select is_correct from public.choices");
  ok("even a WHA admin cannot select choices.is_correct", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", buyer, "select * from public.choices");
  ok("`select *` on choices is refused for a learner", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", buyer,
    "select id from public.choices where is_correct = true");
  ok("is_correct cannot be used as a filter either", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", admin,
    "update public.choices set position = position returning is_correct");
  ok("is_correct cannot be read back through RETURNING", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", buyer,
    "select count(*) from public.choices group by is_correct");
  ok("is_correct cannot be leaked through GROUP BY", e?.code === "42501", e?.message);
}
{
  const r = await as("authenticated", admin, () =>
    c.query("select id, text, position from public.choices where question_id = $1", [q1]));
  ok("the safe columns of choices are still readable", r.rows.length === 2);
}
{
  const r = await as("authenticated", admin, async () => (await c.query(
    "select public.admin_quiz($1) as r", [quiz])).rows[0].r);
  const key = r?.questions?.find((q) => q.id === q1)?.choices ?? [];
  ok("a WHA admin reads the answer key through admin_quiz()",
    key.find((ch) => ch.id === right1)?.is_correct === true &&
    key.find((ch) => ch.id === wrong1)?.is_correct === false, JSON.stringify(r)?.slice(0, 200));
}
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    "select public.admin_quiz($1) as r", [quiz])).rows[0].r);
  ok("a learner calling admin_quiz() gets nothing", r === null, JSON.stringify(r));
}

console.log("\n— Catalogue visibility —");
{
  const r = await as("anon", null, () => c.query("select id from public.programs"));
  ok("anon sees the published programme", r.rows.length === 1);
  await c.query(`update public.programs set published = false where id = $1`, [prog]);
  const r2 = await as("anon", null, () => c.query("select id from public.programs"));
  ok("anon cannot see an unpublished programme", r2.rows.length === 0);
  await c.query(`update public.programs set published = true where id = $1`, [prog]);
}
{
  const e = await expectError("authenticated", buyer,
    `insert into public.programs (slug,title,summary,description,price_cents)
     values ('x','x','x','x',1)`);
  ok("a learner cannot create a programme", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", buyer,
    `update public.profiles set role = 'WHA_ADMIN' where id = $1`, [buyer]);
  ok("a learner cannot promote themselves", !!e, "no error raised");
}

console.log("\n— Checkout —");
const order = await as("authenticated", buyer, async () => {
  const { rows } = await c.query(
    `select public.create_order_with_invoice($1,'INDIVIDUAL',1,null,null,'buyer@example.com',
      '1 Road',null,'Cape Town','7945') as r`, [prog]);
  return rows[0].r;
});
ok("order created", order.ok === true, order.error);
ok("invoice number is WHA-INV-<year>-0001",
  order.invoice_number === `WHA-INV-${new Date().getFullYear()}-0001`, order.invoice_number);
{
  const t = (await c.query(
    `select subtotal_cents, vat_cents, total_cents from public.orders where id = $1`,
    [order.order_id])).rows[0];
  ok("VAT is 15% of subtotal",
    t.subtotal_cents === 450000 && t.vat_cents === 67500 && t.total_cents === 517500,
    JSON.stringify(t));
}
{
  const second = await as("authenticated", other, async () => (await c.query(
    `select public.create_order_with_invoice($1,'INDIVIDUAL',1,null,null,'other@example.com',
      null,null,null,null) as r`, [prog])).rows[0].r);
  ok("the next invoice number increments",
    second.invoice_number === `WHA-INV-${new Date().getFullYear()}-0002`, second.invoice_number);
}
{
  const r = await as("authenticated", other, () =>
    c.query("select id from public.orders where id = $1", [order.order_id]));
  ok("an unrelated user cannot see someone else's order", r.rows.length === 0);
}
{
  const r = await as("authenticated", admin, () =>
    c.query("select id from public.orders where id = $1", [order.order_id]));
  ok("a WHA admin can see it", r.rows.length === 1);
}

console.log("\n— Activation —");
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.activate_order($1, 'trying it on') as r`, [order.order_id])).rows[0].r);
  ok("a buyer cannot activate their own order", r.ok === false, JSON.stringify(r));
}
const activated = await as("authenticated", admin, async () => (await c.query(
  `select public.activate_order($1, 'paid by EFT') as r`, [order.order_id])).rows[0].r);
ok("a WHA admin can activate", activated.ok === true, activated.error);
const enrollment = (await c.query(
  `select id from public.enrollments where order_id = $1`, [order.order_id])).rows[0]?.id;
ok("one seat exists and is auto-assigned to the individual buyer",
  !!enrollment &&
  (await c.query(`select user_id from public.enrollments where id = $1`, [enrollment]))
    .rows[0].user_id === buyer);
ok("activation wrote an audit entry",
  (await c.query(`select count(*)::int n from public.audit_log where action='order.activated'`))
    .rows[0].n === 1);
{
  const r = await as("authenticated", admin, async () => (await c.query(
    `select public.activate_order($1) as r`, [order.order_id])).rows[0].r);
  ok("activating twice is refused", r.ok === false, JSON.stringify(r));
}

console.log("\n— Assessment —");
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.submit_quiz_attempt($1,$2,$3::jsonb) as r`,
    [enrollment, quiz, mcAnswers({ [q1]: right1, [q2]: right2 })])).rows[0].r);
  ok("the assessment is locked until the lessons are done", r.ok === false, JSON.stringify(r));
}
await as("authenticated", buyer, () => c.query(
  `insert into public.lesson_progress (enrollment_id, lesson_id) values ($1,$2)`,
  [enrollment, lesson]));
ok("the seat holder can tick a lesson off",
  (await c.query(`select count(*)::int n from public.lesson_progress`)).rows[0].n === 1);
{
  const e = await expectError("authenticated", other,
    `insert into public.lesson_progress (enrollment_id, lesson_id) values ($1,$2)`,
    [enrollment, lesson]);
  ok("someone else cannot tick off a lesson on that seat", e?.code === "42501", e?.message);
}
{
  const e = await expectError("authenticated", buyer,
    `insert into public.quiz_attempts (quiz_id, enrollment_id, score_percent, passed)
     values ($1,$2,100,true)`, [quiz, enrollment]);
  ok("a learner cannot write their own passing attempt", e?.code === "42501", e?.message);
}
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.submit_quiz_attempt($1,$2,$3::jsonb) as r`,
    [enrollment, quiz, mcAnswers({ [q1]: wrong1, [q2]: right2 })])).rows[0].r);
  ok("a half-right attempt scores 50 and fails",
    r.ok === true && r.score_percent === 50 && r.passed === false, JSON.stringify(r));
  ok("attempts_left is reported as 2", r.attempts_left === 2, JSON.stringify(r));
}
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.submit_quiz_attempt($1,$2,$3::jsonb) as r`,
    [enrollment, quiz, mcAnswers({ [q1]: right1 })])).rows[0].r);
  ok("an incomplete submission is refused", r.ok === false, JSON.stringify(r));
}
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.submit_quiz_attempt($1,$2,$3::jsonb) as r`,
    [enrollment, quiz, mcAnswers({ [q1]: right1, [q2]: right1 })])).rows[0].r);
  ok("a choice from another question is refused", r.ok === false, JSON.stringify(r));
}

console.log("\n— Certificate —");
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.issue_certificate($1) as r`, [enrollment])).rows[0].r);
  ok("no certificate while the assessment is unpassed", r.ok === false, JSON.stringify(r));
}
{
  const r = await as("authenticated", buyer, async () => (await c.query(
    `select public.submit_quiz_attempt($1,$2,$3::jsonb) as r`,
    [enrollment, quiz, mcAnswers({ [q1]: right1, [q2]: right2 })])).rows[0].r);
  ok("a full-marks attempt passes", r.ok === true && r.score_percent === 100 && r.passed,
    JSON.stringify(r));
}
ok("passing the last assessment completes the enrolment",
  (await c.query(`select status from public.enrollments where id=$1`, [enrollment]))
    .rows[0].status === "COMPLETED");
const cert = await as("authenticated", buyer, async () => (await c.query(
  `select public.issue_certificate($1) as r`, [enrollment])).rows[0].r);
ok("the certificate issues", cert.ok === true, cert.error);
ok("serial is WHA-CERT-<year>-00001",
  cert.serial === `WHA-CERT-${new Date().getFullYear()}-00001`, cert.serial);
ok("the verify code uses the unambiguous alphabet, grouped",
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/
    .test(cert.verify_code), cert.verify_code);
{
  const again = await as("authenticated", buyer, async () => (await c.query(
    `select public.issue_certificate($1) as r`, [enrollment])).rows[0].r);
  ok("issuing twice returns the same serial, not a second one",
    again.serial === cert.serial, `${again.serial} vs ${cert.serial}`);
}
{
  const r = await as("anon", null, async () => (await c.query(
    `select public.verify_certificate($1) as r`, [cert.verify_code])).rows[0].r);
  ok("anon can verify a genuine certificate",
    r.found === true && r.serial === cert.serial, JSON.stringify(r));
  const lower = await as("anon", null, async () => (await c.query(
    `select public.verify_certificate($1) as r`,
    [cert.verify_code.toLowerCase().replace(/-/g, "")])).rows[0].r);
  ok("verification is case- and dash-insensitive", lower.found === true);
  const bogus = await as("anon", null, async () => (await c.query(
    `select public.verify_certificate('ZZZZ-ZZZZ-ZZZZ') as r`)).rows[0].r);
  ok("a bogus code reports not found", bogus.found === false);
}
{
  const e = await expectError("anon", null, "select * from public.certificates");
  const r = e ? { rows: [] } : await as("anon", null, () =>
    c.query("select * from public.certificates"));
  ok("anon cannot read the certificates table directly", !!e || r.rows.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
await c.end();
process.exit(fail ? 1 : 0);
