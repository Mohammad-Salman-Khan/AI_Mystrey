import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMystery, MysteryGenerationError, parseGeminiJson, validateGeneratedMystery } from './generator.js';

function validMystery() {
  const suspects = [
    { id: 'suspect_1', name: 'Alex Morgan', profile: 'Lab assistant', relationship: 'Maintains the prototype', motive: 'Wanted to sell the design', alibi: 'Claims to have been at dinner', notes: 'Had after-hours access.' },
    { id: 'suspect_2', name: 'Blair Chen', profile: 'Graduate student', relationship: 'Worked on the prototype', motive: 'Feared losing a research grant', alibi: 'Claims to have been at the library', notes: 'Borrowed a lab key earlier.' },
    { id: 'suspect_3', name: 'Casey Singh', profile: 'Security officer', relationship: 'Guarded the building', motive: 'Was owed overtime', alibi: 'Claims to have been at the front desk', notes: 'Saw the lights fail.' }
  ];
  const evidence = [
    { id: 'evidence_1', type: 'messages' as const, title: 'Recovered chat', description: 'A fictional chat transcript.', content: 'Alex (18:40): I will be there soon.', relatedSuspectIds: ['suspect_1'] },
    { id: 'evidence_2', type: 'camera_log' as const, title: 'East corridor log', description: 'A simulated camera event log.', content: '18:42 — A person enters the corridor.', relatedSuspectIds: ['suspect_1'] },
    { id: 'evidence_3', type: 'document' as const, title: 'Access register', description: 'A fictional door access report.', content: '18:43 — Alex Morgan used the laboratory badge.', relatedSuspectIds: ['suspect_1'] },
    { id: 'evidence_4', type: 'witness_statement' as const, title: 'Night guard statement', description: 'A fictional witness account.', content: 'I saw someone leave with a small case.', relatedSuspectIds: ['suspect_3'] },
    { id: 'evidence_5', type: 'physical_clue' as const, title: 'Loose screw', description: 'A small physical clue.', content: 'A screw from the display case was found nearby.', relatedSuspectIds: ['suspect_2'] }
  ];
  return {
    title: 'The Missing Prototype',
    briefing: 'A research prototype disappeared during a short power failure at a university lab.',
    setting: 'University laboratory',
    suspects,
    timeline: [
      { time: '18:35', description: 'The lab closes to visitors.' },
      { time: '18:42', description: 'A person enters the east corridor.' },
      { time: '18:50', description: 'The prototype is reported missing.' }
    ],
    evidence,
    solution: {
      culpritSuspectId: 'suspect_1',
      explanation: 'Recovered chat places Alex nearby; East corridor log shows the approach; Access register records Alex entering the lab.',
      decisiveEvidenceIds: ['evidence_1', 'evidence_2', 'evidence_3'],
      redHerringEvidenceIds: ['evidence_5']
    }
  };
}

test('parses fenced JSON and surrounding explanatory text safely', () => {
  const raw = validMystery();
  const parsed = parseGeminiJson(`Here is the requested case:\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n`);
  assert.deepEqual(parsed, raw);
});

test('validates culprit, clue references, and explanation evidence references', () => {
  const mystery = validMystery();
  assert.equal(validateGeneratedMystery(mystery).solution.culpritSuspectId, 'suspect_1');

  const bad = validMystery();
  bad.evidence[0].relatedSuspectIds = ['suspect_missing'];
  assert.throws(() => validateGeneratedMystery(bad), /unknown suspect ID/);
});

test('succeeds after one corrective retry for invalid generated JSON shape', async () => {
  const invalid = validMystery() as Record<string, unknown>;
  delete invalid.setting;
  const prompts: string[] = [];
  const events: string[] = [];
  const result = await generateMystery('A prototype disappears from a university lab during a power cut.', 'medium', {
    request: async prompt => { prompts.push(prompt); return JSON.stringify(prompts.length === 1 ? invalid : validMystery()); },
    log: event => events.push(event)
  });

  assert.equal(result.solution.culpritSuspectId, 'suspect_1');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /"relatedSuspectIds": \["suspect id"\]/);
  assert.match(prompts[0], /"notes": "string"/);
  assert.match(prompts[1], /previous response was rejected/i);
  assert.ok(events.includes('response_validation_failed'));
  assert.ok(events.includes('generation_succeeded'));
});

test('returns a clear error after the bounded retries fail to parse JSON', async () => {
  const events: string[] = [];
  await assert.rejects(
    generateMystery('A prototype disappears from a university lab during a power cut.', 'medium', {
      request: async () => 'This is not a JSON case.',
      log: event => events.push(event)
    }),
    (error: unknown) => error instanceof MysteryGenerationError
      && error.code === 'GENERATION_FAILED'
      && /incomplete or inconsistent/i.test(error.message)
  );
  assert.deepEqual(events, ['response_json_parse_failed', 'response_json_parse_failed']);
});

test('logs provider details without leaking API keys or returning provider internals', async () => {
  const originalError = console.error;
  const logLines: string[] = [];
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
  await assert.rejects(
    generateMystery('A prototype disappears from a university lab during a power cut.', 'medium', {
      request: async () => { throw Object.assign(new Error('HTTP 403 key=secret-value AIza123456789012345678901234567890'), { status: 403 }); }
    }),
    (error: unknown) => error instanceof MysteryGenerationError
      && error.code === 'GEMINI_AUTH_FAILED'
      && !error.message.includes('secret-value')
  );
  console.error = originalError;
  const output = logLines.join('\n');
  assert.match(output, /provider_request_failed/);
  assert.match(output, /403/);
  assert.doesNotMatch(output, /secret-value|AIza123456789012345678901234567890/);
});

test('reports an unavailable configured model clearly', async () => {
  await assert.rejects(
    generateMystery('A prototype disappears from a university lab during a power cut.', 'medium', {
      request: async () => { throw Object.assign(new Error('Model not available'), { status: 404 }); },
      log: () => undefined
    }),
    (error: unknown) => error instanceof MysteryGenerationError
      && error.code === 'GEMINI_MODEL_UNAVAILABLE'
      && /GEMINI_MODEL/.test(error.message)
  );
});

test('reports provider timeouts distinctly', async () => {
  await assert.rejects(
    generateMystery('A prototype disappears from a university lab during a power cut.', 'medium', {
      request: async () => { throw new Error('This operation was aborted'); },
      log: () => undefined
    }),
    (error: unknown) => error instanceof MysteryGenerationError
      && error.code === 'GEMINI_TIMEOUT'
      && /took too long/i.test(error.message)
  );
});
