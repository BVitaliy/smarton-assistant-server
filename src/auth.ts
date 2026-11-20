import { createHash } from "node:crypto";
import { HttpError, TenantConfig, VerifiedUser } from "./types";

const VERIFY_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_TOKENS = 5000;

/**
 * Кеш перевірених токенів у пам'яті інстансу: без нього кожне повідомлення
 * (і кожна ітерація tools) смикало б API апки ще раз.
 */
const verified = new Map<string, { user: VerifiedUser; expiresAt: number }>();

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) throw new HttpError(401, "unauthorized", "Missing bearer token.");
  return match[1].trim();
}

/**
 * Перевіряє токен юзера через API самої апки. Окремої авторизації в
 * консультанта немає: хто залогінений в апці, той і може писати.
 */
export async function verifyUser(
  tenant: TenantConfig,
  token: string,
  locale: string,
): Promise<VerifiedUser> {
  const tokenHash = sha256(`${tenant.id}:${token}`);
  const cached = verified.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  let response: Response;
  try {
    response = await fetch(joinUrl(tenant.apiBaseUrl, tenant.verifyPath), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-client-lang": locale,
        "x-client-platform": "assistant",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(503, "auth_unavailable", "Could not verify the session.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "unauthorized", "Session is not valid.");
  }
  if (!response.ok) {
    throw new HttpError(503, "auth_unavailable", "Could not verify the session.");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Тіло не обов'язкове: достатньо статусу 200.
  }

  // Токен міняється після refresh, тому стабільний id з профілю кращий для
  // лімітів. Якщо API його не віддає — рахуємо за хешем токена.
  const userId = tenant.extractUserId(body) ?? `token:${tokenHash.slice(0, 32)}`;
  const firstName = safeFirstName(tenant.extractFirstName(body));
  const user: VerifiedUser = { userId: `${tenant.id}:${userId}`, ...(firstName ? { firstName } : {}) };

  if (verified.size >= MAX_CACHED_TOKENS) verified.clear();
  verified.set(tokenHash, { user, expiresAt: Date.now() + VERIFY_TTL_MS });
  return user;
}

/**
 * Не `new URL(path, base)`: для шляху з `/` на початку він відкидає шлях
 * бази, і `https://x.biz/api` + `/profile` дало б `https://x.biz/profile`.
 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Ім'я йде в промпт, тож пропускаємо лише те, що схоже на ім'я: літери,
 * пробіл, дефіс, апостроф, до двох слів і 30 символів. Інакше поле профілю стало б
 * лазівкою, щоб підкинути моделі інструкції.
 */
export function safeFirstName(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}' ’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Ім'я рідко довше за два слова («Анна Марія»); більше — радше спроба
  // вписати речення, тож лишаємо тільки перше слово.
  const words = cleaned.split(" ");
  const name = words.length > 2 ? words[0] : cleaned;
  if (!name || name.length > 30) return null;
  return name;
}
