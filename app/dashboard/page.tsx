import { cookies } from "next/headers";
import { decodeIdToken } from "@/app/lib/jwt";
import DashboardClient from "@/app/components/dashboard/DashboardClient";

export const metadata = {
  title: "Dashboard | PinHaoYun",
};

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("id_token")?.value;
  let username = "Explorer";
  let userId = "";
  if (token) {
    const payload = decodeIdToken(token) as Record<string, string | undefined>;
    username =
      payload.given_name ||
      payload.preferred_username ||
      payload["cognito:username"] ||
      payload.email ||
      username;
    userId =
      payload.email ||
      payload["cognito:username"] ||
      payload.sub ||
      "";
  }

  return (
    <main className="dashboard-main">
      <DashboardClient userId={userId} username={username} />
    </main>
  );
}
