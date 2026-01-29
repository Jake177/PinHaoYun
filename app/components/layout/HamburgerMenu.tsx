"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";

type HamburgerMenuProps = {
  username?: string;
};

type MenuItem = {
  href: Route;
  icon: string;
  label: string;
  active: boolean;
};

export default function HamburgerMenu({ username }: HamburgerMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close menu on route change
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  // Close menu on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  const handleLogout = async () => {
    setLogoutLoading(true);
    try {
      await fetch("/api/session/clear", { method: "POST" });
    } catch {
      // ignore network errors
    } finally {
      setLogoutLoading(false);
      router.replace("/login");
    }
  };

  const menuItems: MenuItem[] = [
    {
      href: "/dashboard" as Route,
      icon: "home",
      label: "My Library",
      active: pathname === "/dashboard",
    },
    {
      href: "/dashboard/profile" as Route,
      icon: "account_circle",
      label: "Profile",
      active: pathname === "/dashboard/profile",
    },
    {
      href: "/dashboard/map" as Route,
      icon: "map_pin_heart",
      label: "Footprints",
      active: pathname === "/dashboard/map",
    },
  ];

  return (
    <div className="hamburger-menu" ref={menuRef}>
      <button
        type="button"
        className="hamburger-button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label="Open menu"
      >
        <span className={`hamburger-icon ${isOpen ? "hamburger-icon--open" : ""}`}>
          <span />
          <span />
          <span />
        </span>
      </button>

      {isOpen && (
        <div className="hamburger-dropdown">
          {username && (
            <div className="hamburger-dropdown__header">
              <span className="hamburger-dropdown__greeting">
                Hi, {username}
              </span>
            </div>
          )}

          <nav className="hamburger-dropdown__nav">
            {menuItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`hamburger-dropdown__item ${
                  item.active ? "hamburger-dropdown__item--active" : ""
                }`}
              >
                <span className="hamburger-dropdown__icon material-symbols-outlined">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>

          <div className="hamburger-dropdown__footer">
            <button
              type="button"
              className="hamburger-dropdown__logout"
              onClick={handleLogout}
              disabled={logoutLoading}
            >
              <span className="hamburger-dropdown__icon material-symbols-outlined">
                exit_to_app
              </span>
              <span>{logoutLoading ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
