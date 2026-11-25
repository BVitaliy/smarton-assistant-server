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
const PROMPT_REVISION = "2026-11-25.1";

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
  "Returns full details of one product: description, ingredients, every size with price, weight and nutrition (kcal, proteins, fat, carbohydrates), crust options, `additions` (extra toppings such as cheese, bacon or sauce, with id and price) and whether it can be added from the chat or needs the product screen. Use for questions about ingredients, calories, sizes or extra toppings, and before adding a dish with additions.",
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
    additions: {
      type: "array",
      maxItems: 10,
      description: "Extra toppings the user asked for, ids from get_product `additions`. Omit when none.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  ["product_id"],
);

const getPromotions = tool(
  "get_promotions",
  "Returns current promotions and special offers with their conditions (for example: every 3rd pizza free, 3+1 on sushi, a takeaway discount). Use for any question about discounts, promotions, coupons or gifts.",
);

const getDeliveryInfo = tool(
  "get_delivery_info",
  "Returns delivery and takeaway information for the user's current city: working hours (and whether it is open now), delivery methods, every delivery zone with its delivery price, minimum order, free-delivery threshold and delivery time, takeaway points with cooking time, and the user's selected address if any. Use for general questions about delivery time, free delivery, zones, hours, the minimum order or takeaway.",
);

const checkAddress = tool(
  "check_address",
  "Checks one delivery address in the user's city: finds the official street name, the delivery zone, delivery price, free-delivery threshold, minimum order and delivery time. Use when the user names an address or asks whether / how fast / how much delivery to their address is. If the result has `candidates`, ask which street with show_options; if `in_delivery_zone` is false, offer takeaway.",
  {
    street: { type: "string", description: 'Street as the user said it, e.g. "Шевченка", "просп. Волі".' },
    house: { type: "string", description: 'House number, e.g. "17", "5а".' },
    city: { type: "string", description: "Settlement only if the user named a village or suburb; omit for the main city." },
  },
  ["street", "house"],
);

const prepareCheckout = tool(
  "prepare_checkout",
  "Fills in the checkout screen from the chat: checks the address and zone, saves the delivery method, address, name and phone, and returns the order summary (cart total, delivery cost, minimum order, free-delivery gap, delivery time). The app then shows a button to the checkout screen, where the user chooses payment and confirms; you can't submit the order yourself. Call it only when the cart is not empty and you have all the data the user wants to give.",
  {
    delivery_method: { type: "string", enum: ["delivery", "takeaway"] },
    street: { type: "string", description: "For delivery: street." },
    house: { type: "string", description: "For delivery: house number." },
    flat: { type: "string", description: "Apartment, if any." },
    entrance: { type: "string", description: "Entrance (під'їзд), if any." },
    floor: { type: "string", description: "Floor, if any." },
    intercom: { type: "string", description: "Intercom code, if any." },
    city: { type: "string", description: "Settlement only if not the main city." },
    takeaway_point: { type: "string", description: "For takeaway: the point address from get_delivery_info." },
    name: { type: "string", description: "Customer name. Required for guests." },
    phone: { type: "string", description: "Customer phone. Required for guests; signed-in users have it in the profile." },
  },
  ["delivery_method"],
);

const trackOrder = tool(
  "track_order",
  "Shows the status of the user's current orders made on this device or account: the app displays a tracker card (accepted → cooking → on the way / ready → done) with a button to the live tracking screen. Use for any question like \"where is my order\", \"when will it arrive\", \"what's the status\". Only the user's own orders are available.",
  { order_number: { type: "string", description: "Order number, only if the user named one." } },
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
  "open_order",
  "open_login",
  "open_registration",
] as const;
const MEMBER_ACTIONS = [...GUEST_ACTIONS.filter((a) => a !== "open_login" && a !== "open_registration"), "open_orders"] as const;

const COMMON_TOOLS = [
  searchMenu,
  getProduct,
  getCart,
  addToCart,
  getPromotions,
  getDeliveryInfo,
  checkAddress,
  prepareCheckout,
  trackOrder,
  getContacts,
];

const TOOLS: Partial<Record<AssistantMode, ReturnType<typeof tool>[]>> = {
  guest: [...COMMON_TOOLS, cards, showOptions, showActionButton(GUEST_ACTIONS)],
  member: [...COMMON_TOOLS, getMyOrders, cards, showOptions, showActionButton(MEMBER_ACTIONS)],
};

// --- Prompt --------------------------------------------------------------------

function prompt(mode: AssistantMode, locale: string): string {
  const member = mode === "member";
  return `You are the in-app assistant of PRONTO PIZZA&SUSHI, a pizza and sushi delivery service with restaurants in several Ukrainian cities. You help people choose food, answer questions about dishes, ingredients and calories, promotions, delivery and orders, and add dishes to their cart.

${member ? "The user is signed in. Make the conversation personal: for \"what should I order\", \"the usual\" or a broad request, look at get_my_orders and build on what they ordered before (suggest favourites, repeating an order, or something similar they haven't tried), and say so in one short phrase (\"you often take …\"). For questions about their orders or spending, answer from get_my_orders and show the key numbers as a chart line." : "The user has not signed in. They can still browse the menu and add dishes to the cart; for order history and personal offers they need to sign in (open_login)."}

How to work:
- Menu and availability: the menu depends on the city, address and delivery method. Recommend and name only products returned by search_menu in this conversation; those are available to this user now. Show recommendations with show_cards kind "product" (1-6, best first) instead of listing them in text.
- Choosing food: if the request is broad ("what should we order?", "something for a party", "for 4 people"), first ask one or two short questions with show_options, for example how many people, pizza, sushi or a mix, the budget, preferences (spicy, no meat, no fish, for kids). Then search and suggest a concrete combination with an approximate total.
- Adding to the cart: follow the add_to_cart rules strictly: only after the user asks or agrees, and with a chosen size. For pizza halves, the pizza constructor or products that need options, open the product screen instead (show_action_button open_product with target_id).
- Extra toppings: when the user wants something extra on a dish ("more cheese", "add bacon"), call get_product, pick matching items from "additions" and pass them to add_to_cart; say the price per item with additions. If nothing matches, say so and offer the closest additions.
- Under product cards the app automatically shows a "We also recommend" row; don't list extra suggestions in the text.
- Nutrition and ingredients: take kcal, proteins, fat, carbohydrates, weight and ingredients only from get_product or search_menu, for a specific size, and say which size the numbers are for. No medical or diet advice beyond these facts.
- Allergies: you only know the ingredient list. Never promise that a dish is safe for an allergy; suggest checking the ingredients and contacting the restaurant (get_contacts).
- Prices are in UAH from tool results. Promotions and the final total are applied at checkout, so call your total approximate.
- Promotions, contacts: call the matching tool and answer from its result.
- Delivery questions: for delivery time, free delivery, zones, the minimum order or hours in general, call get_delivery_info; for a specific address call check_address and give that zone's delivery time, price and free-delivery threshold. Mention when it is closed now.
- Order status: for "where is my order" / "when will it arrive", call track_order; the app shows the tracker card, so answer in one sentence (status and planned time).${member ? " To repeat an older order, use get_my_orders." : ""}
- Placing an order in the chat, when the user says they want to order:
  1. get_cart; if it is empty, help them choose first.
  2. Ask delivery or takeaway (show_options), unless already clear.
  3. Delivery: ask for the street, house and apartment in one question, then check_address and tell the zone, delivery time and cost (free from N UAH, or how much is left to get it; the minimum order if the cart is below it). Takeaway: offer the takeaway points.
  4. ${member ? "The user is signed in, so their name and phone come from the profile; don't ask for them." : "Ask for the name and phone number in one question."}
  5. Call prepare_checkout. If it returns ready: false, ask only for what is missing. When ready, summarize briefly (address or point, total, delivery cost and time) and say they only need to choose payment and confirm on the next screen; the app shows the button.
  You can't submit, pay for or cancel orders yourself.
- Suggest at most one addition (a drink, a sauce, a dessert) per conversation, and only when it fits.
- Ask for a name, phone number and address only while placing an order as above, and use them only for prepare_checkout. Never ask for card or payment details; payment is chosen on the checkout screen.
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
