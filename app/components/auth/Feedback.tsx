"use client";

export default function Feedback({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="auth-feedback">{message}</div>;
}
