import type Anthropic from "@anthropic-ai/sdk";

/**
 * Режим консультанта. Обирає не модель, а апка: батьківський режим
 * відкривається лише після батьківського гарду, тож сервер довіряє полю
 * `mode` рівно настільки, наскільки довіряє самій апці. Дитячий режим —
 * безпечний дефолт для залогіненого юзера.
 *
 * `guest` — юзер без акаунта: токена нема, тому замість нього вимагаємо
 * Firebase App Check і рахуємо ліміти за id встановлення та IP.
 */
/**
 * `guest` — без входу; `member` — залогінений користувач (загальний режим);
 * `kid` / `parent` — дитяча апка (SMARTon); `admin` — працівник в адмінці.
 * Кожен tenant оголошує свої.
 */
export type AssistantMode = "kid" | "parent" | "guest" | "member" | "admin";

export const ASSISTANT_MODES: readonly AssistantMode[] = ["kid", "parent", "guest", "member", "admin"];

export interface GuestPolicy {
  enabled: boolean;
  /** Вимагати токен Firebase App Check: лише справжня апка може писати. */
  requireAppCheck: boolean;
  /** Скільки питань гість може поставити в одній розмові. */
  maxQuestions: number;
  /** Запитів до моделі з одного встановлення апки за добу. */
  dailyRequestsPerInstall: number;
  /** Запитів з однієї IP-адреси за 10 хвилин. */
  requestsPerIpPer10Min: number;
}

export interface TenantLimits {
  /** Максимум символів в одному текстовому повідомленні юзера. */
  maxUserTextChars: number;
  /** Максимум повідомлень в історії, яку надсилає клієнт. */
  maxMessages: number;
  /** Максимальний розмір тіла запиту в байтах. */
  maxBodyBytes: number;
  /**
   * Скріншоти від юзера: скільки картинок в одному повідомленні (0 чи не
   * задано — картинки заборонені) і максимальний розмір однієї (байти після
   * base64-декодування). Поки лише адмінка.
   */
  maxImagesPerMessage?: number;
  maxImageBytes?: number;
  /** Максимум символів у результаті одного tool, який повертає клієнт. */
  maxToolResultChars: number;
  /** Запитів до моделі на одного юзера за вікно `rateWindowMs`. */
  rateLimitPerWindow: number;
  rateWindowMs: number;
}

/**
 * Усе, що відрізняє одну апку від іншої. Нова апка = новий конфіг у
 * `tenants/`, без змін у ядрі.
 */
export interface TenantConfig {
  id: string;
  /** API апки: через нього перевіряємо токен юзера. */
  apiBaseUrl: string;
  /**
   * Сайти multisite (шлях після `apiBaseUrl`, "" — головний). Якщо задано,
   * апка передає `site`, і токен перевіряється на сайті юзера.
   */
  sites?: readonly string[];
  /** Будь-який GET, що вимагає авторизації. 200 = токен валідний. */
  verifyPath: string;
  /** Дістає стабільний id юзера з відповіді `verifyPath`, якщо він там є. */
  extractUserId: (body: unknown) => string | null;
  /** Ім'я для звертання з відповіді verifyPath; null — не вказане. */
  extractFirstName: (body: unknown) => string | null;
  /**
   * Id та ім'я з самого токена (JWT), коли `verifyPath` їх не віддає.
   * Викликається лише ПІСЛЯ того, як API апки прийняв токен (200), тож
   * підпис уже перевірив бекенд.
   */
  claimsFromToken?: (token: string) => { userId?: string | null; firstName?: string | null } | null;
  /**
   * Не кешувати готові відповіді навіть з ASSISTANT_ANSWER_CACHE=on
   * (адмінка: відповіді залежать від живих даних).
   */
  noAnswerCache?: boolean;
  /**
   * Суфікс змінних провайдера (`OPENROUTER_API_KEY_<суфікс>` тощо), якщо
   * кілька tenant-ів ділять один ключ (прод і dev адмінки). Не задано — id.
   */
  providerEnvKey?: string;
  /** Режими, які підтримує апка; інші сервер відхиляє. */
  modes: readonly AssistantMode[];
  supportedLocales: readonly string[];
  defaultLocale: string;
  limits: TenantLimits;
  guest: GuestPolicy;
  /**
   * Системний промпт. МАЄ бути детермінованим для пари (mode, locale):
   * будь-яка зміна байтів скидає кеш промпту і прив'язку блоків мислення.
   * Ніяких дат, імен юзера чи випадкових id тут.
   */
  systemPrompt: (mode: AssistantMode, locale: string) => string;
  /**
   * Скільки модель думає перед відповіддю: `low` — найшвидше й найдешевше,
   * `medium` — краще тримає правила промпту, `high` — для складних задач.
   */
  effort: (mode: AssistantMode) => "low" | "medium" | "high";
  /** Набір tools для режиму. Порядок фіксований — він теж частина префікса. */
  tools: (mode: AssistantMode) => Anthropic.Beta.BetaTool[];
  /** Змінюється, коли змінюється база знань або промпт; входить у ключ кешу. */
  knowledgeVersion: string;
}

export interface VerifiedUser {
  userId: string;
  /** Ім'я з профілю, вже очищене (див. `safeFirstName`); лише для залогінених. */
  firstName?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
