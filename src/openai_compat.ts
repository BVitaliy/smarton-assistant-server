import { CompatConfig, ProviderError } from "./providers";

/**
 * Адаптер для API у форматі OpenAI Chat Completions: OpenAI (GPT), OpenRouter
 * (будь-яка модель, зокрема безкоштовні), Gemini / DeepSeek / Mistral / Groq
 * через їхні OpenAI-сумісні адреси. Вибір — `providers.ts`.
 *
 * Апка нічого не помічає: на вході й виході той самий формат, що в Claude
 * (блоки text / tool_use / tool_result / image), переклад — тут.
 */

/**
 * Безкоштовні моделі інколи стоять у черзі хвилинами. Довше не чекаємо:
 * апка покаже «помічник зайнятий» замість нескінченного «друкує…».
 */
const TIMEOUT_MS = 45_000;

/**
 * Скільки моделі «думати» перед відповіддю (ASSISTANT_REASONING):
 * `off` — без роздумів, `low`/`medium`/`high` — рівень зусиль; не задано —
 * як вирішить модель. Безкоштовні моделі думають перед кожним кроком
 * (пошук → картки → текст), тож `low` помітно пришвидшує відповідь.
 */
function reasoningField(config: CompatConfig): Record<string, unknown> {
  const value = config.reasoning?.toLowerCase();
  if (config.kind === "openrouter") {
    if (value === "off") return { reasoning: { enabled: false } };
    if (value === "low" || value === "medium" || value === "high") return { reasoning: { effort: value } };
    return {};
  }
  // OpenAI і сумісні: `reasoning_effort` розуміють лише моделі з роздумами.
  if (value === "low" || value === "medium" || value === "high") return { reasoning_effort: value };
  return {};
}

/**
 * "a,b,c" → model: a, models: [a, b, c] — запасні моделі вміє лише
 * OpenRouter (максимум 3); інші провайдери беруть першу.
 */
function modelFields(model: string, kind: CompatConfig["kind"]): { model: string; models?: string[] } {
  const list = model.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 3);
  if (kind !== "openrouter") return { model: list[0] ?? model };
  return list.length > 1 ? { model: list[0], models: list } : { model: list[0] ?? model };
}

/**
 * Решта параметрів запиту під провайдера. OpenAI: моделі з роздумами
 * приймають лише `max_completion_tokens` і стандартну temperature, тож її не
 * шлемо; usage у стрімі — через stream_options.
 */
function limitFields(kind: CompatConfig["kind"]): Record<string, unknown> {
  if (kind === "openai") return { max_completion_tokens: 4000, stream_options: { include_usage: true } };
  // Безкоштовні моделі «думають» у тих самих токенах — із запасом, щоб
  // роздуми не обрізали відповідь (stop: max_tokens).
  return { max_tokens: 4000, temperature: 0.4 };
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
    const images = blocks.filter((b) => b.type === "image").map(imageUrlPart).filter(Boolean);
    if (images.length) {
      out.push({ role: "user", content: [...(text ? [{ type: "text", text }] : []), ...images] });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

/** Блок картинки Claude (base64) → частина повідомлення OpenAI (data URL). */
function imageUrlPart(block: Block): Block | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || source.type !== "base64") return null;
  return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
}

/** Чи є в розмові картинка (тоді потрібна модель із зором). */
export function hasImages(messages: ClaudeMessage[]): boolean {
  return messages.some(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "image"),
  );
}

export function toOpenAiTools(tools: ClaudeTool[]): Block[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema },
  }));
}

/** Стрімить відповідь моделі; [onText] — шматки тексту для живого показу. */
export async function streamCompat(params: {
  config: CompatConfig;
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
    if (timeout.aborted) throw new ProviderError(504, `No answer from ${config.model} in ${TIMEOUT_MS / 1000}s`);
    throw error;
  }
}

async function request(
  params: Parameters<typeof streamCompat>[0],
  signal: AbortSignal,
): Promise<DemoTurn> {
  const { config } = params;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(config.kind === "openrouter" ? { "X-Title": "SMARTon assistant" } : {}),
    },
    body: JSON.stringify({
      ...modelFields(hasImages(params.messages) ? config.visionModel : config.model, config.kind),
      ...reasoningField(config),
      ...limitFields(config.kind),
      stream: true,
      messages: toOpenAiMessages(params.system, params.messages),
      tools: toOpenAiTools(params.tools),
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(response.status, body.slice(0, 300));
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
        throw new ProviderError(Number(json.error.code) || 502, String(json.error.message ?? "error"));
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
 * Слабкі моделі інколи пишуть у відповідь «Використовую show_options…».
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
