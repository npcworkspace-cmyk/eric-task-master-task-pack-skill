import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath, resolveTaskOutputDir, loadRuntimeConfig, defaultSkillsDir, launcherCandidates } from './runtime/environment.mjs';
import { VERSION, processConfig, validateReviews, targetCountryStatus, writeJson } from './runtime/process.mjs';
import { frontierConfig, loadPolicySnapshot } from './runtime/frontier.mjs';
import { installSkills, SKILL_NAMES } from '../../tiktok-discovery-retrospective/scripts/deployment.mjs';

const isolatedPolicyTests = new WeakSet();
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'tk-portable 空格-'));
  if (!isolatedPolicyTests.has(t)) {
    isolatedPolicyTests.add(t);
    const previousPolicyState = process.env.TIKTOK_DISCOVERY_STATE_DIR;
    process.env.TIKTOK_DISCOVERY_STATE_DIR = join(root, 'isolated-policy-state');
    t.after(() => { if (previousPolicyState === undefined) delete process.env.TIKTOK_DISCOVERY_STATE_DIR; else process.env.TIKTOK_DISCOVERY_STATE_DIR = previousPolicyState; });
  }
  t.after(async () => { const absolute = resolve(root); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && /tk-portable 空格-/.test(absolute)); await rm(absolute, { recursive: true, force: true }); });
  return root;
}
test('path matrix handles spaces and non-ASCII without assuming a Windows task directory', () => {
  assert.equal(resolveConfigPath('./批次/raw', 'C:\\Agents 空间\\Run', 'win32', 'C:\\Users\\example'), 'C:\\Agents 空间\\Run\\批次\\raw');
  assert.equal(resolveConfigPath('./批次/raw', '/Users/example/Agent Work', 'darwin', '/Users/example'), '/Users/example/Agent Work/批次/raw');
  assert.equal(resolveConfigPath('./批次/raw', '/home/example/Agent Work', 'linux', '/home/example'), '/home/example/Agent Work/批次/raw');
  assert.equal(resolveConfigPath('/Users/example/Agent Work/批次', '/Users/example', 'darwin'), '/Users/example/Agent Work/批次');
  assert.equal(resolveConfigPath('/home/example/Agent Work/批次', '/home/example', 'linux'), '/home/example/Agent Work/批次');
  assert.throws(() => resolveConfigPath('C:\\Users\\old\\task', '/home/current', 'linux'), /FOREIGN_ABSOLUTE_PATH/); // Synthetic foreign-path fixture.
  assert.throws(() => resolveConfigPath('/home/old/task', 'C:\\Current', 'win32'), /FOREIGN_ABSOLUTE_PATH/);
  assert.equal(defaultSkillsDir({}, '/Users/new', 'darwin'), '/Users/new/.codex/skills');
  assert.equal(defaultSkillsDir({ CODEX_HOME: 'D:\\Example 空间' }, 'C:\\Users\\new', 'win32'), 'D:\\Example 空间\\skills');
  assert.equal(defaultSkillsDir({}, '/home/new', 'linux'), '/home/new/.codex/skills');
  assert.equal(launcherCandidates({ platform: 'darwin', env: {} }).at(-1).path, '/usr/local/bin/taskmaster');
  assert.equal(launcherCandidates({ platform: 'linux', env: {} }).at(-1).path, '/usr/bin/taskmaster');
  assert.deepEqual(launcherCandidates({ explicit: '/custom/tool', platform: 'linux', env: { TASKMASTER_CLI: '/ignored' } }), [{ path: '/custom/tool', source: 'config.taskmasterPath' }]);
});
test('config paths are config-relative and task outputs require explicit provenance', async t => {
  const root = await sandbox(t), configPath = join(root, 'config.json');
  await writeJson(configPath, { outDir: './结果', taskRoot: './ignored', taskOutputs: { task_one: './已导出/output' } });
  const config = await loadRuntimeConfig(configPath);
  assert.equal(config.outDir, join(root, '结果'));
  assert.equal(resolveTaskOutputDir(config, 'task_one'), join(root, '已导出', 'output'));
  assert.throws(() => resolveTaskOutputDir({}, 'task_one'), /TASK_OUTPUT_DIRECTORY_REQUIRED/);
  assert.throws(() => resolveTaskOutputDir(config, 'task_..\\escape'), /Invalid task ID/);
});
test('three Skill install preserves unrelated files, backs up changes and is idempotent', async t => {
  const root = await sandbox(t), source = join(root, 'release'), target = join(root, 'Agent 技能');
  for (const name of SKILL_NAMES) { await mkdir(join(source, 'skills', name), { recursive: true }); await writeFile(join(source, 'skills', name, 'SKILL.md'), `name: ${name}\n`); }
  await mkdir(join(target, 'unrelated'), { recursive: true }); await writeFile(join(target, 'unrelated', 'keep.txt'), 'preserved');
  const first = await installSkills({ sourceRoot: source, skillsDir: target });
  assert.equal(first.status, 'installed_verified'); assert.equal(first.skills.length, 3);
  const second = await installSkills({ sourceRoot: source, skillsDir: target });
  assert.ok(second.skills.every(s => s.action === 'unchanged')); assert.equal(second.backups.length, 0);
  await writeFile(join(source, 'skills', SKILL_NAMES[0], 'SKILL.md'), 'updated\n');
  const third = await installSkills({ sourceRoot: source, skillsDir: target });
  assert.equal(third.backups.length, 1);
  assert.equal(await readFile(join(third.backups[0].path, 'SKILL.md'), 'utf8'), `name: ${SKILL_NAMES[0]}\n`);
  assert.equal(await readFile(join(target, 'unrelated', 'keep.txt'), 'utf8'), 'preserved');
  assert.equal((await installSkills({ sourceRoot: source, skillsDir: join(root, 'dry'), dryRun: true })).status, 'plan_only');
});

test('multi-country DE/JP target accepts evidenced countries and rejects unsupported inference', async t => {
  const root = await sandbox(t), output = join(root, 'mapped 输出'); await mkdir(output);
  const bios = { german: 'Based in Germany | Pottery creator', japanese: 'Based in Japan | Pottery creator', american: 'Based in USA | Pottery creator', unknown: 'English pottery tutorials | ships to Japan' };
  const actions = Object.keys(bios).map(handle => ({ id: handle, kind: 'profile', route: 'profile_enrichment', seed: handle, url: `https://www.tiktok.com/@${handle}`, sources: [{ seed: handle, targetDepth: 0 }], startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:00Z', status: 'profile_header_observed' }));
  const events = actions.map((action, i) => ({ seq: i + 1, type: 'surface', data: { action, view: { kind: 'profile', url: action.url, observedAt: action.startedAt, cards: [], fields: [{ e2e: 'user-subtitle', text: action.seed }, { e2e: 'followers-count', text: '200K' }, { e2e: 'user-bio', text: bios[action.seed] }] } } }));
  await writeFile(join(output, 'observations.jsonl'), events.map(x => JSON.stringify(x)).join('\n') + '\n');
  await writeJson(join(output, 'checkpoint.json'), { input: { actions }, actions });
  const brief = { id: 'portable-geography', topic: 'pottery', topicTerms: ['pottery'], countries: ['DE', 'JP'], country: 'DE', followersMin: 100000, followersMax: 800000, locationTermsByCountry: { DE: ['Germany'], JP: ['Japan'], US: ['USA'] } };
  const reviews = Object.entries(bios).map(([handle, bio]) => ({ handle, country: ({ german: 'DE', japanese: 'JP', american: 'US', unknown: 'JP' })[handle], topic: 'pass', role: 'creator', expand: true, evidence: [{ field: 'bio', quote: bio }] }));
  const reviewFile = join(root, 'reviews.json'); await writeJson(reviewFile, reviews);
  const config = { brief, taskIds: ['task_geo'], taskOutputs: { task_geo: output }, outDir: join(root, 'result'), aiReviewFile: reviewFile };
  const result = await processConfig(config), map = new Map(result.canonical.authors.map(a => [a.handle, a]));
  assert.equal(map.get('german').fitStatus, 'pass'); assert.equal(map.get('japanese').fitStatus, 'pass');
  assert.equal(map.get('american').fitStatus, 'fail'); assert.equal(map.get('unknown').assessment.country, 'unknown');
  assert.equal(map.get('unknown').assessment.targetCountryStatus, 'unknown'); assert.equal(map.get('unknown').fitStatus, 'unknown');
  assert.equal(map.get('unknown').locationEvidence.length, 0);
  const wrongCountryQuote = validateReviews(result.canonical, [{ ...reviews[0], country: 'JP' }]).reviews[0];
  assert.equal(wrongCountryQuote.country, 'unknown');
  assert.equal(targetCountryStatus('non_US', { country: 'US' }), 'fail');
  assert.equal(targetCountryStatus('non_US', { countries: ['DE', 'JP'] }), 'unknown');
  assert.equal(targetCountryStatus('JP', { countries: ['US', 'JP'] }), 'pass');
  await assert.rejects(processConfig({ ...config, brief: { ...brief, locationTerms: ['Japan'] }, outDir: join(root, 'bad') }), /locationTerms requires one target/);
});

test('validated retrospective policy orders all route candidates without changing budgets or losing parent sources', async t => {
  const root = await sandbox(t), quote = { field: 'bio', quote: 'Pottery tutorials and product reviews' };
  const authors = ['seedone', 'seedtwo'].map(handle => ({ handle, url: `https://www.tiktok.com/@${handle}`, depth: 0, bioEvidence: [{ text: quote.quote, evidence: { taskId: 'task_synthetic' } }], locationEvidence: [], workIds: [], collectionLinks: [] }));
  const query = (route, text) => ({ route, query: text, evidence: [quote] });
  const canonical = { schemaVersion: VERSION, brief: { id: 'synthetic-priority', country: 'DE', followersMin: 100000, followersMax: 800000 }, authors, works: [], actions: [], aiReviews: [
    { handle: 'seedone', topic: 'pass', role: 'creator', country: 'unknown', expand: true, evidence: [quote], queries: [query('scene_query', 'pottery shared routine'), query('brand_query', 'pottery product')] },
    { handle: 'seedtwo', topic: 'pass', role: 'creator', country: 'unknown', expand: true, evidence: [quote], queries: [query('scene_query', 'pottery studio routine'), query('brand_query', 'pottery shared routine')] }
  ] };
  const canonicalPath = join(root, 'canonical.json'); await writeJson(canonicalPath, canonical);
  const config = { canonicalPath, outPath: join(root, 'next.json'), round: 2, maxSeeds: 2, maxActionsPerSeed: 1, limits: { maxScrolls: 2 } };
  const baseline = await frontierConfig(config);
  assert.ok(baseline.actions.every(a => a.route === 'profile_suggested_accounts'));
  const policy = { schemaVersion: 1, version: 'test-v1', scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: { actionDedup: true, routePriority: { hashtag: 1, identity_location: 1, scenario: 2, brand_product: 1, profile_recommendation: 1 }, referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } };
  const policyFile = join(root, 'policy.json'); await writeJson(policyFile, policy);
  const next = await frontierConfig({ ...config, policyFile });
  assert.equal(next.actions.length, 2); assert.ok(next.actions.every(a => a.route === 'scene_query'));
  assert.deepEqual(new Set(next.actions.find(a => a.query === 'pottery shared routine').sources.map(s => s.seed)), new Set(['seedone', 'seedtwo']));
  assert.equal(next.compilation.actionLimitPerSeed, 1); assert.equal(next.limits.maxScrolls, 2);
  assert.equal(next.minFollowers, 100000); assert.equal(next.maxFollowers, 800000);
  assert.equal(next.adoptedPolicy.version, 'test-v1'); assert.match(next.adoptedPolicy.sha256, /^[a-f0-9]{64}$/);
  await writeJson(policyFile, { ...policy, scope: { ...policy.scope, stages: ['seed'] } });
  const wrongScope = await frontierConfig({ ...config, policyFile });
  assert.equal(wrongScope.adoptedPolicy.version, 'default'); assert.ok(wrongScope.actions.every(a => a.route === 'profile_suggested_accounts'));
  await writeJson(policyFile, { ...policy, strategy: { ...policy.strategy, maxScrolls: 50 } });
  await assert.rejects(frontierConfig({ ...config, policyFile }), /strategy accepts exactly/);
});

async function oneCountryFixture(t, countryMeaning, observedCountry = 'US') {
  const root = await sandbox(t), output = join(root, 'observed'); await mkdir(output);
  const bio = `Based in ${observedCountry === 'US' ? 'USA' : 'Germany'} | Pottery creator`, handle = 'samplecreator';
  const action = { id: 'profile', kind: 'profile', route: 'profile_enrichment', seed: handle, url: `https://www.tiktok.com/@${handle}`, sources: [{ seed: handle, targetDepth: 0 }], startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:00Z', status: 'profile_header_observed' };
  await writeFile(join(output, 'observations.jsonl'), JSON.stringify({ seq: 1, type: 'surface', data: { action, view: { kind: 'profile', url: action.url, observedAt: action.startedAt, cards: [], fields: [{ e2e: 'user-subtitle', text: handle }, { e2e: 'followers-count', text: '200K' }, { e2e: 'user-bio', text: bio }] } } }) + '\n');
  await writeJson(join(output, 'checkpoint.json'), { input: { actions: [action] }, actions: [action] });
  const reviewFile = join(root, 'review.json');
  await writeJson(reviewFile, [{ handle, country: observedCountry, marketCountryStatus: 'pass', topic: 'pass', role: 'creator', expand: true, evidence: [{ field: 'bio', quote: bio }] }]);
  const brief = { id: 'country-meaning-fixture', topic: 'pottery', topicTerms: ['pottery'], countries: ['US'], country: 'US', countryMeaning, followersMin: 100000, followersMax: 800000, locationTermsByCountry: { US: ['USA'], DE: ['Germany'] } };
  return processConfig({ brief, taskIds: ['task_location'], taskOutputs: { task_location: output }, aiReviewFile: reviewFile, outDir: join(root, 'result') });
}
test('US self bio does not prove US promotion-market audience and unknown geography still expands', async t => {
  const result = await oneCountryFixture(t, 'promotion_market'), author = result.canonical.authors[0];
  assert.equal(author.assessment.country, 'US'); assert.equal(author.assessment.creatorLocationMatch, 'pass');
  assert.equal(author.assessment.targetCountryStatusBasis, 'creator_location_only');
  assert.equal(author.assessment.marketCountryStatus, 'unknown', 'reviewer flag cannot replace missing audience-country evidence');
  assert.equal(author.assessment.qualificationCountryStatus, 'unknown'); assert.equal(author.fitStatus, 'unknown');
  assert.equal(result.summary.fitPass, 0); assert.equal(result.seeds.length, 1);
  assert.ok(result.queue[0].pending.includes('marketCountryStatus'));
  const elsewhere = (await oneCountryFixture(t, 'promotion_market', 'DE')).canonical.authors[0];
  assert.equal(elsewhere.assessment.creatorLocationMatch, 'fail'); assert.equal(elsewhere.fitStatus, 'unknown', 'creator location outside market is not proof of audience-country mismatch');
});
test('explicit creator_location can pass the basic location condition without claiming audience geography', async t => {
  const result = await oneCountryFixture(t, 'creator_location'), author = result.canonical.authors[0];
  assert.equal(author.assessment.countryMeaningSource, 'explicit_brief');
  assert.equal(author.assessment.qualificationCountryStatus, 'pass'); assert.equal(author.fitStatus, 'pass');
  assert.equal(author.assessment.marketCountryStatus, 'unknown'); assert.equal(result.summary.fullyCommerciallyQualified, 0);
});

test('missing follower bounds fail instead of silently using a prior campaign range', async t => {
  const root = await sandbox(t), brief = { id: 'required-bounds' };
  await assert.rejects(processConfig({ brief, taskIds: [], outDir: join(root, 'processed') }), /FOLLOWER_BOUNDS_REQUIRED/);
  const canonicalPath = join(root, 'canonical.json');
  await writeJson(canonicalPath, { schemaVersion: VERSION, brief, authors: [], works: [], actions: [], aiReviews: [] });
  await assert.rejects(frontierConfig({ canonicalPath, outPath: join(root, 'next.json'), round: 1 }), /FOLLOWER_BOUNDS_REQUIRED/);
});
test('caller controlFile and notBefore survive configuration resolution and both generated inputs', async t => {
  const root = await sandbox(t), notBefore = '2030-01-01T09:00:00+08:00';
  const configFile = join(root, 'process-config.json');
  await writeJson(configFile, { brief: { id: 'control-test', followersMin: 5000, followersMax: 150000 }, taskIds: [], outDir: './processed', controlFile: './job control.json', notBefore });
  const config = await loadRuntimeConfig(configFile), result = await processConfig(config);
  assert.equal(result.enrich.controlFile, join(root, 'job control.json')); assert.equal(result.enrich.notBefore, notBefore);
  const frontierFile = join(root, 'frontier-config.json');
  await writeJson(frontierFile, { canonicalPath: './processed/canonical.json', outPath: './next.json', round: 1, controlFile: './job control.json', notBefore });
  const next = await frontierConfig(await loadRuntimeConfig(frontierFile));
  assert.equal(next.controlFile, join(root, 'job control.json')); assert.equal(next.notBefore, notBefore);
  assert.equal(next.minFollowers, 5000); assert.equal(next.maxFollowers, 150000);
});
test('policy publication interleaved after one read cannot mix a version with another file hash', async t => {
  const root = await sandbox(t), file = join(root, 'current.json');
  const policy = { schemaVersion: 1, version: 'snapshot-v1', scope: { platform: 'tiktok', stages: ['expansion'] }, strategy: { actionDedup: true, routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 }, referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } };
  await writeJson(file, policy); const original = await readFile(file); let calls = 0;
  const snapshot = await loadPolicySnapshot(file, async path => {
    calls++; const bytes = await readFile(path);
    await writeJson(join(root, 'next-policy.json'), { ...policy, version: 'snapshot-v2' });
    await rename(join(root, 'next-policy.json'), file);
    return bytes;
  });
  assert.equal(calls, 1); assert.equal(snapshot.policy.version, 'snapshot-v1');
  assert.equal(snapshot.metadata.sha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 'snapshot-v2');
});

test('next round automatically adopts a published default policy from isolated machine state', async t => {
  const root = await sandbox(t), stateDir = process.env.TIKTOK_DISCOVERY_STATE_DIR;
  const canonicalPath = join(root, 'canonical.json'), outPath = join(root, 'next.json');
  await writeJson(canonicalPath, { schemaVersion: VERSION, brief: { id: 'default-policy', followersMin: 5000, followersMax: 150000 }, authors: [], works: [], actions: [], aiReviews: [] });
  const config = { canonicalPath, outPath, round: 1 };
  const missing = await frontierConfig(config);
  assert.equal(missing.adoptedPolicy.version, 'default'); assert.equal(missing.compilation.policySource, null);
  const policy = { schemaVersion: 1, version: 'published-v1', scope: { platform: 'tiktok', stages: ['expansion'] }, strategy: { actionDedup: true, routePriority: { hashtag: 1, identity_location: 1, scenario: 2, brand_product: 1, profile_recommendation: 1 }, referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } };
  const current = join(stateDir, 'policies', 'current.json'); await writeJson(current, policy);
  const adopted = await frontierConfig(config);
  assert.equal(adopted.adoptedPolicy.version, 'published-v1'); assert.equal(adopted.compilation.routePriority.scenario, 2);
  assert.equal(adopted.compilation.policySource, current);
  assert.equal(adopted.adoptedPolicy.sha256, createHash('sha256').update(await readFile(current)).digest('hex'));
  await assert.rejects(frontierConfig({ ...config, policyFile: join(root, 'explicit-missing.json') }), /ENOENT/);
});
