import Link from "next/link";
import type { Metadata } from "next";
import AuthHeading from "@/app/components/auth/AuthHeading";
import LoginForm from "@/app/components/auth/LoginForm";

type SearchParams = Record<string, string | string[] | undefined>;

const getParam = (params: SearchParams, key: string) => {
  const value = params?.[key];
  return Array.isArray(value) ? value[0] : value;
};

const statusMessage = (status: string | undefined) => {
  switch (status) {
    case "registered":
      return "注册成功，验证码已发送到邮箱，请输入验证码完成验证。";
    case "verified":
      return "邮箱验证成功，请使用密码登录。";
    default:
      return null;
  }
};

export const metadata: Metadata = {
  title: "登录 | PinHaoYun",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = getParam(params, "status");
  const email = getParam(params, "email") || "";
  const nextParam = getParam(params, "next");
  const redirectTo =
    typeof nextParam === "string" && nextParam.startsWith("/")
      ? nextParam
      : undefined;
  const feedback = statusMessage(status);

  return (
    <>
      <AuthHeading
        title="登录 PinHaoYun"
        description="输入邮箱与密码登录，如果账户未验证，我们会引导你完成验证码验证。"
      />
      <LoginForm
        defaultEmail={email}
        initialFeedback={feedback}
        redirectTo={redirectTo}
      />
      <p className="auth-helper">
        还没有账号？<Link href="/register">立即注册</Link>
      </p>
    </>
  );
}
