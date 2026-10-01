// Secrets are supplied by `wrangler secret put`, never by client code or wrangler vars.
interface Env {
  OPENAI_API_KEY?: string;
}
