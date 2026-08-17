// Rebuild a throwaway database from the migrations, then run security.mjs
// against it.
//
//   node supabase/tests/run.mjs
//
// Needs a Postgres to talk to and the `pg` package. The simplest source of both
// on this machine is the embedded server the old Next.js app used:
//
//   cd wha-portal && npm run db:start          # Postgres on :5433
//   WHA_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres \
//     node ../supabase/tests/run.mjs
//
// The auth and storage schemas Supabase provides are stubbed by _stubs.sql, so
// this exercises the schema, the policies and the RPCs — not Supabase's own
// auth implementation. Deploy to a real project to test that.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, "..", "migrations");

const connection =
  process.env.WHA_TEST_DATABASE_URL ?? {
    host: "127.0.0.1", port: 5455, user: "postgres",
    password: "postgres", database: "postgres",
  };

const client = new pg.Client(connection);
await client.connect();

console.log("Rebuilding schema…");
await client.query("drop schema if exists public cascade; create schema public;");
await client.query(
  "drop schema if exists auth cascade;" +
  "drop schema if exists storage cascade;" +
  "drop schema if exists extensions cascade;",
);
await client.query(
  "drop role if exists anon;" +
  "drop role if exists authenticated;" +
  "drop role if exists service_role;",
);

const files = [
  join(here, "_stubs.sql"),
  join(migrations, "0001_schema.sql"),
  join(migrations, "0002_rls.sql"),
  join(migrations, "0003_functions.sql"),
  join(migrations, "0004_storage.sql"),
];

for (const file of files) {
  const name = file.split(/[\\/]/).pop();
  try {
    await client.query(readFileSync(file, "utf8"));
    console.log(`  applied ${name}`);
  } catch (error) {
    console.error(`  FAILED  ${name}: ${error.message}`);
    if (error.hint) console.error(`  hint: ${error.hint}`);
    await client.end();
    process.exit(1);
  }
}

await client.end();

const result = spawnSync(process.execPath, [join(here, "security.mjs")], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
