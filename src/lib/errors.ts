// Turns any error into a short, friendly sentence for the web page.
// Raw error objects (and anything that could contain a secret) never leave the server.
import { MissingEnvError } from "./env";
import { ApiError } from "./http";
import { StorageNotConfiguredError } from "./store";

export function friendlyError(err: unknown): string {
  if (err instanceof StorageNotConfiguredError)
    return "The app's storage isn't connected yet, so it can't cache results or run safely. (Owner: connect Upstash Redis in Vercel.)";
  if (err instanceof MissingEnvError) return `A server setting is missing (${err.envName}). (Owner: add it in Vercel's environment variables.)`;
  if (err instanceof ApiError) return `${err.source} didn't respond as expected: ${err.message.replace(`${err.source}: `, "")}`;
  if (err instanceof Error && /storage error/i.test(err.message)) return "The app's storage didn't respond. Please try again in a minute.";
  if (err instanceof Error && err.message.startsWith("Another run is in progress")) return err.message;
  return "Something unexpected went wrong. Please try again in a minute.";
}
