// ─────────────────────────────────────────────────────────────
// 📁 PATH: app/api/telegram/setup/route.ts
//
// Struktur folder lengkap:
//   your-project/
//   └── app/
//       └── api/
//           └── telegram/
//               └── setup/
//                   └── route.ts   ← FILE INI
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

// GET /api/telegram/setup?secret=YOUR_SETUP_SECRET
// Call this once after deploying to register the webhook with Telegram

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");

  // Simple protection so random people can't re-register your webhook
  if (secret !== process.env.SETUP_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const webhookUrl = `${process.env.VERCEL_URL}/api/telegram/webhook`;
  const telegramApi = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

  // Register webhook
  const res = await fetch(`${telegramApi}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: true,
    }),
  });

  const data = await res.json();

  // Also fetch bot info for confirmation
  const botRes = await fetch(`${telegramApi}/getMe`);
  const botData = await botRes.json();

  return NextResponse.json({
    webhook_setup: data,
    bot: botData.result,
    webhook_url: webhookUrl,
  });
}
