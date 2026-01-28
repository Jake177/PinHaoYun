"use client";

type Rule = { id: string; label: string; passed: boolean };

export default function PasswordRules({ checklist }: { checklist: Rule[] }) {
  return (
    <section className="policy-hint" aria-live="polite">
      <p>Password rules:</p>
      <div className="password-rules">
        {checklist.map(({ id, label, passed }) => (
          <span key={id} data-passed={passed}>
            <strong>{passed ? "✓" : "•"}</strong>
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
