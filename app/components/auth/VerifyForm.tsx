"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Errors from "./Errors";
import Feedback from "./Feedback";

type VerifyFormProps = {
  defaultEmail?: string;
  initialFeedback?: string | null;
  redirectTo?: string;
};

const describeError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "请求失败，请稍后再试。";

export default function VerifyForm({
  defaultEmail = "",
  initialFeedback = null,
  redirectTo,
}: VerifyFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail);
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(
    initialFeedback || null,
  );
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    setEmail(defaultEmail);
  }, [defaultEmail]);

  useEffect(() => {
    setFeedback(initialFeedback || null);
  }, [initialFeedback]);

  const normalizedEmail = useMemo(
    () => email.trim().toLowerCase(),
    [email],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    setFeedback(null);

    if (!normalizedEmail || !code.trim()) {
      setErrors(["请填写邮箱和验证码。"]);
      return;
    }

    setLoading(true);

    try {
      const redirectTarget =
        redirectTo && redirectTo.startsWith("/") ? redirectTo : undefined;

      const resp = await fetch("/api/auth/confirm-sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, code: code.trim() }),
      });

      if (!resp.ok) {
        let message = "验证失败";
        try {
          const data = (await resp.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore parse error
        }
        setErrors([message]);
        return;
      }

      const fallbackSuffix = redirectTarget
        ? `&next=${encodeURIComponent(redirectTarget)}`
        : "";
      router.replace(
        `/login?status=verified&email=${encodeURIComponent(normalizedEmail)}${fallbackSuffix}`,
      );
      return;
    } catch (error) {
      setErrors([describeError(error)]);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!normalizedEmail) {
      setErrors(["请先填写注册时使用的邮箱。"]);
      return;
    }

    setErrors([]);
    setFeedback(null);
    setResending(true);

    try {
      const resp = await fetch("/api/auth/resend-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      if (!resp.ok) {
        let message = "验证码发送失败";
        try {
          const data = (await resp.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore parsing errors
        }
        setErrors([message]);
        return;
      }

      setFeedback("验证码已重新发送，请查收邮箱。");
    } catch (error) {
      setErrors([describeError(error)]);
    } finally {
      setResending(false);
    }
  };

  return (
    <>
      <Errors errors={errors} />
      <Feedback message={feedback} />
      <form onSubmit={handleSubmit} noValidate>
        <div className="field-group">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="注册时使用的邮箱"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field-group">
          <label htmlFor="code">邮箱验证码</label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            placeholder="请输入验证码"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <button
            type="button"
            className="link-button"
            onClick={handleResend}
            disabled={resending}
          >
            {resending ? "发送中..." : "重新发送验证码"}
          </button>
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "处理中..." : "提交验证码"}
        </button>
      </form>
    </>
  );
}
