// ─────────────────────────────────────────────────────────────
// 📁 PATH: app/layout.tsx
//
// Struktur folder lengkap:
//   your-project/
//   └── app/
//       └── layout.tsx   ← FILE INI
// ─────────────────────────────────────────────────────────────

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OpenClaw Telegram Bridge",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
