"use client";

import { usePathname } from "next/navigation";
import LogoutButton from "@/app/components/dashboard/LogoutButton";

type NavbarLogoutProps = {
  isAuthenticated: boolean;
};

const HIDE_ON_PATHS = ["/login", "/register", "/verify", "/"];

export default function NavbarLogout({ isAuthenticated }: NavbarLogoutProps) {
  const pathname = usePathname();
  const shouldHide =
    !isAuthenticated ||
    HIDE_ON_PATHS.some((path) =>
      pathname === path || pathname.startsWith(`${path}/`),
    );

  if (shouldHide) return null;

  return (
    <div className="site-header__actions">
      <LogoutButton />
    </div>
  );
}
