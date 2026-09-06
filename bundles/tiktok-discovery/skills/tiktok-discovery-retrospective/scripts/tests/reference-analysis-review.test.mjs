// SYNTHETIC fixtures only. No public creator data, browser access, or production policy updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareIntake } from '../../../tiktok-seed-discovery/scripts/runtime/intake.mjs';
import { buildReferenceQueue, validateReferenceReviews, analyzeReferenceConfig } from '../../../tiktok-seed-discovery/scripts/runtime/reference-analysis.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const customer = () => ({ countries: ['US'], followersMin: 100000, followersMax: 800000, creatorDescription: 'Synthetic technology demonstration creators', asOf: '2026-08-31T12:00:00.000Z', references: [
  { id: 'ref-1', url: 'https://www.tiktok.com/@synthetic.alpha', type: 'competitor' },
  { id: 'ref-2', url: 'https://www.tiktok.com/@synthetic.alpha/video/1111111111111111111', type: 'brand_partner' },
  { id: 'ref-3', url: 'https://www.tiktok.com/@synthetic.beta', type: 'style_reference' }
] });
const post = (id, authorHandle, caption) => ({ id, authorHandle, caption, createTime: Date.parse('2026-07-01T12:00:00Z') / 1000, url: `https://www.tiktok.com/@${authorHandle}/video/${id}`, evidence: { synthetic: true, event: id }, stats: { playCount: 1000, diggCount: 50, commentCount: 10 } });
const quote = (p, text = p.caption) => ({ postId: p.id, field: 'caption', quote: text });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tk-reference-review-synthetic-'));
  const write = async (name, value) => { const file = path.join(root, name); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); return file; };
  const intake = await prepareIntake(customer(), root);
  const brief = intake.brief;
  const alpha = [post('1111111111111111111', 'synthetic.alpha', 'Testing ExampleBrandA commuter lights #commutetech @examplebranda'), post('1111111111111111112', 'synthetic.alpha', 'Paid partnership with ExampleBrandB #ad #techdemo')];
  const beta = [post('2222222222222222221', 'synthetic.beta', 'Everyday technology demonstrations #techdemo')];
  const corpus = { briefId: brief.id, window: brief.referenceWindow, references: brief.references.map((ref, i) => ({ id: ref.id, owner: i < 2 ? 'synthetic.alpha' : 'synthetic.beta', profileUrl: ref.url, posts: i < 2 ? alpha : beta, profile: { fields: [{ field: 'user-bio', text: 'Synthetic technology creator biography' }] }, coverage: { status: 'complete_visible_public_window', synthetic: true } })) };
  const queue = buildReferenceQueue(brief, corpus);
  const reviewDocument = { briefId: brief.id, window: brief.referenceWindow, reviews: queue.dossiers.map(d => ({ referenceId: d.referenceId, verdict: 'usable', ownerRole: 'creator', summary: 'Synthetic review', reviewedPostIds: d.posts.map(p => p.id), evidence: [quote(d.posts[0])], traits: [], brands: [], queries: [{ route: 'scenario', query: 'synthetic commuter demonstration', evidence: [quote(d.posts[0])], origin: 'derived' }] })) };
  const corpusFile = await write('corpus.json', corpus);
  const reviewFile = await write('reviews.json', reviewDocument);
  const config = { briefFile: path.join(root, 'brief.json'), corpusFile, reviewFile, outDir: path.join(root, 'analysis'), maxQueries: 100, targetWorks: 240 };
  return { root, write, brief, corpus, queue, reviewDocument, config, alpha, beta };
}

async function run(body) {
  const f = await fixture();
  const previousStateDir = process.env.TIKTOK_DISCOVERY_STATE_DIR;
  process.env.TIKTOK_DISCOVERY_STATE_DIR = path.join(f.root, 'isolated-policy-state');
  try { await body(f); }
  finally {
    if (previousStateDir === undefined) delete process.env.TIKTOK_DISCOVERY_STATE_DIR;
    else process.env.TIKTOK_DISCOVERY_STATE_DIR = previousStateDir;
    const resolved = path.resolve(f.root);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('tk-reference-review-synthetic-')) await fs.rm(resolved, { recursive: true, force: true });
  }
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('missing batch size preserves reviewed material without inventing an executable work target', async () => run(async f => {
  const { targetWorks, ...config } = f.config;
  const result = await analyzeReferenceConfig(config);
  const input = await read(path.join(config.outDir, 'seed-search-input.json'));
  assert.equal(result.reviewStatus, 'reviewed'); assert.equal(result.executionReady, false);
  assert.equal(input.compilation.status, 'needs_batch_budget'); assert.deepEqual(input.actions, []);
  assert.equal(input.limits.totalWorks, undefined);
}));

test('missing intake fields block acquisition and do not create executable reference input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tk-reference-review-synthetic-'));
  try {
    const intake = await prepareIntake({}, root);
    assert.equal(intake.status, 'needs_user_input');
    assert.equal(intake.questions.length, 4);
    await assert.rejects(fs.access(path.join(root, 'reference-input.json')), { code: 'ENOENT' });
  } finally {
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('tk-reference-review-synthetic-')) await fs.rm(root, { recursive: true, force: true });
  }
});

test('intake-to-analysis without AI returns no runnable queries or qualified seeds', async () => run(async f => {
  const { reviewFile, ...config } = f.config;
  const result = await analyzeReferenceConfig(config);
  assert.equal(result.reviewStatus, 'needs_ai_review');
  assert.equal(result.executionReady, false);
  assert.equal(result.runnableQueries, 0);
  const input = await read(path.join(config.outDir, 'seed-search-input.json'));
  assert.deepEqual(input.actions, []);
  const material = await read(path.join(config.outDir, 'reference-seed-material.json'));
  assert.deepEqual(material.confirmedCreatorSeeds, []);
}));

test('partial post review cannot become fully reviewed or execute', async () => run(async f => {
  f.reviewDocument.reviews[0].reviewedPostIds = [f.alpha[0].id];
  await f.write('reviews.json', f.reviewDocument);
  const result = await analyzeReferenceConfig(f.config);
  assert.equal(result.reviewStatus, 'partial_ai_review');
  assert.equal(result.executionReady, false);
  assert.equal(result.runnableQueries, 0);
}));

test('forged query citation is discarded while its valid reference review stays', async () => run(async f => {
  const first = f.reviewDocument.reviews[0];
  first.queries = [{ route: 'scenario', query: 'forged query', evidence: [{ postId: f.alpha[0].id, field: 'caption', quote: 'This quote never occurred' }] }];
  const validated = validateReferenceReviews(f.queue, f.reviewDocument);
  assert.equal(validated.reviews.find(r => r.referenceId === first.referenceId).queries.length, 0);
  assert.ok(validated.issues.some(i => i.reason === 'query_missing_valid_route_or_quote'));
}));

test('plain brand mention cannot become paid partnership', async () => run(async f => {
  f.reviewDocument.reviews[0].brands = [{ name: 'ExampleBrandA', relation: 'paid_partner', evidence: [quote(f.alpha[0])] }];
  const validated = validateReferenceReviews(f.queue, f.reviewDocument);
  assert.equal(validated.reviews[0].brands[0].relation, 'unknown');
  assert.equal(validated.reviews[0].brands[0].independentlyVerifiedSales, false);
}));

test('paid disclosure for another brand cannot be combined across posts to upgrade a mention', async () => run(async f => {
  f.reviewDocument.reviews[0].brands = [{ name: 'ExampleBrandA', relation: 'paid_partner', evidence: [quote(f.alpha[0]), quote(f.alpha[1])] }];
  const validated = validateReferenceReviews(f.queue, f.reviewDocument);
  assert.notEqual(validated.reviews[0].brands[0].relation, 'paid_partner');
}));

test('generic ad label for another named brand in the same post does not establish this brand relationship', async () => run(async f => {
  const mixed = 'Testing ExampleBrandA lights; paid partnership with ExampleBrandB #ad';
  f.corpus.references[0].posts[0].caption = mixed;
  f.reviewDocument.reviews[0].evidence = [{ postId: f.alpha[0].id, field: 'caption', quote: mixed }];
  f.reviewDocument.reviews[0].brands = [{ name: 'ExampleBrandA', relation: 'paid_partner', evidence: [{ postId: f.alpha[0].id, field: 'caption', quote: mixed }] }];
  const validated = validateReferenceReviews(buildReferenceQueue(f.brief, f.corpus), f.reviewDocument);
  assert.notEqual(validated.reviews[0].brands[0].relation, 'paid_partner');
}));

test('multiple reference links from one author add one baseline author and preserve reference sources', async () => run(async f => {
  await analyzeReferenceConfig({ ...f.config, baselineHandles: ['@synthetic.existing'] });
  const input = await read(path.join(f.config.outDir, 'seed-search-input.json'));
  assert.deepEqual(input.baselineHandles.sort(), ['synthetic.alpha', 'synthetic.beta', 'synthetic.existing']);
  assert.equal(input.actions.length, 1);
  assert.equal(input.actions[0].sources.length, 3);
}));

test('policy changes ordering, not action budget, and retains source identities', async () => run(async f => {
  for (const r of f.reviewDocument.reviews) r.queries = [];
  const ev = [quote(f.alpha[0])];
  f.reviewDocument.reviews[0].queries = [{ route: 'hashtag', query: '#synthetic', evidence: ev }, { route: 'brand_product', query: 'synthetic product use', evidence: ev }];
  await f.write('reviews.json', f.reviewDocument);
  const policy = { schemaVersion: 1, version: 'synthetic-test', scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: { actionDedup: true,
    routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 },
    referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 2, identity_location: 1, hashtag: 0.5 } } };
  const policyFile = await f.write('policy.json', policy);
  await analyzeReferenceConfig({ ...f.config, policyFile, maxQueries: 1, targetWorks: 37 });
  const input = await read(path.join(f.config.outDir, 'seed-search-input.json'));
  assert.equal(input.actions.length, 1);
  assert.equal(input.actions[0].query, 'synthetic product use');
  assert.equal(input.actions[0].sources[0].referenceId, 'ref-1');
  assert.equal(input.limits.totalWorks, 37);
}));

test('adopted policy provenance uses exact file-byte SHA256 matching the publisher', async () => run(async f => {
  const policy = { schemaVersion: 1, version: 'synthetic-test', scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: { actionDedup: true,
    routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 },
    referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } };
  const policyFile = await f.write('policy.json', policy);
  await analyzeReferenceConfig({ ...f.config, policyFile });
  const report = await read(path.join(f.config.outDir, 'reference-analysis.json'));
  assert.equal(report.adoptedPolicy.sha256, hash(await fs.readFile(policyFile)));
}));

test('a publication during analysis cannot mix one policy version with another file hash', async () => run(async f => {
  const policy = { schemaVersion: 1, version: 'synthetic-before', scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: { actionDedup: true,
    routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 },
    referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } };
  const policyFile = await f.write('policy.json', policy);
  const before = await fs.readFile(policyFile);
  const changed = structuredClone(policy); changed.version = 'synthetic-after'; changed.strategy.referenceQueryPriority.scenario = 2;
  const originalRead = fs.readFile;
  let interleaved = false;
  // A deterministic mock of another publisher replacing current.json immediately after the first read.
  fs.readFile = async function (file, ...args) {
    const bytes = await originalRead.call(this, file, ...args);
    if (!interleaved && path.resolve(String(file)) === policyFile) {
      interleaved = true;
      await fs.writeFile(policyFile, JSON.stringify(changed, null, 2) + '\n');
    }
    return bytes;
  };
  try { await analyzeReferenceConfig({ ...f.config, policyFile }); }
  finally { fs.readFile = originalRead; }
  const report = await read(path.join(f.config.outDir, 'reference-analysis.json'));
  assert.equal(report.adoptedPolicy.version, 'synthetic-before');
  assert.equal(report.adoptedPolicy.sha256, hash(before));
}));

test('foreign corpus Brief and changed frozen corpus window are rejected', async () => run(async f => {
  const foreign = structuredClone(f.corpus); foreign.briefId = 'another-brief';
  assert.throws(() => buildReferenceQueue(f.brief, foreign), /does not match/);
  const changedWindow = structuredClone(f.corpus); changedWindow.window.end = '2026-09-01T12:00:00Z';
  assert.throws(() => buildReferenceQueue(f.brief, changedWindow), /does not match/);
  await assert.rejects(prepareIntake({ ...customer(), asOf: '2026-09-01T12:00:00Z' }, f.root), /JOB_BRIEF_CONFLICT/);
}));

test('review document belonging to another Brief is rejected even when quotes overlap', async () => run(async f => {
  f.reviewDocument.briefId = 'another-brief';
  await f.write('reviews.json', f.reviewDocument);
  await assert.rejects(analyzeReferenceConfig(f.config), /brief|match/i);
}));

test('review document from a different frozen window is rejected even when posts overlap', async () => run(async f => {
  f.reviewDocument.window = { ...f.reviewDocument.window, end: '2026-09-01T12:00:00Z' };
  await f.write('reviews.json', f.reviewDocument);
  await assert.rejects(analyzeReferenceConfig(f.config), /window|match/i);
}));
