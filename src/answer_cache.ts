import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { sha256 } from "./auth";
import { adminApp } from "./firebase_admin";
import { AssistantMode } from "./types";

/**
 * Кеш готових відповідей, спільний для всіх юзерів апки.
 *
 * Рівень 1 (зараз): точний збіг нормалізованого питання.
 * Рівень 2 (далі): семантичний пошук за embeddings, див. README.
 *
 * Кешуються ЛИШЕ загальні відповіді: перше питання розмови, на яке модель
 * відповіла без жодного tool. Усе, що спиралось на дані юзера (курси,
 * підписка, баланс), проходить через tools і тому сюди не потрапляє.
 *
 * Ключ включає апку, режим, мову і версію бази знань: оновили базу —
 * старі відповіді більше не знаходяться.
 */
const COLLECTION = "assistant_answer_cache";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheScope {
  tenantId: string;
  mode: AssistantMode;
  locale: string;
  knowledgeVersion: string;
}

export function isAnswerCacheEnabled(): boolean {
  return process.env.ASSISTANT_ANSWER_CACHE === "on";
}

function db() {
  return getFirestore(adminApp());
}

/** Нормалізація для точного збігу: регістр, пробіли, апострофи, кінцева пунктуація. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'«»„“”.,!?…]+|[\s"'«»„“”.,!?…]+$/g, "")
    .trim();
}

function cacheKey(scope: CacheScope, question: string): string {
  return sha256(
    [scope.tenantId, scope.mode, scope.locale, scope.knowledgeVersion, normalizeQuestion(question)].join("\u0000"),
  );
}

/** Помилка кешу ніколи не ламає відповідь: просто йдемо до моделі. */
export async function readCachedAnswer(scope: CacheScope, question: string): Promise<string | null> {
  if (!isAnswerCacheEnabled()) return null;
  try {
    const ref = db().collection(COLLECTION).doc(cacheKey(scope, question));
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() as { answer?: unknown; expiresAt?: Timestamp };
    if (typeof data.answer !== "string") return null;
    if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return null;

    // Лічильник влучань — щоб бачити, які питання повторюються найчастіше.
    void ref.update({ hits: FieldValue.increment(1), lastHitAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    return data.answer;
  } catch (error) {
    logger.warn("answer_cache.read_failed", { error: String(error) });
    return null;
  }
}

export async function writeCachedAnswer(scope: CacheScope, question: string, answer: string): Promise<void> {
  if (!isAnswerCacheEnabled()) return;
  try {
    await db()
      .collection(COLLECTION)
      .doc(cacheKey(scope, question))
      .set({
        ...scope,
        question: normalizeQuestion(question),
        answer,
        hits: 0,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
      });
  } catch (error) {
    logger.warn("answer_cache.write_failed", { error: String(error) });
  }
}
