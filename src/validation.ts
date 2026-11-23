import type Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_MODES, AssistantMode, HttpError, TenantConfig } from "./types";

/** Від клієнта приймаємо лише user/assistant: system-повідомлень з клієнта не буває. */
type MessageParam = Anthropic.Beta.BetaUserMessageParam | Anthropic.Beta.BetaAssistantMessageParam;
type ContentParam = Anthropic.Beta.BetaMessageContentParam;

export interface ChatRequest {
  tenantId: string;
  mode: AssistantMode;
  locale: string;
  messages: MessageParam[];
  /** Сайт апки в multisite (напр. місто Pronto: "lutsk"); "" — головний. */
  site?: string;
}

/**
 * Типи блоків, які модель повертає в наших відповідях і які клієнт має
 * повернути назад без змін. Якщо API почне віддавати новий тип блока,
 * запит впаде з 400 — так ми помітимо це одразу, а не тихо загубимо блок.
 */
const ASSISTANT_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "fallback",
]);

/** Від юзера приймаємо лише текст і результати tools. Без картинок і файлів. */
const USER_BLOCK_TYPES = new Set(["text", "tool_result"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function parseChatRequest(
  body: unknown,
  resolveTenant: (id: string) => TenantConfig | undefined,
): { request: ChatRequest; tenant: TenantConfig } {
  if (!isRecord(body)) throw bad("Body must be a JSON object.");

  const tenantId = body.tenant;
  if (typeof tenantId !== "string") throw bad("`tenant` is required.");
  const tenant = resolveTenant(tenantId);
  if (!tenant) throw bad(`Unknown tenant "${tenantId}".`);

  const mode = body.mode;
  if (typeof mode !== "string" || !ASSISTANT_MODES.includes(mode as AssistantMode)) {
    throw bad("`mode` must be one of: " + ASSISTANT_MODES.join(", "));
  }
  if (!tenant.modes.includes(mode as AssistantMode)) {
    throw bad(`\`mode\` "${mode}" is not supported by tenant "${tenant.id}".`);
  }

  // Multisite (Pronto: кожне місто — окремий сайт WordPress): лише відомі
  // сайти, щоб через параметр не можна було змусити сервер ходити куди завгодно.
  let site: string | undefined;
  if (tenant.sites) {
    site = typeof body.site === "string" ? body.site.trim().replace(/^\/+|\/+$/g, "") : "";
    if (!tenant.sites.includes(site)) throw bad(`Unknown site "${site}".`);
  }

  const rawLocale = typeof body.locale === "string" ? body.locale : "";
  const locale = tenant.supportedLocales.includes(rawLocale)
    ? rawLocale
    : tenant.defaultLocale;

  const messages = sanitizeMessages(body.messages, tenant);

  return {
    tenant,
    request: { tenantId, mode: mode as AssistantMode, locale, messages, site },
  };
}

function sanitizeMessages(raw: unknown, tenant: TenantConfig): MessageParam[] {
  const { limits } = tenant;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw bad("`messages` must be a non-empty array.");
  }
  if (raw.length > limits.maxMessages) {
    throw new HttpError(
      413,
      "conversation_too_long",
      "Conversation is too long. Start a new one.",
    );
  }

  const result: MessageParam[] = [];
  raw.forEach((message, index) => {
    if (!isRecord(message)) throw bad(`messages[${index}] must be an object.`);
    const { role, content } = message;

    // Клієнт не може підсунути системне повідомлення: операторські
    // інструкції — тільки з сервера.
    if (role !== "user" && role !== "assistant") {
      throw bad(`messages[${index}].role must be "user" or "assistant".`);
    }

    if (typeof content === "string") {
      if (role === "user") checkUserText(content, index, limits.maxUserTextChars);
      result.push({ role, content });
      return;
    }

    if (!Array.isArray(content) || content.length === 0) {
      throw bad(`messages[${index}].content must be a string or a non-empty array.`);
    }

    const allowed = role === "user" ? USER_BLOCK_TYPES : ASSISTANT_BLOCK_TYPES;
    content.forEach((block, blockIndex) => {
      if (!isRecord(block) || typeof block.type !== "string") {
        throw bad(`messages[${index}].content[${blockIndex}] has no type.`);
      }
      if (!allowed.has(block.type)) {
        throw bad(
          `messages[${index}].content[${blockIndex}]: block type "${block.type}" is not allowed for ${role}.`,
        );
      }
      if (role === "user" && block.type === "text") {
        checkUserText(block.text, index, limits.maxUserTextChars);
      }
      if (role === "user" && block.type === "tool_result") {
        checkToolResult(block, index, limits.maxToolResultChars);
      }
    });

    // Блоки асистента повертаємо байт-у-байт: від цього залежать кеш
    // промпту і прив'язка блоків мислення.
    result.push({ role, content: content as ContentParam } as MessageParam);
  });

  if (result[0].role !== "user") throw bad("The first message must be from the user.");
  if (result[result.length - 1].role !== "user") {
    throw bad("The last message must be from the user (text or tool results).");
  }

  return result;
}

function checkUserText(text: unknown, index: number, maxChars: number): void {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw bad(`messages[${index}]: user text must be a non-empty string.`);
  }
  if (text.length > maxChars) {
    throw new HttpError(
      413,
      "message_too_long",
      `Message is longer than ${maxChars} characters.`,
    );
  }
}

function checkToolResult(
  block: Record<string, unknown>,
  index: number,
  maxChars: number,
): void {
  if (typeof block.tool_use_id !== "string") {
    throw bad(`messages[${index}]: tool_result needs tool_use_id.`);
  }
  const { content } = block;
  const size =
    typeof content === "string"
      ? content.length
      : JSON.stringify(content ?? "").length;
  if (size > maxChars) {
    throw new HttpError(413, "tool_result_too_large", "Tool result is too large.");
  }
}

/** Якщо вся розмова — одне текстове питання, повертає його текст. */
export function singleQuestionText(messages: MessageParam[]): string | null {
  if (messages.length !== 1) return null;
  const { content } = messages[0];
  if (content === undefined) return null;
  if (typeof content === "string") return content;
  if (content.length === 1 && content[0].type === "text") return content[0].text;
  return null;
}
