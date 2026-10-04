import { getServerSession } from "next-auth";
import { authOptions } from "~/server/auth";
import { workforcePool } from "~/server/workforce/provider";
import { workforceAdmission, workforceUser } from "~/server/workforce/native";
export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const pool = workforcePool();
  if (
    !(await workforceAdmission(
      pool,
      session.user.id,
      process.env.WORKFORCE_SCIM_SCOPE ?? "",
    ))
  )
    return new Response("Unauthorized", { status: 401 });
  const w = await workforceUser(pool, session.user.id);
  return Response.json({
    id: String(session.user.id),
    name: session.user.name,
    email: session.user.email,
    grants: w!.grants,
    revocationEpoch: String(w!.revocation_epoch),
  });
}
