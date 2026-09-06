// Synthetic offline examples only; no real campaign configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processConfig, validateReviews, writeJson } from './process.mjs';
import { frontierConfig } from './frontier.mjs';

const at = '2026-09-06T01:00:00.000Z';
const url = handle => `https://www.tiktok.com/@${handle}`;
const action = (id, query) => ({ id, query, kind: 'search', route: 'topic_query', url: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`, sources: [], startedAt: at });
const workCard = (handle, id, caption) => ({ id, authorHandle: handle, url: `${url(handle)}/video/${id}`, caption, text: caption });
async function fixture(brief, { recommendations = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tk-pipeline-test-')), taskId = 'task_fixture', output = join(root, taskId, 'output');
  await mkdir(output, { recursive: true });
  const a = action('search1', brief.topic), profile = { id: 'profile1', kind: 'profile', route: recommendations ? 'profile_suggested_accounts' : 'profile_enrichment', seed: 'alice', url: url('alice'), startedAt: at, sources: [{ seed: 'alice', rootDepth: 0, targetDepth: 0, route: recommendations ? 'profile_suggested_accounts' : 'profile_enrichment' }] };
  const caption = `${brief.topic} commute tips #DailyRide #BikeLife`, cards = [workCard('alice', '1001', caption), workCard('unknown', '1002', 'Unrelated sample'), workCard('alice', '1003', `${brief.topic} repair`), workCard('mismatch', '1004', `${brief.topic} review`)];
  const events = [
    { type: 'response', data: { id: 'r1', actionId: a.id, observedAt: at, items: [{ id: '1001', caption, author: { uniqueId: 'alice', signature: 'Based in Texas | Personal creator' }, authorStats: { followerCount: 200000 }, stats: { diggCount: 100, commentCount: 20, playCount: 1000, shareCount: 500 }, textExtra: [{ hashtagName: 'DailyRide' }, { hashtagName: 'BikeLife' }], createTime: 1750000000 }, { id: '1003', caption: `${brief.topic} repair`, author: { uniqueId: 'alice' }, stats: { diggCount: 10, commentCount: null, playCount: 100 } }] } },
    { type: 'response', data: { id: 'r2', actionId: 'DIFFERENT_ACTION', observedAt: at, items: [{ id: '1004', caption: `${brief.topic} review`, author: { uniqueId: 'mismatch', signature: 'USA' }, authorStats: { followerCount: 300000 } }] } },
    { type: 'surface', data: { action: a, view: { kind: 'search', url: a.url, observedAt: at, cards } } },
    { type: 'action_done', data: { ...a, finishedAt: at, status: 'sample_observed' } },
    { type: 'surface', data: { action: profile, view: { kind: 'profile', url: url('alice'), observedAt: at, cards: [], fields: [{ e2e: 'user-subtitle', text: 'alice' }, { e2e: 'user-bio', text: 'Based in Texas | Personal creator' }, { e2e: 'followers-count', text: '200K' }], authorCards: [{ handle: 'bob', url: url('bob'), displayName: 'Bob', reasonText: 'Suggested for you', rank: 1, containerScope: 'profile_suggested_accounts' }] } } },
    { type: 'action_done', data: { ...profile, finishedAt: at, status: 'profile_header_observed' } }
  ].map((e, i) => ({ seq: i + 1, ...e }));
  await writeFile(join(output, 'observations.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeJson(join(output, 'checkpoint.json'), { input: { actions: [a, profile], baselineHandles: [] }, actions: events.filter(e => e.type === 'action_done').map(e => e.data), store: { authors: [['forged', { followers: 500000 }]], works: [] } });
  return { root, config: { brief, taskIds: [taskId], taskRoot: root, outDir: join(root, 'out') }, caption };
}
const synthetic_topic = { id: 'test-synthetic_topic', topic: 'synthetic_topic', topicTerms: ['synthetic_topic', 'synthetic alternative'], followersMin: 100000, followersMax: 800000, country: 'US', locationTerms: ['Texas'] };

test('synthetic_topic raw pairing, unknown states, empty-work recommendations and exact interaction denominator', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const r = await processConfig(f.config), author = r.canonical.authors.find(a => a.handle === 'alice');
    assert.equal(r.summary.authors, 4);
    assert.equal(r.canonical.authors.some(a => a.handle === 'forged'), false, 'checkpoint data is not evidence');
    assert.equal(author.followerStatus, 'pass');
    assert.equal(author.assessment.topic, 'unknown');
    assert.equal(author.fitStatus, 'unknown');
    assert.equal(author.sampleStats.medianInteractionRate, 0.12, 'shares excluded; null comments excluded');
    assert.equal(author.sampleStats.usableInteractionWorks, 1);
    assert.equal(author.sampleStats.missingInteractionWorks, 1);
    assert.equal(author.sampleStats.sampleBasis, 'observed_same_author_works_not_claimed_recent');
    assert.equal(author.depth, 0);
    assert.deepEqual(r.canonical.authors.find(a => a.handle === 'bob').workIds, []);
    assert.equal(r.canonical.authors.find(a => a.handle === 'bob').depth, 1);
    assert.equal(r.canonical.authors.find(a => a.handle === 'unknown').fitStatus, 'unknown');
    assert.equal(r.canonical.authors.find(a => a.handle === 'mismatch').followers, null, 'different-action response rejected');
    assert.equal(r.clusters.semanticClustering, 'not_performed');
    assert.deepEqual(r.clusters.tags.map(t => t.tag).sort(), ['bikelife', 'dailyride']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('non-synthetic_topic brief uses its own terms and never turns no topic match into fail', async () => {
  const f = await fixture({ ...synthetic_topic, id: 'test-pottery', topic: 'pottery', topicTerms: ['pottery', 'ceramics'] });
  try {
    const r = await processConfig(f.config);
    assert.deepEqual(r.canonical.authors.find(a => a.handle === 'alice').textSignals.topicTerms, ['pottery']);
    const unknown = r.canonical.authors.find(a => a.handle === 'unknown');
    assert.deepEqual(unknown.textSignals.topicTerms, []);
    assert.equal(unknown.fitStatus, 'unknown');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('AI quotes are checked against own evidence; caption USA is not country evidence', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const r = await processConfig(f.config);
    const reviews = validateReviews(r.canonical, [
      { handle: 'alice', topic: 'pass', role: 'creator', country: 'US', expand: true, evidence: [{ workId: '1001', quote: 'synthetic_topic commute tips', field: 'caption' }, { quote: 'Based in Texas', field: 'bio' }], queries: [{ route: 'scene_query', query: 'synthetic_topic commuter Texas', evidence: { quote: 'Based in Texas', field: 'bio' } }] },
      { handle: 'unknown', topic: 'fail', role: 'brand', country: 'US', expand: true, evidence: [{ workId: '1001', quote: 'synthetic_topic commute tips' }] },
      { handle: 'mismatch', topic: 'pass', role: 'creator', country: 'US', expand: true, evidence: [{ workId: '1004', quote: 'synthetic_topic review' }], queries: [{ route: 'topic_query', query: 'made up', evidence: { quote: 'unseen quote', field: 'bio' } }] }
    ]);
    assert.equal(reviews.reviews.find(a => a.handle === 'alice').country, 'US');
    assert.equal(reviews.reviews.find(a => a.handle === 'alice').queries.length, 1);
    assert.equal(reviews.reviews.find(a => a.handle === 'unknown').topic, 'unknown');
    assert.equal(reviews.reviews.find(a => a.handle === 'unknown').expand, false);
    assert.equal(reviews.reviews.find(a => a.handle === 'mismatch').country, 'unknown');
    assert.equal(reviews.reviews.find(a => a.handle === 'mismatch').queries.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('next frontier preserves real depth, recommendation target, source quotes and cross-round dedup', async () => {
  const f = await fixture(synthetic_topic, { recommendations: false });
  try {
    const reviewFile = join(f.root, 'reviews.json');
    await writeJson(reviewFile, [{ handle: 'alice', topic: 'pass', role: 'creator', country: 'US', expand: true, evidence: [{ quote: 'Based in Texas', field: 'bio' }, { workId: '1001', quote: 'synthetic_topic commute tips' }], queries: [{ route: 'scene_query', query: 'synthetic_topic commute tips', evidence: { workId: '1001', quote: 'synthetic_topic commute tips' } }] }]);
    const r = await processConfig({ ...f.config, aiReviewFile: reviewFile });
    assert.equal(r.canonical.authors.some(a => a.handle === 'bob'), false, 'profile enrichment cannot discover next-level recommendation authors');
    assert.equal(r.canonical.authors.find(a => a.handle === 'alice').sources.some(s => s.parent === 'alice'), false, 'profile owner has no self-edge');
    assert.equal(r.canonical.authors.find(a => a.handle === 'alice').fitStatus, 'pass');
    const next = await frontierConfig({ canonicalPath: join(f.config.outDir, 'canonical.json'), outPath: join(f.root, 'next.json'), round: 2, maxSeeds: 12, maxActionsPerSeed: 5 });
    assert.equal(next.actions.length, 4);
    assert.equal(next.actions[0].route, 'profile_suggested_accounts');
    assert.equal(next.actions[0].url, url('alice'), 'recommendations inspect seed, not child profile');
    assert.ok(next.actions.every(a => a.sources.every(s => s.rootDepth === 0 && s.targetDepth === (a.route === 'profile_suggested_accounts' ? 0 : 1))));
    assert.equal(next.actions[1].sources[0].evidence.queryOrigin, 'ai_proposed_from_verified_quote_not_child_attribute');
    assert.equal(next.actions.filter(a => a.route === 'hashtag_query').length, 2, 'metadata tags compile searches; no fabricated collection links');
    for (const a of next.actions) r.canonical.actions.push({ ...a, taskId: 'task_next', startedAt: at, finishedAt: at, status: 'sample_observed' });
    await writeJson(join(f.root, 'round2.json'), r.canonical);
    const final = await frontierConfig({ canonicalPath: join(f.root, 'round2.json'), outPath: join(f.root, 'next2.json'), round: 3 });
    assert.equal(final.actions.length, 0);
    const merge = await processConfig({ ...f.config, priorCanonical: join(f.config.outDir, 'canonical.json'), outDir: join(f.root, 'merged') });
    assert.equal(merge.summary.authors, r.summary.authors);
    assert.equal(merge.summary.works, r.summary.works);
    assert.equal(merge.canonical.actions.length, 2, 'same task is not imported twice');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('configured location cues apply only to self bio and preserve unknown shipping or flag-only geography', async () => {
  const f = await fixture({ ...synthetic_topic, locationCues: [{ country: 'US', pattern: 'Located In MI|in LA|BOSTON.*📍|en los Estados Unidos|Orlando, FL', label: 'explicit personal US location' }] });
  try {
    const file = join(f.root, 'task_fixture', 'output', 'observations.jsonl');
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(file, 'utf8');
    for (const [bio, expected] of [['🇳🇵🇩🇰 in LA', 'US'], ['Located In MI', 'US'], ['BOSTON🏡📍', 'US'], ['Trabajando de Delivery en los Estados Unidos', 'US'], ['Orlando, FL', 'US'], ['Shipping to Orlando, FL', 'unknown'], ['🇺🇸 #usa English speaking', 'unknown']]) {
      await writeFile(file, original.replaceAll('Based in Texas | Personal creator', bio));
      const r = await processConfig(f.config);
      const result = validateReviews(r.canonical, [{ handle: 'alice', country: 'US', evidence: [{ quote: bio, field: 'bio' }] }]);
      assert.equal(result.reviews[0].country, expected, bio);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('repeated actions deduplicate globally while preserving both task attempts and raw provenance', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const second = join(f.root, 'task_repeat', 'output');
    await mkdir(second, { recursive: true });
    for (const name of ['checkpoint.json', 'observations.jsonl']) await copyFile(join(f.root, 'task_fixture', 'output', name), join(second, name));
    const r = await processConfig({ ...f.config, taskIds: ['task_fixture', 'task_repeat'] });
    assert.equal(r.summary.works, 4);
    assert.equal(r.summary.authors, 4);
    assert.equal(r.canonical.actions.length, 2);
    assert.ok(r.canonical.actions.every(a => a.attempts.length === 2));
    const w = r.canonical.works.find(w => w.id === '1001');
    assert.equal(new Set(w.sources.map(s => s.taskId)).size, 2);
    assert.ok(w.sources.every(s => Number.isInteger(s.evidence.rawLine)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('same platform ID under two handles is detected and unique identities do not double count', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const file = join(f.root, 'task_fixture', 'output', 'observations.jsonl');
    const events = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    events[0].data.items[0].author.id = '777';
    events[0].data.items.push({ id: '1005', caption: 'synthetic_topic renamed account', author: { id: '777', uniqueId: 'alice_new' } });
    events.find(e => e.type === 'surface').data.view.cards.push(workCard('alice_new', '1005', 'synthetic_topic renamed account'));
    await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const r = await processConfig(f.config);
    assert.equal(r.summary.authors, r.canonical.authors.length);
    assert.equal(r.summary.observedHandles, 5);
    assert.equal(r.summary.uniqueAccountIdentities, 4);
    assert.equal(r.summary.identityAliases, 1);
    assert.deepEqual(r.canonical.identityAliases[0].handles.sort(), ['alice', 'alice_new']);
    assert.equal(r.summary.identityConflicts, 0);
    events[0].data.items[1].author.id = '888';
    await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const conflict = await processConfig(f.config);
    assert.equal(conflict.summary.identityConflicts, 1);
    assert.equal(conflict.canonical.identityConflicts[0].disposition, 'unresolved_not_merged');
    assert.equal(conflict.summary.uniqueAccountIdentities, 5, 'ambiguous ID histories are not merged');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('cluster reviews label only observed tags with deduplicated evidence and keep uncovered tags unreviewed', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const reviewFile = join(f.root, 'cluster-review.json');
    await writeJson(reviewFile, [{ label: 'Commuter riding', tags: ['DailyRide', '#DAILYRIDE'], disposition: 'relevant' }]);
    const r = await processConfig({ ...f.config, clusterReviewFile: reviewFile });
    assert.equal(r.summary.semanticClustering, 'ai_labeled_observed_tag_subset');
    assert.equal(r.summary.semanticGroups, 1);
    const group = r.clusters.semanticGroups[0];
    assert.deepEqual(group.tags, ['dailyride']);
    assert.deepEqual(group.workIds, ['1001']);
    assert.deepEqual(group.authorHandles, ['alice']);
    assert.equal(group.workCount, 1);
    assert.equal(group.uniqueAccountIdentities, 1);
    assert.ok(group.sources.every(s => s.evidence.rawFile && Number.isInteger(s.evidence.rawLine)));
    assert.deepEqual(r.clusters.unreviewedTags, ['bikelife']);
    await writeJson(reviewFile, [{ label: 'Invented', tags: ['never_observed'], disposition: 'relevant' }]);
    await assert.rejects(processConfig({ ...f.config, clusterReviewFile: reviewFile }), /unobserved tag/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('enrichment baseline cannot erase discovery-new flags and prior-canonical flags stay independent', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const originalDir = join(f.root, 'task_fixture', 'output');
    const checkpoint = JSON.parse(await readFile(join(originalDir, 'checkpoint.json'), 'utf8'));
    checkpoint.input.baselineHandles = ['unknown'];
    await writeJson(join(originalDir, 'checkpoint.json'), checkpoint);
    const first = await processConfig(f.config);
    assert.equal(first.canonical.authors.find(a => a.handle === 'alice').newVsBaseline, true);
    assert.equal(first.canonical.authors.find(a => a.handle === 'unknown').newVsBaseline, false);
    const enrichmentDir = join(f.root, 'task_enrichment', 'output');
    await mkdir(enrichmentDir, { recursive: true });
    checkpoint.input.baselineHandles = first.canonical.authors.map(a => a.handle);
    await writeJson(join(enrichmentDir, 'checkpoint.json'), checkpoint);
    const events = (await readFile(join(originalDir, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    events.find(e => e.type === 'surface').data.view.cards.push(workCard('newarrival', '1005', 'synthetic_topic new arrival'));
    await writeFile(join(enrichmentDir, 'observations.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const combined = await processConfig({ ...f.config, taskIds: ['task_fixture', 'task_enrichment'], outDir: join(f.root, 'combined') });
    assert.equal(combined.canonical.authors.find(a => a.handle === 'alice').newVsBaseline, true, 'later checkpoint baseline is not the discovery baseline');
    assert.deepEqual(combined.canonical.baselineHandles, ['unknown']);
    const continued = await processConfig({ ...f.config, taskIds: ['task_enrichment'], priorCanonical: join(f.config.outDir, 'canonical.json'), outDir: join(f.root, 'continued') });
    const alice = continued.canonical.authors.find(a => a.handle === 'alice'), arrival = continued.canonical.authors.find(a => a.handle === 'newarrival');
    assert.equal(alice.newVsBaseline, true);
    assert.equal(alice.newVsPriorCanonical, false);
    assert.equal(arrival.newVsBaseline, true);
    assert.equal(arrival.newVsPriorCanonical, true);
    assert.equal(continued.canonical.authors.find(a => a.handle === 'unknown').newVsBaseline, false);
    assert.deepEqual(continued.canonical.baselineHandles, ['unknown']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('profile no-bio placeholder stays missing and cannot support a verified bio review', async () => {
  const f = await fixture(synthetic_topic);
  try {
    const file = join(f.root, 'task_fixture', 'output', 'observations.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('Based in Texas | Personal creator', '尚无个人简介。'));
    const r = await processConfig(f.config), alice = r.canonical.authors.find(a => a.handle === 'alice');
    assert.equal(alice.bio, '');
    assert.deepEqual(alice.bioEvidence, []);
    assert.ok(alice.dataGaps.includes('bio_not_observed'));
    const review = validateReviews(r.canonical, [{ handle: 'alice', topic: 'pass', role: 'creator', expand: true, evidence: [{ field: 'bio', quote: '尚无个人简介。' }] }]).reviews[0];
    assert.equal(review.validation, 'unverified_review');
    assert.equal(review.expand, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('tag allow/exclude rules block metadata and observed-link bypass while context keeps the original quote', async () => {
  const f = await fixture(synthetic_topic, { recommendations: false });
  try {
    const file = join(f.root, 'task_fixture', 'output', 'observations.jsonl');
    const events = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    events[0].data.items[0].textExtra.push({ hashtagName: 'NotSelected' });
    const search = events.find(e => e.type === 'surface');
    search.data.view.detail = { ...search.data.view.cards[0], links: ['bikelife', 'linkblocked', 'keepcollection'].map(tag => ({ url: `https://www.tiktok.com/tag/${tag}`, text: `#${tag}` })) };
    events.find(e => e.type === 'surface' && e.data.action.kind === 'profile').data.view.links = [{ url: 'https://www.tiktok.com/tag/ownerblocked', text: '#ownerblocked' }];
    await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const reviewFile = join(f.root, 'reviews.json');
    await writeJson(reviewFile, [{ handle: 'alice', topic: 'pass', role: 'creator', country: 'US', expand: true, evidence: [{ quote: 'Based in Texas', field: 'bio' }, { workId: '1001', quote: 'synthetic_topic commute tips' }], queries: [] }]);
    await processConfig({ ...f.config, aiReviewFile: reviewFile });
    const next = await frontierConfig({ canonicalPath: join(f.config.outDir, 'canonical.json'), outPath: join(f.root, 'filtered-next.json'), round: 2, maxActionsPerSeed: 30, allowedTags: ['#DailyRide', '#BikeLife', 'keepcollection'], excludedTags: ['#BIKELIFE'], tagQueryContext: 'synthetic_topic commuter' });
    const query = next.actions.find(a => a.route === 'hashtag_query');
    assert.equal(query.query, '#dailyride synthetic_topic commuter');
    assert.equal(query.sources[0].evidence.quote, 'DailyRide');
    assert.equal(query.sources[0].evidence.queryContext, 'synthetic_topic commuter');
    assert.equal(query.sources[0].evidence.taskId, 'task_fixture');
    assert.ok(query.sources[0].evidence.rawFile.endsWith('observations.jsonl'));
    assert.equal(query.sources[0].sourceWork, `${url('alice')}/video/1001`);
    assert.deepEqual(next.actions.filter(a => a.kind === 'collection').map(a => a.url), ['https://www.tiktok.com/tag/keepcollection']);
    assert.ok(next.actions.every(a => !/bikelife|notselected|linkblocked|ownerblocked/i.test(a.query ?? a.url)));
    assert.ok(next.compilation.skipped.some(s => s.tag === 'bikelife' && s.reason === 'tag_excluded_by_reviewed_batch_plan'));
    assert.ok(next.compilation.skipped.some(s => s.tag === 'notselected' && s.reason === 'tag_not_selected_in_reviewed_batch_plan'));
    assert.ok(next.compilation.skipped.some(s => s.tag === 'bikelife' && s.reason === 'observed_tag_link_excluded_by_reviewed_batch_plan'));
    assert.ok(next.compilation.skipped.some(s => s.tag === 'ownerblocked' && s.reason === 'observed_tag_link_excluded_by_reviewed_batch_plan'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
