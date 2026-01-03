import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./ui/globals.css";
import { manrope } from "./ui/font";
import Navbar from "./ui/navbar";
import { decodeIdToken } from "./lib/jwt";

export const metadata: Metadata = {
  title: "Pin Hao Yun",
  description: "App Router bootstrap for Pin Hao Yun.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const cookieStore = await cookies();
  const idToken = cookieStore.get("id_token")?.value;
  const isAuthenticated = Boolean(idToken);

  let username: string | undefined;
  if (idToken) {
    try {
      const payload = decodeIdToken(idToken) as Record<string, string | undefined>;
      username =
        payload.given_name ||
        payload.preferred_username ||
        payload["cognito:username"] ||
        payload.email?.split("@")[0];
    } catch {
      // ignore decode errors
    }
  }

  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0"
        />
      </head>
      <body className={manrope.className}>
        <div className="site-shell">
          <Navbar isAuthenticated={isAuthenticated} username={username} />
          <div className="site-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
