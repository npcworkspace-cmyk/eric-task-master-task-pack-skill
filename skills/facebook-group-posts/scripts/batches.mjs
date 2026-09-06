import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, validateConfig, groupUrl } from './prepare.mjs';

const execFileAsync = promisify(execFile);
const runningStates = new Set(['created', 'queued', 'starting', 'running']);
const safeCode = error => /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SUPERVISOR_ERROR_REQUIRES_REVIEW';
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync(); } finally { await handle.close(); }
  const delays = [50, 100, 200, 400, 800, 1000, 1000];
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, file); return; }
    catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= delays.length) throw error; await new Promise(resolve => setTimeout(resolve, delays[attempt])); }
  }
}
export async function markEvolutionPending(workspace, state) {
  const file = path.join(workspace, 'evolution-review-status.json');
  const terminal = {
    phase: state?.phase || 'unknown', stop_reason: state?.stop_reason || null,
    task_id: state?.task_id || null, task_state: state?.task_state || null,
    supervisor_updated_at: state?.updated_at || null,
  };
  const terminalFingerprint = createHash('sha256').update(JSON.stringify(terminal)).digest('hex');
  const existing = await readJson(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing?.status === 'completed' && existing.terminal_fingerprint === terminalFingerprint) return existing;
  const value = {
    schema_version: 1, status: 'pending', review_required: true,
    terminal_fingerprint: terminalFingerprint, terminal,
    marked_at: new Date().toISOString(),
    required_action: 'Run scripts/evolve.py review from the installed Skill for this task workspace; use no_change or a tested candidate.',
  };
  await atomicJson(file, value);
  return value;
}
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function pathsEqual(left, right) { return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right); }
function fingerprint(config) {
  const selected = Object.fromEntries(['groupUrl', 'startTime', 'endTime', 'workspace', 'launcher', 'modulePath', 'maxPages', 'maxBatches', 'boundaryPages', 'paceMs', 'managerUrl', 'profile', 'resumeCheckpointPath', 'timezone'].map(key => [key, config[key] ?? null]));
  // Omit absent hashes to preserve fingerprints of legacy, unpinned configs.
  if (config.moduleSha256 !== undefined) selected.moduleSha256 = config.moduleSha256;
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}
async function verifyModuleSnapshot(config) {
  if (config.moduleSha256 === undefined) return;
  let bytes;
  try { bytes = await fs.readFile(config.modulePath); } catch { throw new Error('MODULE_SNAPSHOT_UNREADABLE'); }
  if (createHash('sha256').update(bytes).digest('hex') !== config.moduleSha256) throw new Error('MODULE_SNAPSHOT_CHANGED');
}
export async function resolveCliCommand(launcher, platform = process.platform) {
  if (platform !== 'win32' || !/\.cmd$/i.test(launcher)) return { executable: launcher, prefix: [] };
  // The installed launcher invokes this same CLI. execFile avoids cmd.exe
  // expansion of %, &, Unicode, or quoted workspace/profile arguments.
  const source = await fs.readFile(launcher, 'utf8');
  if (!/"%~dp0\.\.\\runtime\\node\.exe"\s+"%~dp0\.\.\\app\\src\\cli\.mjs"\s+%\*/i.test(source)) throw new Error('UNSUPPORTED_WINDOWS_LAUNCHER_LAYOUT');
  const executable = path.resolve(path.dirname(launcher), '..', 'runtime', 'node.exe');
  const cli = path.resolve(path.dirname(launcher), '..', 'app', 'src', 'cli.mjs');
  if (!(await exists(executable)) || !(await exists(cli))) throw new Error('INSTALLED_CLI_RUNTIME_MISSING');
  return { executable, prefix: [cli] };
}
export function parseCliOutput(stdout) {
  try { const value = JSON.parse(stdout.trim()); if (value && typeof value === 'object') return value; } catch {}
  for (const line of stdout.trim().split(/\r?\n/).reverse()) { try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch {} }
  throw new Error('CLI_JSON_MISSING');
}
export function productionDependencies(config) {
  return {
    async cli(args) {
      const command = await resolveCliCommand(config.launcher);
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
      let result;
      try { result = await execFileAsync(command.executable, [...command.prefix, ...args], { encoding: 'utf8', windowsHide: true, env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 }); }
      catch { throw new Error(args[0] === 'run' ? 'LAUNCH_OUTCOME_UNCERTAIN' : 'CLI_COMMAND_FAILED'); }
      const value = parseCliOutput(result.stdout);
      if (value.ok === false) throw new Error(args[0] === 'run' ? 'LAUNCH_OUTCOME_UNCERTAIN' : 'CLI_RETURNED_ERROR');
      return value;
    },
    async health() {
      try {
        const response = await fetch(`${config.managerUrl}/v1/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (value.service !== 'eric-task-master' || !Number.isSafeInteger(Number(value.pid)) || !value.version) throw new Error();
        return { service: value.service, pid: Number(value.pid), version: String(value.version), ...(value.started_at ? { started_at: value.started_at } : {}) };
      } catch { throw new Error('MANAGER_STOPPED_OR_UNREACHABLE'); }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    emit: value => console.log(JSON.stringify(value)),
  };
}
async function acquireLock(file) {
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(file).catch(() => null);
    if (!Number.isSafeInteger(previous?.pid)) throw new Error('LOCK_REQUIRES_REVIEW');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('ANOTHER_SUPERVISOR_IS_RUNNING');
    await fs.unlink(file); handle = await fs.open(file, 'wx');
  }
  const token = randomUUID();
  await handle.writeFile(JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })); await handle.sync();
  return async () => { await handle.close(); const current = await readJson(file).catch(() => null); if (current?.token === token) await fs.unlink(file); };
}
function checkScope(value, config, groupId) {
  if (groupUrl(value.group_url) !== config.groupUrl || Date.parse(value.start) !== Date.parse(config.startTime) || Date.parse(value.end) !== Date.parse(config.endTime)) throw new Error('CHECKPOINT_SCOPE_MISMATCH');
  if (!/^\d+$/.test(String(value.group_id)) || (groupId && String(value.group_id) !== String(groupId))) throw new Error('CHECKPOINT_GROUP_MISMATCH');
  if (value.sorting_setting !== 'CHRONOLOGICAL' || value.page_size !== 3 || value.required_boundary_pages !== config.boundaryPages) throw new Error('CHECKPOINT_STRATEGY_MISMATCH');
  if (value.operation !== 'GroupsCometFeedRegularStoriesPaginationQuery') throw new Error('CHECKPOINT_OPERATION_MISMATCH');
}
export async function readCheckpoint(file, config, groupId) {
  const checkpoint = await readJson(file);
  checkScope(checkpoint, config, groupId);
  if (checkpoint.schema_version !== 3 || !Number.isSafeInteger(checkpoint.pages) || checkpoint.pages < 0 || checkpoint.next_page !== checkpoint.pages + 1 || typeof checkpoint.cursor !== 'string' || !checkpoint.cursor) throw new Error('CHECKPOINT_NOT_RESUMABLE');
  if (!Array.isArray(checkpoint.history_files) || !checkpoint.history_files.length || new Set(checkpoint.history_files.map(p => path.resolve(p))).size !== checkpoint.history_files.length) throw new Error('CHECKPOINT_HISTORY_MISSING');
  for (const history of checkpoint.history_files) if (!path.isAbsolute(history) || !(await exists(history))) throw new Error('CHECKPOINT_HISTORY_MISSING');
  if (!path.isAbsolute(checkpoint.source_file || '') || !(await exists(checkpoint.source_file))) throw new Error('CHECKPOINT_POSTS_MISSING');
  return checkpoint;
}
export async function validateHandoff(before, after, config, batchDir, result) {
  const expectedPage = (before?.pages || 0) + config.maxPages;
  if (after.pages !== expectedPage || result.pages !== after.pages || after.cursor === before?.cursor) throw new Error('CHECKPOINT_DID_NOT_ADVANCE_EXACTLY_BATCH_SIZE');
  if (!pathsEqual(after.source_file, path.join(batchDir, 'posts.json'))) throw new Error('CHECKPOINT_POSTS_WRONG_PATH');
  const state = await readJson(path.join(batchDir, 'pagination-state.json'));
  if (state.status !== 'page_limit' || state.has_next !== true || state.page !== after.pages) throw new Error('PAGINATION_STATE_NOT_CONTINUABLE');
  const earlier = before?.history_files || [];
  if (after.history_files.length <= earlier.length || earlier.some((file, index) => !pathsEqual(file, after.history_files[index]))) throw new Error('CHECKPOINT_HISTORY_CHAIN_BROKEN');
  let expectedCursor = before?.cursor ?? null, page = before?.pages || 0, initialSeen = Boolean(before);
  for (const file of after.history_files.slice(earlier.length)) {
    const content = await fs.readFile(file, 'utf8');
    if (!content.endsWith('\n')) throw new Error('JOURNAL_INCOMPLETE');
    for (const line of content.split('\n').filter(Boolean)) {
      const row = JSON.parse(line); checkScope(row, config, after.group_id);
      // The first naturally observed pagination request may already have a
      // server cursor from the initial HTML. Preserve that real bootstrap anchor.
      if (!initialSeen && row.page === 0 && (row.request_cursor === null || typeof row.request_cursor === 'string' && row.request_cursor.length > 0)) { initialSeen = true; }
      else { if (row.page !== page + 1 || row.request_cursor !== expectedCursor) throw new Error('JOURNAL_CURSOR_CHAIN_BROKEN'); page++; }
      if (row.status !== 'ok' || row.stream_final !== true || row.has_next !== true || !row.next_cursor || row.next_cursor === row.request_cursor) throw new Error('JOURNAL_PAGE_NOT_CONTINUABLE');
      expectedCursor = row.next_cursor;
    }
  }
  if (!initialSeen || page !== after.pages || expectedCursor !== after.cursor) throw new Error('JOURNAL_CHECKPOINT_MISMATCH');
}
export async function runSupervisor(configPath, overrides = {}) {
  const config = validateConfig(await readJson(configPath)), deps = { ...productionDependencies(config), ...overrides };
  for (const file of [config.launcher, config.modulePath]) if (!(await exists(file))) throw new Error('LAUNCHER_OR_MODULE_MISSING');
  await fs.mkdir(config.workspace, { recursive: true });
  const statusFile = path.join(config.workspace, 'supervisor-status.json'), stopFile = path.join(config.workspace, 'stop-request.json');
  const unlock = await acquireLock(path.join(config.workspace, 'supervisor.lock'));
  let state, previous, safeToStop = false;
  const save = async () => { state.updated_at = new Date().toISOString(); await atomicJson(statusFile, state); };
  const rememberLatestCheckpoint = async () => {
    if (state?.profile_mismatch) return;
    const candidate = state?.batch_dir ? path.join(state.batch_dir, 'pagination-checkpoint.json') : state?.next_checkpoint;
    if (!candidate || !(await exists(candidate))) return;
    try {
      const latest = await readCheckpoint(candidate, config, state.group_id);
      state.latest_checkpoint = candidate; state.latest_checkpoint_pages = latest.pages;
      state.group_id = latest.group_id; state.latest_checkpoint_error = null;
    } catch (error) { state.latest_checkpoint_error = safeCode(error); }
  };
  const verifyProfile = (task, required = false) => {
    const profileId = task?.profileId;
    if (typeof profileId !== 'string' || !profileId) { if (required) throw new Error('TASK_PROFILE_ID_MISSING'); return; }
    if (state.resolvedProfileId && state.resolvedProfileId !== profileId) {
      state.profile_mismatch = true; throw new Error('TASK_PROFILE_CHANGED');
    }
    state.resolvedProfileId = profileId;
  };
  const checkManager = async () => { const current = await deps.health(); if (JSON.stringify(current) !== JSON.stringify(state.manager)) throw new Error('MANAGER_INSTANCE_CHANGED'); };
  const cli = async args => { await checkManager(); const value = await deps.cli(args); await checkManager(); return value; };
  async function stopTask() {
    if (state?.task_id && (runningStates.has(state.task_state) || state.task_state === 'waiting_user')) {
      try { await cli(['stop', state.task_id, '--json']); state.active_stop = 'requested'; }
      catch (error) { state.active_stop = safeCode(error); }
    }
  }
  const interrupted = async () => { await atomicJson(stopFile, { requested_at: new Date().toISOString(), reason: 'SUPERVISOR_SIGNAL' }); };
  const signalHandler = () => { interrupted().catch(() => {}); };
  process.on('SIGINT', signalHandler); process.on('SIGTERM', signalHandler);
  try {
    previous = await exists(statusFile) ? await readJson(statusFile) : null;
    if (previous) {
      if (previous.config_fingerprint !== fingerprint(config)) throw new Error('CONFIG_CHANGED_REQUIRES_NEW_WORKSPACE');
      if (!['monitoring', 'ready_for_next'].includes(previous.phase)) {
        state = { ...previous, pid: process.pid };
        await markEvolutionPending(config.workspace, state);
        throw new Error(previous.phase === 'launching' ? 'LAUNCH_OUTCOME_UNCERTAIN_REQUIRES_REVIEW' : 'PREVIOUS_STOP_REQUIRES_EXPLICIT_RECOVERY');
      }
      state = { ...previous, pid: process.pid }; await checkManager();
    } else {
      if (await exists(stopFile)) throw new Error('STOP_REQUEST_PRESENT');
      let manager;
      try { manager = await deps.health(); } catch { await deps.cli(['panel', '--json']); manager = await deps.health(); }
      state = { schema_version: 1, config_fingerprint: fingerprint(config), pid: process.pid, manager, phase: 'ready_for_next', batch_number: 0, task_id: null, task_state: null, next_checkpoint: config.resumeCheckpointPath || null, batches: [], cumulative_pages: 0, processed_posts: 0 };
    }
    safeToStop = true; await save();
    deps.emit({ event: 'dashboard', url: `${config.managerUrl}/dashboard`, workspace: config.workspace });
    while (true) {
      if (await exists(stopFile)) { await stopTask(); await rememberLatestCheckpoint(); state.phase = 'stopped'; state.stop_reason = 'USER_STOP'; await save(); break; }
      await checkManager();
      if (state.phase === 'ready_for_next') {
        await verifyModuleSnapshot(config);
        const before = state.next_checkpoint ? await readCheckpoint(state.next_checkpoint, config, state.group_id) : null;
        if (state.batch_number > 0 && !before) throw new Error('NEXT_CHECKPOINT_MISSING');
        if (before) state.group_id = before.group_id;
        const startPage = (before?.pages || 0) + 1, endPage = (before?.pages || 0) + config.maxPages;
        const batchNumber = state.batch_number + 1;
        const batchDir = path.join(config.workspace, 'batches', `batch-${String(batchNumber).padStart(4, '0')}-pages-${String(startPage).padStart(7, '0')}-${String(endPage).padStart(7, '0')}`);
        await fs.mkdir(path.dirname(batchDir), { recursive: true }); await fs.mkdir(batchDir);
        const input = { groupUrl: config.groupUrl, startTime: config.startTime, endTime: config.endTime, outputDir: batchDir, maxPages: config.maxPages, boundaryPages: config.boundaryPages, paceMs: config.paceMs, ...(config.timezone ? { timezone: config.timezone } : {}), ...(state.group_id ? { groupId: state.group_id } : {}), ...(state.next_checkpoint ? { resumeCheckpointPath: state.next_checkpoint } : {}) };
        const inputFile = path.join(batchDir, 'input.json'); await atomicJson(inputFile, input);
        Object.assign(state, { phase: 'launching', batch_number: batchNumber, start_page: startPage, planned_end_page: endPage, batch_dir: batchDir, input_file: inputFile, task_id: null, task_state: null, result_reason: null });
        await save();
        if (await exists(stopFile)) { state.phase = 'stopped'; state.stop_reason = 'USER_STOP_BEFORE_LAUNCH'; await save(); break; }
        const args = ['run', config.modulePath, '--input', `@${inputFile}`, '--label', `FB group batch ${batchNumber}; pages ${startPage}-${endPage}`, '--detach', '--json'];
        if (config.profile) args.push('--profile', config.profile);
        const created = await cli(args);
        if (!created.task?.id) throw new Error('LAUNCH_OUTCOME_UNCERTAIN');
        state.task_id = String(created.task.id); state.task_state = created.task.state || 'created'; state.phase = 'monitoring';
        state.batches.push({ batch: batchNumber, task_id: state.task_id, start_page: startPage, planned_end_page: endPage, input_file: inputFile });
        verifyProfile(created.task);
        await save();
        deps.emit({ event: 'batch_started', task_id: state.task_id, start_page: startPage, planned_end_page: endPage });
        // Retain the ID before panel or follow-up operations. No repeat of run.
        await cli(['panel', '--json']);
        continue;
      }
      const response = await cli(['status', state.task_id, '--json']), task = response.task;
      if (!task || String(task.id) !== state.task_id) throw new Error('TASK_STATUS_ID_MISMATCH');
      state.task_state = task.state;
      verifyProfile(task, true);
      const postsFile = path.join(state.batch_dir, 'posts.json');
      if (await exists(postsFile)) {
        const posts = await readJson(postsFile);
        state.cumulative_pages = posts.metadata?.feed_pages ?? state.cumulative_pages;
        state.processed_posts = posts.metadata?.in_range_count ?? state.processed_posts;
        state.current_page_earliest = posts.metadata?.current_page_earliest ?? null;
      }
      await save();
      deps.emit({ event: 'progress', task_id: state.task_id, state: task.state, batch_pages: Math.max(0, state.cumulative_pages - state.start_page + 1), max_pages: config.maxPages, cumulative_pages: state.cumulative_pages, posts: state.processed_posts, current_page_earliest: state.current_page_earliest, observed_at: state.updated_at });
      if (task.state === 'finished') {
        const reason = task.result?.reason || 'missing_result'; state.result_reason = reason;
        state.batches.at(-1).result_reason = reason;
        if (reason !== 'page_limit') { await rememberLatestCheckpoint(); state.phase = 'finished'; state.stop_reason = `TASK_RESULT_${reason}`; await save(); break; }
        const before = state.next_checkpoint ? await readCheckpoint(state.next_checkpoint, config, state.group_id) : null;
        const nextCheckpoint = path.join(state.batch_dir, 'pagination-checkpoint.json');
        const after = await readCheckpoint(nextCheckpoint, config, state.group_id);
        await validateHandoff(before, after, config, state.batch_dir, task.result);
        state.group_id = after.group_id; state.next_checkpoint = nextCheckpoint; state.latest_checkpoint = nextCheckpoint; state.latest_checkpoint_pages = after.pages; state.cumulative_pages = after.pages; state.phase = 'ready_for_next';
        await save(); deps.emit({ event: 'batch_verified', cumulative_pages: after.pages, next_page: after.next_page });
        if (config.maxBatches && state.batch_number >= config.maxBatches) { state.phase = 'stopped'; state.stop_reason = 'BATCH_LIMIT'; await save(); break; }
        continue;
      }
      if (!runningStates.has(task.state)) { await rememberLatestCheckpoint(); state.phase = 'stopped'; state.stop_reason = `TASK_STATE_${task.state}`; await save(); break; }
      await deps.sleep(config.pollMs);
    }
    await markEvolutionPending(config.workspace, state);
    deps.emit({ event: 'supervisor_stopped', phase: state.phase, reason: state.stop_reason, active_stop: state.active_stop || null, task_id: state.task_id, evolution_review: 'pending' });
    return state;
  } catch (error) {
    if (state && safeToStop) {
      if (state.phase !== 'launching') await stopTask();
      await rememberLatestCheckpoint();
      const uncertain = state.phase === 'launching';
      state.phase = uncertain ? 'launching' : 'requires_review'; state.stop_reason = safeCode(error); await save();
      try { await markEvolutionPending(config.workspace, state); }
      catch (reviewError) { state.evolution_review_error = safeCode(reviewError); await save(); }
    }
    throw error;
  } finally { process.off('SIGINT', signalHandler); process.off('SIGTERM', signalHandler); await unlock(); }
}
export async function requestStop(configPath, overrides = {}) {
  const config = validateConfig(await readJson(configPath)), deps = { ...productionDependencies(config), ...overrides };
  await atomicJson(path.join(config.workspace, 'stop-request.json'), { requested_at: new Date().toISOString(), reason: 'USER_STOP' });
  const state = await readJson(path.join(config.workspace, 'supervisor-status.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!state?.task_id) return { stop_requested: true, active_stop: state?.phase === 'launching' ? 'LAUNCH_OUTCOME_UNCERTAIN_REQUIRES_REVIEW' : 'no_known_active_task' };
  if (!runningStates.has(state.task_state) && state.task_state !== 'waiting_user') return { stop_requested: true, active_stop: 'task_already_terminal', task_id: state.task_id };
  const manager = await deps.health();
  if (JSON.stringify(manager) !== JSON.stringify(state.manager)) throw new Error('MANAGER_INSTANCE_CHANGED_STOP_NOT_CONFIRMED');
  await deps.cli(['stop', state.task_id, '--json']);
  return { stop_requested: true, active_stop: 'requested', task_id: state.task_id };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (!action || action === '--help') console.log('node batches.mjs run|stop|status --config <config.json>\nrun continues only verified page_limit batches. stop requests active task stop and keeps checkpoints. A stopped/uncertain run requires review and explicit recovery into a new workspace.');
  else try {
    const options = parseArgs(process.argv.slice(3));
    if (!options.config || Object.keys(options).some(key => key !== 'config')) throw new Error('CONFIG_ARGUMENT_REQUIRED');
    if (action === 'run') await runSupervisor(path.resolve(options.config));
    else if (action === 'stop') console.log(JSON.stringify(await requestStop(path.resolve(options.config))));
    else if (action === 'status') {
      const config = validateConfig(await readJson(options.config)), state = await readJson(path.join(config.workspace, 'supervisor-status.json'));
      if (!['monitoring', 'ready_for_next'].includes(state.phase)) await markEvolutionPending(config.workspace, state);
      console.log(JSON.stringify(state, null, 2));
    }
    else throw new Error('UNKNOWN_COMMAND');
  } catch (error) { console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; }
}
