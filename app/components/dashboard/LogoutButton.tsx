"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      await fetch("/api/session/clear", { method: "POST" });
    } catch {
      // ignore network errors, still redirect to login
    } finally {
      setLoading(false);
      router.replace("/login");
    }
  };

  return (
    <button
      type="button"
      className="dashboard-link"
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? "正在退出..." : "退出登录"}
    </button>
  );
}
