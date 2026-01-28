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
      return "Registration successful. We've sent a verification code to your email. Enter it to finish verifying your account.";
    case "verified":
      return "Email verified. You can now sign in with your password.";
    default:
      return null;
  }
};

export const metadata: Metadata = {
  title: "Sign in | PinHaoYun",
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
        title="Sign in to PinHaoYun"
        description=""
      />
      <LoginForm
        defaultEmail={email}
        initialFeedback={feedback}
        redirectTo={redirectTo}
      />
      <p className="auth-helper">
        Don&apos;t have an account? <Link href="/register">Create a new account</Link>
      </p>
    </>
  );
}
