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
app.use(
  express.json({
    limit: "1mb",
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
