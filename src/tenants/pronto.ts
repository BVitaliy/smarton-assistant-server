import { sha256 } from "../auth";
import { loadKnowledge } from "../knowledge";
import { AssistantMode, TenantConfig } from "../types";
import {
  CLARIFYING_RULES,
  FACTS_RULES,
  formattingRules,
  identityRules,
  languageRule,
  pickId,
  showActionButton,
  showCards,
  showOptions,
  tool,
} from "./common";

/**
 * PRONTO PIZZA&SUSHI — доставка піци й суші (Ionic/Angular апка,
 * бекенд WordPress + WooCommerce). Режими: гість і залогінений (`member`).
 *
 * Змінюйте при кожній правці текстів промпту: номер входить у версію кешу.
 */
const PROMPT_REVISION = "2026-11-22.1";

const knowledge = loadKnowledge("pronto");

// --- Tools: виконує апка (через свої сервіси), сервер лише описує -------------

const searchMenu = tool(
  "search_menu",
  "Searches the menu available for the user's current city, address and delivery method (delivery or takeaway). Returns matching products with id, name, category, short ingredients, sizes (variation id, size title, price in UAH, weight, kcal) and whether the product can be added from the chat. Use it before recommending or talking about specific dishes; call it again with other filters if needed.",
  {
    query: {
      type: "string",
      description: 'Free text: a dish, an ingredient or a taste, e.g. "salmon", "spicy", "cheese", "vegetarian". Omit to browse a category.',
    },
    category: {
      type: "string",
      description: 'Menu category in the user\'s words or as in the menu, e.g. "pizza", "sushi", "sets", "WOK", "soups", "drinks", "sauces".',
    },
    max_price: { type: "number", description: "Maximum price in UAH." },
    max_kcal: { type: "number", description: "Maximum calories (kcal) of the product." },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "How many products to return, default 8." },
  },
);

const getProduct = tool(
  "get_product",
  "Returns full details of one product: description, ingredients, every size with price, weight and nutrition (kcal, proteins, fat, carbohydrates), extra options (crust, toppings) and whether it can be added from the chat or needs the product screen. Use for questions about ingredients, calories, sizes or options.",
  { id: { type: "string", description: "Product id from search_menu or the cart." } },
  ["id"],
);

const getCart = tool(
  "get_cart",
  "Returns what is in the user's cart now: items (product id, name, size, quantity, price), the item count and the total in UAH. Use for questions about the cart or the total, and before suggesting additions.",
);

const addToCart = tool(
  "add_to_cart",
  'Adds a product to the user\'s cart. Call it ONLY when the user clearly asked to add this product or agreed to your suggestion ("yes, add it"); never on your own initiative. Use the size (variation_id) the user chose; if the product has several sizes and the user did not choose, ask with show_options first. If the result says the product needs options, offer the product screen with show_action_button open_product instead. After adding, confirm in one short sentence.',
  {
    product_id: { type: "string", description: "Product id from search_menu or get_product." },
    variation_id: {
      type: "string",
      description: "Size id from search_menu or get_product. Omit for products without sizes.",
    },
    quantity: { type: "integer", minimum: 1, maximum: 10, description: "How many, default 1." },
  },
  ["product_id"],
);

const getPromotions = tool(
  "get_promotions",
  "Returns current promotions and special offers with their conditions (for example: every 3rd pizza free, 3+1 on sushi, a takeaway discount). Use for any question about discounts, promotions, coupons or gifts.",
);

const getDeliveryInfo = tool(
  "get_delivery_info",
  "Returns delivery and takeaway information for the user's current city: delivery methods, takeaway addresses, working hours, delivery zones with the minimum order and delivery price, and the user's selected city, address and delivery method if any. Use for questions about delivery, hours, the minimum order, takeaway or whether an address is served.",
);

const getContacts = tool(
  "get_contacts",
  "Returns phone numbers, emails, addresses, working hours and social links. Use when the user wants to contact the restaurant or support.",
);

const getMyOrders = tool(
  "get_my_orders",
  "Returns the signed-in user's recent orders: number, date, status, items and total, including active orders in progress. Use for questions about an order's status or to repeat a previous order.",
);

const cards = showCards(["product", "promotion"], "photos, names, prices, weight, calories, and an add-to-cart or open button");

const GUEST_ACTIONS = [
  "open_menu",
  "open_category",
  "open_product",
  "open_cart",
  "open_checkout",
  "open_promotions",
  "open_contacts",
  "open_login",
  "open_registration",
] as const;
const MEMBER_ACTIONS = [...GUEST_ACTIONS.filter((a) => a !== "open_login" && a !== "open_registration"), "open_orders"] as const;

const COMMON_TOOLS = [searchMenu, getProduct, getCart, addToCart, getPromotions, getDeliveryInfo, getContacts];

const TOOLS: Partial<Record<AssistantMode, ReturnType<typeof tool>[]>> = {
  guest: [...COMMON_TOOLS, cards, showOptions, showActionButton(GUEST_ACTIONS)],
  member: [...COMMON_TOOLS, getMyOrders, cards, showOptions, showActionButton(MEMBER_ACTIONS)],
};

// --- Prompt --------------------------------------------------------------------

function prompt(mode: AssistantMode, locale: string): string {
  const member = mode === "member";
  return `You are the in-app assistant of PRONTO PIZZA&SUSHI, a pizza and sushi delivery service with restaurants in several Ukrainian cities. You help people choose food, answer questions about dishes, ingredients and calories, promotions, delivery and orders, and add dishes to their cart.

${member ? "The user is signed in." : "The user has not signed in. They can still browse the menu and add dishes to the cart; for order history and personal offers they need to sign in (open_login)."}

How to work:
- Menu and availability: the menu depends on the city, address and delivery method. Recommend and name only products returned by search_menu in this conversation; those are available to this user now. Show recommendations with show_cards kind "product" (1-6, best first) instead of listing them in text.
- Choosing food: if the request is broad ("what should we order?", "something for a party", "for 4 people"), first ask one or two short questions with show_options, for example how many people, pizza, sushi or a mix, the budget, preferences (spicy, no meat, no fish, for kids). Then search and suggest a concrete combination with an approximate total.
- Adding to the cart: follow the add_to_cart rules strictly: only after the user asks or agrees, and with a chosen size. For pizza halves, the pizza constructor or products that need options, open the product screen instead (show_action_button open_product with target_id).
- Nutrition and ingredients: take kcal, proteins, fat, carbohydrates, weight and ingredients only from get_product or search_menu, for a specific size, and say which size the numbers are for. No medical or diet advice beyond these facts.
- Allergies: you only know the ingredient list. Never promise that a dish is safe for an allergy; suggest checking the ingredients and contacting the restaurant (get_contacts).
- Prices are in UAH from tool results. Promotions and the final total are applied at checkout, so call your total approximate.
- Promotions, delivery, working hours, contacts: call the matching tool and answer from its result.
${member ? "- Orders: for an order's status or to repeat an order, call get_my_orders.\n" : ""}- Placing an order and payment happen only on the checkout screen: when the user is ready, add show_action_button open_checkout (or open_cart to review). You can't place, pay for or cancel orders yourself.
- Suggest at most one addition (a drink, a sauce, a dessert) per conversation, and only when it fits.
- Never ask for phone numbers, addresses or payment details in the chat; the checkout screen collects them.
- Keep replies to about 1-4 sentences plus cards.

${CLARIFYING_RULES}

${FACTS_RULES}

${formattingRules("prontopizza.ua")}

${identityRules("PRONTO")}

${languageRule(locale)}

<knowledge_base>
${knowledge.text}
</knowledge_base>`;
}

// --- Tenant --------------------------------------------------------------------

/** `wp/v2/users/me`: `{ id, name, first_name? }`. */
function pickFirstName(body: unknown): string | null {
  const record = body as Record<string, any> | null;
  const first = record?.first_name;
  if (typeof first === "string" && first.trim()) return first;
  const name = record?.name;
  return typeof name === "string" ? name.trim().split(/\s+/)[0] ?? null : null;
}

export const prontoTenant: TenantConfig = {
  id: "pronto",
  apiBaseUrl: "https://prontopizza.ua",
  // WordPress + JWT Auth: «хто я» з токеном юзера. 200 — токен дійсний.
  // WordPress Multisite: кожне місто — свій сайт (prontopizza.ua/lutsk/…), і
  // токен дійсний на сайті, що його видав. Список — з generalInfo.
  sites: ["", "kolomyja", "chernivtsi", "khmelnytskyi", "uzhhorod", "ternopil", "lutsk", "kamyanets", "vinnytsia"],
  verifyPath: "wp-json/wp/v2/users/me",
  extractUserId: pickId,
  extractFirstName: pickFirstName,
  modes: ["guest", "member"],
  supportedLocales: ["uk", "ru", "en"],
  defaultLocale: "uk",
  limits: {
    maxUserTextChars: 1500,
    maxMessages: 80,
    maxBodyBytes: 400_000,
    maxToolResultChars: 24_000,
    rateLimitPerWindow: 60,
    rateWindowMs: 10 * 60 * 1000,
  },
  // Гість — звичайний покупець (замовляти можна й без акаунта), тож ліміти
  // м'якші, ніж у дитячої апки. TODO(перед продом): App Check для гостей.
  guest: {
    enabled: true,
    requireAppCheck: false,
    maxQuestions: 30,
    dailyRequestsPerInstall: 150,
    requestsPerIpPer10Min: 120,
  },
  systemPrompt: (mode, locale) => prompt(mode, locale),
  effort: () => "medium",
  tools: (mode) => TOOLS[mode]!,
  knowledgeVersion: sha256(`${PROMPT_REVISION}:${knowledge.version}`).slice(0, 12),
};
