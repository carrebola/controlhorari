import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Horari",
  description: "Control y seguimiento del fichaje automático en Timenet",
  applicationName: "Control Horari",
  appleWebApp: { capable: true, title: "Control Horari", statusBarStyle: "default" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
