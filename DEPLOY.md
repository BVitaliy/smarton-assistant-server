# Деплой сервера AI-консультанта на свій сервер

Для бекенд-розробника. Сервер консультанта — невелика Node.js-програма з теки
`functions/` (гілка `feature/ai-assistant`). Вона проксує запити апки до моделі
AI: ключ моделі живе лише на сервері, сервер перевіряє вхід користувача через
API SMARTon і тримає ліміти для гостей. Сайт і API це не зачіпає.

## Варіант без свого сервера: Render

Безкоштовний хостинг, нічого налаштовувати на сервері не треба. У корені
репозиторію є `render.yaml`:

1. https://render.com → увійти через GitHub.
2. New → **Blueprint** → вибрати репозиторій `smarton_app` (гілка
   `feature/ai-assistant` уже вказана в `render.yaml`).
3. Render попросить значення `OPENROUTER_API_KEY` — вставити ключ.
4. Apply. За кілька хвилин сервіс зібрано, адреса — у шапці сервісу, напр.
   `https://smarton-assistant.onrender.com`. Перевірка: `…/health`.
5. Апці потрібна адреса `…/chat`.

Безкоштовний план «засинає» після ~15 хв без запитів: перша відповідь після
цього чекає ~30–60 с. Кожен push у гілку — автоматичний передеплой.

## Що потрібно на сервері

- Node.js **22** (LTS), npm.
- pm2 (або systemd) — щоб процес працював постійно й піднімався після ребуту.
- nginx (вже є) — один новий `location`.
- Вихідний HTTPS до: `api.anthropic.com` (Claude) або `openrouter.ai` (демо),
  а також до API SMARTon (`smarton.biz/api`, `smarton-dev.moonart.net.ua/api`).
- ~300 МБ на диску (з `node_modules`), ~150 МБ RAM.

## Куди

Пропозиція (можна інакше — головне сказати розробнику апки підсумкову адресу):

| | Значення |
|---|---|
| Тека | `/opt/smarton-assistant` (копія репозиторію, працюємо в `functions/`) |
| Процес | слухає `127.0.0.1:8787`, назовні не відкритий |
| Публічна адреса | `https://smarton.biz/assistant/chat` (через nginx) |
| Перевірка | `https://smarton.biz/assistant/health` |

Один сервер обслуговує і прод (`smarton`), і dev (`smarton-dev`) — апка сама
каже в запиті, звідки вона. Можна спершу підняти на dev-сервері.

## Перше встановлення

```bash
git clone <repo> /opt/smarton-assistant
cd /opt/smarton-assistant && git checkout feature/ai-assistant
cd functions
npm ci
npm run build

cp server.env.example .env.server   # заповнити ключі (див. коментарі у файлі)
chmod 600 .env.server

pm2 start npm --name smarton-assistant -- start
pm2 save && pm2 startup             # автозапуск після ребуту
```

Ключі (`ANTHROPIC_API_KEY` або для демо `OPENROUTER_API_KEY`) отримати від
розробника апки окремо — не через git і не в чаті.

## nginx

```nginx
location /assistant/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_buffering off;        # відповідь іде потоком (SSE), по словах
    proxy_cache off;
    proxy_read_timeout 300s;
    client_max_body_size 1m;
}
```

Без `proxy_buffering off` чат працюватиме, але текст з'являтиметься одним
шматком наприкінці, а не по словах.

## Перевірка

```bash
curl https://smarton.biz/assistant/health
# {"ok":true,"provider":"anthropic"}   (або "openrouter" для демо)

curl -N -X POST https://smarton.biz/assistant/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Assistant-Install: 0123456789abcdef0123456789abcdef' \
  -d '{"tenant":"smarton","mode":"guest","locale":"uk","messages":[{"role":"user","content":"Що таке SMARTon?"}]}'
# має прийти потік: event: text … event: message
```

Якщо `event: error` з `app_check_required` — для гостей у проді увімкнена
перевірка App Check (див. `server.env.example`, `ASSISTANT_GUEST_APP_CHECK`).

## Оновлення

```bash
cd /opt/smarton-assistant && git pull
cd functions && npm ci && npm run build
pm2 restart smarton-assistant
```

Деплоїти треба після змін промптів, бази знань (`knowledge/smarton/`), статей
(`npm run sync:articles`), коду сервера. Апку при цьому перевипускати не треба.

## Логи й безпека

- `pm2 logs smarton-assistant` — лише метрики (режим, модель, час, токени),
  **без тексту розмов**: серед користувачів діти.
- `.env.server` — з правами `600`, не в git (вже в `.gitignore`).
- Порт 8787 не відкривати назовні — лише через nginx.
- Ліміти гостей рахуються в пам'яті процесу: при одному процесі вони точні;
  не запускати кілька копій за балансувальником без спільного лічильника.

## Що потім робить розробник апки

Прописує адресу в `dart_defines` (`ASSISTANT_URL=https://smarton.biz/assistant/chat`)
і збирає апку. Коду апки змінювати не треба.
