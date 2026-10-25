import { GoogleGenerativeAI, SchemaType, type GenerationConfig, type ResponseSchema } from '@google/generative-ai';
import { z, ZodError } from 'zod';

const SuspectSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  profile: z.string().trim().min(1),
  relationship: z.string().trim().min(1),
  motive: z.string().trim().min(1),
  alibi: z.string().trim().min(1),
  notes: z.string().trim()
}).strict();
const TimelineSchema = z.object({ time: z.string().trim().min(1), description: z.string().trim().min(1) }).strict();
const EvidenceSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['messages', 'image', 'video', 'camera_log', 'witness_statement', 'document', 'physical_clue']),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  content: z.string().trim().min(1),
  relatedSuspectIds: z.array(z.string().trim().min(1))
}).strict();
const GeneratedSchema = z.object({
  title: z.string().trim().min(3),
  briefing: z.string().trim().min(20),
  setting: z.string().trim().min(3),
  suspects: z.array(SuspectSchema).min(3).max(5),
  timeline: z.array(TimelineSchema).min(3),
  evidence: z.array(EvidenceSchema).min(5).max(8),
  solution: z.object({
    culpritSuspectId: z.string().trim().min(1),
    explanation: z.string().trim().min(30),
    decisiveEvidenceIds: z.array(z.string().trim().min(1)).min(3),
    redHerringEvidenceIds: z.array(z.string().trim().min(1))
  }).strict()
}).strict();

export type GeneratedCase = z.infer<typeof GeneratedSchema>;
export type GenerationStage = 'configuration' | 'provider' | 'json' | 'validation';

export class MysteryGenerationError extends Error {
  readonly status: number;
  constructor(readonly code: string, readonly stage: GenerationStage, message: string, status = 502) {
    super(message);
    this.name = 'MysteryGenerationError';
    this.status = status;
  }
}

type GenerationDependencies = {
  request: (prompt: string, timeoutMs: number) => Promise<string>;
  log: (event: string, details: Record<string, unknown>) => void;
};

const MAX_ATTEMPTS = 2;
const MAX_REPAIR_CONTEXT = 18_000;
const GEMINI_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    briefing: { type: SchemaType.STRING },
    setting: { type: SchemaType.STRING },
    suspects: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: {
      id: { type: SchemaType.STRING }, name: { type: SchemaType.STRING }, profile: { type: SchemaType.STRING },
      relationship: { type: SchemaType.STRING }, motive: { type: SchemaType.STRING }, alibi: { type: SchemaType.STRING }, notes: { type: SchemaType.STRING }
    }, required: ['id', 'name', 'profile', 'relationship', 'motive', 'alibi', 'notes'] } },
    timeline: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: {
      time: { type: SchemaType.STRING }, description: { type: SchemaType.STRING }
    }, required: ['time', 'description'] } },
    evidence: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: {
      id: { type: SchemaType.STRING }, type: { type: SchemaType.STRING, enum: ['messages', 'image', 'video', 'camera_log', 'witness_statement', 'document', 'physical_clue'] },
      title: { type: SchemaType.STRING }, description: { type: SchemaType.STRING }, content: { type: SchemaType.STRING },
      relatedSuspectIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
    }, required: ['id', 'type', 'title', 'description', 'content', 'relatedSuspectIds'] } },
    solution: { type: SchemaType.OBJECT, properties: {
      culpritSuspectId: { type: SchemaType.STRING }, explanation: { type: SchemaType.STRING },
      decisiveEvidenceIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      redHerringEvidenceIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
    }, required: ['culpritSuspectId', 'explanation', 'decisiveEvidenceIds', 'redHerringEvidenceIds'] }
  },
  required: ['title', 'briefing', 'setting', 'suspects', 'timeline', 'evidence', 'solution']
};

const SYSTEM_SCHEMA = `Return one JSON object with exactly this structure (no extra properties):
{
  "title": "string",
  "briefing": "string (at least 20 characters)",
  "setting": "string",
  "suspects": [{ "id": "unique string", "name": "string", "profile": "string", "relationship": "string", "motive": "string", "alibi": "string", "notes": "string" }],
  "timeline": [{ "time": "string", "description": "string" }],
  "evidence": [{ "id": "unique string", "type": "messages | image | video | camera_log | witness_statement | document | physical_clue", "title": "string", "description": "string", "content": "string", "relatedSuspectIds": ["suspect id"] }],
  "solution": { "culpritSuspectId": "one suspect id", "explanation": "string (at least 30 characters)", "decisiveEvidenceIds": ["at least 3 evidence ids"], "redHerringEvidenceIds": ["evidence ids"] }
}
Rules: make 3-5 suspects and 5-8 evidence items; use unique IDs; every suspect and evidence reference must exist; choose exactly one culprit from suspects; use at least 3 distinct decisive evidence IDs; decisive and red-herring IDs must not overlap; explicitly name every decisive evidence item in the explanation; all clues and the timeline must agree. Include the notes field on every suspect. All content is fictional. Camera logs are text simulations only; do not claim an image or video was generated.`;

function safeLog(event: string, details: Record<string, unknown>): void {
  // Keep diagnostics useful while preventing accidental credential leakage from SDK errors.
  const serialized = JSON.stringify(details).replace(/AIza[\w-]{20,}/g, '[redacted-api-key]')
    .replace(/((?:[?&]|\b)key=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s@]+@/gi, '$1[credentials]@');
  console.error(`[mystery-generation] ${event} ${serialized}`);
}

function getErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ZodError) {
    return {
      name: error.name,
      issueCount: error.issues.length,
      issues: error.issues.slice(0, 20).map(issue => ({ path: issue.path.join('.') || '<root>', code: issue.code, message: issue.message }))
    };
  }
  if (error instanceof Error) {
    const providerError = error as Error & { status?: number; statusText?: string; code?: string };
    return {
      name: error.name,
      code: providerError.code,
      status: providerError.status,
      statusText: providerError.statusText,
      message: error.message.slice(0, 1000)
    };
  }
  return { message: String(error).slice(0, 500) };
}

function extractJsonObject(responseText: string): string {
  const text = responseText.replace(/^\uFEFF/, '').trim();
  if (!text) throw new SyntaxError('Gemini returned an empty response.');

  // Prefer a complete fenced block, but do not depend on Gemini honoring fences.
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? text;
  const openingBrace = candidate.indexOf('{');
  if (openingBrace < 0) throw new SyntaxError('No JSON object was found in the Gemini response.');

  // Find the first balanced object without being confused by braces in quoted strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openingBrace; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(openingBrace, index + 1);
    }
  }
  throw new SyntaxError('Gemini returned an incomplete JSON object.');
}

export function parseGeminiJson(responseText: string): unknown {
  const candidate = extractJsonObject(responseText);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parse error';
    throw new SyntaxError(`Invalid JSON: ${message}`);
  }
}

export function validateGeneratedMystery(raw: unknown): GeneratedCase {
  const parsed = GeneratedSchema.parse(raw);
  const suspectIds = new Set(parsed.suspects.map(suspect => suspect.id));
  const evidenceIds = new Set(parsed.evidence.map(item => item.id));
  const normalizedNames = parsed.suspects.map(suspect => suspect.name.toLocaleLowerCase());

  if (suspectIds.size !== parsed.suspects.length) throw new Error('Suspect IDs must be unique.');
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error('Suspect names must be unique.');
  if (evidenceIds.size !== parsed.evidence.length) throw new Error('Evidence IDs must be unique.');
  if (!suspectIds.has(parsed.solution.culpritSuspectId)) throw new Error('The culprit must match exactly one generated suspect ID.');
  if (parsed.evidence.some(item => new Set(item.relatedSuspectIds).size !== item.relatedSuspectIds.length)) {
    throw new Error('Evidence cannot repeat a related suspect ID.');
  }
  if (parsed.evidence.some(item => item.relatedSuspectIds.some(id => !suspectIds.has(id)))) {
    throw new Error('Evidence refers to an unknown suspect ID.');
  }
  if (new Set(parsed.solution.decisiveEvidenceIds).size !== parsed.solution.decisiveEvidenceIds.length) {
    throw new Error('Decisive evidence IDs must be distinct.');
  }
  if (new Set(parsed.solution.redHerringEvidenceIds).size !== parsed.solution.redHerringEvidenceIds.length) {
    throw new Error('Red-herring evidence IDs must be distinct.');
  }
  if ([...parsed.solution.decisiveEvidenceIds, ...parsed.solution.redHerringEvidenceIds].some(id => !evidenceIds.has(id))) {
    throw new Error('The solution refers to an unknown evidence ID.');
  }
  const decisiveIds = new Set(parsed.solution.decisiveEvidenceIds);
  if (parsed.solution.redHerringEvidenceIds.some(id => decisiveIds.has(id))) {
    throw new Error('An evidence item cannot be both decisive and a red herring.');
  }
  const explanation = parsed.solution.explanation.toLocaleLowerCase();
  const decisiveEvidence = parsed.evidence.filter(item => decisiveIds.has(item.id));
  const uncited = decisiveEvidence.filter(item => !explanation.includes(item.id.toLocaleLowerCase()) && !explanation.includes(item.title.toLocaleLowerCase()));
  if (uncited.length > 0) {
    throw new Error(`The solution explanation must name each decisive evidence item; missing: ${uncited.map(item => item.id).join(', ')}.`);
  }
  return parsed;
}

function makePrompt(scenario: string, difficulty: string, correction?: string): string {
  const repair = correction
    ? `\n\nYour previous response was rejected: ${correction}. Correct the response and return a complete replacement JSON object. Do not omit required fields. Previous response (truncated if needed):\n`
    : '';
  return `Create a fair, completely fictional short detective mystery based on the scenario below. Difficulty: ${difficulty}.\n\n${SYSTEM_SCHEMA}\n\nScenario:\n<scenario>${scenario}</scenario>${repair}`;
}

function createGeminiRequest(): GenerationDependencies['request'] {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new MysteryGenerationError('GENERATION_UNAVAILABLE', 'configuration', 'Mystery generation is not configured. Please check the server setup.', 503);
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
      temperature: 0.75,
      // The legacy SDK type omits Gemini 3's current wire field, but the API
      // accepts thinkingConfig.thinkingLevel and low reduces time to first token.
      thinkingConfig: { thinkingLevel: 'low' }
    } as GenerationConfig
  });
  return async (prompt, timeoutMs) => {
    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }, { timeout: timeoutMs });
    return result.response.text();
  };
}

export async function generateMystery(
  scenario: string,
  difficulty: string,
  overrides: Partial<GenerationDependencies> = {}
): Promise<GeneratedCase> {
  const log = overrides.log ?? safeLog;
  let request: GenerationDependencies['request'];
  try {
    request = overrides.request ?? createGeminiRequest();
  } catch (error) {
    log('provider_configuration_failed', getErrorDetails(error));
    if (error instanceof MysteryGenerationError) throw error;
    throw new MysteryGenerationError('GENERATION_UNAVAILABLE', 'configuration', 'Mystery generation is not configured. Please check the server setup.', 503);
  }
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
  let repairContext = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let responseText: string;
    const requestStartedAt = Date.now();
    try {
      responseText = await request(makePrompt(scenario, difficulty, repairContext || undefined), timeoutMs);
    } catch (error) {
      const details = getErrorDetails(error);
      const elapsedMs = Date.now() - requestStartedAt;
      log('provider_request_failed', { attempt, timeoutMs, elapsedMs, ...details });
      const status = typeof details.status === 'number' && details.status >= 400 && details.status < 600 ? details.status : 502;
      const providerMessage = typeof details.message === 'string' ? details.message : '';
      if (status === 404) {
        throw new MysteryGenerationError('GEMINI_MODEL_UNAVAILABLE', 'provider', 'The configured Gemini model is unavailable. Update GEMINI_MODEL in the server environment and restart the API.', 502);
      }
      if (status === 401 || status === 403) {
        throw new MysteryGenerationError('GEMINI_AUTH_FAILED', 'provider', 'Gemini rejected the server credentials. Check GEMINI_API_KEY in the server environment.', 502);
      }
      if (status === 429) {
        throw new MysteryGenerationError('GEMINI_RATE_LIMITED', 'provider', 'The mystery service is busy right now. Please try again shortly.', 503);
      }
      if (/abort|timed? ?out|timeout/i.test(providerMessage)) {
        throw new MysteryGenerationError('GEMINI_TIMEOUT', 'provider', 'Mystery generation took too long. Please try again; if it continues, increase GEMINI_TIMEOUT_MS.', 504);
      }
      throw new MysteryGenerationError('GEMINI_REQUEST_FAILED', 'provider', 'The mystery service could not generate a case right now. Please try again shortly.', status === 429 ? 503 : 502);
    }

    let raw: unknown;
    try {
      raw = parseGeminiJson(responseText);
    } catch (error) {
      const details = getErrorDetails(error);
      log('response_json_parse_failed', { attempt, responseLength: responseText.length, ...details });
      repairContext = `${details.message ?? 'The response was not valid JSON.'}\n${responseText.slice(0, MAX_REPAIR_CONTEXT)}`;
      continue;
    }

    try {
      const mystery = validateGeneratedMystery(raw);
      log('generation_succeeded', { attempt, suspectCount: mystery.suspects.length, evidenceCount: mystery.evidence.length });
      return mystery;
    } catch (error) {
      const details = getErrorDetails(error);
      log('response_validation_failed', { attempt, ...details });
      repairContext = `${details.message ?? 'The response did not match the required schema or consistency rules.'}\n${responseText.slice(0, MAX_REPAIR_CONTEXT)}`;
    }
  }

  throw new MysteryGenerationError(
    'GENERATION_FAILED',
    'validation',
    'The mystery generator returned incomplete or inconsistent case details. Please try again with a different scenario.',
    502
  );
}
