import { randomUUID } from "node:crypto";
import { ScimError, type WorkforceGrant } from "@isoastra/fleet-scim";
import type {
  ScimNativeAdapter,
  ScimQueryable,
} from "@isoastra/fleet-scim/postgres";
export const selfGrant = (scopeId: string): WorkforceGrant => ({
  role: "workforce-self",
  resource: scopeId,
});
export const nativeWorkforce: ScimNativeAdapter = {
  async resolveUser(tx, input) {
    const linked = (
      await tx.query(
        'SELECT "userId" FROM "Account" WHERE provider=$1 AND "providerAccountId"=$2',
        ["oidc", input.principal.subject],
      )
    ).rows[0];
    if (linked) {
      const owned = (
        await tx.query(
          "SELECT user_id FROM usesend_workforce WHERE user_id=$1 AND issuer=$2 AND subject=$3 AND scope_id=$4",
          [
            linked.userId,
            input.principal.issuer,
            input.principal.subject,
            input.scopeId,
          ],
        )
      ).rows[0];
      if (!owned)
        throw new ScimError(
          409,
          "uniqueness",
          "Existing application identity is outside workforce ownership",
        );
      return String(linked.userId);
    }
    const name =
      [input.name?.givenName, input.name?.familyName]
        .filter(Boolean)
        .join(" ") || input.userName;
    try {
      const row = (
        await tx.query(
          'INSERT INTO "User"(name,email,"emailVerified","isBetaUser","isWaitlisted") VALUES($1,$2,now(),false,true) RETURNING id',
          [name, input.userName],
        )
      ).rows[0]!;
      await tx.query(
        'INSERT INTO "Account"(id,"userId",type,provider,"providerAccountId") VALUES($1,$2,\'oauth\',\'oidc\',$3)',
        [randomUUID(), row.id, input.principal.subject],
      );
      await tx.query(
        "INSERT INTO usesend_workforce(user_id,issuer,subject,scope_id) VALUES($1,$2,$3,$4)",
        [
          row.id,
          input.principal.issuer,
          input.principal.subject,
          input.scopeId,
        ],
      );
      return String(row.id);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ScimError(
          409,
          "uniqueness",
          "Native identity conflicts with an existing account",
        );
      throw error;
    }
  },
  async applyUser(tx, input) {
    await tx.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [
      input.userId,
    ]);
    const name =
      [input.name?.givenName, input.name?.familyName]
        .filter(Boolean)
        .join(" ") || input.userName;
    await tx.query(
      'UPDATE "User" SET name=$2,email=$3,"isWaitlisted"=true,"isBetaUser"=false WHERE id=$1',
      [input.userId, name, input.userName],
    );
    await tx.query(
      "UPDATE usesend_workforce SET active=$2,grants=$3::jsonb,revocation_epoch=$4 WHERE user_id=$1",
      [
        input.userId,
        input.active,
        JSON.stringify(input.grants),
        input.revocationEpoch,
      ],
    );
    if (input.revoke) {
      await tx.query('DELETE FROM "Session" WHERE "userId"=$1', [input.userId]);
      await tx.query(
        'UPDATE "Account" SET access_token=NULL,refresh_token=NULL,id_token=NULL,expires_at=NULL,refresh_token_expires_in=NULL WHERE "userId"=$1',
        [input.userId],
      );
    }
    // Workforce cannot enter team procedures, mint team API keys, or issue delegated credentials.
    return { sessions: true, tokens: true, delegations: true };
  },
  async readUser(tx, input) {
    const row = (
      await tx.query(
        'SELECT w.active,w.grants,w.revocation_epoch FROM usesend_workforce w JOIN "User" u ON u.id=w.user_id WHERE w.user_id=$1 AND w.scope_id=$2 FOR UPDATE OF u',
        [input.userId, input.scopeId],
      )
    ).rows[0];
    return row
      ? {
          active: Boolean(row.active),
          grants: row.grants as WorkforceGrant[],
          revocationEpoch: String(row.revocation_epoch),
        }
      : null;
  },
};
export async function workforceUser(
  tx: ScimQueryable,
  userId: string | number,
) {
  return (
    (
      await tx.query("SELECT * FROM usesend_workforce WHERE user_id=$1", [
        userId,
      ])
    ).rows[0] ?? null
  );
}
export async function workforceAdmission(
  tx: ScimQueryable,
  userId: string | number,
  scopeId: string,
) {
  const w = await workforceUser(tx, userId);
  return Boolean(
    w?.active &&
    w.scope_id === scopeId &&
    (w.grants as WorkforceGrant[]).some(
      (g) => g.role === "workforce-self" && g.resource === scopeId,
    ),
  );
}
