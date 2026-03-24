import { cookies } from "next/headers";
import { decodeIdToken } from "@/app/lib/jwt";

export type SessionUser = {
  email: string;
  username: string | null;
  sub: string | null;
  idToken: string;
  accessToken: string | null;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const idToken = cookieStore.get("id_token")?.value;
  const accessToken = cookieStore.get("access_token")?.value ?? null;

  if (!idToken) return null;

  const payload = decodeIdToken(idToken) as Record<string, unknown>;
  const email =
    ((payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string) ||
      "")
      .toLowerCase()
      .trim();

  if (!email) return null;

  const username =
    (payload.given_name as string) ||
    (payload.preferred_username as string) ||
    (payload["cognito:username"] as string) ||
    (payload.email as string) ||
    null;

  return {
    email,
    username,
    sub: (payload.sub as string) || null,
    idToken,
    accessToken,
  };
}
