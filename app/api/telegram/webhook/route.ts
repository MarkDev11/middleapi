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


async function editMessage(chatId: number, messageId: number, text: string) {
  const MAX_LENGTH = 4096;
  const truncated = text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH - 20) + "...(truncated)" : text;
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: truncated,
      parse_mode: "Markdown",
    }),
  }).catch(() =>
    // Fallback tanpa markdown kalau parse error
    fetch(`${TELEGRAM_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: truncated }),
    })
  );
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

// PRODUCTION_URL untuk callback — harus include https://
const VERCEL_PRODUCTION_URL = process.env.PRODUCTION_URL ?? `https://${process.env.VERCEL_URL}`;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET!;

// Fire-and-forget: kirim task ke OpenClaw tanpa nunggu jawaban.
// OpenClaw akan POST balik ke /api/openclaw/callback kalau sudah selesai.
async function sendToOpenClaw(
  userMessage: string,
  userId: number,
  chatId: number,
  placeholderMsgId: number,
  replyToMessageId: number,
  username?: string
): Promise<void> {
  const callbackUrl = `${VERCEL_PRODUCTION_URL}/api/openclaw/callback`;

  const systemPrompt = [
    "You are a helpful AI assistant accessible via Telegram.",
    username ? `The user\'s Telegram username is @${username}.` : "",
    "Respond naturally and concisely. Use Markdown formatting when appropriate.",
    "For code, always use code blocks with the language name.",
    "",
    "IMPORTANT: When you have finished your response, you MUST send it back via HTTP POST.",
    `Send a POST request to: ${callbackUrl}`,
    `With header: x-callback-secret: ${CALLBACK_SECRET}`,
    "With JSON body:",
    `{`,
    `  "chat_id": ${chatId},`,
    `  "placeholder_message_id": ${placeholderMsgId},`,
    `  "reply_to_message_id": ${replyToMessageId},`,
    `  "text": "YOUR FULL RESPONSE HERE"`,
    `}`,
    "If you produced a screenshot or image file, also include:",
    `  "photo_url": "https://your-image-url.png"`,
    "Send this callback as the LAST action after completing your task.",
  ].filter(Boolean).join("\n");

  const response = await fetch(`${OPENCLAW_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCLAW_TOKEN}`,
      "x-openclaw-agent-id": OPENCLAW_AGENT_ID,
    },
    body: JSON.stringify({
      model: "openclaw",
      user: `tg_${userId}`,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
      max_tokens: 4000,
    }),
    // Timeout 10 menit — OpenClaw hanya perlu acknowledge task diterima
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenClaw error:", response.status, errorText);
    if (response.status === 503) {
      throw new Error("OpenClaw sedang warm up. Coba lagi dalam beberapa detik.");
    }
    if (response.status === 401) {
      throw new Error("OpenClaw auth gagal. Cek OPENCLAW_GATEWAY_PASSWORD.");
    }
    throw new Error(`OpenClaw returned ${response.status}`);
  }
}


// ──────────────────────────────────────────────
// Screenshot helper
// ──────────────────────────────────────────────

// Deteksi nama file gambar dari teks response OpenClaw
function extractImageFilenames(text: string): string[] {
  const matches = text.match(/([\w\-\.]+\.(?:png|jpg|jpeg|gif|webp))/gi);
  return matches ? [...new Set(matches)] : [];
}

// Ambil file dari workspace OpenClaw di HF Spaces lalu kirim ke Telegram
async function trySendScreenshots(chatId: number, text: string, replyToMessageId: number) {
  const filenames = extractImageFilenames(text);
  if (filenames.length === 0) return;

  for (const filename of filenames) {
    try {
      // OpenClaw workspace default ada di /root/.openclaw/workspace/
      // HF Spaces expose file melalui endpoint gateway files
      const fileUrl = `${OPENCLAW_BASE_URL}/api/agents/${OPENCLAW_AGENT_ID}/workspace/files/${filename}`;
      const fileRes = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${OPENCLAW_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!fileRes.ok) {
        console.log(`Could not fetch ${filename}: ${fileRes.status}`);
        continue;
      }

      const blob = await fileRes.blob();
      const formData = new FormData();
      formData.append("chat_id", chatId.toString());
      formData.append("photo", blob, filename);
      formData.append("reply_to_message_id", replyToMessageId.toString());
      formData.append("caption", `📸 ${filename}`);

      const sendRes = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        body: formData,
      });

      if (sendRes.ok) {
        console.log(`Screenshot ${filename} sent to Telegram.`);
      } else {
        console.log(`Failed to send photo ${filename}: ${await sendRes.text()}`);
      }
    } catch (err) {
      console.log(`Error sending screenshot ${filename}:`, err);
    }
  }
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
    // 1. Kirim placeholder — user tahu bot sedang kerja
    const placeholderRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "⏳ _Sedang memproses..._",
        parse_mode: "Markdown",
        reply_to_message_id: messageId,
      }),
    });
    const placeholderData = await placeholderRes.json();
    const placeholderMsgId: number = placeholderData?.result?.message_id;

    // 2. Fire-and-forget ke OpenClaw — tidak perlu nunggu selesai.
    //    OpenClaw akan POST balik ke /api/openclaw/callback kalau selesai.
    sendToOpenClaw(text, userId, chatId, placeholderMsgId, messageId, username)
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : "Terjadi kesalahan.";
        if (placeholderMsgId) {
          await editMessage(chatId, placeholderMsgId, `⚠️ ${msg}`);
        } else {
          await sendError(chatId, msg);
        }
      });

    // 3. Langsung selesai — Vercel return, OpenClaw kerja di background HF Spaces
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
