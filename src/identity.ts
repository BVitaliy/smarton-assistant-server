import type Anthropic from "@anthropic-ai/sdk";
import { getAppCheck } from "firebase-admin/app-check";
import { logger } from "firebase-functions";
import type { Request } from "firebase-functions/v2/https";
import { bearerToken, verifyUser } from "./auth";
import { adminApp } from "./firebase_admin";
import { checkRateLimit } from "./rate_limit";
import { HttpError, TenantConfig, VerifiedUser } from "./types";
import type { ChatRequest } from "./validation";

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

/** Id встановлення генерує апка: 32–64 hex-символи. */
const INSTALL_ID = /^[a-f0-9]{32,64}$/;

/**
 * Хто пише і чи можна йому зараз писати.
 *
 * - Залогінений (`kid` / `parent`): токен апки, перевірений через її API.
 * - Гість (`guest`): токена нема. Замість нього — App Check (запит прийшов
 *   зі справжньої апки), ліміти за id встановлення та IP і стеля питань на
 *   розмову. Історію тримає клієнт, тож стелю можна обійти новою розмовою —
 *   від цього захищає добовий ліміт на встановлення.
 */
export async function identify(req: Request, tenant: TenantConfig, request: ChatRequest): Promise<VerifiedUser> {
  if (request.mode !== "guest") {
    const token = bearerToken(req.header("authorization"));
    const user = await verifyUser(tenant, token, request.locale, request.site);
    checkRateLimit(user.userId, tenant.limits.rateLimitPerWindow, tenant.limits.rateWindowMs);
    return user;
  }

  const policy = tenant.guest;
  if (!policy.enabled) {
    throw new HttpError(403, "guest_disabled", "Sign in to use the assistant.");
  }

  if (policy.requireAppCheck) await verifyAppCheck(req.header("x-firebase-appcheck"));

  const installId = (req.header("x-assistant-install") ?? "").toLowerCase();
  if (!INSTALL_ID.test(installId)) {
    throw new HttpError(400, "bad_request", "Missing installation id.");
  }

  const questions = countUserQuestions(request.messages);
  if (questions > policy.maxQuestions) {
    throw new HttpError(403, "guest_limit", "Sign up to keep chatting.");
  }

  checkRateLimit(`ip:${tenant.id}:${clientIp(req)}`, policy.requestsPerIpPer10Min, TEN_MINUTES);
  checkRateLimit(`guest:${tenant.id}:${installId}`, policy.dailyRequestsPerInstall, ONE_DAY);

  return { userId: `${tenant.id}:guest:${installId}` };
}

async function verifyAppCheck(token: string | undefined): Promise<void> {
  if (!token) {
    throw new HttpError(401, "app_check_required", "This app build is not verified.");
  }
  try {
    await getAppCheck(adminApp()).verifyToken(token);
  } catch (error) {
    logger.warn("assistant.app_check_failed", { error: String(error) });
    throw new HttpError(401, "app_check_failed", "This app build is not verified.");
  }
}

/** Питання юзера — це повідомлення з текстом; результати tools не рахуються. */
function countUserQuestions(messages: ChatRequest["messages"]): number {
  return messages.filter((message) => {
    if (message.role !== "user") return false;
    const { content } = message;
    if (typeof content === "string") return true;
    return (content ?? []).some((block: Anthropic.Beta.BetaContentBlockParam) => block.type === "text");
  }).length;
}

/** Cloud Run ставить IP клієнта першим у X-Forwarded-For. */
function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.ip || "unknown";
}
