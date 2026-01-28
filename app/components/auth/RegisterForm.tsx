"use client";

import { useMemo, useState, type FormEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import RegisterFields from "./RegisterFields";
import PasswordRules from "./PasswordRules";
import Errors from "./Errors";
import type { RegistrationFormState } from "./types";

const EMPTY_FORM: RegistrationFormState = {
  email: "",
  password: "",
  confirmPassword: "",
  preferredUsername: "",
  givenName: "",
  familyName: "",
  gender: "Male",
};

const PASSWORD_RULES = [
  { id: "length", label: "At least 8 characters", test: (value: string) => value.length >= 8 },
  { id: "upper", label: "At least 1 upper-case letter", test: (value: string) => /[A-Z]/.test(value) },
  { id: "lower", label: "At least 1 lower-case letter", test: (value: string) => /[a-z]/.test(value) },
  { id: "digit", label: "At least 1 number", test: (value: string) => /\d/.test(value) },
  { id: "symbol", label: "At least 1 special character", test: (value: string) => /[^A-Za-z0-9]/.test(value) },
];

const GENDER_OPTIONS = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
  { value: "Other", label: "Other / Prefer not to say" },
] as const;

const describeError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "Request failed. Please try again.";

export default function RegisterForm() {
  const router = useRouter();
  const [formState, setFormState] = useState<RegistrationFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const passwordChecklist = useMemo(
    () =>
      PASSWORD_RULES.map((rule) => ({
        id: rule.id,
        label: rule.label,
        passed: rule.test(formState.password),
      })),
    [formState.password],
  );

  const validate = (): string[] => {
    const issues: string[] = [];
    if (!formState.givenName.trim()) {
      issues.push("Please enter your first name.");
    }
    if (!formState.familyName.trim()) {
      issues.push("Please enter your surname.");
    }
    if (!formState.preferredUsername.trim()) {
      issues.push("Please choose a username.");
    }
    if (!formState.email.trim()) {
      issues.push("Please enter your email.");
    }
    if (formState.password !== formState.confirmPassword) {
      issues.push("Passwords do not match.");
    }
    const failedRules = passwordChecklist.filter((item) => !item.passed);
    if (failedRules.length > 0) {
      issues.push("Your password doesn't meet all complexity requirements.");
    }
    return issues;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);

    const normalizedEmail = formState.email.trim().toLowerCase();
    const issues = validate();
    if (issues.length > 0) {
      setErrors(issues);
      return;
    }

    setLoading(true);

    try {
      const resp = await fetch("/api/auth/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: normalizedEmail,
          password: formState.password,
          preferredUsername: formState.preferredUsername.trim(),
          givenName: formState.givenName.trim(),
          familyName: formState.familyName.trim(),
          gender: formState.gender,
        }),
      });

      if (!resp.ok) {
        let message = "Sign-up failed.";
        try {
          const data = (await resp.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore JSON parse errors
        }
        setErrors([message]);
        return;
      }

      router.replace(
        `/verify?status=registered&email=${encodeURIComponent(normalizedEmail)}`,
      );
      return;
    } catch (error) {
      setErrors([describeError(error)]);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <>
      <Errors errors={errors} />
      
      <form onSubmit={handleSubmit} noValidate>
        <div className="field-group">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={formState.email}
            onChange={handleChange}
            required
          />
        </div>

        <RegisterFields
          formState={{
            givenName: formState.givenName,
            familyName: formState.familyName,
            preferredUsername: formState.preferredUsername,
            gender: formState.gender,
          }}
          onChange={handleChange}
          genderOptions={GENDER_OPTIONS}
        />

        <div className="field-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="A strong password"
            autoComplete="new-password"
            value={formState.password}
            onChange={handleChange}
            required
          />
        </div>

        <div className="field-group">
          <label htmlFor="confirmPassword">Confirm password</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Re-enter your password"
            autoComplete="new-password"
            value={formState.confirmPassword}
            onChange={handleChange}
            required
          />
        </div>
        <PasswordRules checklist={passwordChecklist} />

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "Creating account..." : "Create account"}
        </button>
      </form>
    </>
  );
}
