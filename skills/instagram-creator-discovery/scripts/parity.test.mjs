import test from 'node:test';
import assert from 'node:assert/strict';
import * as audit from './ig-audit.mjs';
import * as collector from './collect.mjs';

// Only pure exports are called. The Task Master entry never imports this file.
test('collector and audit normalize the same observed handles and work identifiers', () => {
  for (const value of ['@Alpha.Name', ' alpha.name ', '/Alpha.Name/', 'https://instagram.com/Alpha.Name/?utm_source=test', '/explore/', '/api/', '/checkpoint/', // Synthetic fixture.
    'https://evil.test/alpha/', 'https://name:password@instagram.com/alpha/', null, 'A'.repeat(31), '/alpha/reels/']) {
    assert.equal(collector.normalizeHandle(value), audit.normalizeHandle(value), String(value));
  }
  for (const value of ['/reel/AbC_1/', '/alpha/reels/AbC_1/?utm_source=test', 'https://instagram.com/p/AbC_1/', 'https://instagram.com/p/abc_1/', '/REEL/AbC/', '/stories/alpha/123/', 'https://evil.test/p/AbC/', null]) {
    assert.deepEqual(collector.parseInstagramWork(value), audit.parseInstagramWork(value), String(value));
  }
});
test('semantic action keys agree on full parameters, runtime exclusions and invalid inputs', () => {
  const action = { routeId: 'following', seed: 'alpha', url: 'https://www.instagram.com/alpha/', phase: 'pilot', depth: 1, // Synthetic fixture.
    budget: { maxAccounts: 12, maxScrolls: 3 }, filters: { language: ['en', 'fr'], audience: { minimum: 10 } } };
  for (const a of [action, { ...action, batchId: 'batch' }, { ...action, batch_id: 'batch' }, { ...action, costRole: 'diagnostic' },
    { ...action, phase: 'expand', budget: { maxAccounts: 13, maxScrolls: 3 } },
    { ...action, attemptId: 'later', status: 'failed', startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:00:01Z', durationMs: 1000, error: 'redacted', accountHandles: ['alpha'] }]) {
    assert.equal(collector.semanticActionKey(a, 'batch'), audit.semanticActionKey(a, 'batch'));
  }
  for (const a of [{ ...action, batchId: 'other' }, { ...action, batch_id: 'other' }, { ...action, value: undefined }, { ...action, params: { invalid: NaN } }]) {
    assert.throws(() => collector.semanticActionKey(a, 'batch')); assert.throws(() => audit.semanticActionKey(a, 'batch'));
  }
});
test('candidate source rules agree for cards, authors, references and complete named lookup chains', () => {
  const base = { handle: 'alpha', seed: 'alpha', sourceUrl: 'https://www.instagram.com/alpha/' }; // Synthetic fixture.
  const cue = { ...base, routeId: 'profile_credit_repost', evidenceKind: 'profile', lookupOnly: true, routeVariant: 'named_profile_lookup', parentSeed: 'parent', sourceWorkUrl: 'https://www.instagram.com/reel/AbC/', cueEvidenceId: 'prior.json' }; // Synthetic fixture.
  const cases = [
    { ...base, routeId: 'profile_similar', evidenceKind: 'account_card' }, { ...base, routeId: 'following', evidenceKind: 'account_card', sourceUrl: null },
    { ...base, routeId: 'unknown', evidenceKind: 'account_card' }, { ...base, routeId: 'profile_enrich', evidenceKind: 'account_card' },
    { ...base, routeId: 'keyword_content', evidenceKind: 'content_author', sourceUrl: null },
    { ...base, routeId: 'hashtag_content', evidenceKind: 'cached_content_author', sourceUrl: 'https://www.instagram.com/reel/AbC/', contentId: 'AbC' }, // Synthetic fixture.
    { ...base, routeId: 'hashtag_content', evidenceKind: 'content_author', sourceUrl: 'https://www.instagram.com/reel/AbC/', contentId: 'wrong' }, // Synthetic fixture.
    cue, { ...cue, lookupOnly: false }, { ...cue, routeVariant: 'named_profile_from_verified_prior_work' }, { ...cue, sourceUrl: 'https://www.instagram.com/wrong/' }, // Synthetic fixture.
    { ...base, route_id: 'following', evidence_kind: 'account_card' }, { ...base, routeId: 'following', evidenceKind: 'reference_only' },
    { ...base, handle: null, routeId: 'following', evidenceKind: 'account_card' }
  ];
  for (const record of cases) assert.equal(collector.isCandidateEvidence(record), audit.isCandidateEvidence(record), JSON.stringify(record));
});
test('JSONL commit parsers agree on BOM, LF boundaries and corrupted committed records', () => {
  for (const text of ['', '{"complete":true}', '{"valid":1}\n{"tail":', '\uFEFF{"unicode":"中文"}\r\n\n{"valid":2}\n']) {
    assert.deepEqual(collector.parseCommittedJSONL(text), audit.parseCommittedJSONL(text));
  }
  for (const text of ['not-json\n', '{"valid":1}\n[]\n', '{"valid":1}\n{"corrupt":\n']) {
    assert.throws(() => collector.parseCommittedJSONL(text)); assert.throws(() => audit.parseCommittedJSONL(text));
  }
});
