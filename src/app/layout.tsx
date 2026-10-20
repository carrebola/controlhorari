import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Horari",
  description: "Control y seguimiento del fichaje automático en Timenet",
  applicationName: "Control Horari",
  icons: { apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Control Horari", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#047857" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
