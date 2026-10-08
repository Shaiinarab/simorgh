interface SimorghSecrets {
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SIMORGH_API_KEY?: string;
  /**
   * `{"<token>": "<userId>"}`. Present ⇒ callers are distinguishable, and the per-user
   * routes (`/api/v1/user/:userId/logs`, `/api/v1/context/:refId`) enforce that a caller
   * only ever reads their own data. A deployment reachable from the internet with only
   * `SIMORGH_API_KEY` refuses those routes rather than serving an unverified user.
   */
  SIMORGH_API_KEYS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  CORS_ORIGINS?: string;
}

interface Env extends SimorghSecrets {}

declare namespace Cloudflare {
  interface Env extends SimorghSecrets {}
}
