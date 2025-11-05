import Link from "next/link";
import type { Metadata } from "next";
import AuthHeading from "@/app/components/auth/AuthHeading";
import RegisterForm from "@/app/components/auth/RegisterForm";

export const metadata: Metadata = {
  title: "注册 | PinHaoYun",
};

export default function RegisterPage() {
  return (
    <>
      <AuthHeading
        title="创建你的 PinHaoYun 账户"
        description="填写必填属性后即可完成注册，我们会向邮箱发送验证码用于激活账户。"
      />
      <RegisterForm />
      <p className="auth-helper">
        已经有账号？<Link href="/login">返回登录</Link>
      </p>
    </>
  );
}
