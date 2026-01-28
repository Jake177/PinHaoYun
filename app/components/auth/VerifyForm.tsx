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
    : "Request failed. Please try again.";

export default function VerifyForm({
  defaultEmail = "",
  initialFeedback = null,
  redirectTo,
}: VerifyFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail);
  const [otp, setOtp] = useState<string[]>(Array(6).fill(""));
  const [errors, setErrors] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(
    initialFeedback || null,
  );
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const inputs = useMemo(
    () => Array.from({ length: 6 }, () => ({ current: null as HTMLInputElement | null })),
    [],
  );

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

  const codeValue = useMemo(() => otp.join(""), [otp]);

  const updateOtp = (index: number, value: string) => {
    setOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const focusNext = (index: number) => {
    if (index < inputs.length - 1) {
      inputs[index + 1].current?.focus();
    }
  };

  const focusPrev = (index: number) => {
    if (index > 0) {
      inputs[index - 1].current?.focus();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    setFeedback(null);

    if (!normalizedEmail || codeValue.length !== 6) {
      setErrors(["Please enter your email and the 6-digit verification code."]);
      return;
    }

    setLoading(true);

    try {
      const redirectTarget =
        redirectTo && redirectTo.startsWith("/") ? redirectTo : undefined;

      const resp = await fetch("/api/auth/confirm-sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, code: codeValue }),
      });

      if (!resp.ok) {
        let message = "Verification failed.";
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
      setErrors(["Please enter the email address you used to sign up."]);
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
        let message = "Failed to send verification code.";
        try {
          const data = (await resp.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore parsing errors
        }
        setErrors([message]);
        return;
      }

      setFeedback("A new verification code has been sent. Please check your email.");
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
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="Email used during registration"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field-group">
          <label htmlFor="code">Verification code</label>
          <div className="otp-grid" aria-label="6-digit code input">
            {otp.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  inputs[idx].current = el;
                }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                className="otp-box"
                value={digit}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "").slice(-1);
                  updateOtp(idx, val);
                  if (val) focusNext(idx);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !otp[idx]) {
                    updateOtp(idx, "");
                    focusPrev(idx);
                  } else if (e.key === "ArrowLeft") {
                    focusPrev(idx);
                  } else if (e.key === "ArrowRight") {
                    focusNext(idx);
                  }
                }}
                required
                aria-label={`Code digit ${idx + 1}`}
              />
            ))}
          </div>
          <button
            type="button"
            className="link-button"
            onClick={handleResend}
            disabled={resending}
          >
            {resending ? "Sending..." : "Resend code"}
          </button>
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "Verifying..." : "Verify"}
        </button>
      </form>
    </>
  );
}
