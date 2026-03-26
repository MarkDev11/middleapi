// ─────────────────────────────────────────────────────────────
// 📁 PATH: app/page.tsx
//
// Struktur folder lengkap:
//   your-project/
//   └── app/
//       └── page.tsx   ← FILE INI
// ─────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", maxWidth: "600px" }}>
      <h1>🦞 OpenClaw Telegram Bridge</h1>
      <p>This Vercel app acts as a middleman between Telegram and your OpenClaw instance on Hugging Face Spaces.</p>
      <h2>Status</h2>
      <ul>
        <li>Webhook endpoint: <code>/api/telegram/webhook</code></li>
        <li>Setup endpoint: <code>/api/telegram/setup?secret=YOUR_SECRET</code></li>
      </ul>
    </main>
  );
}
