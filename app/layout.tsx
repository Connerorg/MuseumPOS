import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Museum POS | Ticketing & Sales", description: "Museum ticketing and sales management point of sale.", applicationName: "Museum POS", manifest: "/manifest.json" };
export const viewport: Viewport = { themeColor: "#10241f", width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en-ZA"><body>{children}</body></html>; }
