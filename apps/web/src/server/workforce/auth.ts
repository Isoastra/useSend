import { randomUUID } from "node:crypto";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { workforcePool } from "./provider";
import { workforceUser, workforceAdmission } from "./native";
export function createWorkforceAuthAdapter(prismaAdapter: Adapter): Adapter {
  return {
    ...prismaAdapter,
    async createSession(input) {
      const pool = workforcePool();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [
          input.userId,
        ]);
        const w = await workforceUser(c, input.userId);
        if (!w) {
          await c.query("COMMIT");
          return prismaAdapter.createSession!(input);
        }
        if (
          !(await workforceAdmission(
            c,
            input.userId,
            process.env.WORKFORCE_SCIM_SCOPE ?? "",
          ))
        )
          throw new Error("Workforce admission denied");
        const row = (
          await c.query(
            'INSERT INTO "Session"(id,"userId","sessionToken",expires) VALUES($1,$2,$3,$4::timestamptz AT TIME ZONE \'UTC\') RETURNING *',
            [randomUUID(), input.userId, input.sessionToken, input.expires],
          )
        ).rows[0]!;
        await c.query("COMMIT");
        return row;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    },
    async getSessionAndUser(token) {
      const value = await prismaAdapter.getSessionAndUser!(token);
      if (!value) return null;
      const w = await workforceUser(workforcePool(), value.user.id);
      return w &&
        !(await workforceAdmission(
          workforcePool(),
          value.user.id,
          process.env.WORKFORCE_SCIM_SCOPE ?? "",
        ))
        ? null
        : value;
    },
    async getUserByEmail(email) {
      const user = await prismaAdapter.getUserByEmail!(email);
      return user && (await workforceUser(workforcePool(), user.id))
        ? null
        : user;
    },
    async updateUser(input) {
      if (await workforceUser(workforcePool(), input.id))
        throw new Error("Workforce profile is controller-owned");
      return prismaAdapter.updateUser!(input);
    },
    async deleteUser(id) {
      if (await workforceUser(workforcePool(), id))
        throw new Error("Workforce identity retained");
      return prismaAdapter.deleteUser!(id);
    },
    async linkAccount(input: AdapterAccount) {
      if (await workforceUser(workforcePool(), input.userId))
        throw new Error("Workforce binding immutable");
      return prismaAdapter.linkAccount!({
        ...input,
        token_type: input.token_type?.toLowerCase() as
          Lowercase<string> | undefined,
      });
    },
    async unlinkAccount(input: {
      provider: string;
      providerAccountId: string;
      type?: string;
    }) {
      const account = await prismaAdapter.getUserByAccount!(input);
      if (account && (await workforceUser(workforcePool(), account.id)))
        throw new Error("Workforce binding immutable");
      return prismaAdapter.unlinkAccount!(input);
    },
  } as Adapter;
}
export async function workforceSignIn(
  user: { email?: string | null; id?: string | number; name?: string | null },
  account:
    | { provider: string; providerAccountId: string; type?: string }
    | null
    | undefined,
): Promise<boolean | null> {
  const pool = workforcePool();
  if (account?.provider === "oidc") {
    const linked = (
      await pool.query(
        'SELECT "userId" FROM "Account" WHERE provider=\'oidc\' AND "providerAccountId"=$1',
        [account.providerAccountId],
      )
    ).rows[0];
    if (!linked) return false;
    const w = await workforceUser(pool, linked.userId);
    return w
      ? w.issuer === process.env.OIDC_ISSUER &&
          (await workforceAdmission(
            pool,
            linked.userId,
            process.env.WORKFORCE_SCIM_SCOPE ?? "",
          ))
      : true;
  }
  if (
    user.email &&
    (
      await pool.query(
        'SELECT w.user_id FROM usesend_workforce w JOIN "User" u ON u.id=w.user_id WHERE u.email=$1',
        [user.email],
      )
    ).rows[0]
  )
    return false;
  return null;
}
