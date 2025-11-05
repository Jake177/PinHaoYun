import Link from "next/link";
import type { Metadata } from "next";
import AuthHeading from "@/app/components/auth/AuthHeading";
import VerifyForm from "@/app/components/auth/VerifyForm";

type SearchParams = Record<string, string | string[] | undefined>;

const getParam = (params: SearchParams, key: string) => {
  const value = params?.[key];
  return Array.isArray(value) ? value[0] : value;
};

const statusMessage = (status: string | undefined) => {
  switch (status) {
    case "registered":
      return "注册成功，验证码已发送到邮箱，请输入验证码完成激活。";
    case "unconfirmed":
      return "该账户尚未验证，请输入验证码完成激活。";
    case "resent":
      return "验证码已重新发送，请查收邮箱。";
    default:
      return "请输入邮箱与验证码完成账户激活。";
  }
};

export const metadata: Metadata = {
  title: "验证账户 | PinHaoYun",
};

export default function VerifyPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const email = getParam(searchParams, "email") || "";
  const status = getParam(searchParams, "status");
  const nextParam = getParam(searchParams, "next");
  const redirectTo =
    typeof nextParam === "string" && nextParam.startsWith("/")
      ? nextParam
      : undefined;
  const feedback = statusMessage(status);

  return (
    <>
      <AuthHeading
        title="验证邮箱"
        description="我们已向你的邮箱发送验证码，请填写验证码完成激活。"
      />
      <VerifyForm
        defaultEmail={email}
        initialFeedback={feedback}
        redirectTo={redirectTo}
      />
      <p className="auth-helper">
        已经验证成功？<Link href="/login">返回登录</Link>
      </p>
    </>
  );
}
