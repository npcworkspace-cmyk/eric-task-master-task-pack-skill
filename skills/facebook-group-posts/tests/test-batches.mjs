import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runSupervisor, requestStop, readJson, atomicJson, parseCliOutput, resolveCliCommand, readCheckpoint, validateHandoff } from '../scripts/batches.mjs';
import { groupUrl, timeValue, prepare, resolveLauncher, validateConfig, SKILL_ROOT } from '../scripts/prepare.mjs';

const testRoot = os.tmpdir();
const fixtureRoot = await fs.mkdtemp(path.join(testRoot, 'fb-batch-tests-'));
let fixtureIndex = 0;
const manager = { service: 'eric-task-master', pid: 23456, version: 'synthetic-1' };

async function fixture() {
  const workspace = path.join(fixtureRoot, `fixture-${++fixtureIndex}`); await fs.mkdir(workspace);
  const launcher = path.join(workspace, 'fake-cli.mjs'), modulePath = path.join(workspace, 'fake-collector.mjs');
  await fs.writeFile(launcher, '// synthetic CLI; never executed\n'); await fs.writeFile(modulePath, '// synthetic collector; never executed\n');
  const config = validateConfig({ schemaVersion: 1, groupUrl: 'https://www.facebook.com/groups/synthetic.group/', startTime: '2025-02-01T00:00:00-05:00', endTime: '2025-03-01T13:04:00-05:00', workspace, launcher, modulePath, maxPages: 2, boundaryPages: 5, paceMs: 500, pollMs: 1, managerUrl: 'http://127.0.0.1:19946', profile: '测试 Profile & "literal" %PATH%' });
  const configPath = path.join(workspace, 'config.json'); await atomicJson(configPath, config);
  return { config, configPath };
}
function scope(input) {
  return { schema_version: 3, group_url: input.groupUrl, group_id: '123456789012345', start: input.startTime, end: input.endTime, sorting_setting: 'CHRONOLOGICAL', page_size: 3, required_boundary_pages: input.boundaryPages, operation: 'GroupsCometFeedRegularStoriesPaginationQuery' };
}
async function outputBatch(input, reason = 'page_limit', corrupt = false) {
  const before = input.resumeCheckpointPath ? await readJson(input.resumeCheckpointPath) : null;
  const start = before?.pages || 0, pages = start + input.maxPages;
  const inherited = before?.history_files || [], historyFile = path.join(input.outputDir, 'synthetic-history.jsonl');
  const rows = [], common = scope(input);
  let cursor = before?.cursor || 'synthetic-cursor-0';
  if (!before) rows.push({ ...common, page: 0, request_cursor: null, next_cursor: cursor, status: 'ok', stream_final: true, has_next: true });
  for (let page = start + 1; page <= pages; page++) {
    const next = `synthetic-cursor-${page}`;
    rows.push({ ...common, page, request_cursor: corrupt && page === start + 1 ? 'WRONG' : cursor, next_cursor: next, status: 'ok', stream_final: true, has_next: true, posts: [] }); cursor = next;
  }
  await fs.writeFile(historyFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await atomicJson(path.join(input.outputDir, 'posts.json'), { metadata: { ...common, feed_pages: pages, in_range_count: pages * 3, current_page_earliest: '2025-02-10T09:20:00Z' }, posts: [] });
  await atomicJson(path.join(input.outputDir, 'pagination-checkpoint.json'), { ...common, pages, next_page: pages + 1, cursor, history_files: [...inherited, historyFile], source_file: path.join(input.outputDir, 'posts.json') });
  await atomicJson(path.join(input.outputDir, 'pagination-state.json'), { ...common, page: pages, status: reason, has_next: true });
  return { reason, pages };
}
function fakeDependencies(options = {}) {
  const calls = [], inputs = [], tasks = new Map();
  return { calls, inputs, deps: {
    health: async () => options.health ? options.health(calls) : { ...manager },
    emit: () => {}, sleep: async () => {},
    cli: async args => {
      calls.push([...args]);
      if (args[0] === 'panel') return { ok: true, url: 'http://127.0.0.1:19946/dashboard' };
      if (args[0] === 'run') {
        const input = await readJson(args[args.indexOf('--input') + 1].slice(1)); inputs.push(input);
        if (options.uncertain) throw new Error('LAUNCH_OUTCOME_UNCERTAIN');
        const id = `task_synthetic_${inputs.length}`; tasks.set(id, input);
        if (options.afterRun) await options.afterRun(input, inputs.length);
        return { ok: true, task: { id, state: 'running', ...(options.omitCreatedProfile ? {} : { profileId: options.changedProfile && inputs.length > 1 ? 'profile_changed' : 'profile_synthetic' }) } };
      }
      if (args[0] === 'stop') return { ok: true, task: { id: args[1], state: 'stopped' } };
      if (args[0] === 'status') {
        const input = tasks.get(args[1]);
        const profileId = options.changedProfile && inputs.length > 1 ? 'profile_changed' : 'profile_synthetic';
        if (options.taskState) return { task: { id: args[1], state: options.taskState, profileId } };
        const reason = options.reason || (inputs.length === 1 ? 'page_limit' : 'date_boundary_needs_review');
        return { task: { id: args[1], state: 'finished', profileId, result: await outputBatch(input, reason, options.corrupt) } };
      }
      throw new Error('UNEXPECTED_FAKE_CLI_CALL');
    },
  } };
}

test('2-page batches inherit the exact checkpoint and all journal paths; stop for boundary review', async () => {
  const { configPath, config } = await fixture(), fake = fakeDependencies();
  const state = await runSupervisor(configPath, fake.deps);
  assert.equal(fake.inputs.length, 2);
  assert.equal(fake.inputs[0].groupId, undefined);
  assert.equal(fake.inputs[1].groupId, '123456789012345');
  const checkpoint = await readJson(fake.inputs[1].resumeCheckpointPath);
  assert.equal(checkpoint.pages, 2); assert.equal(checkpoint.cursor, 'synthetic-cursor-2');
  assert.equal(fake.inputs[1].startTime, config.startTime); assert.equal(fake.inputs[1].endTime, config.endTime);
  assert.equal(state.batches[1].start_page, 3);
  assert.equal(state.stop_reason, 'TASK_RESULT_date_boundary_needs_review');
  assert.equal(state.phase, 'finished');
  assert.equal(fake.calls.filter(call => call[0] === 'run')[0].at(-1), config.profile);
  const after = await readJson(path.join(fake.inputs[1].outputDir, 'pagination-checkpoint.json'));
  assert.deepEqual(after.history_files.slice(0, 1), checkpoint.history_files);
});

test('feed_end and failed tasks never start a second batch', async () => {
  for (const options of [{ reason: 'feed_end' }, { taskState: 'failed' }, { taskState: 'waiting_user' }, { reason: 'http_error' }]) {
    const { configPath } = await fixture(), fake = fakeDependencies(options);
    const state = await runSupervisor(configPath, fake.deps);
    assert.equal(fake.inputs.length, 1); assert.ok(state.stop_reason);
  }
});

test('journal mismatch fails closed without a repeated launch', async () => {
  const { configPath } = await fixture(), fake = fakeDependencies({ corrupt: true });
  await assert.rejects(runSupervisor(configPath, fake.deps), /JOURNAL_CURSOR_CHAIN_BROKEN/);
  assert.equal(fake.inputs.length, 1);
});

test('uncertain launch remains uncertain on restart and is never repeated', async () => {
  const { configPath } = await fixture(), fake = fakeDependencies({ uncertain: true });
  await assert.rejects(runSupervisor(configPath, fake.deps), /LAUNCH_OUTCOME_UNCERTAIN/);
  await assert.rejects(runSupervisor(configPath, fake.deps), /LAUNCH_OUTCOME_UNCERTAIN_REQUIRES_REVIEW/);
  assert.equal(fake.inputs.length, 1);
});

test('stop request arriving while launch returns stops the newly identified task', async () => {
  const { configPath, config } = await fixture();
  const fake = fakeDependencies({ afterRun: async () => atomicJson(path.join(config.workspace, 'stop-request.json'), { reason: 'USER_STOP' }) });
  const state = await runSupervisor(configPath, fake.deps);
  assert.equal(fake.inputs.length, 1); assert.equal(fake.calls.filter(call => call[0] === 'stop').length, 1);
  assert.equal(state.stop_reason, 'USER_STOP'); assert.equal(state.active_stop, 'requested');
});

test('standalone stop command stops active task and leaves artifacts', async () => {
  const { configPath, config } = await fixture(), calls = [];
  await atomicJson(path.join(config.workspace, 'supervisor-status.json'), { manager, task_id: 'task_synthetic_active', task_state: 'running', phase: 'monitoring' });
  await fs.writeFile(path.join(config.workspace, 'keep-checkpoint.txt'), 'preserve');
  const result = await requestStop(configPath, { health: async () => manager, cli: async args => { calls.push(args); return { ok: true }; } });
  assert.equal(result.active_stop, 'requested'); assert.deepEqual(calls[0], ['stop', 'task_synthetic_active', '--json']);
  assert.equal(await fs.readFile(path.join(config.workspace, 'keep-checkpoint.txt'), 'utf8'), 'preserve');
  assert.equal((await readJson(path.join(config.workspace, 'stop-request.json'))).reason, 'USER_STOP');
});

test('manager instance change stops scheduling without starting or restarting Manager', async () => {
  const { configPath } = await fixture();
  const fake = fakeDependencies({ health: calls => calls.some(call => call[0] === 'status') ? { ...manager, pid: 99999 } : { ...manager } });
  await assert.rejects(runSupervisor(configPath, fake.deps), /MANAGER_INSTANCE_CHANGED/);
  assert.equal(fake.inputs.length, 1);
  assert.equal(fake.calls.filter(call => call[0] === 'panel').length, 1);
});

test('resolved Profile is retained and a changed second-batch Profile is stopped before merge', async () => {
  const { configPath, config } = await fixture(), fake = fakeDependencies({ changedProfile: true });
  await assert.rejects(runSupervisor(configPath, fake.deps), /TASK_PROFILE_CHANGED/);
  const state = await readJson(path.join(config.workspace, 'supervisor-status.json'));
  assert.equal(state.resolvedProfileId, 'profile_synthetic'); assert.equal(state.phase, 'requires_review');
  assert.equal(state.profile_mismatch, true); assert.equal(state.active_stop, 'requested');
  assert.equal(fake.calls.filter(call => call[0] === 'stop').at(-1)[1], 'task_synthetic_2');
  assert.equal(state.latest_checkpoint_pages, 2);
});

test('Profile can be discovered from status when create response omits it', async () => {
  const { configPath } = await fixture(), fake = fakeDependencies({ reason: 'feed_end', omitCreatedProfile: true });
  const state = await runSupervisor(configPath, fake.deps);
  assert.equal(state.resolvedProfileId, 'profile_synthetic');
});

test('every terminal supervisor run creates a task-local evolution review obligation', async () => {
  const { config, configPath } = await fixture(), fake = fakeDependencies({ reason: 'feed_end' });
  const state = await runSupervisor(configPath, fake.deps);
  const marker = await readJson(path.join(config.workspace, 'evolution-review-status.json'));
  assert.equal(state.phase, 'finished');
  assert.equal(marker.status, 'pending');
  assert.equal(marker.review_required, true);
  assert.equal(marker.terminal.phase, 'finished');
  assert.match(marker.required_action, /evolve\.py review/);
});

test('configuration change cannot quietly reuse an old run', async () => {
  const { configPath } = await fixture(), fake = fakeDependencies({ reason: 'feed_end' });
  await runSupervisor(configPath, fake.deps);
  const config = await readJson(configPath); config.startTime = '2025-02-02T00:00:00-05:00'; await atomicJson(configPath, config);
  await assert.rejects(runSupervisor(configPath, fake.deps), /CONFIG_CHANGED_REQUIRES_NEW_WORKSPACE/);
  assert.equal(fake.inputs.length, 1);
});

test('Task Master launcher resolves from explicit environment and PATH without a fixed install location', async () => {
  const folder = path.join(fixtureRoot, `launcher-${++fixtureIndex}`); await fs.mkdir(folder);
  const filename = process.platform === 'win32' ? 'taskmaster.cmd' : 'taskmaster';
  const launcher = path.join(folder, filename); await fs.writeFile(launcher, 'synthetic launcher\n');
  assert.equal(await resolveLauncher(undefined, process.platform, { ERIC_TASK_MASTER_CLI: launcher, PATH: '' }), path.resolve(launcher));
  assert.equal(await resolveLauncher(undefined, process.platform, { PATH: folder }), path.resolve(launcher));
  await assert.rejects(resolveLauncher(undefined, process.platform, { PATH: path.join(folder, 'missing') }), /INSTALLED_LAUNCHER_NOT_FOUND/);
});

test('prepare requires every task to provide its own page budget', async () => {
  const { config } = await fixture(), workspace = path.join(fixtureRoot, `missing-budget-${++fixtureIndex}`);
  await assert.rejects(
    prepare({ url: config.groupUrl, start: config.startTime, end: config.endTime, workspace, launcher: config.launcher }),
    /INTEGER_OUT_OF_RANGE/,
  );
  await assert.rejects(fs.readFile(path.join(workspace, 'config.json')), { code: 'ENOENT' });
});

test('prepare preserves explicit timezone and Unicode; does not overwrite config or invoke CLI', async () => {
  const { config } = await fixture(), workspace = path.join(fixtureRoot, '准备 workspace & %literal%');
  const result = await prepare({ url: 'https://m.facebook.com/groups/synthetic-another.fixture/?tracking=drop', start: '2025-01-01T00:00:00+05:30', end: '2025-02-01T00:00:00+05:30', workspace, launcher: config.launcher, profile: '测试 Profile', 'max-pages': '7' });
  assert.equal(result.config.startTime, '2025-01-01T00:00:00+05:30'); assert.equal(result.config.profile, '测试 Profile');
  assert.equal(result.config.groupUrl, 'https://www.facebook.com/groups/synthetic-another.fixture/');
  assert.equal(result.config.maxPages, 7);
  const originalModule = await fs.readFile(path.join(SKILL_ROOT, 'scripts', 'collect.mjs'));
  assert.deepEqual(await fs.readFile(result.config.modulePath), originalModule);
  assert.equal(result.config.moduleSha256, createHash('sha256').update(originalModule).digest('hex'));
  assert.equal(result.config.modulePath, path.join(workspace, 'executor', 'collect.mjs'));
  const originalConfig = await fs.readFile(result.configPath);
  await assert.rejects(prepare({ url: result.config.groupUrl, start: result.config.startTime, end: result.config.endTime, workspace, launcher: config.launcher, 'max-pages': '7' }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(result.configPath), originalConfig);
  assert.deepEqual(await fs.readFile(result.config.modulePath), originalModule);
});

test('upgrading a candidate skill source leaves an existing task executor and config pinned', async () => {
  const { config } = await fixture(), candidateRoot = path.join(fixtureRoot, 'candidate-skill');
  await fs.mkdir(path.join(candidateRoot, 'scripts'), { recursive: true });
  for (const name of ['prepare.mjs', 'collect.mjs']) await fs.copyFile(path.join(SKILL_ROOT, 'scripts', name), path.join(candidateRoot, 'scripts', name));
  const candidate = await import(pathToFileURL(path.join(candidateRoot, 'scripts', 'prepare.mjs')).href);
  const options = { url: config.groupUrl, start: config.startTime, end: config.endTime, workspace: path.join(fixtureRoot, 'pinned-task'), launcher: config.launcher, 'max-pages': '3' };
  const prepared = await candidate.prepare(options), taskConfigBytes = await fs.readFile(prepared.configPath), taskModuleBytes = await fs.readFile(prepared.config.modulePath);
  await fs.appendFile(path.join(candidateRoot, 'scripts', 'collect.mjs'), '\n// Synthetic later source revision.\n');
  assert.notDeepEqual(await fs.readFile(path.join(candidateRoot, 'scripts', 'collect.mjs')), taskModuleBytes);
  assert.deepEqual(await fs.readFile(prepared.configPath), taskConfigBytes);
  assert.deepEqual(await fs.readFile(prepared.config.modulePath), taskModuleBytes);
  const newer = await candidate.prepare({ ...options, workspace: path.join(fixtureRoot, 'later-task') });
  assert.notEqual(newer.config.moduleSha256, prepared.config.moduleSha256);
  assert.deepEqual(await fs.readFile(prepared.config.modulePath), taskModuleBytes);
});

test('prepare refuses a preexisting executor even when config is absent', async () => {
  const { config } = await fixture(), workspace = path.join(fixtureRoot, 'executor-collision'), modulePath = path.join(workspace, 'executor', 'collect.mjs');
  await fs.mkdir(path.dirname(modulePath), { recursive: true }); await fs.writeFile(modulePath, '// Preserve this existing executor.\n');
  await assert.rejects(prepare({ url: config.groupUrl, start: config.startTime, end: config.endTime, workspace, launcher: config.launcher, 'max-pages': '3' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(modulePath, 'utf8'), '// Preserve this existing executor.\n');
  await assert.rejects(fs.readFile(path.join(workspace, 'config.json')), { code: 'ENOENT' });
});

test('tampered pinned executor blocks the first task and stops subsequent scheduling before another launch', async () => {
  for (const changeAfterFirst of [false, true]) {
    const { config, configPath } = await fixture();
    config.moduleSha256 = createHash('sha256').update(await fs.readFile(config.modulePath)).digest('hex');
    await atomicJson(configPath, config);
    if (!changeAfterFirst) await fs.appendFile(config.modulePath, '// Synthetic tamper before first launch.\n');
    const fake = fakeDependencies(changeAfterFirst ? { afterRun: async () => fs.appendFile(config.modulePath, '// Synthetic tamper before next launch.\n') } : {});
    await assert.rejects(runSupervisor(configPath, fake.deps), /MODULE_SNAPSHOT_CHANGED/);
    assert.equal(fake.inputs.length, changeAfterFirst ? 1 : 0);
    const state = await readJson(path.join(config.workspace, 'supervisor-status.json'));
    assert.equal(state.phase, 'requires_review'); assert.equal(state.stop_reason, 'MODULE_SNAPSHOT_CHANGED');
    if (changeAfterFirst) assert.equal(state.latest_checkpoint_pages, config.maxPages);
  }
});

test('module hash participates in run identity and malformed hashes are refused', async () => {
  const { config, configPath } = await fixture();
  assert.throws(() => validateConfig({ ...config, moduleSha256: 'not-a-sha256' }), /INVALID_MODULE_SHA256/);
  config.moduleSha256 = createHash('sha256').update(await fs.readFile(config.modulePath)).digest('hex'); await atomicJson(configPath, config);
  const fake = fakeDependencies({ reason: 'feed_end' }); await runSupervisor(configPath, fake.deps);
  config.moduleSha256 = '0'.repeat(64); await atomicJson(configPath, config);
  await assert.rejects(runSupervisor(configPath, fake.deps), /CONFIG_CHANGED_REQUIRES_NEW_WORKSPACE/);
  assert.equal(fake.inputs.length, 1);
});

test('date and URL validation rejects ambiguous/invalid input', () => {
  assert.throws(() => timeValue('2025-03-01T00:00:00'), /TIMEZONE/);
  assert.throws(() => timeValue('2025-02-30T00:00:00Z'), /INVALID_CALENDAR_DATE/);
  assert.throws(() => groupUrl('https://evil.example/groups/demo/'), /INVALID_GROUP_URL/);
  assert.throws(() => groupUrl('https://www.facebook.com/groups/synthetic-demo/posts/123/'), /GROUP_ROOT/);
});

test('bounded calibration stops after one verified batch and resumes into a new workspace', async () => {
  const first = await fixture(); first.config.maxBatches = 1; await atomicJson(first.configPath, first.config);
  const fakeFirst = fakeDependencies({ reason: 'page_limit' });
  const state = await runSupervisor(first.configPath, fakeFirst.deps);
  assert.equal(state.stop_reason, 'BATCH_LIMIT'); assert.equal(state.phase, 'stopped'); assert.equal(fakeFirst.inputs.length, 1);
  const checkpoint = await readJson(state.next_checkpoint); assert.equal(checkpoint.next_page, 3);
  const second = await fixture(); second.config.maxBatches = 1; second.config.resumeCheckpointPath = state.next_checkpoint; await atomicJson(second.configPath, second.config);
  const fakeSecond = fakeDependencies({ reason: 'page_limit' });
  const nextState = await runSupervisor(second.configPath, fakeSecond.deps);
  assert.equal(fakeSecond.inputs.length, 1); assert.equal(fakeSecond.inputs[0].resumeCheckpointPath, state.next_checkpoint);
  assert.equal(nextState.start_page, 3); assert.equal(nextState.cumulative_pages, 4); assert.equal(nextState.stop_reason, 'BATCH_LIMIT');
});

test('UTF8 CLI JSON and standard Windows launcher resolve without a shell', async () => {
  assert.equal(parseCliOutput('diagnostic\n{"task":{"id":"测试","state":"running"}}\n').task.id, '测试');
  const base = path.join(fixtureRoot, '标准安装 & %literal%');
  await fs.mkdir(path.join(base, 'bin'), { recursive: true }); await fs.mkdir(path.join(base, 'runtime')); await fs.mkdir(path.join(base, 'app', 'src'), { recursive: true });
  await fs.writeFile(path.join(base, 'runtime', 'node.exe'), 'synthetic'); await fs.writeFile(path.join(base, 'app', 'src', 'cli.mjs'), 'synthetic');
  const launcher = path.join(base, 'bin', 'taskmaster.cmd');
  await fs.writeFile(launcher, '@echo off\r\nset "NODE_OPTIONS="\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\src\\cli.mjs" %*\r\n');
  const command = await resolveCliCommand(launcher, 'win32');
  assert.equal(command.executable, path.join(base, 'runtime', 'node.exe'));
  assert.deepEqual(command.prefix, [path.join(base, 'app', 'src', 'cli.mjs')]);
});

test('live supervisor lock refuses a second writer', async () => {
  const { configPath, config } = await fixture(), fake = fakeDependencies();
  await atomicJson(path.join(config.workspace, 'supervisor.lock'), { pid: process.pid, token: 'synthetic-active' });
  await assert.rejects(runSupervisor(configPath, fake.deps), /ANOTHER_SUPERVISOR_IS_RUNNING/);
  assert.equal(fake.calls.length, 0);
});

test('real collector checkpoint writer interoperates with supervisor across two batches', async () => {
  const collector = await import('../scripts/collect.mjs');
  const { config } = await fixture();
  let before = null;
  for (let batch = 0; batch < 2; batch++) {
    const batchDir = path.join(config.workspace, `real-core-batch-${batch}`);
    const input = collector.normalizeInput({ ...config, outputDir: batchDir, groupId: '123456789012345' });
    const actualScope = collector.checkpointScope(input);
    const store = await collector.createCheckpointStore(batchDir, actualScope, before, input.boundaryPages);
    let cursor = before?.cursor || 'real-helper-cursor-0';
    if (!before) await store.record({ page: 0, request_cursor: 'observed-native-bootstrap', next_cursor: cursor, status: 'ok', stream_final: true, has_next: true, posts: [] });
    const first = (before?.pages || 0) + 1, last = first + config.maxPages - 1;
    for (let page = first; page <= last; page++) {
      const next = `real-helper-cursor-${page}`;
      await store.record({ page, request_cursor: cursor, next_cursor: next, status: 'ok', stream_final: true, has_next: true, posts: [] }); cursor = next;
    }
    await atomicJson(path.join(batchDir, 'posts.json'), { metadata: actualScope, posts: [] });
    await store.finish('page_limit', last, true);
    const after = await readCheckpoint(path.join(batchDir, 'pagination-checkpoint.json'), config, input.groupId);
    await validateHandoff(before, after, config, batchDir, { reason: 'page_limit', pages: last });
    before = after;
  }
  assert.equal(before.pages, 4); assert.equal(before.history_files.length, 2);
});

console.log(`Synthetic fixtures retained at ${fixtureRoot}; no browser or live CLI was used.`);
