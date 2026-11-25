import Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { readCachedAnswer, writeCachedAnswer } from "./answer_cache";
import { identify } from "./identity";
import { streamCompat } from "./openai_compat";
import { ProviderError, resolveProvider } from "./providers";
import { resolveTenant } from "./tenants";
import { HttpError } from "./types";
import { parseChatRequest, singleQuestionText } from "./validation";

/*
 * Модель і провайдер — `providers.ts` (змінні середовища для кожного
 * tenant-а). Claude Haiku 5.5 за замовчуванням: $0.10 / $0.50 за 1M токенів
 * вхід / вихід, читання з кешу промпту — 0.1x від ціни входу.
 */

/**
 * Протокол відповіді — Server-Sent Events:
 *   event: text     data: {"text": "..."}                 — шматок тексту для живого показу
 *   event: message  data: {"content": [...], "stop_reason": "...", "cached": bool}
 *                   — фінальний вміст ходу. Клієнт кладе `content` в історію
 *                     БЕЗ ЗМІН і, якщо stop_reason == "tool_use", виконує tools.
 *   event: error    data: {"code": "...", "message": "..."}
 *
 * Сервер не зберігає розмову: історію тримає клієнт і надсилає щоразу.
 */
export async function handleChat(req: Request, res: Response, apiKey: string): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== "POST") {
    res.status(405).json({ code: "method_not_allowed" });
    return;
  }

  let sseStarted = false;
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { tenant, request } = parseChatRequest(req.body, resolveTenant);

    if (req.rawBody && req.rawBody.length > tenant.limits.maxBodyBytes) {
      throw new HttpError(413, "body_too_large", "Request is too large.");
    }

    // Залогінений — за токеном апки; гість — за App Check і id встановлення.
    const user = await identify(req, tenant, request);
    const personalNote = user.firstName ? personalizationNote(user.firstName) : null;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    sseStarted = true;

    const cacheScope = {
      tenantId: tenant.id,
      mode: request.mode,
      locale: request.locale,
      knowledgeVersion: tenant.knowledgeVersion,
    };

    // 1) Кеш готових відповідей — лише для першого питання розмови.
    // Персональні відповіді («Привіт, Олю!») не кешуємо: їх отримав би інший юзер.
    const question = personalNote || tenant.noAnswerCache ? null : singleQuestionText(request.messages);
    if (question) {
      const cached = await readCachedAnswer(cacheScope, question);
      if (cached) {
        send("text", { text: cached });
        send("message", { content: [{ type: "text", text: cached }], stop_reason: "end_turn", cached: true });
        logTurn({ tenant: tenant.id, mode: request.mode, locale: request.locale, cached: true, latencyMs: Date.now() - startedAt });
        res.end();
        return;
      }
    }

    // 2) Модель: Claude напряму або OpenAI-сумісний провайдер (GPT, OpenRouter, Gemini…).
    const provider = resolveProvider(tenant.providerEnvKey ?? tenant.id, apiKey);
    if (provider.kind !== "anthropic") {
      const abort = new AbortController();
      req.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const turn = await streamCompat({
        config: provider,
        system: [tenant.systemPrompt(request.mode, request.locale), personalNote].filter(Boolean).join("\n\n"),
        tools: tenant.tools(request.mode) as never,
        messages: request.messages as never,
        onText: (text) => send("text", { text }),
        signal: abort.signal,
      });
      send("message", { content: turn.content, stop_reason: turn.stopReason, cached: false });
      res.end();
      logTurn({
        tenant: tenant.id,
        mode: request.mode,
        provider: provider.kind,
        model: turn.model,
        stopReason: turn.stopReason,
        usage: turn.usage,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const client = new Anthropic({ apiKey: provider.apiKey });
    const stream = client.beta.messages.stream({
      model: provider.model,
      max_tokens: 16000,
      betas: ["thinking-binding-controls-2026-08-01"],
      // Відмову класифікатора безпеки (stop_reason "refusal") обробляє
      // клієнт: показує м'яке повідомлення й прибирає питання з історії.
      //
      // Мислення адаптивне: модель сама вирішує, скільки думати, а effort
      // задає межу. `drop_block` — страховка: якщо промпт оновився посеред
      // розмови, старі блоки мислення відкидаються замість помилки 400.
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: tenant.effort(request.mode) },
      // Автокеш промпту: системний промпт + база знань + історія кешуються
      // на боці Claude, наступний хід читає їх у ~10 разів дешевше.
      cache_control: { type: "ephemeral" },
      // Спільний промпт — першим блоком, ім'я — окремим після нього.
      system: [
        { type: "text", text: tenant.systemPrompt(request.mode, request.locale) },
        ...(personalNote ? [{ type: "text" as const, text: personalNote }] : []),
      ],
      tools: tenant.tools(request.mode),
      messages: request.messages,
    });

    req.on("close", () => {
      if (!res.writableEnded) stream.abort();
    });

    stream.on("text", (delta) => send("text", { text: delta }));

    const message = await stream.finalMessage();
    send("message", { content: message.content, stop_reason: message.stop_reason, cached: false });
    res.end();

    logTurn({
      tenant: tenant.id,
      mode: request.mode,
      locale: request.locale,
      cached: false,
      model: message.model,
      stopReason: message.stop_reason,
      refusalCategory: message.stop_reason === "refusal" ? message.stop_details?.category ?? null : undefined,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens,
      },
      latencyMs: Date.now() - startedAt,
    });

    // 3) Запис у кеш: тільки загальна відповідь на перше питання, без tools.
    const usedTools = message.content.some((block) => block.type === "tool_use");
    if (question && message.stop_reason === "end_turn" && !usedTools) {
      const answer = message.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (answer) await writeCachedAnswer(cacheScope, question, answer);
    }
  } catch (error) {
    const { status, code, message } = toPublicError(error);
    if (status >= 500) logger.error("assistant.chat_failed", { code, error: String(error) });

    if (sseStarted) {
      if (!res.writableEnded) {
        send("error", { code, message });
        res.end();
      }
    } else {
      res.status(status).json({ code, message });
    }
  }
}

/**
 * Ім'я з профілю — для теплішого звертання. Уже очищене `safeFirstName`, але
 * однаково подаємо його як дані в лапках, а не як частину інструкцій.
 */
export function personalizationNote(firstName: string): string {
  return `Personalization: the signed-in user's first name from their profile is "${firstName}". Address them by this name now and then where it feels natural (a greeting, praise, encouragement), not in every message, and use the correct grammatical form for the reply language. If they ask to be called differently, do so. This is the only profile detail you know; never mention a surname or other personal data.`;
}

function toPublicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ProviderError) {
    // Денний ліміт безкоштовних моделей акаунта (50 або 1000 запитів) —
    // повтор до півночі UTC не допоможе, тож кажемо про це прямо.
    if (error.status === 429 && /free-models-per-day/i.test(error.message)) {
      return {
        status: 429,
        code: "daily_limit",
        message: "The assistant has used up today's request limit. It will work again after 00:00 UTC.",
      };
    }
    // 429 — ліміт провайдера, 504 — модель не відповіла вчасно; решта
    // (ключ, конфігурація, 400) — «тимчасово недоступний», причина — у лозі.
    return error.status === 429 || error.status === 504
      ? { status: 503, code: "model_busy", message: "The assistant is busy. Try again later." }
      : { status: 502, code: "model_unavailable", message: "The assistant is temporarily unavailable." };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 503, code: "model_busy", message: "The assistant is busy. Try again in a minute." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    // 400 від API — це баг у нас (формат історії, промпт), а не в юзера.
    return { status: 502, code: "model_rejected", message: "The assistant could not process this conversation." };
  }
  if (error instanceof Anthropic.APIError) {
    return { status: 502, code: "model_unavailable", message: "The assistant is temporarily unavailable." };
  }
  return { status: 500, code: "internal", message: "Something went wrong." };
}

/**
 * Лог без тексту розмов: серед юзерів діти, тож зміст повідомлень не
 * зберігаємо. Лише метрики — щоб рахувати вартість, кеш і відмови.
 */
function logTurn(fields: Record<string, unknown>): void {
  logger.info("assistant.turn", fields);
}
