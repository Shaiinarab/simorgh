interface SimorghSecrets {
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
  SIMORGH_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  CORS_ORIGINS?: string;
}

interface Env extends SimorghSecrets {}

declare namespace Cloudflare {
  interface Env extends SimorghSecrets {}
}
