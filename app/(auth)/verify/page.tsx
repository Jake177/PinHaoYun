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
      return "Registration successful. We've sent a verification code to your email. Enter it to activate your account.";
    case "unconfirmed":
      return "This account hasn't been verified yet. Enter the verification code to activate it.";
    case "resent":
      return "A new verification code has been sent. Please check your email.";
    default:
      return "Enter your email and verification code to activate your account.";
  }
};

export const metadata: Metadata = {
  title: "Verify account | PinHaoYun",
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const email = getParam(params, "email") || "";
  const status = getParam(params, "status");
  const nextParam = getParam(params, "next");
  const redirectTo =
    typeof nextParam === "string" && nextParam.startsWith("/")
      ? nextParam
      : undefined;
  const feedback = statusMessage(status);

  return (
    <>
      <AuthHeading
        title="Verify your email"
        description="We've sent a verification code to your email. Enter it below to finish activation."
      />
      <VerifyForm
        defaultEmail={email}
        initialFeedback={feedback}
        redirectTo={redirectTo}
      />
      <p className="auth-helper">
        Already verified? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
