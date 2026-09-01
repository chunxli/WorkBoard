import type { Metadata } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import { THEME_INITIALIZER } from "@/lib/theme";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

import NavBar from "@/components/NavBar";

export const metadata: Metadata = {
  title: "Work Board",
  description: "Create, run, compare, and resume Copilot work",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${manrope.variable} ${jetBrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INITIALIZER }} />
      </head>
      <body className="flex min-h-full flex-col text-neutral-100">
        <NavBar />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-9 lg:px-8">
          <div className="page-enter">{children}</div>
        </main>
      </body>
    </html>
  );
}
