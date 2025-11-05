import Link from "next/link";
import { cookies } from "next/headers";
import Logo from "./logo";

export default function Navbar() {
  const cookieStore = cookies();
  const isAuthenticated = Boolean(cookieStore.get("id_token"));
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
    </header>
  );
}
