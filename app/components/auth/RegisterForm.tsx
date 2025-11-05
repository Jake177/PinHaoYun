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
  { id: "length", label: "至少 8 个字符", test: (value: string) => value.length >= 8 },
  { id: "upper", label: "至少 1 个大写字母", test: (value: string) => /[A-Z]/.test(value) },
  { id: "lower", label: "至少 1 个小写字母", test: (value: string) => /[a-z]/.test(value) },
  { id: "digit", label: "至少 1 个数字", test: (value: string) => /\d/.test(value) },
  { id: "symbol", label: "至少 1 个特殊字符", test: (value: string) => /[^A-Za-z0-9]/.test(value) },
];

const GENDER_OPTIONS = [
  { value: "Male", label: "男" },
  { value: "Female", label: "女" },
  { value: "Other", label: "其他 / 不透露" },
] as const;

const describeError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "请求失败，请稍后再试。";

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
      issues.push("请输入名字。");
    }
    if (!formState.familyName.trim()) {
      issues.push("请输入姓氏。");
    }
    if (!formState.preferredUsername.trim()) {
      issues.push("请输入用户名。");
    }
    if (!formState.email.trim()) {
      issues.push("请输入邮箱。");
    }
    if (formState.password !== formState.confirmPassword) {
      issues.push("两次输入的密码不一致。");
    }
    const failedRules = passwordChecklist.filter((item) => !item.passed);
    if (failedRules.length > 0) {
      issues.push("密码未满足所有复杂度要求。");
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
        let message = "注册失败";
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
          <label htmlFor="email">邮箱</label>
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
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="符合复杂度要求的密码"
            autoComplete="new-password"
            value={formState.password}
            onChange={handleChange}
            required
          />
        </div>

        <div className="field-group">
          <label htmlFor="confirmPassword">确认密码</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="再次输入密码"
            autoComplete="new-password"
            value={formState.confirmPassword}
            onChange={handleChange}
            required
          />
        </div>
        <PasswordRules checklist={passwordChecklist} />

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "处理中..." : "创建账号"}
        </button>
      </form>
    </>
  );
}
