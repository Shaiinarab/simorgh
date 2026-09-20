import { executeAgent } from "./agent-service";
import { constantTimeEqual } from "./security";

const TELEGRAM_MAX_TEXT = 4096;
const TELEGRAM_BODY_LIMIT = 64_000;

export interface TelegramMessage {
  chat: { id: number };
  from?: { id: number };
  text?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

export function splitTelegramMessage(
  text: string,
  maxChars = TELEGRAM_MAX_TEXT
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function parseTelegramUpdate(raw: string): TelegramUpdate | null {
  if (raw.length > TELEGRAM_BODY_LIMIT) return null;
  try {
    const parsed = JSON.parse(raw) as TelegramUpdate;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.message?.chat?.id !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function telegramApi(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await fetch(
    "https://api.telegram.org/bot" + token + "/" + method,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    throw new Error("telegram_" + method + "_http_" + response.status);
  }
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  for (const chunk of splitTelegramMessage(text || "No answer returned.")) {
    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

async function getFlockStatus(env: Env): Promise<string> {
  const id = env.FLOCK_COORDINATOR.idFromName("global");
  const stub = env.FLOCK_COORDINATOR.get(id);
  const status = await stub.getFlockStatus();
  return status.birds
    .map(
      (bird) =>
        bird.name + " · " + bird.status + " · " + bird.provider
    )
    .join("\n");
}

function commandParts(text: string): {
  command?: string;
  argument: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { argument: trimmed };
  const firstSpace = trimmed.indexOf(" ");
  const command = (
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  ).toLowerCase();
  return {
    command,
    argument:
      firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim(),
  };
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const configuredSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const suppliedSecret =
    request.headers.get("X-Telegram-Bot-Api-Secret-Token")?.trim();

  if (!configuredSecret) {
    return Response.json(
      { ok: false, error: "telegram_not_configured" },
      { status: 503 }
    );
  }

  if (
    !suppliedSecret ||
    !(await constantTimeEqual(suppliedSecret, configuredSecret))
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const raw = await request.text();
  const update = parseTelegramUpdate(raw);
  if (!update?.message) {
    return Response.json({ ok: true, ignored: true });
  }

  if (typeof update.update_id === "number") {
    const dedupeKey = "telegram_update_" + update.update_id;
    if (await env.CONTEXT_STORE.get(dedupeKey)) {
      return Response.json({ ok: true, duplicate: true });
    }
    await env.CONTEXT_STORE.put(dedupeKey, "1", { expirationTtl: 86_400 });
  }

  const text = update.message.text?.trim();
  if (!text) return Response.json({ ok: true, ignored: true });

  const chatId = update.message.chat.id;
  const userId =
    "telegram:" + String(update.message.from?.id ?? chatId);

  const flockId = env.FLOCK_COORDINATOR.idFromName("global");
  const limiter = env.FLOCK_COORDINATOR.get(flockId);
  const decision = await limiter.checkRateLimit(userId, 20, 60_000);

  if (!decision.allowed) {
    if (env.TELEGRAM_BOT_TOKEN) {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Rate limit reached. Try again in about " +
          Math.ceil((decision.resetAt - Date.now()) / 1000) +
          " seconds."
      );
    }
    return Response.json({ ok: true, rate_limited: true });
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return Response.json(
      { ok: false, error: "telegram_not_configured" },
      { status: 503 }
    );
  }

  const { command, argument } = commandParts(text);

  try {
    if (command === "/start" || command === "/help") {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "🦅 Simorgh\n\nSend a normal message to ask the flock.\n/search <query> uses web search.\n/time returns server time.\n/status shows flock health."
      );
      return Response.json({ ok: true });
    }

    if (command === "/status") {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        await getFlockStatus(env)
      );
      return Response.json({ ok: true });
    }

    if (command === "/time") {
      const result = await executeAgent(env, {
        prompt: "What is the current server time?",
        tools: ["get_server_time"],
        userId,
        tier: "Free-Volunteer",
        requestId: "telegram:" + String(update.update_id ?? crypto.randomUUID()),
      });
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, result.agentResponse);
      return Response.json({ ok: true });
    }

    if (command === "/search") {
      if (!argument) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Usage: /search <query>"
        );
        return Response.json({ ok: true });
      }
      const result = await executeAgent(env, {
        prompt: argument,
        tools: ["search_web"],
        userId,
        tier: "Free-Volunteer",
        requestId: "telegram:" + String(update.update_id ?? crypto.randomUUID()),
      });
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, result.agentResponse);
      return Response.json({ ok: true });
    }

    const result = await executeAgent(env, {
      prompt: text,
      tools: [],
      userId,
      tier: "Free-Volunteer",
      requestId: "telegram:" + String(update.update_id ?? crypto.randomUUID()),
    });
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, result.agentResponse);
    return Response.json({ ok: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_webhook_error",
        error: String(error),
        updateId: update.update_id,
      })
    );
    try {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "The flock hit an internal error. Please try again."
      );
    } catch {
      // Keep Telegram retries from becoming an error storm.
    }
    return Response.json({ ok: true });
  }
}
