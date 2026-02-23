import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SkipLink } from "@/components/shell/skip-link";
import { TopBar } from "@/components/shell/top-bar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Providers } from "@/components/shell/providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vigil — Autonomous SOC Platform",
  description: "AI-powered security operations center with autonomous incident response",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <Providers>
          <SkipLink />
          <TopBar />
          <MobileNav />
          <main
            id="main-content"
            className="pt-12 pb-16 md:pb-0 min-h-screen"
          >
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
