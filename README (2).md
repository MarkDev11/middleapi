# 🦞 OpenClaw Telegram Bridge

Middleman Vercel (Next.js App Router) yang menghubungkan **Telegram Bot** dengan **OpenClaw** yang berjalan di Hugging Face Spaces.

```
Telegram User
    │
    ▼ (webhook)
Vercel (Next.js)          ← kamu deploy ini
    │
    ▼ (HTTP POST /v1/chat/completions + Bearer token)
HF Spaces (OpenClaw)      ← sudah running
    │
    ▼ (response)
Vercel
    │
    ▼ (sendMessage)
Telegram User
```

---

## Prasyarat

1. Bot Telegram dari [@BotFather](https://t.me/BotFather) → ambil token
2. OpenClaw running di HF Spaces dengan env var:
   - `OPENCLAW_GATEWAY_PASSWORD` → password auth gateway
   - `OPENAI_API_BASE`, `OPENAI_API_KEY`, `MODEL` → sudah terconfig
3. Akun [Vercel](https://vercel.com) (free tier cukup, tapi Pro lebih baik untuk timeout lebih lama)

---

## Setup

### 1. Clone & install

```bash
git clone <repo-ini>
cd openclaw-telegram-bridge
npm install
```

### 2. Isi environment variables

Copy `.env.example` ke `.env.local`:

```bash
cp .env.example .env.local
```

Isi nilai-nilainya:

| Variable | Keterangan |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token dari @BotFather |
| `OPENCLAW_HF_URL` | URL HF Space, contoh: `https://mark421-openclaw-ai.hf.space` |
| `OPENCLAW_GATEWAY_PASSWORD` | Nilai env `OPENCLAW_GATEWAY_PASSWORD` di HF Space kamu |
| `OPENCLAW_AGENT_ID` | Agent ID di OpenClaw (default: `main`) |
| `SETUP_SECRET` | String random untuk protect endpoint setup |
| `VERCEL_URL` | URL Vercel kamu setelah deploy |

### 3. Deploy ke Vercel

```bash
npx vercel --prod
```

Atau push ke GitHub dan connect ke Vercel dashboard. Set semua env vars di **Settings → Environment Variables** di Vercel dashboard.

### 4. Register webhook Telegram

Setelah deploy, akses URL ini di browser:

```
https://your-project.vercel.app/api/telegram/setup?secret=YOUR_SETUP_SECRET
```

Ganti `YOUR_SETUP_SECRET` dengan nilai `SETUP_SECRET` yang kamu set.

Response sukses:
```json
{
  "webhook_setup": { "ok": true, "result": true },
  "bot": { "username": "your_bot_name", ... },
  "webhook_url": "https://your-project.vercel.app/api/telegram/webhook"
}
```

### 5. Test

Kirim pesan ke bot Telegram kamu. Bot akan:
- Tampilkan indikator "typing..."
- Forward pesan ke OpenClaw di HF Spaces
- Kirim balik respons OpenClaw ke Telegram

---

## Catatan Penting

### Timeout Vercel

- **Hobby (free):** max 10 detik per function → HF Space yang cold start bisa timeout
- **Pro:** max 60 detik (sudah dikonfigurasi di `vercel.json`) → **Recommended**

Kalau sering timeout, solusinya adalah **ping HF Space secara rutin** agar tidak sleep (gunakan cron job atau UptimeRobot untuk hit `https://mark421-openclaw-ai.hf.space/health` setiap 5 menit).

### HF Space Cold Start

HF Spaces free tier akan **sleep setelah ~15 menit tidak aktif**. Bot akan merespons dengan pesan error dan minta user coba lagi. Space biasanya warm up dalam 30-60 detik.

### Session per User

OpenClaw menerima field `user` dalam request. Bridge ini menggunakan `tg_{telegram_user_id}` sebagai session key, sehingga setiap pengguna Telegram punya sesi percakapan terpisah di OpenClaw.

---

## Struktur File

Buat folder project baru, lalu taruh file-file ini sesuai path-nya:

```
your-project/                  ← root project (npm init di sini)
│
├── app/                       ← Next.js App Router
│   ├── layout.tsx             ← app/layout.tsx
│   ├── page.tsx               ← app/page.tsx
│   └── api/
│       └── telegram/
│           ├── webhook/
│           │   └── route.ts   ← app/api/telegram/webhook/route.ts  ✅ PENTING
│           └── setup/
│               └── route.ts   ← app/api/telegram/setup/route.ts
│
├── .env.example               ← rename ke .env.local untuk local dev
├── .gitignore
├── next.config.js
├── package.json
├── tsconfig.json
└── vercel.json                ← config timeout (taruh di root!)
```

> 💡 Setiap file sudah ada komentar `📁 PATH:` di baris pertamanya sebagai pengingat.
