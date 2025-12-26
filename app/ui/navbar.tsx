import Link from "next/link";
import Logo from "./logo";
import NavbarLogout from "./navbar-logout";

type NavbarProps = {
  isAuthenticated: boolean;
};

export default function Navbar({ isAuthenticated }: NavbarProps) {
  const href = isAuthenticated ? "/dashboard" : "/login";
  const ariaLabel = isAuthenticated ? "返回 PinHaoYun 控制台" : "返回登录页面";

  return (
    <header className="site-header">
      <Link
        href={href}
        className="site-header__logo"
        aria-label={ariaLabel}
      >
        <Logo />
      </Link>
      <NavbarLogout isAuthenticated={isAuthenticated} />
    </header>
  );
}
