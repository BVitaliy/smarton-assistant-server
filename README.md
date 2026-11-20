# SMARTon AI-консультант — сервер

Сервер AI-консультанта для мобільної апки SMARTon: проксі між апкою й моделлю
AI (Claude або, для внутрішнього демо, OpenRouter). Ключ моделі — лише тут.

- `POST /chat` — чат (Server-Sent Events), `GET /health` — перевірка.
- Налаштування — змінні середовища, див. `server.env.example`.

Копія теки `functions/` з репозиторію апки (гілка `feature/ai-assistant`).
Джерело правди — репозиторій апки: зміни робити там і переносити сюди.

## Render (безкоштовно)

1. https://render.com → увійти через GitHub.
2. New → **Blueprint** → цей репозиторій (або New → Web Service з полями з
   `render.yaml`: Build `npm ci && npm run build`, Start `node lib/server.js`,
   Instance Type Free, змінні середовища з `render.yaml`).
3. Вставити `OPENROUTER_API_KEY`.
4. Після деплою: `https://<сервіс>.onrender.com/health` → `{"ok":true,...}`.
   Апці потрібна адреса `https://<сервіс>.onrender.com/chat`.

## Локально

```bash
npm ci && npm run build
cp server.env.example .env.server   # заповнити
npm start                            # http://127.0.0.1:8787
```

Свій сервер (nginx, pm2) — див. `DEPLOY.md`.
