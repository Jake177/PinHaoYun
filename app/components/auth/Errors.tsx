"use client";

export default function Errors({ errors }: { errors: string[] }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div className="auth-errors">
      {errors.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
