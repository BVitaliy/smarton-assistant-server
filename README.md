# AI-помічник — сервер (multi-tenant)

Один сервер AI-помічника для кількох апок: проксі між апкою й моделлю AI
(Claude або, для внутрішнього демо, OpenRouter). Ключ моделі — лише тут.

Апки (tenants): `smarton`, `smarton-dev` (дитяча освітня, Flutter) і `pronto`
(доставка піци й суші, Ionic/Angular).

- `POST /chat` — чат (Server-Sent Events), `GET /health` — перевірка.
- Налаштування — змінні середовища, див. `server.env.example`.

Копія теки `functions/` з репозиторію апки (гілка `feature/ai-assistant`).
Джерело правди — репозиторій апки: зміни робити там і переносити сюди.

## Як підключити нову апку

1. `src/tenants/<app>.ts` — конфіг: які режими (`guest`, `member`…), промпт,
   tools, перевірка входу (`verifyPath` — будь-який «хто я» API апки), ліміти.
   Загальне — з `src/tenants/common.ts` (кнопки-варіанти, картки, кнопки
   переходу, правила форматування, фактів, уточнень).
2. `knowledge/<app>/*.md` — сталі факти (файли з `_` і рядки `TODO` у промпт не
   йдуть). Змінне (меню, ціни, акції) — через tools з API апки.
3. Зареєструвати в `src/tenants/index.ts`.
4. В апці: клієнт протоколу (Flutter — пакет `ai_assistant`; TypeScript — див.
   апку Pronto) + виконавці tools через сервіси апки.

Tools виконує апка (клієнт), сервер лише описує їх моделі — так помічник бачить
рівно те, що бачить юзер (його кошик, меню для його адреси, його замовлення).

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
