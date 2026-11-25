/**
 * Той самий консультант, що й `assistantChat` у Firebase, але як звичайний
 * Node.js-сервер — для сервера сайту, Render, тунелю тощо.
 *
 * Запуск: `npm run build && npm start`. Налаштування — зі змінних середовища
 * або з файлу `.env.server`, якщо він є (див. `server.env.example`,
 * docs/ai-assistant/DEPLOY_SERVER.md, render.yaml).
 *
 *   POST /chat    — чат (протокол як у функції: SSE)
 *   GET  /health  — перевірка, що сервер живий
 */
import express from "express";
import type { Request } from "firebase-functions/v2/https";
import { handleChat } from "./chat";

const port = Number(process.env.PORT ?? 8787);
// Свій сервер — лише локально (назовні через nginx). На Render та подібних
// хостингах трафік приходить ззовні контейнера, тож слухаємо всі інтерфейси.
const host = process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

const app = express();
app.disable("x-powered-by");
// За nginx: IP клієнта — з X-Forwarded-For (ліміти гостей рахуються за ним).
app.set("trust proxy", true);
// CORS для апок у WebView (Ionic/Capacitor) і сайтів. Нативні апки
// (Flutter) CORS не потребують. Додаткові origin-и — ASSISTANT_CORS_ORIGINS.
const corsOrigins = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
  "http://localhost:8100",
  "http://localhost:4200",
  // Адмінка SMARTon (Angular) живе на тих самих доменах, що й API: /admin/.
  "https://smarton.biz",
  "https://smarton-dev.moonart.net.ua",
  ...(process.env.ASSISTANT_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
]);
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && corsOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Assistant-Install, X-Firebase-AppCheck",
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(origin && corsOrigins.has(origin) ? 204 : 403).end();
    return;
  }
  next();
});

app.use(
  express.json({
    // Адмінка надсилає скріншоти (до ~3 МБ); межу для кожного tenant-а
    // перевіряє `handleChat` (limits.maxBodyBytes).
    limit: "4mb",
    // `handleChat` перевіряє розмір запиту за сирим тілом, як у Firebase.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, provider: process.env.ASSISTANT_PROVIDER || "anthropic" });
});

const chat = (req: express.Request, res: express.Response) =>
  handleChat(req as unknown as Request, res, apiKey);
app.post("/chat", chat);
// Щоб працювало й без шляху: https://ai.example.com/ → чат.
app.post("/", chat);

app.listen(port, host, () => {
  console.log(`assistant server: http://${host}:${port} (POST /chat, GET /health)`);
});
