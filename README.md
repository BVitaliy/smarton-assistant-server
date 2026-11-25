# AI-помічник — сервер (multi-tenant)

Один сервер AI-помічника для кількох апок: проксі між апкою й моделлю AI
(Claude або, для внутрішнього демо, OpenRouter). Ключ моделі — лише тут.

Апки (tenants): `smarton`, `smarton-dev` (дитяча освітня, Flutter), `pronto`
(доставка піци й суші, Ionic/Angular) і `smarton-admin`, `smarton-admin-dev`
(помічник-аналітик в адмінці SMARTon, Angular; режим `admin`).

- `POST /chat` — чат (Server-Sent Events), `GET /health` — перевірка.
- Налаштування — змінні середовища, див. `server.env.example`.

Починався як копія теки `functions/` з репозиторію SMARTon; тепер головна копія
— цей репозиторій (tenant-ів `pronto` і `smarton-admin` у `functions/` нема).

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

## Модель і провайдер

Провайдер обирається змінними середовища (`src/providers.ts`), не в апках:
`ASSISTANT_PROVIDER` = `anthropic` (Claude напряму, за замовчуванням) |
`openai` (GPT) | `openrouter` | `compatible` (будь-який API у форматі OpenAI:
Gemini, DeepSeek, Mistral…), модель — `ASSISTANT_MODEL`. Апки завжди говорять
із сервером у форматі Claude; переклад для OpenAI-сумісних — `src/openai_compat.ts`.
Як перемкнути на Render — [DEPLOY.md](DEPLOY.md#як-змінити-модель-claude-gpt-gemini).

## Свій ключ моделі для tenant-а

Будь-яку змінну провайдера можна задати окремо для tenant-а — суфіксом з його
id (великі літери, `-` → `_`): `ASSISTANT_PROVIDER_SMARTON_ADMIN`,
`OPENROUTER_API_KEY_SMARTON_ADMIN`, `ASSISTANT_MODEL_PRONTO` тощо. Не
задано — беруться загальні. Адмінка (прод і dev) ділить суфікс `SMARTON_ADMIN`
(`providerEnvKey` у конфігу tenant-а).

Окремий ключ дає окремий облік (видно, скільки запитів з'їла адмінка) і
дозволяє вимкнути чи замінити його, не чіпаючи апки. Безкоштовний ліміт
OpenRouter (50 запитів на добу до покупки $10 кредитів, після — 1000) рахується
на акаунт, тож другий ключ того самого акаунта ліміту не додає.

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
