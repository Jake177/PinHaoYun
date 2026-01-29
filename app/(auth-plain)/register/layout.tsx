import type { ReactNode } from "react";

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-wrapper auth-wrapper--solo">
      <section className="auth-card auth-card--solo" aria-live="polite">
        {children}
      </section>
    </main>
  );
}
