import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeHandle, normalizeAccount, parseInstagramWork, semanticActionKey, isCandidateEvidence, parseCommittedJSONL, readJsonl, audit } from './ig-audit.mjs';

const tempParent = fs.realpathSync(os.tmpdir()), scratch = fs.mkdtempSync(path.join(tempParent, 'ig-audit-test-'));
let serial = 0;
after(() => { const resolved = fs.realpathSync(scratch); if (path.dirname(resolved) !== tempParent || !path.basename(resolved).startsWith('ig-audit-test-')) throw Error('Unsafe test cleanup target'); fs.rmSync(resolved, { recursive: true }); });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n');
const lines = (file, rows) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const append = (file, rows) => fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const at = second => `2020-01-01T00:00:${String(second).padStart(2, '0')}Z`;
const observation = (handle, routeId = 'profile_similar', time = 2, extra = {}) => ({ handle, routeId, seed: 'seed', observedAt: at(time), evidenceKind: 'account_card', evidenceId: handle + '.json', sourceUrl: `https://www.instagram.com/${handle}/`, ...extra });
function fixture() {
  const dir = path.join(scratch, String(++serial)); fs.mkdirSync(dir);
  const files = Object.fromEntries(['accounts', 'actions', 'reviews', 'profiles', 'invalid'].map(k => [k, path.join(dir, k + '.jsonl')]));
  files.baseline = path.join(dir, 'baseline.json'); write(files.baseline, { handles: ['old'] });
  for (const key of ['actions', 'reviews', 'profiles', 'invalid']) lines(files[key], []);
  const rows = [observation('old'), observation('seedx', 'profile_similar', 0, { seed: 'seedx', evidenceKind: 'profile' }),
    observation('Alice'), observation('bob', 'following'), observation('shared', 'following', 3), observation('shared', 'profile_similar', 4),
    observation('overflow', 'hashtag_content', 5, { evidenceKind: 'content_author', sourceUrl: 'https://www.instagram.com/overflow/reel/AbC/' }), // Synthetic fixture.
    observation('alice', 'profile_enrich', 1, { evidenceKind: 'profile', evidenceId: 'alice-profile.json' }),
    observation('orphan', 'profile_enrich', 1, { evidenceKind: 'profile' }), observation('reference', 'profile_similar', 0, { evidenceKind: 'reference_only' })];
  lines(files.accounts, rows);
  return { dir, files, rows, run: extra => audit({ ...files, accounts: [files.accounts], reviews: [files.reviews], actions: [files.actions], profiles: [files.profiles], target: 3, ...extra }) };
}

test('handle and stable identity descriptors reject system URLs and do not guess aliases', () => {
  assert.equal(normalizeHandle(' @Alice.Name '), 'alice.name');
  assert.equal(normalizeHandle('https://instagram.com/Alice.Name/?utm_source=x'), 'alice.name'); // Synthetic fixture.
  for (const value of ['https://www.instagram.com/explore/', 'https://evil.test/alice/', 'https://user:secret@instagram.com/alice/', 'alice/path', 'a'.repeat(31), 'https://instagram.com/alice/reels/']) assert.equal(normalizeHandle(value), null); // Synthetic fixture.
  assert.equal(normalizeAccount('alice', '0007', 'official_v1').entityKey, 'instagram:official_v1:0007');
  assert.equal(normalizeAccount('alice', 7, 'official_v1').identityStatus, 'provisional_handle');
  assert.notEqual(normalizeAccount('alice').entityKey, normalizeAccount('alice_new').entityKey);
});
test('works preserve shortcode case; author-path is a cue only', () => {
  const a = parseInstagramWork('https://instagram.com/alice/reels/AbC_9/?utm_source=x'); // Synthetic fixture.
  assert.equal(a.canonicalUrl, 'https://www.instagram.com/reel/AbC_9/'); assert.equal(a.authorFromPath, 'alice'); // Synthetic fixture.
  assert.equal(a.key, parseInstagramWork('https://www.instagram.com/p/AbC_9/').key);
  assert.notEqual(a.key, parseInstagramWork('https://www.instagram.com/p/abc_9/').key);
  assert.equal(parseInstagramWork('https://www.instagram.com/stories/alice/123'), null); // Synthetic fixture.
  assert.equal(isCandidateEvidence({ handle: 'alice', routeId: 'profile_collab_authors', evidenceKind: 'profile', sourceUrl: a.canonicalUrl }), false);
});
test('semantic keys include full nested parameters and batch, but no attempt timing', () => {
  const action = { routeId: 'following', seed: 'alice', batchId: 'batch', params: { location: 'X', filters: { language: 'en', category: 'new' } }, maxAccounts: 10, phase: 'pilot' };
  const reordered = { phase: 'pilot', maxAccounts: 10, params: { filters: { category: 'new', language: 'en' }, location: 'X' }, seed: 'alice', routeId: 'following' };
  assert.equal(semanticActionKey(action), semanticActionKey(reordered, 'batch'));
  assert.equal(semanticActionKey(action), semanticActionKey({ ...action, status: 'failed', attemptId: 'retry', startedAt: at(1), durationMs: 12, stopReason: 'budget' }));
  for (const patch of [{ maxAccounts: 11 }, { phase: 'expand' }, { routeVariant: 'new' }, { refreshWindow: 'later' }, { params: { ...action.params, hiddenNewFilter: true } }, { batchId: 'later' }]) assert.notEqual(semanticActionKey(action), semanticActionKey({ ...action, ...patch }));
  assert.notEqual(semanticActionKey(action), semanticActionKey({ ...action, params: { ...action.params, startedAt: 'semantic_filter' } }));
  assert.match(semanticActionKey(action), /^[a-f0-9]{64}$/); assert.throws(() => semanticActionKey(action, 'conflict')); assert.throws(() => semanticActionKey({ routeId: 'x' }));
  assert.throws(() => semanticActionKey({ ...action, unknownParameter: undefined })); assert.throws(() => semanticActionKey({ ...action, params: { invalid: NaN } }));
});
test('only supported route/source pairs or complete named cues are candidates', () => {
  const cue = { handle: 'alice', seed: '@Alice', routeId: 'profile_credit_repost', evidenceKind: 'profile', sourceUrl: 'https://www.instagram.com/alice/', lookupOnly: true, routeVariant: 'named_profile_lookup', parentSeed: 'source', sourceWorkUrl: 'https://www.instagram.com/reel/AbC/', cueEvidenceId: 'source.json' }; // Synthetic fixture.
  assert.equal(isCandidateEvidence(cue), true);
  for (const patch of [{ lookupOnly: false }, { routeId: 'following' }, { cueEvidenceId: '' }, { parentSeed: null }, { sourceWorkUrl: 'https://example.test/p/AbC/' }, { handle: 'wrong' }]) assert.equal(isCandidateEvidence({ ...cue, ...patch }), false);
  assert.equal(isCandidateEvidence(observation('a')), true); assert.equal(isCandidateEvidence(observation('a', 'unknown_route')), false);
  assert.equal(isCandidateEvidence(observation('a', 'profile_enrich')), false); assert.equal(isCandidateEvidence(observation('a', 'hashtag_content')), false);
});
test('LF commit excludes complete and incomplete tails; committed corruption is fatal', () => {
  const parsed = parseCommittedJSONL('\uFEFF{"handle":"中文"}\r\n{"handle":"complete_but_uncommitted"}');
  assert.equal(parsed.records.length, 1); assert.equal(parsed.committedBytes, Buffer.byteLength('\uFEFF{"handle":"中文"}\r\n'));
  assert.equal(parseCommittedJSONL('{"broken":').records.length, 0);
  assert.throws(() => parseCommittedJSONL('{"ok":1}\nnot-json\n{"ok":2}\n'), /line 2/);
  assert.throws(() => parseCommittedJSONL('[]\n'), /line 1/);
});
test('byte-safe reads reject corrupt committed UTF8 and preserve partial UTF8 tail accounting', () => {
  const file = path.join(scratch, 'utf8.jsonl'); fs.writeFileSync(file, Buffer.concat([Buffer.from('{"ok":1}\n'), Buffer.from([0xe4, 0xb8])]));
  const result = readJsonl(file); assert.equal(result.records.length, 1); assert.equal(result.ignoredTailBytes, 2);
  fs.writeFileSync(file, Buffer.from([0xff, 10])); assert.throws(() => readJsonl(file), /UTF-8/);
});
test('candidate-only target, same-time line order, background and overflow reconcile', () => {
  const f = fixture(), r = f.run(); assert.equal(r.qa.passed, true); assert.equal(r.summary.candidateUnique, 4);
  assert.equal(r.summary.targetCount, 3); assert.equal(r.summary.overflowCount, 1); assert.equal(r.summary.supportOnlyUnique, 2);
  assert.deepEqual(r.entities.filter(x => x.pool === 'target').map(x => x.handle), ['alice', 'bob', 'shared']);
  const alice = r.entities.find(x => x.handle === 'alice'); assert.equal(alice.firstObserved.routeId, 'profile_enrich'); assert.equal(alice.firstCandidate.routeId, 'profile_similar');
  assert.equal(r.routes.reduce((n, x) => n + x.globalFirstTargetUnique, 0), 3);
  assert.equal(r.overlaps.find(x => x.routeA === 'following' && x.routeB === 'profile_similar').candidateIntersectionUnique, 1);
  assert.equal(r.qualificationCertified, false);
});
test('exact invalidations preserve other evidence and can move first attribution', () => {
  const f = fixture(); lines(f.files.invalid, [{ handle: '@ALICE', evidenceId: 'Alice.json' }]);
  append(f.files.accounts, [observation('alice', 'following', 6, { evidenceId: 'other.json' })]);
  const r = f.run(); assert.equal(r.summary.exclusions.exactInvalidRows, 1); assert.equal(r.summary.candidateUnique, 4);
  assert.equal(r.entities.find(x => x.handle === 'alice').firstCandidate.routeId, 'following');
  assert.equal(r.entities.find(x => x.handle === 'alice').pool, 'overflow');
});
test('unsupported routes are support-only and visibly partial', () => {
  const f = fixture(); append(f.files.accounts, [observation('unknown_source', 'brand_new_route')]);
  const r = f.run(); assert.equal(r.entities.find(x => x.handle === 'unknown_source').pool, 'support_only');
  assert.equal(r.status, 'partial_snapshot'); assert(r.warnings.some(x => x.code === 'unsupported_route_support_only'));
});
test('complete uncommitted tail is not counted and input bytes remain unchanged', () => {
  const f = fixture(); fs.appendFileSync(f.files.accounts, JSON.stringify(observation('tail')));
  const before = fs.readFileSync(f.files.accounts), r = f.run(); assert.equal(r.summary.candidateUnique, 4); assert.equal(r.status, 'partial_snapshot');
  assert(fs.readFileSync(f.files.accounts).equals(before));
});
test('missing timestamps and evidence IDs are excluded, never invented', () => {
  const f = fixture(); append(f.files.accounts, [observation('no_date', 'following', 2, { observedAt: '2020-01-01' }), observation('no_id', 'following', 2, { evidenceId: null })]);
  const r = f.run(); assert.equal(r.summary.candidateUnique, 4); assert.equal(r.summary.exclusions.missingObservationEvidenceRows, 2);
});
test('real retry costs count, journal versions coalesce, unstarted dispatch does not consume browser time', () => {
  const f = fixture();
  const action = { actionKey: 'same', routeId: 'following', attemptId: 'one', startedAt: at(1), status: 'running' };
  lines(f.files.actions, [action, { ...action, status: 'failed', finishedAt: at(2), durationMs: 1000 }, { ...action, attemptId: 'two', startedAt: at(3), finishedAt: at(4), durationMs: 1200, status: 'completed' },
    { actionKey: 'skip', routeId: 'following', status: 'skipped' }, { actionKey: 'unknown_time', routeId: 'following', status: 'failed' }]);
  const r = f.run(), route = r.routes.find(x => x.routeId === 'following');
  assert.equal(route.actionCount, 3); assert.equal(route.browserKnownMs, 2200); assert.equal(route.untimedActionCount, 1); assert.equal(r.summary.unstartedDispatchRows, 1);
});
test('profile-linked review outranks newer triage; newest actual profile evidence then review wins', () => {
  const f = fixture(); lines(f.files.profiles, [{ handle: 'alice', url: 'https://www.instagram.com/alice/', evidenceId: 'profile-old.json', observedAt: at(5) }, { handle: 'alice', url: 'https://www.instagram.com/alice/', evidenceId: 'profile-new.json', observedAt: at(9) }]);
  lines(f.files.reviews, [{ handle: 'alice', reviewLevel: 'profile', profileEvidenceId: 'profile-new.json', reviewedAt: at(10), role: 'unmapped_role', theme: 'core', expansionStatus: 'hold' },
    { handle: 'alice', evidenceLevel: 'profile', evidenceIds: ['profile-old.json'], reviewedAt: at(20), role: 'brand' },
    { handle: 'alice', evidenceLevel: 'discovery_evidence_triage', evidenceIds: ['Alice.json'], reviewedAt: at(30), role: 'unknown' }]);
  const review = f.run().entities.find(x => x.handle === 'alice').review;
  assert.equal(review.role, 'unmapped_role'); assert.equal(review.expansionStatus, 'hold'); assert.equal(review.profileLinked, true);
});
test('profile title without matching exact handle/evidence cannot claim profile priority', () => {
  const f = fixture(); lines(f.files.profiles, [{ handle: 'alice', url: 'https://www.instagram.com/wrong/', evidenceId: 'wrong.json', observedAt: at(9) }]);
  lines(f.files.reviews, [{ handle: 'alice', evidenceLevel: 'profile', evidenceIds: ['wrong.json'], reviewedAt: at(30), role: 'brand' },
    { handle: 'alice', evidenceLevel: 'discovery_evidence_triage', evidenceIds: ['Alice.json'], reviewedAt: at(10), role: 'unknown' }]);
  const review = f.run().entities.find(x => x.handle === 'alice').review; assert.equal(review.profileLinked, false); assert.equal(review.linkage, 'discovery_linked');
});
test('different brief/rubric versions are preserved and require an explicit context choice', () => {
  const f = fixture(); lines(f.files.reviews, ['v1', 'v2'].map(rubricVersion => ({ handle: 'alice', briefVersion: 'brief', rubricVersion, evidenceLevel: 'triage', evidenceIds: ['Alice.json'], reviewedAt: at(10), role: rubricVersion === 'v1' ? 'brand' : 'unknown' })));
  const ambiguous = f.run(), alice = ambiguous.entities.find(x => x.handle === 'alice');
  assert.equal(alice.review, null); assert.equal(alice.reviewVariants.length, 2); assert.equal(ambiguous.summary.unresolvedReviewContextUnique, 1);
  const selected = f.run({ briefVersion: 'brief', rubricVersion: 'v2' }).entities.find(x => x.handle === 'alice').review;
  assert.equal(selected.rubricVersion, 'v2'); assert.equal(selected.role, 'unknown');
});
test('snake-case observations override action defaults and retain complete named provenance', () => {
  const f = fixture(); lines(f.files.actions, [{ actionKey: 'cue', routeId: 'following', lookupOnly: false, status: 'completed', durationMs: 2 }]);
  append(f.files.accounts, [{ handle: 'cue', seed: 'cue', action_key: 'cue', route_id: 'profile_credit_repost', evidence_kind: 'profile', evidence_id: 'cue.json', observed_at: at(8),
    source_url: 'https://www.instagram.com/cue/', lookup_only: true, route_variant: 'named_profile_lookup', parent_seed: 'parent', source_work_url: 'https://www.instagram.com/reel/ABC/', cue_evidence_id: 'prior.json' }]); // Synthetic fixture.
  const cue = f.run().entities.find(x => x.handle === 'cue'); assert.equal(cue.pool, 'overflow'); assert.equal(cue.firstCandidate.parentSeed, 'parent'); assert.equal(cue.firstCandidate.cueEvidenceId, 'prior.json');
});
test('URL output retains only IG search q and excludes credentials and tracking', () => {
  const f = fixture(); append(f.files.accounts, [observation('query', 'keyword_content', 8, { evidenceKind: 'content_author', contentUrl: 'https://www.instagram.com/reel/Query1/', sourceUrl: 'https://instagram.com/explore/search/keyword/?q=cargo%20bike&access_token=secret&utm_source=x' })]);
  const entity = f.run().entities.find(x => x.handle === 'query'); assert.equal(new URL(entity.firstCandidate.sourceUrl).search, '?q=cargo+bike'); assert(!JSON.stringify(entity).includes('secret'));
});
test('CLI creates derived artifacts, refuses overwrite, and never modifies sources', () => {
  const f = fixture(), script = fileURLToPath(new URL('./ig-audit.mjs', import.meta.url)), out = path.join(f.dir, 'output'), before = fs.readFileSync(f.files.accounts);
  const args = [script, '--accounts', f.files.accounts, '--baseline', f.files.baseline, '--target', '3', '--out', out];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(first.status, 0, first.stderr); assert(fs.existsSync(path.join(out, 'audit.json'))); assert(fs.existsSync(path.join(out, 'entities.jsonl')));
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(second.status, 2); assert.match(second.stderr, /Output exists/); assert(fs.readFileSync(f.files.accounts).equals(before));
});
test('untraceable author tags and conflicting work IDs cannot enter the candidate target', () => {
  const f = fixture(); append(f.files.accounts, [
    observation('untraceable', 'keyword_content', 9, { evidenceKind: 'content_author', sourceUrl: null, sourceWorkUrl: null, contentUrl: null }),
    observation('mismatch', 'keyword_content', 9, { evidenceKind: 'content_author', sourceUrl: 'https://www.instagram.com/reel/ABC/', contentId: 'DEF' }), // Synthetic fixture.
    observation('bad_card', 'profile_similar', 9, { sourceUrl: 'https://wrong.test/seed/' })
  ]);
  const result = f.run(); assert.equal(result.summary.candidateUnique, 4);
  for (const h of ['untraceable', 'mismatch', 'bad_card']) assert.equal(result.entities.find(x => x.handle === h).pool, 'support_only');
  assert.equal(result.status, 'partial_snapshot'); assert.equal(result.warnings.filter(x => x.code === 'candidate_source_incomplete_or_unsupported').length, 3);
});
test('explicit diagnostic costs are separate while failed discovery retains its measured cost', () => {
  const f = fixture(); lines(f.files.actions, [
    { actionKey: 'production', routeId: 'profile_similar', status: 'failed', phase: 'pilot', durationMs: 3000 },
    { actionKey: 'diagnostic', routeId: 'profile_similar', status: 'completed', phase: 'diagnostic', durationMs: 7000 },
    { actionKey: 'explicit', routeId: 'following', status: 'completed', costRole: 'diagnostic', durationMs: 2000 },
    { actionKey: 'enrich', routeId: 'profile_enrich', status: 'completed', durationMs: 4000 }
  ]);
  const r = f.run(); assert.equal(r.summary.discoveryBrowserKnownMs, 3000); assert.equal(r.summary.diagnosticBrowserKnownMs, 9000); assert.equal(r.summary.enrichmentBrowserKnownMs, 4000);
  assert.equal(r.routes.find(x => x.routeId === 'profile_similar').browserKnownMs, 3000); assert.equal(r.costFrames.find(x => x.costRole === 'diagnostic').actionCount, 2);
});
test('review output retains allowed scope, rationale, continuity and original semantic fields', () => {
  const f = fixture(); lines(f.files.reviews, [{ handle: 'alice', reviewLevel: 'profile', profileEvidenceId: 'alice-profile.json', reviewedAt: at(8),
    role: 'individual_creator', theme: 'core', expansionStatus: 'approved_core', allowedScope: ['specific_observed_work'], rationale: 'Visible repeated content in a bounded sample.',
    continuity: { observed: 3, verified: false }, customCriterion: { result: 'unknown' }, cookie: 'must-not-export' }]); // Synthetic fixture.
  const review = f.run().entities.find(x => x.handle === 'alice').review;
  assert.deepEqual(review.routeScope, ['specific_observed_work']); assert.deepEqual(review.allowedScope, review.routeScope); assert.equal(review.rationale, 'Visible repeated content in a bounded sample.');
  assert.deepEqual(review.continuity, { observed: 3, verified: false }); assert.equal(review.originalReview.customCriterion.result, 'unknown'); assert(!JSON.stringify(review).includes('must-not-export'));
});
