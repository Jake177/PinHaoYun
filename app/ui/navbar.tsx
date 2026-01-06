import Link from "next/link";
import Logo from "./logo";
import NavbarLogout from "./navbar-logout";

type NavbarProps = {
  isAuthenticated: boolean;
  username?: string;
};

export default function Navbar({ isAuthenticated, username }: NavbarProps) {
  const ariaLabel = isAuthenticated ? "返回 PinHaoYun 控制台" : "返回登录页面";

  return (
    <header className="site-header">
      <Link
        href="/"
        className="site-header__logo"
        aria-label={ariaLabel}
      >
        <Logo />
      </Link>
      <NavbarLogout isAuthenticated={isAuthenticated} username={username} />
    </header>
  );
}
