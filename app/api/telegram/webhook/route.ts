// ─────────────────────────────────────────────────────────────
// 📁 PATH: app/api/telegram/webhook/route.ts
//
// Struktur folder lengkap:
//   your-project/
//   └── app/
//       └── api/
//           └── telegram/
//               └── webhook/
//                   └── route.ts   ← FILE INI
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";

// Cache update_id yang sudah diproses — cegah duplikat kalau Telegram retry
// Map<update_id, timestamp> — dibersihkan setiap 5 menit
const processedUpdates = new Map<number, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 menit

function isDuplicate(updateId: number): boolean {
  const now = Date.now();
  // Bersihkan entri lama
  for (const [id, ts] of processedUpdates.entries()) {
    if (now - ts > DEDUP_TTL_MS) processedUpdates.delete(id);
  }
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.set(updateId, now);
  return false;
}

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const OPENCLAW_BASE_URL = process.env.OPENCLAW_HF_URL!; // e.g. https://mark421-openclaw-ai.hf.space
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_PASSWORD!;
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";

// ──────────────────────────────────────────────
// Telegram helpers
// ──────────────────────────────────────────────

async function sendTyping(chatId: number) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

async function sendMessage(chatId: number, text: string, replyToMessageId?: number) {
  // Keep typing while we send (Telegram typing lasts ~5s, reset it every 4s)
  const MAX_LENGTH = 4096;
  const chunks: string[] = [];

  // Split message into Telegram-safe chunks
  if (text.length <= MAX_LENGTH) {
    chunks.push(text);
  } else {
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, MAX_LENGTH));
      remaining = remaining.slice(MAX_LENGTH);
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "Markdown",
    };
    if (i === 0 && replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }

    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // If Markdown parse fails, retry as plain text
    if (!res.ok) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunks[i],
          ...(i === 0 && replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
        }),
      });
    }
  }
}

async function sendError(chatId: number, msg: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `⚠️ ${msg}`,
    }),
  });
}

// ──────────────────────────────────────────────
// OpenClaw helpers
// ──────────────────────────────────────────────

async function callOpenClaw(
  userMessage: string,
  userId: number,
  username?: string
): Promise<string> {
  const systemPrompt = [
    "You are a helpful AI assistant accessible via Telegram.",
    username ? `The user's Telegram username is @${username}.` : "",
    "Respond naturally and concisely. Use Markdown formatting when appropriate.",
    "For code, always use code blocks with the language name.",
  ]
    .filter(Boolean)
    .join(" ");

  const response = await fetch(`${OPENCLAW_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCLAW_TOKEN}`,
      "x-openclaw-agent-id": OPENCLAW_AGENT_ID,
    },
    body: JSON.stringify({
      model: "openclaw",
      // Pass userId so OpenClaw maintains a stable session per Telegram user
      user: `tg_${userId}`,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
      max_tokens: 4000,
    }),
    // Vercel has max 60s on Pro, 10s on Hobby
    // HF Spaces can be slow, so we rely on Vercel's native timeout
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenClaw error:", response.status, errorText);

    if (response.status === 503) {
      throw new Error(
        "OpenClaw is waking up (HF Space cold start). Please try again in a moment."
      );
    }
    if (response.status === 401) {
      throw new Error("OpenClaw auth failed. Check OPENCLAW_GATEWAY_PASSWORD.");
    }
    throw new Error(`OpenClaw returned ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenClaw.");
  }

  return content;
}

// ──────────────────────────────────────────────
// Webhook handler
// ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const update = await req.json();

  // Langsung return 200 ke Telegram (< 5 detik) agar tidak retry/loop.
  // waitUntil memastikan processUpdate tetap jalan di background
  // meski response sudah dikirim — solusi resmi Vercel untuk webhook.
  // Cegah duplikat — Telegram retry kalau webhook lambat
  if (isDuplicate(update.update_id)) {
    console.log(`Duplicate update_id ${update.update_id}, skipping.`);
    return NextResponse.json({ ok: true });
  }

  waitUntil(
    processUpdate(update).catch((err) => {
      console.error("Unhandled error in processUpdate:", err);
    })
  );

  return NextResponse.json({ ok: true });
}

async function processUpdate(update: TelegramUpdate) {
  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const username = message.from?.username;
  const messageId = message.message_id;
  const text = message.text;

  if (!userId || !text) return;

  // Ignore bot commands except /start and /help
  if (text.startsWith("/")) {
    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        `👋 *Halo!* Saya adalah asisten AI yang didukung oleh OpenClaw.\n\nKirim pesan apa saja dan saya akan menjawabnya!`,
        messageId
      );
      return;
    }
    if (text.startsWith("/help")) {
      await sendMessage(
        chatId,
        `ℹ️ *Cara penggunaan:*\n\nKirim pesan biasa dan saya akan menjawabnya menggunakan AI.\n\nSetiap pengguna memiliki sesi percakapan tersendiri.`,
        messageId
      );
      return;
    }
    // Ignore unknown commands
    return;
  }

  try {
    // Send typing indicator immediately
    await sendTyping(chatId);

    // Keep typing alive during long responses (every 4s)
    const typingInterval = setInterval(() => sendTyping(chatId), 4000);

    try {
      const reply = await callOpenClaw(text, userId, username);
      clearInterval(typingInterval);
      await sendMessage(chatId, reply, messageId);
    } catch (err) {
      clearInterval(typingInterval);
      throw err;
    }
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Terjadi kesalahan yang tidak diketahui.";
    await sendError(chatId, msg);
  }
}

// ──────────────────────────────────────────────
// Types (minimal)
// ──────────────────────────────────────────────

interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
}
