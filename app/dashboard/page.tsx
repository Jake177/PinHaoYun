import { cookies } from "next/headers";
import { decodeIdToken } from "@/app/lib/jwt";
import LogoutButton from "@/app/components/dashboard/LogoutButton";

export const metadata = {
  title: "Dashboard | PinHaoYun",
};

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = (await cookieStore).get("id_token")?.value;
  let username = "Explorer";
  if (token) {
    const payload = decodeIdToken(token) as Record<string, string | undefined>;
    username = payload.preferred_username ?? username;
  }

  return (
    <main className="dashboard-main">
      <div className="dashboard-card">
        <p className="auth-hero__eyebrow">PinHaoYun Dashboard</p>
        <h1>{`欢迎，${username}`}</h1>
        <p>
          这里将展示与你的业务相关的核心指标、环境状态与操作入口。当前版本
          使用 Cognito ID Token 维持登录态，可直接接入后端服务。
        </p>
        <LogoutButton />
      </div>
    </main>
  );
}
