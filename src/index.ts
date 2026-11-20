import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { handleChat } from "./chat";

/**
 * Ключ Claude API живе лише тут, у Secret Manager — не в апці.
 * Задати: `firebase functions:secrets:set ANTHROPIC_API_KEY`
 */
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

export const assistantChat = onRequest(
  {
    region: "europe-west1",
    secrets: [anthropicApiKey],
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 80,
    maxInstances: 20,
    cors: false,
  },
  (req, res) => handleChat(req, res, anthropicApiKey.value()),
);
