/**
 * Яка модель відповідає — окремо для кожного tenant-а, лише змінними
 * середовища (без правок коду й без релізу апок: формат між апкою й сервером
 * завжди «як у Claude», переклад — у адаптерах).
 *
 *   ASSISTANT_PROVIDER = anthropic | openai | openrouter | compatible
 *   ASSISTANT_MODEL     — id моделі провайдера (для openrouter — до 3 через кому)
 *   ASSISTANT_VISION_MODEL — модель для питань зі скріншотом (не задано — та сама)
 *   ASSISTANT_REASONING — off | low | medium | high (лише OpenAI-сумісні)
 *
 * Ключі:
 *   anthropic  — ANTHROPIC_API_KEY (Claude напряму)
 *   openai     — OPENAI_API_KEY (GPT напряму; OPENAI_BASE_URL — напр. Azure)
 *   openrouter — OPENROUTER_API_KEY (сотні моделей одним ключем, зокрема Claude і GPT)
 *   compatible — LLM_API_KEY + LLM_BASE_URL: будь-який API у форматі OpenAI
 *                Chat Completions (Gemini, DeepSeek, Mistral, Groq, свій сервер…)
 *
 * Кожна змінна може мати суфікс tenant-а: `ASSISTANT_PROVIDER_SMARTON_ADMIN`,
 * `OPENAI_API_KEY_PRONTO` тощо (id великими, «-» → «_»). Без суфікса — для всіх.
 */

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "compatible";

/** Провайдер у форматі OpenAI Chat Completions. */
export interface CompatConfig {
  kind: "openai" | "openrouter" | "compatible";
  apiKey: string;
  baseUrl: string;
  /** Для openrouter — «a,b,c»: основна й запасні. */
  model: string;
  /** Модель для запитів із картинкою. */
  visionModel: string;
  /** off | low | medium | high; не задано — як вирішить модель. */
  reasoning?: string;
}

export interface AnthropicConfig {
  kind: "anthropic";
  apiKey: string;
  model: string;
}

export type ProviderConfig = AnthropicConfig | CompatConfig;

/** Помилка провайдера моделі (не Anthropic SDK) з HTTP-статусом. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Claude Haiku 5.5 — обрано для проду (ціна). Сервер шле адаптивне мислення
 * й `effort`, тож для Claude підходять моделі 4.6 і новіші.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

/**
 * Безкоштовні моделі OpenRouter (порівняння на українській 2026-11-23):
 * nemotron-3-ultra — чиста мова; ernie — добре, але інколи англійське слово;
 * nemotron-3.5-super-vl — запасна, бачить картинки.
 */
const DEFAULT_OPENROUTER_MODEL =
  "nvidia/nemotron-3-ultra-550b-a55b:free,baidu/ernie-5.5-flash-preview:free,nvidia/nemotron-3.5-super-vl:free";

/** Для ходів зі скріншотом: Gemma 4 — найкраща українська серед безкоштовних, далі Nemotron VL. */
const DEFAULT_OPENROUTER_VISION_MODEL =
  "google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-26b-a4b-it:free";

/** Змінна для tenant-а (`NAME_<TENANT>`), інакше загальна (`NAME`). */
export function tenantEnv(name: string, tenantKey?: string): string | undefined {
  if (tenantKey) {
    const suffix = tenantKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const own = process.env[`${name}_${suffix}`]?.trim();
    if (own) return own;
  }
  return process.env[name]?.trim() || undefined;
}

/**
 * Провайдер для tenant-а. [fallbackAnthropicKey] — ключ Claude, який передав
 * хостинг (Firebase secret / .env.server). Помилка конфігурації —
 * [ProviderError]: апка покаже «помічник тимчасово недоступний», а в лозі
 * буде причина.
 */
export function resolveProvider(tenantKey: string, fallbackAnthropicKey = ""): ProviderConfig {
  const env = (name: string) => tenantEnv(name, tenantKey);
  const kind = (env("ASSISTANT_PROVIDER") ?? "anthropic").toLowerCase();
  const model = env("ASSISTANT_MODEL");
  const vision = env("ASSISTANT_VISION_MODEL");
  const reasoning = env("ASSISTANT_REASONING");

  switch (kind) {
    case "anthropic":
    case "claude": {
      const apiKey = env("ANTHROPIC_API_KEY") || fallbackAnthropicKey;
      if (!apiKey) throw new ProviderError(500, "ANTHROPIC_API_KEY is not set");
      return { kind: "anthropic", apiKey, model: model || DEFAULT_CLAUDE_MODEL };
    }

    case "openrouter": {
      const apiKey = requireKey(env("OPENROUTER_API_KEY"), "OPENROUTER_API_KEY");
      // Ключ OpenRouter — лише ASCII і починається з sk-or-. Інакше (напр.
      // вставили разом з лапками) fetch падає з незрозумілою помилкою.
      if (!/^sk-or-[\x21-\x7e]+$/.test(apiKey)) {
        throw new ProviderError(
          401,
          `OPENROUTER_API_KEY looks wrong: must start with "sk-or-" and contain no spaces or quotes (starts with "${apiKey.slice(0, 6)}…")`,
        );
      }
      const chosen = model || env("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL;
      // Безкоштовні моделі мають денний ліміт і можуть зберігати запити —
      // лише з явним дозволом (внутрішнє демо) або в емуляторі.
      const allowFree =
        process.env.FUNCTIONS_EMULATOR === "true" || process.env.ASSISTANT_ALLOW_DEMO_PROVIDER === "true";
      if (!allowFree && /:free\b/.test(chosen)) {
        throw new ProviderError(500, "free OpenRouter models need ASSISTANT_ALLOW_DEMO_PROVIDER=true");
      }
      return {
        kind: "openrouter",
        apiKey,
        baseUrl: env("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1",
        model: chosen,
        visionModel:
          vision ||
          env("OPENROUTER_VISION_MODEL") ||
          (/:free\b/.test(chosen) ? DEFAULT_OPENROUTER_VISION_MODEL : chosen),
        reasoning: reasoning || env("OPENROUTER_REASONING"),
      };
    }

    case "openai":
    case "gpt": {
      const chosen = requireKey(model, "ASSISTANT_MODEL (e.g. an OpenAI model id)");
      return {
        kind: "openai",
        apiKey: requireKey(env("OPENAI_API_KEY"), "OPENAI_API_KEY"),
        baseUrl: env("OPENAI_BASE_URL") || "https://api.openai.com/v1",
        model: chosen,
        visionModel: vision || chosen,
        reasoning,
      };
    }

    case "compatible": {
      const chosen = requireKey(model, "ASSISTANT_MODEL");
      return {
        kind: "compatible",
        apiKey: requireKey(env("LLM_API_KEY"), "LLM_API_KEY"),
        baseUrl: requireKey(env("LLM_BASE_URL"), "LLM_BASE_URL").replace(/\/+$/, ""),
        model: chosen,
        visionModel: vision || chosen,
        reasoning,
      };
    }

    default:
      throw new ProviderError(500, `Unknown ASSISTANT_PROVIDER "${kind}"`);
  }
}

function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new ProviderError(500, `${name} is not set`);
  return value;
}
