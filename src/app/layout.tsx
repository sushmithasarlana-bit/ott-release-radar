import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Geist } from "next/font/google";
import "./globals.css";

const body = Geist({ variable: "--font-body", subsets: ["latin"] });
const display = Bebas_Neue({ variable: "--font-display", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "OTT Release Radar",
  description: "Weekly Telegram digest of new titles on Netflix, Prime Video and JioHotstar in India, with Gemini watch-or-skip verdicts.",
};

export const viewport: Viewport = { themeColor: "#07080b", colorScheme: "dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
