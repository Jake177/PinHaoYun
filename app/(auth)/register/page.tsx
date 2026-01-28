import Link from "next/link";
import type { Metadata } from "next";
import AuthHeading from "@/app/components/auth/AuthHeading";
import RegisterForm from "@/app/components/auth/RegisterForm";

export const metadata: Metadata = {
  title: "Sign up | PinHaoYun",
};

export default function RegisterPage() {
  return (
    <>
      <AuthHeading
        title="Create your PinHaoYun account"
        description="Fill in the required details to sign up. We'll email you a verification code to activate your account."
      />
      <RegisterForm />
      <p className="auth-helper">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
