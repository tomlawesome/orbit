import type { Metadata, Viewport } from "next";
import "@/app/theme-tokens.css";
import "@/app/globals.css";
import "@/app/shell.css";
import "@/app/family.css";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://127.0.0.1:3000"),
  title: { default: "Orbit", template: "%s · Orbit" },
  description: "Everything in your orbit, on track. Manage household maintenance, services, renewals and schedules.",
  applicationName: "Orbit",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: ["/icon.svg"],
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Orbit" },
  openGraph: {
    type: "website",
    siteName: "Orbit",
    title: "Orbit",
    description: "Everything in your orbit, on track.",
    images: [{ url: "/og.png", width: 1731, height: 908, alt: "Orbit — Everything in your orbit, on track." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Orbit",
    description: "Everything in your orbit, on track.",
    images: ["/og.png"],
  },
};

// Star-chart's page depth, matching manifest.ts; #15162b was the retired identity.
export const viewport: Viewport = { themeColor: "#060b1c", colorScheme: "light dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
