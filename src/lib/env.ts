// Server-only access to secrets. Whitespace is stripped because a stray space
// from copy-paste once broke the Gemini key during setup.

export type EnvName =
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_CHAT_ID"
  | "TMDB_TOKEN"
  | "RAPIDAPI_KEY"
  | "GEMINI_API_KEY"
  | "CRON_SECRET"
  | "DEMO_PASSWORD";

export class MissingEnvError extends Error {
  envName: EnvName;
  constructor(envName: EnvName) {
    super(`${envName} is not set on the server`);
    this.envName = envName;
  }
}

export function env(name: EnvName): string {
  const value = (process.env[name] ?? "").replace(/\s+/g, "");
  if (!value) throw new MissingEnvError(name);
  return value;
}

export function hasEnv(name: EnvName): boolean {
  return (process.env[name] ?? "").trim() !== "";
}
