import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./ui/globals.css";
import { manrope } from "./ui/font";
import Navbar from "./ui/navbar";

export const metadata: Metadata = {
  title: "Pin Hao Yun",
  description: "App Router bootstrap for Pin Hao Yun.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={manrope.className}>
        <div className="site-shell">
          <Navbar />
          <div className="site-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
