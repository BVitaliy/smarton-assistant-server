import { logger } from "firebase-functions";

/**
 * ЛИШЕ ДЛЯ ЛОКАЛЬНОГО ДЕМО: моделі OpenRouter (зокрема безкоштовні) замість
 * Claude, щоб показати чат без оплати.
 *
 * Вмикається файлом `functions/.env.local` (його читає тільки емулятор):
 *   ASSISTANT_PROVIDER=openrouter
 *   OPENROUTER_API_KEY=...
 *   OPENROUTER_MODEL=google/gemma-4-31b-it:free
 *
 * Поза емулятором вмикається лише з ASSISTANT_ALLOW_DEMO_PROVIDER=true
 * (внутрішнє демо, напр. TestFlight для команди). Інакше ігнорується: безкоштовні
 * моделі мають ліміт ~50 запитів на добу на акаунт, а провайдери можуть
 * зберігати й навчатися на запитах — для дитячої апки в проді це не годиться.
 *
 * Апка нічого не помічає: на вході й виході той самий формат, що в Claude
 * (блоки text / tool_use / tool_result), переклад у формат OpenAI — тут.
 */

/**
 * Основна + запасні (через кому): якщо перша зайнята чи впала, OpenRouter сам
 * бере наступну. Порівняння на українській (2026-11-23): nemotron-3-ultra —
 * чиста мова; ernie — добре, але інколи англійське слово; nemotron-3.5-super —
 * помилки («ролі», «остра»), JSON у тексті. Gemma зараз майже завжди зайнята.
 */
const DEFAULT_MODEL =
  "nvidia/nemotron-3-ultra-550b-a55b:free,baidu/ernie-5.5-flash-preview:free,nvidia/nemotron-3.5-super-vl:free";

/**
 * Безкоштовні моделі інколи стоять у черзі хвилинами. Довше не чекаємо:
 * апка покаже «помічник зайнятий» замість нескінченного «друкує…».
 */
const TIMEOUT_MS = 45_000;

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** OPENROUTER_REASONING (або його варіант для tenant-а). */
  reasoning?: string;
}

/**
 * Змінна середовища для конкретного tenant-а з запасним загальним значенням:
 * `OPENROUTER_API_KEY_SMARTON_ADMIN`, інакше `OPENROUTER_API_KEY`. Так адмінка
 * може мати свій ключ (свій денний ліміт і рахунок), а апки — спільний.
 */
function tenantEnv(name: string, tenantId?: string): string | undefined {
  if (tenantId) {
    const suffix = tenantId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const own = process.env[`${name}_${suffix}`]?.trim();
    if (own) return own;
  }
  return process.env[name]?.trim() || undefined;
}

export class OpenRouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Налаштування демо-провайдера або null, якщо працюємо з Claude. */
export function demoOpenRouter(tenantId?: string): OpenRouterConfig | null {
  if (process.env.ASSISTANT_PROVIDER !== "openrouter") return null;
  // Безкоштовні моделі — лише локально або на сервері з явним прапорцем
  // «внутрішнє демо». У Firebase-деплої й на проді — ніколи випадково.
  const allowed =
    process.env.FUNCTIONS_EMULATOR === "true" || process.env.ASSISTANT_ALLOW_DEMO_PROVIDER === "true";
  if (!allowed) {
    logger.warn("assistant.openrouter_ignored", { reason: "set ASSISTANT_ALLOW_DEMO_PROVIDER=true for internal demo" });
    return null;
  }
  const apiKey = tenantEnv("OPENROUTER_API_KEY", tenantId) ?? "";
  if (!apiKey || apiKey === "PASTE_KEY_HERE") {
    throw new OpenRouterError(401, "OPENROUTER_API_KEY is not set");
  }
  // Ключ OpenRouter — лише ASCII і починається з sk-or-. Інакше (напр.
  // вставили разом з підказкою чи лапками) fetch падає з незрозумілою
  // помилкою про ByteString — краще одразу сказати, що з ключем не так.
  if (!/^sk-or-[\x21-\x7e]+$/.test(apiKey)) {
    throw new OpenRouterError(
      401,
      `OPENROUTER_API_KEY looks wrong: must start with "sk-or-" and contain no spaces, quotes or non-Latin letters (starts with "${apiKey.slice(0, 6)}…")`,
    );
  }
  return {
    apiKey,
    model: tenantEnv("OPENROUTER_MODEL", tenantId) || DEFAULT_MODEL,
    baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    reasoning: tenantEnv("OPENROUTER_REASONING", tenantId),
  };
}

/**
 * Скільки моделі «думати» перед відповіддю (OPENROUTER_REASONING):
 * `off` — без роздумів, `low`/`medium`/`high` — рівень зусиль; не задано —
 * як вирішить модель. Безкоштовні моделі думають перед кожним кроком
 * (пошук → картки → текст), тож `low` помітно пришвидшує відповідь.
 */
function reasoningField(setting?: string): { reasoning?: Record<string, unknown> } {
  const value = setting?.toLowerCase();
  if (value === "off") return { reasoning: { enabled: false } };
  if (value === "low" || value === "medium" || value === "high") return { reasoning: { effort: value } };
  return {};
}

/** "a,b,c" → model: a, models: [a, b, c] (фолбек OpenRouter; максимум 3). */
function modelFields(model: string): { model: string; models?: string[] } {
  const list = model.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 3);
  return list.length > 1 ? { model: list[0], models: list } : { model: list[0] ?? model };
}

type Block = Record<string, unknown>;
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | Block[];
}
interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface DemoTurn {
  content: Block[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  model: string;
  usage?: { input?: number; output?: number };
}

/** Історія Claude → повідомлення OpenAI chat completions. */
export function toOpenAiMessages(system: string, messages: ClaudeMessage[]): Block[] {
  const out: Block[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content;

    if (message.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function",
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (!text && calls.length === 0) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // Результати tools мають іти одразу після assistant з tool_calls.
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      const raw = block.content;
      const content = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
      out.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id),
        content: block.is_error ? `Error: ${content}` : content,
      });
    }
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n")
      .trim();
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function toOpenAiTools(tools: ClaudeTool[]): Block[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema },
  }));
}

/** Стрімить відповідь моделі; [onText] — шматки тексту для живого показу. */
export async function streamOpenRouter(params: {
  config: OpenRouterConfig;
  system: string;
  tools: ClaudeTool[];
  messages: ClaudeMessage[];
  onText: (text: string) => void;
  signal: AbortSignal;
}): Promise<DemoTurn> {
  const { config } = params;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await request(params, AbortSignal.any([params.signal, timeout]));
  } catch (error) {
    if (timeout.aborted) throw new OpenRouterError(504, `No answer from ${config.model} in ${TIMEOUT_MS / 1000}s`);
    throw error;
  }
}

async function request(
  params: Parameters<typeof streamOpenRouter>[0],
  signal: AbortSignal,
): Promise<DemoTurn> {
  const { config } = params;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "SMARTon assistant demo",
    },
    body: JSON.stringify({
      ...modelFields(config.model),
      ...reasoningField(config.reasoning),
      stream: true,
      // Безкоштовні моделі «думають» у тих самих токенах — із запасом, щоб
      // роздуми не обрізали відповідь (stop: max_tokens).
      max_tokens: 4000,
      temperature: 0.4,
      messages: toOpenAiMessages(params.system, params.messages),
      tools: toOpenAiTools(params.tools),
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new OpenRouterError(response.status, body.slice(0, 300));
  }

  let text = "";
  let finish: string | null = null;
  let model = config.model;
  let usage: DemoTurn["usage"];
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue; // порожні рядки й коментарі OpenRouter
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;

      let json: Record<string, any>;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        throw new OpenRouterError(Number(json.error.code) || 502, String(json.error.message ?? "error"));
      }
      if (typeof json.model === "string") model = json.model;
      if (json.usage) usage = { input: json.usage.prompt_tokens, output: json.usage.completion_tokens };

      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        params.onText(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : calls.size;
        const current = calls.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        calls.set(index, current);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  const content: Block[] = [];
  const clean = withoutToolTalk(text, params.tools);
  if (clean) content.push({ type: "text", text: clean });
  let n = 0;
  for (const call of calls.values()) {
    if (!call.name) continue;
    let input: unknown = {};
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch {
      input = {}; // клієнт перевірить вхід і поверне моделі помилку
    }
    content.push({ type: "tool_use", id: call.id || `call_demo_${Date.now()}_${n++}`, name: call.name, input });
  }

  const hasTools = content.some((b) => b.type === "tool_use");
  const stopReason: DemoTurn["stopReason"] = hasTools
    ? "tool_use"
    : finish === "length"
      ? "max_tokens"
      : finish === "content_filter"
        ? "refusal"
        : "end_turn";

  return { content, stopReason, model, usage };
}

/**
 * Безкоштовні моделі інколи пишуть у відповідь «Використовую show_options…».
 * Прибираємо такі рядки з фінального тексту (його й показує апка). Claude
 * так не робить — це лише для демо.
 */
export function withoutToolTalk(text: string, tools: ClaudeTool[]): string {
  const names = tools.map((tool) => tool.name);
  return text
    .split("\n")
    .filter((line) => !names.some((name) => line.includes(name)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
