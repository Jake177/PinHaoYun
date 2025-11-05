import type { ReactNode } from "react";
import AuthHero from "@/app/components/auth/AuthHero";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-wrapper">
      <AuthHero />
      <section className="auth-card" aria-live="polite">
        {children}
      </section>
    </main>
  );
}
