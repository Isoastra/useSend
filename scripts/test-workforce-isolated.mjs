import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Native lifecycle acceptance always owns a disposable database cluster.
const suite = {
  variable: "WORKFORCE_TEST_DATABASE_URL",
  command: "node",
  args: ["--import", "tsx", "apps/web/tests/workforce/scim.ts"],
};
const homebrew = "/opt/homebrew/opt/postgresql@18/bin";
const windowsPostgres = "C:\\Program Files\\PostgreSQL\\18\\bin";
const bin =
  process.env.POSTGRES_BIN ??
  process.env.TEST_PG_BIN ??
  (existsSync(join(homebrew, "postgres"))
    ? homebrew
    : existsSync(join(windowsPostgres, "postgres.exe"))
      ? windowsPostgres
      : "");
// macOS PostgreSQL 18 refuses to start without a valid locale in its environment.
const pgEnv = { ...process.env, LC_ALL: process.env.LC_ALL || "C" };
const binary = (name) =>
  bin ? join(bin, process.platform === "win32" ? `${name}.exe` : name) : name;
const pnpmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs");
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      command === "pnpm" ? process.execPath : command,
      command === "pnpm" ? [pnpmCli, ...args] : args,
      {
        stdio: "inherit",
        env,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
const server = createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const data = await mkdtemp(join(tmpdir(), "grid-reconciliation-pg-"));
let started = false;
try {
  await run(
    binary("initdb"),
    [
      "-D",
      data,
      "--no-locale",
      "--encoding=UTF8",
      "--auth=trust",
      "--username=grid_test",
    ],
    pgEnv,
  );
  await appendFile(
    join(data, "postgresql.conf"),
    "\nunix_socket_directories=''\n",
  );
  await run(
    binary("pg_ctl"),
    ["-D", data, "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"],
    pgEnv,
  );
  started = true;
  await run(binary("createdb"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "grid_test",
    "grid_test",
  ]);
  const url = `postgresql://grid_test@127.0.0.1:${port}/grid_test`;
  await run(suite.command, suite.args, {
    ...process.env,
    [suite.variable]: url,
    DATABASE_URL: url,
    TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
    SKIP_ENV_VALIDATION: "true",
    NEXT_PUBLIC_IS_CLOUD: "false",
    OIDC_ISSUER: "https://auth.isoastra.test",
    OIDC_CLIENT_ID: "offline",
    OIDC_CLIENT_SECRET: "offline",
    WORKFORCE_SCIM_SCOPE: "usesend:synthetic:test",
    WORKER_ENABLED: "false",
  });
} finally {
  if (started)
    await run(
      binary("pg_ctl"),
      ["-D", data, "-m", "fast", "-w", "stop"],
      pgEnv,
    );
  await rm(data, { recursive: true, force: true });
}
