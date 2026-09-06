// Local-only portability contract. This module never starts a browser or Manager.
import { access, stat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const ENVIRONMENT_VERSION = 'tiktok-portable-environment-2.0.0';
export const pathApi = platform => platform === 'win32' ? path.win32 : path.posix;
export function resolveConfigPath(value, baseDir = process.cwd(), platform = process.platform, userHome = homedir()) {
  if (typeof value !== 'string' || !value.trim()) throw Error('A nonempty local path is required');
  const p = pathApi(platform);
  if (platform !== 'win32' && (/^[a-z]:/i.test(value) || value.startsWith('\\'))) throw Error(`FOREIGN_ABSOLUTE_PATH: ${value}; configure a path on this machine`);
  if (platform === 'win32' && /^\/(?!\/)/.test(value)) throw Error(`FOREIGN_ABSOLUTE_PATH: ${value}; configure a Windows drive or UNC path on this machine`);
  if (/^[a-z]+:\/\//i.test(value)) throw Error('Local filesystem paths are required, not URLs');
  const expanded = value === '~' ? userHome : /^~[\\/]/.test(value) ? p.join(userHome, value.slice(2)) : value;
  return p.resolve(baseDir, expanded);
}
export function normalizeRuntimeConfig(config, baseDir = config.configBaseDir ?? process.cwd()) {
  const output = { ...config, configBaseDir: resolveConfigPath(baseDir) };
  for (const key of ['outDir', 'outPath', 'taskRoot', 'priorCanonical', 'aiReviewFile', 'clusterReviewFile', 'canonicalPath', 'taskmasterPath', 'policyFile', 'controlFile']) {
    if (config[key] !== undefined) output[key] = resolveConfigPath(config[key], output.configBaseDir);
  }
  if (config.taskOutputs !== undefined) {
    if (!config.taskOutputs || Array.isArray(config.taskOutputs) || typeof config.taskOutputs !== 'object') throw Error('taskOutputs must map real Task Master task IDs to output directories');
    output.taskOutputs = Object.fromEntries(Object.entries(config.taskOutputs).map(([id, dir]) => [id, resolveConfigPath(dir, output.configBaseDir)]));
  }
  if (config.notBefore !== undefined && (typeof config.notBefore !== 'string' || !Number.isFinite(Date.parse(config.notBefore)))) throw Error('notBefore must be a valid date-time string');
  return output;
}
export async function loadRuntimeConfig(file) {
  const absolute = resolveConfigPath(file);
  return normalizeRuntimeConfig(JSON.parse((await readFile(absolute, 'utf8')).replace(/^\uFEFF/, '')), path.dirname(absolute));
}
export function resolveTaskOutputDir(config, taskId) {
  if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw Error(`Invalid task ID: ${taskId}`);
  if (config.taskOutputs && Object.hasOwn(config.taskOutputs, taskId)) return resolveConfigPath(config.taskOutputs[taskId], config.configBaseDir);
  if (config.taskRoot) return path.join(resolveConfigPath(config.taskRoot, config.configBaseDir), taskId, 'output');
  throw Error(`TASK_OUTPUT_DIRECTORY_REQUIRED: supply taskOutputs[${JSON.stringify(taskId)}] from the actual Task Master outputDir, or an explicit offline taskRoot; installation paths are never guessed`);
}
export const isMain = url => !!process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href;
export function defaultSkillsDir(env = process.env, userHome = homedir(), platform = process.platform) {
  const p = pathApi(platform);
  return p.join(env.CODEX_HOME || p.join(userHome, '.codex'), 'skills');
}
export function launcherCandidates({ explicit, env = process.env, platform = process.platform, userHome = homedir() } = {}) {
  const p = pathApi(platform), candidates = [];
  const add = (value, source) => { if (value && !candidates.some(c => c.path === value)) candidates.push({ path: value, source }); };
  if (explicit) { add(explicit, 'config.taskmasterPath'); return candidates; }
  if (env.TASKMASTER_CLI) { add(env.TASKMASTER_CLI, 'TASKMASTER_CLI'); return candidates; }
  const names = platform === 'win32' ? ['taskmaster.cmd', 'taskmaster.exe', 'taskmaster.bat', 'taskmaster'] : ['taskmaster'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) for (const name of names) add(p.join(dir, name), 'PATH');
  if (platform === 'win32' && env.LOCALAPPDATA) add(p.join(env.LOCALAPPDATA, 'Programs', 'Eric Task Master', 'bin', 'taskmaster.cmd'), 'documented_windows_installation');
  if (platform === 'darwin') add('/usr/local/bin/taskmaster', 'documented_macos_installation');
  if (platform === 'linux') add('/usr/bin/taskmaster', 'documented_linux_installation');
  return candidates;
}
async function usableFile(file, executable = false) {
  try { if (!(await stat(file)).isFile()) return false; await access(file, executable && process.platform !== 'win32' ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
}
export async function inspectEnvironment(config = {}) {
  const candidates = launcherCandidates({ explicit: config.taskmasterPath }), checked = [];
  let launcher = null;
  for (const candidate of candidates) {
    const resolved = resolveConfigPath(candidate.path, config.configBaseDir);
    const usable = await usableFile(resolved, true);
    checked.push({ ...candidate, path: resolved, usable });
    if (usable) { launcher = { path: resolved, source: candidate.source }; break; }
  }
  const major = Number(process.versions.node.split('.')[0]), missing = [];
  if (major < 22) missing.push({ code: 'NODE_VERSION', action: 'Run these offline scripts with Node.js 22 or later; a supported Task Master distribution may include Node.', observed: process.versions.node });
  if (!launcher) missing.push({ code: 'TASKMASTER_LAUNCHER', action: 'Locate the installed or extracted official Eric Task Master launcher, then set taskmasterPath in environment.json or TASKMASTER_CLI. If absent, follow the official release installation instructions; this doctor installs nothing.', releaseUrl: 'https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest' });
  return { schemaVersion: ENVIRONMENT_VERSION, checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: { path: process.execPath, version: process.versions.node, supported: major >= 22 }, taskmaster: { launcher, checkedCandidateCount: checked.length, checkedCandidates: checked.filter(c => c.usable || c.source !== 'PATH'), processOrManagerInspected: false }, defaultSkillsDir: defaultSkillsDir(), status: missing.length ? 'needs_environment_setup' : 'local_prerequisites_detected', missing, agentNextSteps: missing.length ? missing.map(x => x.action) : ['Use the discovered absolute launcher path for task commands; quote paths for the current shell. Pin taskmasterPath if this is not the intended installation.', 'Respect the user-selected Profile and existing pause/cooldown state. Capture each returned taskId and actual outputDir.', 'Pass taskOutputs to offline processing. Browser availability, Chrome, login and site access are not proven by this local doctor.'], sideEffects: 'none; no Manager/browser/network/package installation' };
}
