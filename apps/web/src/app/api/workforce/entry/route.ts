import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "~/server/auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const path = !session?.user
    ? "/login"
    : session.user.isWorkforce
      ? "/api/workforce/me"
      : "/dashboard";
  return NextResponse.redirect(
    new URL(path, process.env.NEXTAUTH_URL ?? request.url),
  );
}
