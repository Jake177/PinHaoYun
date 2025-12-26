import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./ui/globals.css";
import { manrope } from "./ui/font";
import Navbar from "./ui/navbar";

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
  const isAuthenticated = Boolean(cookieStore.get("id_token"));

  return (
    <html lang="en">
      <body className={manrope.className}>
        <div className="site-shell">
          <Navbar isAuthenticated={isAuthenticated} />
          <div className="site-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
