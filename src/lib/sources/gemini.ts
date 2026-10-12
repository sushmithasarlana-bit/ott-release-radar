// Gemini Flash: one batched "watch or skip" call per run, through OpenRouter
// (openrouter.ai), which forwards the request to Google's Gemini models.
import { GENRE_NOTES, PREFS } from "../config";
import type { Enriched } from "../enrich";
import { env } from "../env";
import { ApiError, getJson } from "../http";

// OpenRouter model IDs, both verified live on 2026-10-12 (structured JSON output
// and reasoning effort supported, served by Google). The backup is only used if
// the main model fails.
export const GEMINI_MODELS = ["google/gemini-3.7-flash", "google/gemini-3.5-flash"] as const;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Per model. 80 titles took ~50 s on 2026-10-12. Worst case (main times out,
// backup runs) is 110 + 90 = 200 s, inside Vercel Hobby's 300 s limit.
const TIMEOUT_MS = [110_000, 90_000];
// Safety limit for one call (96 titles matched once horror + comedy were added).
export const MAX_TITLES_PER_CALL = 120;

export const NO_SYNOPSIS = "Synopsis unavailable";

export interface Verdict {
  verdict: "WATCH" | "SKIP" | null; // null = AI verdict unavailable
  score: number | null; // 1-10
  reason: string | null;
  synopsis: string;
}

export interface GeminiRun {
  verdicts: Map<string, Verdict>; // by candidate id
  model: string | null; // model that answered (as reported by the API)
  ms: number;
  error: string | null; // why verdicts are unavailable, if they are
  usedBackup: boolean;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          verdict: { type: "string", enum: ["WATCH", "SKIP"] },
          score: { type: "integer", minimum: 1, maximum: 10 },
          reason: { type: "string" },
          synopsis: { type: "string" },
        },
        required: ["id", "verdict", "score", "reason", "synopsis"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function buildPrompt(titles: Enriched[]): string {
  const rows = titles.map((t, i) => ({
    id: i + 1,
    title: t.title,
    type: t.kind === "movie" ? "Movie" : t.kind === "newSeason" ? "New season of a series" : "Series",
    language: t.details.originalLanguage,
    genres: t.details.genres,
    year: t.saDetails.year,
    ...(t.kind === "movie" ? { runtimeMinutes: t.details.runtime } : { seasonsAdded: t.seasonsAdded, episodes: t.details.episodes }),
    synopsis: t.details.overview ?? "",
  }));

  return `You pick streaming titles for ${PREFS.viewerName}.
${PREFS.viewerName}'s taste: genres ${PREFS.genres.join(", ")}; languages ${PREFS.languages.join(", ")}.
${GENRE_NOTES ? `Genre notes: ${GENRE_NOTES}.` : ""}

For EVERY title below return one item with:
- id: the title's id.
- verdict: "WATCH" if it fits ${PREFS.viewerName}'s taste well, otherwise "SKIP".
- score: integer 1-10 for how well it fits that taste (WATCH means 6-10, SKIP means 1-5). Be selective: a matching genre tag alone is not enough. Judge the premise and tone in the synopsis (e.g. is it really suspenseful, really sci-fi, aimed at adults?). For dramas, judge whether it feels like an indie drama.
- reason: one line, at most 18 words, naming something specific from this title's premise. Explain the fit with the listed genres; do not mention the language, and do not claim any other likes or dislikes for ${PREFS.viewerName}.
- synopsis: at most 2 short sentences (40 words max) that restate ONLY facts from the given synopsis. Do not add names, plot points, awards or opinions that are not in it. If the given synopsis is empty, return exactly "${NO_SYNOPSIS}".

Base your judgement only on the details provided: no awards, reviews, cast or facts from outside knowledge.

Titles (JSON):
${JSON.stringify(rows)}`;
}

interface OpenRouterResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  error?: { message?: string; code?: number };
}

async function callModel(model: string, prompt: string, timeoutMs: number): Promise<{ text: string; modelVersion: string }> {
  const { data } = await getJson<OpenRouterResponse>(
    "Gemini",
    OPENROUTER_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
        "X-Title": "OTT Release Radar",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 16384,
        reasoning: { effort: "low" },
        response_format: { type: "json_schema", json_schema: { name: "verdicts", strict: true, schema: RESPONSE_SCHEMA } },
      }),
    },
    timeoutMs,
  );
  // OpenRouter can report a provider error inside a 200 response.
  if (data.error) throw new ApiError("Gemini", data.error.code ?? 200, `OpenRouter: ${data.error.message ?? "unknown error"}`);
  const choice = data.choices?.[0];
  if (choice?.finish_reason && choice.finish_reason !== "stop")
    throw new ApiError("Gemini", 200, `answer incomplete (finish_reason ${choice.finish_reason})`);
  return { text: choice?.message?.content ?? "", modelVersion: data.model ?? model };
}

/** Parses and checks Gemini's JSON. Invalid items are skipped (they get "unavailable"). */
function parseVerdicts(text: string, titles: Enriched[]): Map<string, Verdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("Gemini", 200, "reply was not valid JSON");
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new ApiError("Gemini", 200, "reply had no items list");

  const out = new Map<string, Verdict>();
  for (const raw of items as Record<string, unknown>[]) {
    const title = typeof raw.id === "number" ? titles[raw.id - 1] : undefined;
    const ok =
      title &&
      (raw.verdict === "WATCH" || raw.verdict === "SKIP") &&
      Number.isInteger(raw.score) &&
      (raw.score as number) >= 1 &&
      (raw.score as number) <= 10 &&
      (raw.verdict === "WATCH") === (raw.score as number) >= 6 &&
      typeof raw.reason === "string" &&
      raw.reason.trim() !== "" &&
      typeof raw.synopsis === "string";
    if (!ok || out.has(title.id)) continue;
    out.set(title.id, {
      verdict: raw.verdict as "WATCH" | "SKIP",
      score: raw.score as number,
      reason: clip(raw.reason as string, 160),
      // Never trust the model to say "no synopsis": decide that from our data.
      synopsis: title.details.overview ? clip((raw.synopsis as string) || NO_SYNOPSIS, 320) : NO_SYNOPSIS,
    });
  }
  if (out.size === 0) throw new ApiError("Gemini", 200, "reply had no usable verdicts");
  return out;
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function unavailableVerdict(t: Enriched): Verdict {
  return { verdict: null, score: null, reason: null, synopsis: t.details.overview ? clip(t.details.overview, 320) : NO_SYNOPSIS };
}

/** One batched call (backup model on failure). Never throws: failures become "unavailable". */
export async function getVerdicts(titles: Enriched[], models: readonly string[] = GEMINI_MODELS): Promise<GeminiRun> {
  const started = Date.now();
  const run: GeminiRun = { verdicts: new Map(), model: null, ms: 0, error: null, usedBackup: false };
  const batch = titles.slice(0, MAX_TITLES_PER_CALL);
  if (!batch.length) return run;

  const prompt = buildPrompt(batch);
  const errors: string[] = [];
  for (const [i, model] of models.entries()) {
    try {
      const { text, modelVersion } = await callModel(model, prompt, TIMEOUT_MS[i] ?? TIMEOUT_MS.at(-1)!);
      run.verdicts = parseVerdicts(text, batch);
      run.model = modelVersion;
      run.usedBackup = i > 0;
      break;
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message.replace(/^Gemini: /, "") : "unexpected error"}`);
    }
  }
  if (!run.model) run.error = `Gemini failed (${errors.join("; ")})`;

  for (const t of titles) if (!run.verdicts.has(t.id)) run.verdicts.set(t.id, unavailableVerdict(t));
  run.ms = Date.now() - started;
  return run;
}
