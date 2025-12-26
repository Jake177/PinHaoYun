"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Errors from "./Errors";
import Feedback from "./Feedback";
import { Route } from "next";

type LoginFormProps = {
  defaultEmail?: string;
  initialFeedback?: string | null;
  redirectTo?: string;
};

const describeError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "请求失败，请稍后再试。";

const isUnconfirmedError = (message: string) =>
  ["未验证", "未确认", "NotConfirmed", "UserNotConfirmed"].some((keyword) =>
    message.includes(keyword),
  );

export default function LoginForm({
  defaultEmail = "",
  initialFeedback = null,
  redirectTo,
}: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [feedback, setFeedback] = useState(initialFeedback);
  const [loading, setLoading] = useState(false);

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
    setLoading(true);

    if (!normalizedEmail || !password) {
      setErrors(["请填写邮箱和密码。"]);
      setLoading(false);
      return;
    }

    try {
      const hasCustomRedirect =
        typeof redirectTo === "string" && redirectTo.startsWith("/");
      const redirectTarget = hasCustomRedirect
        ? redirectTo
        : "/dashboard";

      const resp = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, password }),
      });

      if (!resp.ok) {
        let message = "登录失败";
        try {
          const data = (await resp.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore json errors
        }

        if (isUnconfirmedError(message)) {
          try {
            await fetch("/api/auth/resend-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: normalizedEmail }),
            });
          } catch {
            // silently ignore resend failures here
          }
          const nextQuery = hasCustomRedirect
            ? `&next=${encodeURIComponent(redirectTarget)}`
            : "";
          router.push(
            (`/verify?status=unconfirmed&email=${encodeURIComponent(
              normalizedEmail,
            )}${nextQuery}`) as Route);
          return;
        }

        setErrors([message]);
        return;
      }

      router.replace(redirectTarget as Route);
    } catch (error) {
      setErrors([describeError(error)]);
    } finally {
      setLoading(false);
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
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field-group">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="请输入密码"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "处理中..." : "登录"}
        </button>
      </form>
    </>
  );
}
