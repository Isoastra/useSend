import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  SCIM_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
  WORKFORCE_USER_SCHEMA as U,
  WORKFORCE_GROUP_SCHEMA as G,
  workforceExternalId,
} from "@isoastra/fleet-scim";
import {
  createWorkforceAuthAdapter,
  workforceSignIn,
} from "../../src/server/workforce/auth";
import { PrismaClient } from "@prisma/client";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
const db = new PrismaClient();
import { workforcePool } from "../../src/server/workforce/provider";
const pool = new Pool({
  connectionString: process.env.WORKFORCE_TEST_DATABASE_URL,
});
let server: ReturnType<typeof spawn> | undefined;
let redis: ReturnType<typeof spawn> | undefined;
const issuer = "https://auth.isoastra.test",
  scope = "usesend:synthetic:test";
const port = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
try {
  execFileSync("pnpm", ["--filter", "web", "db:migrate-deploy"], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.WORKFORCE_TEST_DATABASE_URL,
    },
    stdio: "pipe",
  });
  await pool.query(`INSERT INTO "User"(id,name,email,"isBetaUser","isWaitlisted") VALUES(1000,'Owner','owner@test.invalid',true,false),(1001,'Customer','existing@test.invalid',true,false);
 INSERT INTO "Account"(id,"userId",type,provider,"providerAccountId") VALUES('owner',1000,'oauth','oidc','owner-sub');
 INSERT INTO "Team"(id,name,"updatedAt") VALUES(1000,'Existing team',now());
 INSERT INTO "TeamUser"("teamId","userId",role) VALUES(1000,1000,'ADMIN'),(1000,1001,'MEMBER');
 INSERT INTO "ApiKey"("clientId","tokenHash","partialToken",name,"updatedAt","teamId") VALUES('existing-service','qualification-hash','test','Existing service',now(),1000);`);
  const httpPort = await port(),
    redisPort = await port(),
    origin = `http://127.0.0.1:${httpPort}`;
  redis = spawn(
    "/opt/homebrew/opt/redis/bin/redis-server",
    [
      "--port",
      String(redisPort),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: "ignore" },
  );
  const token = "workforce-native-test-writer-bearer-at-least-32-chars",
    read = "workforce-native-test-reader-bearer-at-least-32-chars";
  server = spawn(
    process.execPath,
    [
      resolve("apps/web/node_modules/next/dist/bin/next"),
      "start",
      "-p",
      String(httpPort),
      "-H",
      "127.0.0.1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: resolve("apps/web"),
      env: {
        ...process.env,
        DATABASE_URL: process.env.WORKFORCE_TEST_DATABASE_URL,
        REDIS_URL: `redis://127.0.0.1:${redisPort}`,
        SKIP_ENV_VALIDATION: "true",
        NODE_ENV: "production",
        NEXT_PUBLIC_IS_CLOUD: "false",
        WORKER_ENABLED: "false",
        NEXTAUTH_SECRET: "native-workforce-fixture-secret-32chars",
        NEXTAUTH_URL: origin,
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: "offline",
        OIDC_CLIENT_SECRET: "offline",
        WORKFORCE_SCIM_SCOPE: scope,
        WORKFORCE_SCIM_BASE_URL: origin + "/scim/v2",
        WORKFORCE_SCIM_WRITE_TOKEN: token,
        WORKFORCE_SCIM_READ_TOKEN: read,
        ADMIN_EMAIL: "owner@test.invalid",
      },
    },
  );
  let logs = "";
  server.stdout?.on("data", (v) => (logs += v));
  server.stderr?.on("data", (v) => (logs += v));
  let ready = false;
  for (let n = 0; n < 150; n++) {
    try {
      if (
        (await fetch(origin + "/scim/v2/ServiceProviderConfig")).status === 401
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, logs);
  const req = (
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
    bearer = token,
  ) =>
    fetch(origin + "/scim/v2/" + path, {
      method,
      headers: {
        authorization: "Bearer " + bearer,
        "content-type": "application/scim+json",
        ...(etag ? { "if-match": etag } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (await req("GET", "ServiceProviderConfig", undefined, undefined, read))
      .status,
    200,
  );
  assert.equal((await req("POST", "Users", {}, undefined, read)).status, 401);
  const payload = (
    subject: string,
    email: string,
    version = "1",
    active = true,
  ) => ({
    schemas: [SCIM_USER_SCHEMA, U],
    externalId: workforceExternalId({ issuer, subject }),
    userName: email,
    name: { givenName: "Fleet", familyName: "Qualification" },
    active,
    [U]: {
      issuer,
      subject,
      grants: [],
      authorityEpoch: "1",
      desiredVersion: version,
    },
  });
  assert.equal(
    (await req("POST", "Users", payload("collision", "existing@test.invalid")))
      .status,
    409,
  );
  assert.equal(
    (await req("POST", "Users", payload("owner-sub", "owner@test.invalid")))
      .status,
    409,
  );
  let response = await req(
    "POST",
    "Users",
    payload("employee", "employee@test.invalid"),
  );
  assert.equal(response.status, 201);
  let user = await response.json();
  const id = user.id;
  assert.equal(
    (await req("POST", "Users", payload("employee", "employee@test.invalid")))
      .status,
    201,
  );
  assert.equal(user[U].provisioningState, "confirmed");
  const adapter = createWorkforceAuthAdapter(
    PrismaAdapter(db) as unknown as Adapter,
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        adapter.createSession!({
          sessionToken: "unassigned",
          userId: id,
          expires: new Date(Date.now() + 60000),
        }),
      ),
    /Workforce admission denied/,
  );
  assert.equal(
    await workforceSignIn(
      { id: 0, name: "Unknown", email: "unknown@test.invalid" },
      {
        provider: "oidc",
        providerAccountId: "unknown",
        type: "oauth",
      },
    ),
    false,
  );
  assert.equal(
    await workforceSignIn(
      { id: Number(id), email: "employee@test.invalid" },
      {
        provider: "oidc",
        providerAccountId: "employee",
        type: "oauth",
      },
    ),
    false,
  );
  const groupBody = {
    schemas: [SCIM_GROUP_SCHEMA, G],
    externalId: `workforce:${scope}:self`,
    displayName: "Self",
    members: [{ value: id }],
    [G]: { authorityEpoch: "1", desiredVersion: "1" },
  };
  response = await req("POST", "Groups", groupBody);
  assert.equal(response.status, 201);
  let group = await response.json();
  assert.equal(
    await workforceSignIn(
      { id: Number(id), email: "employee@test.invalid" },
      {
        provider: "oidc",
        providerAccountId: "employee",
        type: "oauth",
      },
    ),
    true,
  );
  assert.equal(
    await workforceSignIn(
      { id: Number(id), email: "employee@test.invalid" },
      {
        provider: "email",
        providerAccountId: "employee@test.invalid",
        type: "email",
      },
    ),
    false,
  );
  const nativeToken = randomUUID();
  await adapter.createSession!({
    sessionToken: nativeToken,
    userId: id,
    expires: new Date(Date.now() + 60000),
  });
  const cookie =
    "next-auth.session-token=" +
    nativeToken +
    "; __Secure-next-auth.session-token=" +
    nativeToken;
  assert(await adapter.getSessionAndUser!(nativeToken));
  const authResponse = await fetch(origin + "/api/auth/session", {
    headers: { cookie },
  });
  assert.equal(authResponse.status, 200);
  const selfResponse = await fetch(origin + "/api/workforce/me", {
    headers: { cookie },
  });
  assert.equal(
    selfResponse.status,
    200,
    logs + "\nself " + (await selfResponse.text()),
  );
  const denied = await fetch(origin + "/api/trpc/team.getTeamUsers", {
    headers: { cookie },
  });
  assert.equal(denied.status, 401);
  const entry = await fetch(origin + "/api/workforce/entry", {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(entry.status, 307);
  assert.equal(
    new URL(entry.headers.get("location")!).pathname,
    "/api/workforce/me",
  );
  const ownerToken = randomUUID();
  await adapter.createSession!({
    sessionToken: ownerToken,
    userId: 1000 as never,
    expires: new Date(Date.now() + 60000),
  });
  const ownerCookie =
    "next-auth.session-token=" +
    ownerToken +
    "; __Secure-next-auth.session-token=" +
    ownerToken;
  assert.equal(
    (
      await fetch(origin + "/api/trpc/team.getTeamUsers", {
        headers: { cookie: ownerCookie },
      })
    ).status,
    200,
  );
  const ownerEntry = await fetch(origin + "/api/workforce/entry", {
    headers: { cookie: ownerCookie },
    redirect: "manual",
  });
  assert.equal(
    new URL(ownerEntry.headers.get("location")!).pathname,
    "/dashboard",
  );

  await pool.query(
    "UPDATE \"Account\" SET access_token='fixture',refresh_token='fixture',id_token='fixture' WHERE \"userId\"=$1",
    [id],
  );
  user = await (await req("GET", "Users/" + id)).json();
  response = await req(
    "PUT",
    "Users/" + id,
    {
      ...payload("employee", "renamed@test.invalid", "2"),
      name: { givenName: "Renamed", familyName: "Qualification" },
    },
    user.meta.version,
  );
  assert.equal(response.status, 200);
  user = await response.json();
  assert.equal(
    (await pool.query('SELECT email FROM "User" WHERE id=$1', [id])).rows[0]
      .email,
    "renamed@test.invalid",
  );
  response = await req(
    "PUT",
    "Groups/" + group.id,
    {
      ...groupBody,
      members: [],
      [G]: { authorityEpoch: "1", desiredVersion: "2" },
    },
    group.meta.version,
  );
  assert.equal(response.status, 200);
  group = await response.json();
  assert.equal(
    (await fetch(origin + "/api/workforce/me", { headers: { cookie } })).status,
    401,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS n FROM "Session" WHERE "userId"=$1',
        [id],
      )
    ).rows[0].n,
    "0",
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS n FROM "Account" WHERE "userId"=$1 AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL)',
        [id],
      )
    ).rows[0].n,
    "0",
  );
  response = await req("GET", "Users/" + id);
  user = await response.json();
  assert.equal(user[U].provisioningState, "confirmed");
  assert.equal(user[U].revocation.sessions, true);
  assert.equal(user[U].revocation.revision, user[U].revocationEpoch);
  await assert.rejects(
    () => pool.query("DELETE FROM usesend_workforce WHERE user_id=$1", [id]),
    /immutable/,
  );
  await assert.rejects(
    () =>
      pool.query(
        'UPDATE "Account" SET "providerAccountId"=\'rebound\' WHERE "userId"=$1',
        [id],
      ),
    /foreign key/,
  );
  await assert.rejects(
    () => Promise.resolve(adapter.updateUser!({ id, name: "Unauthorized" })),
    /controller-owned/,
  );
  await assert.rejects(
    () => Promise.resolve(adapter.deleteUser!(id)),
    /retained/,
  );
  // Native mint shares the same row lock as SCIM revoke: queued mint cannot survive disable.
  response = await req(
    "PUT",
    "Groups/" + group.id,
    { ...groupBody, [G]: { authorityEpoch: "1", desiredVersion: "3" } },
    group.meta.version,
  );
  assert.equal(response.status, 200);
  user = await (await req("GET", "Users/" + id)).json();
  const block = await pool.connect();
  await block.query("BEGIN");
  await block.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [id]);
  const disable = req(
    "PUT",
    "Users/" + id,
    payload("employee", "renamed@test.invalid", "3", false),
    user.meta.version,
  );
  let waiting = false;
  for (let n = 0; n < 50; n++) {
    const r = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT%FOR UPDATE%' AND pid<>pg_backend_pid()",
    );
    if (r.rows.length) {
      waiting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!waiting) {
    await block.query("ROLLBACK");
    block.release();
    await disable;
    assert.fail("SCIM disable did not queue behind the native user lock");
  }
  const mint = Promise.resolve(
    adapter.createSession!({
      sessionToken: "disable-race",
      userId: id,
      expires: new Date(Date.now() + 60000),
    }),
  );
  // The protocol's preliminary conditional read may queue before the write
  // transaction. A mint that wins then must be deleted by the committed revoke;
  // a mint that runs after the write transaction must fail admission.
  const minted = mint.then(
    () => true,
    (error: Error) => {
      assert.match(error.message, /denied/);
      return false;
    },
  );
  await new Promise((r) => setTimeout(r, 30));
  await block.query("COMMIT");
  block.release();
  response = await disable;
  assert.equal(response.status, 200);
  user = await response.json();
  await minted;
  assert.equal(await adapter.getSessionAndUser!("disable-race"), null);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS n FROM "Session" WHERE "userId"=$1',
        [id],
      )
    ).rows[0].n,
    "0",
  );
  assert.equal(user.active, false);
  assert.equal(user[U].provisioningState, "confirmed");
  await assert.rejects(
    () =>
      Promise.resolve(
        adapter.createSession!({
          sessionToken: "disabled",
          userId: id,
          expires: new Date(Date.now() + 60000),
        }),
      ),
    /denied/,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS n FROM "TeamUser" WHERE "teamId"=1000',
      )
    ).rows[0].n,
    "2",
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS n FROM "ApiKey" WHERE "clientId"=\'existing-service\'',
      )
    ).rows[0].n,
    "1",
  );
  assert.equal(
    (
      await pool.query(
        'SELECT "providerAccountId" FROM "Account" WHERE "userId"=1000',
      )
    ).rows[0].providerAccountId,
    "owner-sub",
  );
  console.log(
    "PASS useSend native full-schema SCIM HTTP: immutable collision/owner protection, unknown/unassigned/alternate provider denial, real adapter session mint, actual HTTP self access/customer denial, rename, mapped removal/native session and OAuth revoke, fresh confirmations, retained binding/identity, customer/service-key preservation",
  );
} finally {
  server?.kill("SIGTERM");
  redis?.kill("SIGTERM");
  await pool.end();
  await workforcePool().end();
  await db.$disconnect();
}
