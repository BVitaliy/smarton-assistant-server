// Збирає список статей з https://smarton.biz/knowledge-base у базу знань
// консультанта (knowledge/smarton/06_articles.md).
//
// Запуск: `npm run sync:articles`, потім передеплоїти функцію. Сайт віддає
// статті HTML-сторінками по 10; коли бекенд дасть JSON зі статтями, цей
// скрипт варто перевести на нього.

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://smarton.biz";
const MAX_PAGES = 20;
// Повний список — українською й англійською; для ru/tr/ar той самий slug.
const LOCALES = [
  { code: "uk", prefix: "", heading: "Українською" },
  { code: "en", prefix: "/en", heading: "English" },
];

const out = join(dirname(fileURLToPath(import.meta.url)), "../knowledge/smarton/06_articles.md");

function decode(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(locale, page) {
  // Мову сайт бере з кукі `lang`: `/en/knowledge-base?current_page=…`
  // перенаправляє на українську сторінку й губить мову.
  const url = `${SITE}${locale.prefix}/knowledge-base?current_page=${page}&per_page=10`;
  const response = await fetch(url, {
    headers: { "User-Agent": "smarton-assistant-sync", Cookie: `lang=${locale.code}` },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const html = await response.text();
  const items = [];
  for (const match of html.matchAll(/<a class="h5 title[^"]*" href="([^"]+)">\s*([\s\S]*?)\s*<\/a>/g)) {
    const path = match[1].startsWith("http") ? new URL(match[1]).pathname : match[1];
    items.push({ path, title: decode(match[2]) });
  }
  return items;
}

async function collect(locale) {
  const seen = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage(locale, page);
    const fresh = items.filter((item) => !seen.has(item.path));
    if (fresh.length === 0) break; // сторінки скінчились (сайт повторює останню)
    for (const item of fresh) seen.set(item.path, item);
  }
  return [...seen.values()];
}

const sections = [];
let total = 0;
for (const locale of LOCALES) {
  const articles = await collect(locale);
  total += articles.length;
  sections.push(
    `${locale.heading}:\n` + articles.map((a) => `- ${a.title} — ${SITE}${a.path}`).join("\n"),
  );
}

const header = `# Статті бази знань на сайті

Корисні статті на smarton.biz про курси й розвиток дітей. Коли стаття з цього списку справді стосується питання, можна дати одне-два посилання наприкінці відповіді. Адреса — мовою відповіді: українською без префікса, англійською з /en/, для російської, турецької й арабської — той самий шлях з префіксом /ru/, /tr/ чи /ar/ (наприклад https://smarton.biz/ru/little-chef-a-fun-cooking-adventure). Інших адрес не вигадувати.

_Згенеровано scripts/sync_articles.mjs ${new Date().toISOString().slice(0, 10)}; не редагувати вручну._
`;

await writeFile(out, `${header}\n${sections.join("\n\n")}\n`);
console.log(`articles: ${total} → ${out}`);
