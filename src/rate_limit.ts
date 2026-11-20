import { HttpError } from "./types";

/**
 * Ліміт у пам'яті інстансу (ковзне вікно). Це перший бар'єр від зациклення
 * клієнта чи скрипта з чужим токеном. Він неточний, якщо функція
 * масштабується на кілька інстансів; глобальний денний ліміт — наступний крок
 * (Firestore-лічильник), див. docs/ai-assistant/README.md.
 */
const hits = new Map<string, number[]>();
const MAX_TRACKED_USERS = 20000;

export function checkRateLimit(userId: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);

  if (recent.length >= limit) {
    hits.set(userId, recent);
    throw new HttpError(429, "rate_limited", "Too many messages. Try again a bit later.");
  }

  recent.push(now);
  if (hits.size >= MAX_TRACKED_USERS && !hits.has(userId)) hits.clear();
  hits.set(userId, recent);
}
