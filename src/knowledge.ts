import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./auth";

/**
 * База знань апки — markdown-файли в `functions/knowledge/<tenant>/`.
 * Поки база невелика (десятки сторінок), вона цілком іде в системний промпт
 * і кешується на боці Claude, тож векторна БД не потрібна. Коли перестане
 * влазити — перейдемо на пошук (RAG), інтерфейс цього модуля не зміниться.
 *
 * Файли читаються в алфавітному порядку: промпт має бути байт-у-байт
 * однаковим між запитами, інакше не працює кеш промпту.
 */
export interface Knowledge {
  text: string;
  version: string;
}

export function loadKnowledge(tenantId: string): Knowledge {
  const dir = path.join(__dirname, "..", "knowledge", tenantId);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .sort();

  const text = files
    .map((name) => stripTodos(readFileSync(path.join(dir, name), "utf8")))
    .join("\n\n---\n\n");

  return { text, version: sha256(text).slice(0, 12) };
}

/** Рядки `TODO(...)` — нотатки для команди, модель їх не бачить. */
function stripTodos(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*TODO\b/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
