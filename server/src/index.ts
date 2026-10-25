import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { generateMystery } from './generator.js';
import { loadDatabaseModules, type DatabaseModules } from './database.js';

// npm workspaces run scripts from the workspace directory, while the documented
// .env lives at the repository root. Resolve it from this module in both src and dist.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

let database: DatabaseModules | null = null;

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader('X-Request-Id', res.locals.requestId); next(); });
app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const fail = (code: string, message: string, status = 400) => Object.assign(new Error(message), { code, status });
function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error).slice(0, 500) };
  const details = error as Error & { code?: string | number; status?: number };
  const message = error.message.replace(/AIza[\w-]{20,}/g, '[redacted-api-key]')
    .replace(/((?:[?&]|\b)key=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s@]+@/gi, '$1[credentials]@');
  return { name: error.name, code: details.code, status: details.status, message: message.slice(0, 1000) };
}
const publicCase = (doc: any) => ({ id: doc.publicId, title: doc.title, scenario: doc.scenario, briefing: doc.briefing, setting: doc.setting, suspects: doc.suspects, timeline: doc.timeline, evidence: doc.evidence.map((e: any) => { const record = typeof e.toObject === 'function' ? e.toObject() : e; return { ...record, generationStatus: e.type === 'image' || e.type === 'video' ? 'unavailable' : e.type === 'camera_log' ? 'simulated' : 'ready' }; }), status: doc.status, createdAt: doc.createdAt });

app.get('/api/v1/health', asyncRoute(async (_req, res) => res.json({ status: 'ok', database: database?.mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' })));
app.get('/api/v1/ready', (_req, res) => {
  const ready = database?.mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', database: ready ? 'connected' : 'disconnected' });
});
app.post('/api/v1/cases', asyncRoute(async (req, res) => {
  const input = z.object({ scenario: z.string().trim().min(20).max(1200), difficulty: z.enum(['easy','medium','hard']).default('medium') }).safeParse(req.body);
  if (!input.success) throw fail('VALIDATION_ERROR', 'Write a scenario between 20 and 1,200 characters.');
  if (!database || database.mongoose.connection.readyState !== 1) throw fail('DATABASE_UNAVAILABLE', 'The case archive is temporarily unavailable. Please try again shortly.', 503);
  console.info('[case-create] generation_started', JSON.stringify({ requestId: res.locals.requestId, scenarioLength: input.data.scenario.length, difficulty: input.data.difficulty }));
  const generated = await generateMystery(input.data.scenario, input.data.difficulty);
  const id = randomUUID(); const days = Math.max(1, Number(process.env.CASE_TTL_DAYS || 7));
  let doc;
  try {
    doc = await database.Mystery.create({ ...generated, publicId: id, scenario: input.data.scenario, status: 'investigating', expiresAt: new Date(Date.now() + days * 86400000) });
  } catch (error) {
    console.error('[case-persistence] save_failed', JSON.stringify({ requestId: res.locals.requestId, ...safeErrorDetails(error) }));
    throw fail('CASE_PERSISTENCE_FAILED', 'The mystery was prepared but could not be saved. Please try again shortly.', 503);
  }
  res.status(201).json({ case: publicCase(doc) });
}));
app.get('/api/v1/cases/:caseId', asyncRoute(async (req, res) => {
  if (!database || database.mongoose.connection.readyState !== 1) throw fail('DATABASE_UNAVAILABLE', 'The case archive is temporarily unavailable.', 503);
  const doc = await database.Mystery.findOne({ publicId: req.params.caseId, expiresAt: { $gt: new Date() } });
  if (!doc) throw fail('CASE_NOT_FOUND', 'This case could not be found or has expired.', 404);
  res.json({ case: publicCase(doc) });
}));
app.post('/api/v1/cases/:caseId/accusation', asyncRoute(async (req, res) => {
  const input = z.object({ suspectId: z.string().min(1) }).safeParse(req.body);
  if (!input.success) throw fail('VALIDATION_ERROR', 'Select a suspect before submitting your accusation.');
  if (!database || database.mongoose.connection.readyState !== 1) throw fail('DATABASE_UNAVAILABLE', 'The case archive is temporarily unavailable.', 503);
  const doc = await database.Mystery.findOne({ publicId: req.params.caseId, expiresAt: { $gt: new Date() } });
  if (!doc) throw fail('CASE_NOT_FOUND', 'This case could not be found or has expired.', 404);
  if (doc.status === 'completed') throw fail('CASE_COMPLETED', 'A final accusation has already been submitted for this case.', 409);
  if (!doc.suspects.some(s => s.id === input.data.suspectId)) throw fail('VALIDATION_ERROR', 'That suspect is not part of this case.');
  const updated = await database.Mystery.findOneAndUpdate({ _id: doc._id, status: 'investigating' }, { $set: { status: 'completed', accusation: { suspectId: input.data.suspectId, submittedAt: new Date() } } }, { new: true });
  if (!updated) throw fail('CASE_COMPLETED', 'A final accusation has already been submitted for this case.', 409);
  const culprit = updated.suspects.find(s => s.id === updated.solution?.culpritSuspectId);
  res.json({ result: { correct: input.data.suspectId === updated.solution?.culpritSuspectId, accusedSuspectId: input.data.suspectId, culpritSuspectId: updated.solution?.culpritSuspectId, culpritName: culprit?.name, explanation: updated.solution?.explanation, decisiveEvidenceIds: updated.solution?.decisiveEvidenceIds, redHerringEvidenceIds: updated.solution?.redHerringEvidenceIds } });
}));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || (err.code === 'GENERATION_UNAVAILABLE' ? 503 : 500);
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.status || err.code === 'GENERATION_UNAVAILABLE' || err.code === 'GENERATION_FAILED' ? err.message : 'Something went wrong. Please try again.';
  console.error('[api] request_failed', JSON.stringify({ requestId: res.locals.requestId, code, status, ...safeErrorDetails(err) }));
  res.status(status).json({ error: { code, message, requestId: res.locals.requestId } });
});

const port = Number(process.env.PORT || 4000);
const start = async () => {
  const configuredUri = process.env.MONGODB_URI?.trim();
  // Atlas examples use <username> as a placeholder. If the brackets were left in
  // when the username was filled in, remove only that wrapper before connecting.
  const mongoUri = configuredUri?.replace(/^(mongodb(?:\+srv)?:\/\/)<([^<>]+)>:/i, '$1$2:');
  if (mongoUri) {
    try {
      database = await loadDatabaseModules();
      await database.mongoose.connect(mongoUri);
      console.log('MongoDB connected');
    }
    catch (error) {
      const err = error as Error & { code?: string };
      const safeMessage = (err.message || '').replace(/(mongodb(?:\+srv)?:\/\/)[^\s@]+@/gi, '$1[credentials]@');
      console.error('MongoDB connection failed:', err.name, err.code || '', safeMessage);
      console.error('Check the Atlas database username/password, Network Access IP allowlist, and that MONGODB_URI is set in the root .env file.');
    }
  } else {
    console.error('MONGODB_URI is missing. Add it to the repository root .env file; case operations are disabled.');
  }
  if (process.env.NODE_ENV === 'production') {
    const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
    app.use(express.static(clientDist, { index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }
  app.listen(port, '0.0.0.0', () => console.log(`Mystery Room API listening on ${port}`));
};
void start();
