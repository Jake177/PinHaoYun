"use client";

import { usePathname } from "next/navigation";
import HamburgerMenu from "@/app/components/layout/HamburgerMenu";

type NavbarLogoutProps = {
  isAuthenticated: boolean;
  username?: string;
};

// Auth pages where we don't show any menu
const AUTH_PATHS = ["/login", "/register", "/verify"];

export default function NavbarLogout({ isAuthenticated, username }: NavbarLogoutProps) {
  const pathname = usePathname();

  // Don't show on auth pages or if not authenticated
  if (!isAuthenticated) return null;

  // Don't show on auth pages
  const isAuthPage = AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  if (isAuthPage) return null;

  // Don't show on home page
  if (pathname === "/") return null;

  // Show hamburger menu on dashboard pages
  const isDashboard = pathname === "/dashboard" || pathname.startsWith("/dashboard");

  if (isDashboard) {
    return (
      <div className="site-header__actions">
        <HamburgerMenu username={username} />
      </div>
    );
  }

  return null;
}
