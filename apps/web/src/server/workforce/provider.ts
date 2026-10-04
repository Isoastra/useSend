import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createScimProvider } from "@isoastra/fleet-scim";
import { createPostgresScimAdapter } from "@isoastra/fleet-scim/postgres";
import { nativeWorkforce, selfGrant } from "./native";
let pool: Pool | undefined;
export function workforcePool() {
  if (pool) return pool;
  const raw = new URL(process.env.DATABASE_URL!);
  const cert = process.env.WORKFORCE_DATABASE_TLS_CERT;
  if (!cert)
    return (pool = new Pool({
      connectionString: raw.toString(),
      options: "-c search_path=fleet,public",
    }));
  const leaf = readFileSync(cert, "utf8"),
    ca =
      leaf +
      (process.env.WORKFORCE_DATABASE_TLS_CA
        ? readFileSync(process.env.WORKFORCE_DATABASE_TLS_CA, "utf8")
        : "");
  const fingerprint = new X509Certificate(leaf).fingerprint256;
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"])
    raw.searchParams.delete(key);
  return (pool = new Pool({
    connectionString: raw.toString(),
    options: "-c search_path=fleet,public",
    ssl: {
      ca,
      rejectUnauthorized: true,
      checkServerIdentity: (_host, peer) =>
        peer.fingerprint256 === fingerprint
          ? undefined
          : new Error("Database certificate mismatch"),
    },
  }));
}
const equal = (a: string, b: string | undefined) =>
  Boolean(
    b &&
    b.length >= 32 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b)),
  );
export async function workforceScim(request: Request) {
  const scopeId = process.env.WORKFORCE_SCIM_SCOPE,
    baseUrl = process.env.WORKFORCE_SCIM_BASE_URL,
    issuer = process.env.OIDC_ISSUER;
  if (
    !scopeId ||
    !baseUrl ||
    !issuer ||
    !process.env.WORKFORCE_SCIM_WRITE_TOKEN
  )
    return new Response("Not configured", { status: 404 });
  const adapter = createPostgresScimAdapter(workforcePool(), nativeWorkforce, {
    applicationId: "usesend",
    scopeId,
    issuer,
    validateGrant: async (_tx, g) =>
      g.role === "workforce-self" && g.resource === scopeId,
    groupGrants: async (_tx, id) =>
      id === `workforce:${scopeId}:self` ? [selfGrant(scopeId)] : null,
  });
  const incoming = new URL(request.url);
  const canonical = new Request(
    new URL(incoming.pathname + incoming.search, baseUrl),
    request,
  );
  return createScimProvider({
    baseUrl,
    issuer,
    applicationId: "usesend",
    scopeId,
    adapter,
    authenticate: async (r) => {
      const h = r.headers.get("authorization") ?? "";
      if (!h.startsWith("Bearer ")) return false;
      return (
        equal(h.slice(7), process.env.WORKFORCE_SCIM_WRITE_TOKEN) ||
        (r.method === "GET" &&
          equal(h.slice(7), process.env.WORKFORCE_SCIM_READ_TOKEN))
      );
    },
  })(canonical);
}
