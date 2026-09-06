import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || i + 1 === argv.length || argv[i + 1].startsWith('--')) throw new Error('ARGUMENT_REQUIRES_VALUE');
    const key = argv[i].slice(2);
    if (Object.hasOwn(result, key)) throw new Error('DUPLICATE_ARGUMENT');
    result[key] = argv[++i];
  }
  return result;
}
export function groupUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_GROUP_URL'); }
  if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('INVALID_GROUP_URL');
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
  if (!match) throw new Error('USE_A_GROUP_ROOT_URL');
  return `https://www.facebook.com/groups/${match[1]}/`;
}
export function timeValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('DATE_REQUIRES_EXPLICIT_TIMEZONE');
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/), year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('INVALID_CALENDAR_DATE');
  return value;
}
export function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error('INTEGER_OUT_OF_RANGE');
  return n;
}
export function managerOrigin(value) {
  let url;
  try { url = new URL(value || 'http://127.0.0.1:19946'); } catch { throw new Error('INVALID_MANAGER_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('MANAGER_MUST_BE_LOCAL_LOOPBACK');
  return url.origin;
}
export async function resolveLauncher(explicit, platform = process.platform, env = process.env) {
  const candidates = [], seen = new Set();
  const add = value => {
    if (!value) return;
    const candidate = path.resolve(value);
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
  };
  const searchPath = command => {
    const pathValue = env.PATH || env.Path || env.path || '';
    const extensions = platform === 'win32' && !/\.(?:cmd|exe|bat)$/i.test(command) ? ['', '.cmd', '.exe', '.bat'] : [''];
    for (const folder of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
      for (const extension of extensions) add(path.join(folder, command + extension));
    }
  };
  const configured = explicit || env.ERIC_TASK_MASTER_CLI;
  if (configured) {
    if (path.isAbsolute(configured) || /[\\/]/.test(configured)) add(configured);
    else searchPath(configured);
  } else {
    searchPath('taskmaster');
    if (platform === 'win32' && env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Programs', 'Eric Task Master', 'bin', 'taskmaster.cmd'));
  }
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      if (platform !== 'win32') await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  throw new Error('INSTALLED_LAUNCHER_NOT_FOUND_USE_EXPLICIT_LAUNCHER');
}
export function validateConfig(config) {
  if (config.schemaVersion !== 1) throw new Error('CONFIG_VERSION_MISMATCH');
  config.groupUrl = groupUrl(config.groupUrl);
  timeValue(config.startTime); timeValue(config.endTime);
  if (Date.parse(config.startTime) > Date.parse(config.endTime)) throw new Error('REVERSED_TIME_RANGE');
  config.maxPages = positiveInteger(config.maxPages);
  config.boundaryPages = positiveInteger(config.boundaryPages, 5, 100);
  if (config.boundaryPages < 5) throw new Error('BOUNDARY_REQUIRES_AT_LEAST_FIVE_PAGES');
  config.maxBatches = config.maxBatches == null ? null : positiveInteger(config.maxBatches, 1, 10000);
  config.paceMs = positiveInteger(config.paceMs, 500, 60000);
  if (config.paceMs < 250) throw new Error('PACE_TOO_FAST');
  config.pollMs = positiveInteger(config.pollMs, 15000, 60000);
  config.managerUrl = managerOrigin(config.managerUrl);
  for (const key of ['workspace', 'launcher', 'modulePath']) if (!path.isAbsolute(config[key] || '')) throw new Error('CONFIG_REQUIRES_ABSOLUTE_PATHS');
  if (config.moduleSha256 !== undefined && (typeof config.moduleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(config.moduleSha256))) throw new Error('INVALID_MODULE_SHA256');
  if (config.profile !== undefined && (typeof config.profile !== 'string' || !config.profile.trim() || /[\r\n\0]/.test(config.profile))) throw new Error('INVALID_PROFILE');
  if (config.resumeCheckpointPath && !path.isAbsolute(config.resumeCheckpointPath)) throw new Error('CHECKPOINT_REQUIRES_ABSOLUTE_PATH');
  return config;
}
export async function prepare(options) {
  const allowed = new Set(['url', 'start', 'end', 'workspace', 'launcher', 'profile', 'max-pages', 'max-batches', 'boundary-pages', 'pace-ms', 'manager-url', 'resume-checkpoint', 'timezone']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error('UNKNOWN_ARGUMENT');
  if (!options.workspace) throw new Error('WORKSPACE_REQUIRED');
  const config = validateConfig({
    schemaVersion: 1, groupUrl: groupUrl(options.url), startTime: timeValue(options.start), endTime: timeValue(options.end),
    workspace: path.resolve(options.workspace), launcher: await resolveLauncher(options.launcher),
    modulePath: path.join(path.resolve(options.workspace), 'executor', 'collect.mjs'),
    maxPages: positiveInteger(options['max-pages']), boundaryPages: positiveInteger(options['boundary-pages'], 5, 100),
    maxBatches: options['max-batches'] === undefined ? null : positiveInteger(options['max-batches'], 1, 10000),
    paceMs: positiveInteger(options['pace-ms'], 500, 60000), pollMs: 15000,
    managerUrl: managerOrigin(options['manager-url']),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options['resume-checkpoint'] ? { resumeCheckpointPath: path.resolve(options['resume-checkpoint']) } : {}),
    ...(options.timezone ? { timezone: options.timezone } : {}),
    preparedAt: new Date().toISOString(),
  });
  if (config.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(); } catch { throw new Error('INVALID_IANA_TIMEZONE'); } }
  await fs.mkdir(config.workspace, { recursive: true });
  const configPath = path.join(config.workspace, 'config.json');
  for (const file of [configPath, config.modulePath]) {
    try { await fs.lstat(file); throw Object.assign(new Error('PREPARED_FILES_ALREADY_EXIST'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // collect.mjs is self-contained: pin its exact bytes for this task so a later
  // skill upgrade cannot switch the executor between batches. Never overwrite it.
  const moduleBytes = await fs.readFile(path.join(SKILL_ROOT, 'scripts', 'collect.mjs'));
  config.moduleSha256 = createHash('sha256').update(moduleBytes).digest('hex');
  await fs.mkdir(path.dirname(config.modulePath), { recursive: true });
  const moduleHandle = await fs.open(config.modulePath, 'wx');
  try { await moduleHandle.writeFile(moduleBytes); await moduleHandle.sync(); } finally { await moduleHandle.close(); }
  const handle = await fs.open(configPath, 'wx');
  try { await handle.writeFile(JSON.stringify(config, null, 2), 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return { configPath, config };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Prepare only; no browser task is started.\nnode prepare.mjs --url <group URL> --start <ISO timestamp with offset> --end <ISO timestamp with offset> --workspace <new directory> --max-pages <positive per-batch request budget> [--launcher <installed launcher>] [--profile <explicit choice>] [--max-batches <positive limit>] [--boundary-pages 5] [--pace-ms 500] [--resume-checkpoint <path>] [--timezone <IANA name>] [--manager-url http://127.0.0.1:19946]\nmax-pages is required for every task and has no inherited business default. Default max-batches is unlimited; use a deliberately small max-pages and --max-batches 1 for calibration. A batch limit does not prove date-range coverage.');
  } else {
    try { const result = await prepare(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ prepared: true, configPath: result.configPath, next: 'node scripts/batches.mjs run --config <configPath>' })); }
    catch (error) { console.error(JSON.stringify({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.code || 'PREPARE_FAILED' })); process.exitCode = 1; }
  }
}
