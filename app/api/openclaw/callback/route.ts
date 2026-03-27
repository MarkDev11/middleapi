// ─────────────────────────────────────────────────────────────
// 📁 PATH: app/api/openclaw/callback/route.ts
//
// Struktur folder:
//   your-project/
//   └── app/
//       └── api/
//           └── openclaw/
//               └── callback/
//                   └── route.ts   ← FILE INI
//
// Endpoint ini dipanggil OLEH OpenClaw ketika selesai memproses.
// OpenClaw POST ke sini → Vercel forward ke Telegram.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET!;

export async function POST(req: NextRequest) {
  // Validasi secret biar tidak bisa dipanggil sembarangan
  const auth = req.headers.get("x-callback-secret");
  if (auth !== CALLBACK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { chat_id, text, photo_url, reply_to_message_id, placeholder_message_id } = body;

  if (!chat_id || (!text && !photo_url)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    if (placeholder_message_id && text) {
      // Edit placeholder jadi response asli
      const MAX = 4096;
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX));
        remaining = remaining.slice(MAX);
      }

      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          message_id: placeholder_message_id,
          text: chunks[0],
          parse_mode: "Markdown",
        }),
      }).catch(() =>
        fetch(`${TELEGRAM_API}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, message_id: placeholder_message_id, text: chunks[0] }),
        })
      );

      for (let i = 1; i < chunks.length; i++) {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, text: chunks[i] }),
        });
      }
    } else if (text) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text: text.slice(0, 4096),
          parse_mode: "Markdown",
          ...(reply_to_message_id ? { reply_to_message_id } : {}),
        }),
      });
    }

    if (photo_url) {
      await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, photo: photo_url, caption: "📸 Screenshot" }),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Callback error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
