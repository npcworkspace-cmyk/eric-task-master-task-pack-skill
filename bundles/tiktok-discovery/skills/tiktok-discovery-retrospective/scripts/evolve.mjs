// Agent-driven MD/executor iteration. No browser, network, shell interpolation or task defaults.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_NAMES, inventory, exists, inside, same, sha256 } from './deployment.mjs';
import { defaultSkillsDir, isMain } from '../../tiktok-seed-discovery/scripts/runtime/environment.mjs';

const execute = promisify(execFile);
const ROOT_FILES = ['install.mjs', 'package.mjs', 'README-install.md', 'START-HERE.md'];
const metaPath = 'skills/tiktok-discovery-retrospective/release.json';
const json = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const save = async (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
export function rootDocuments() {
  return {
    'install.mjs': "import { cli } from './skills/tiktok-discovery-retrospective/scripts/deployment.mjs';\nawait cli().catch(e => { console.error(e.message); process.exitCode = 1; });\n",
    'package.mjs': "import { cli } from './skills/tiktok-discovery-retrospective/scripts/evolve.mjs';\nawait cli(['package', ...process.argv.slice(2)]).catch(e => { console.error(e.message); process.exitCode = 1; });\n",
    'README-install.md': '# TikTok 三 Skill 通用包\n\n需要 Node.js 22+、Eric Task Master、Chrome，以及能调用本地工具和 Skill 的 Agent。包内程序只用 Node 内置模块；浏览器和登录状态由当前设备提供。\n\n    node install.mjs --dry-run\n    node install.mjs\n    node install.mjs --skills-dir "/your/agent/skills"\n\n默认安装到 CODEX_HOME/skills，未设置时为当前用户的 .codex/skills。已有版本先备份；三个 Skill 的文档和执行器一同升级。重新加载方式以宿主 Agent 为准。\n\n详见 [跨设备配置与恢复](skills/tiktok-discovery-retrospective/references/portability.md)、[MD 与执行器的迭代流程](skills/tiktok-discovery-retrospective/references/code-evolution.md)。发行包的 manifest.json 可核验所有文件；QA.json 明确本版实际验证范围。\n',
    'START-HERE.md': '# 交给 Agent 的启动说明\n\n> 请安装本包三个 TikTok Skill，先读 README-install.md 并检测当前设备。已提供的信息不要重复问；开始前一次收齐推广国家、粉丝区间、3–5 条带类型备注的参考链接，以及红人类别和内容风格。先研究参考，再批量找种子、集中审核、逐轮裂变。每轮结束、暂停或受阻都执行复盘，分别检查 MD 和执行器。只将验证过的通用改进做成新版本；每个任务的数据和机器配置保存在包外。\n\n1. [种子发现](skills/tiktok-seed-discovery/SKILL.md)：需求与参考研究、批量发现、集中审核。\n2. [种子裂变](skills/tiktok-seed-expansion/SKILL.md)：由已审核种子展开一轮，再按收益决定继续。\n3. [复盘与迭代](skills/tiktok-discovery-retrospective/SKILL.md)：证据复盘、策略实验、MD/执行器候选副本、验证、发布和回滚。\n\n复盘不等于每轮强行改代码。没有可靠改进时记录保留原版的理由。具体国家、品牌、账号、关键词、数量目标和 Profile 不会成为通用默认值；技术等待/采样上限与业务目标分别记录。\n'
  };
}
export async function bootstrap(root) {
  for (const [file, text] of Object.entries(rootDocuments())) await fs.writeFile(path.join(root, file), text, { flag: 'wx' });
}
export async function payload(root) {
  const files = [];
  for (const name of SKILL_NAMES) {
    const prefix = 'skills/' + name + '/';
    for (const file of await inventory(path.join(root, 'skills', name))) {
      const p = prefix + file.path;
      if (!/\.(md|mjs)$/.test(p) && p !== prefix + 'agents/openai.yaml' && p !== metaPath) throw Error('NON_PORTABLE_PAYLOAD_FILE: ' + p);
      files.push({ ...file, path: p });
    }
  }
  for (const p of ROOT_FILES) {
    const full = path.join(root, p);
    if ((await fs.lstat(full)).isSymbolicLink()) throw Error('SYMLINK_NOT_SUPPORTED: ' + p);
    const bytes = await fs.readFile(full); files.push({ path: p, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function metadata(root) {
  const meta = await json(path.join(root, metaPath));
  if (!same(Object.keys(meta).sort(), ['minimumNodeMajor', 'schemaVersion', 'skills', 'version']) || meta.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(meta.version) || meta.minimumNodeMajor !== 22 || !same(meta.skills, SKILL_NAMES)) throw Error('Invalid release metadata');
  return meta;
}
function separate(source, out) {
  if (source === out || inside(source, out) || inside(out, source)) throw Error('OUTPUT_OVERLAPS_SOURCE');
}
export async function stage({ skillsDir = defaultSkillsDir(), outDir }) {
  if (!outDir) throw Error('Explicit isolated outDir required');
  const source = path.resolve(skillsDir), out = path.resolve(outDir); separate(source, out);
  for (const name of SKILL_NAMES) await inventory(path.join(source, name));
  await fs.mkdir(out);
  for (const name of SKILL_NAMES) await fs.cp(path.join(source, name), path.join(out, 'skills', name), { recursive: true, force: false, errorOnExist: true });
  await bootstrap(out);
  const files = await payload(out);
  await save(path.join(out, 'baseline.json'), { schemaVersion: 1, version: (await metadata(out)).version, files, sha256: sha256(JSON.stringify(files)) });
  return { status: 'staged', candidate: out, files: files.length, next: 'Edit generalized MD/executor behavior, bump release.json version, then check.' };
}
export async function structuralChecks(root, files) {
  const names = new Set(files.map(f => f.path));
  for (const name of SKILL_NAMES) {
    const text = await fs.readFile(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!front || !front.split(/\r?\n/).some(line => line === 'name: ' + name) || !/^description: \S.+/m.test(front)) throw Error('INVALID_SKILL_FRONTMATTER: ' + name);
  }
  for (const file of files) {
    if (!/\.(md|mjs)$/.test(file.path)) continue;
    const text = await fs.readFile(path.join(root, file.path), 'utf8');
    const targets = file.path.endsWith('.md')
      ? [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(m => m[1].replace(/^<|>$/g, '').split('#')[0]).filter(t => t && !/^(https?:|mailto:)/.test(t) && !t.includes(' '))
      : [...text.matchAll(/^\s*import\s+(?:.*?\s+from\s*)?['"](\.[^'"]+)['"]/gm), ...text.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(m => m[1]);
    for (const target of targets) {
      const absolute = path.resolve(path.dirname(path.join(root, file.path)), target);
      const p = path.relative(root, absolute).split(path.sep).join('/');
      if (!inside(root, absolute) || !names.has(p)) throw Error('MISSING_PACKAGED_REFERENCE: ' + file.path + ' -> ' + target);
    }
    if (!file.path.endsWith('.test.mjs') && /(?:[A-Z]:\\Users\\[^\\\s]+\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/.test(text)) throw Error('PERSONAL_PATH_IN_SOURCE: ' + file.path);
  }
}
export async function check({ sourceRoot, outDir }) {
  if (!sourceRoot || !outDir) throw Error('sourceRoot and separate outDir required');
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22+ required');
  const root = path.resolve(sourceRoot), out = path.resolve(outDir); separate(root, out);
  await fs.mkdir(out, { recursive: false });
  const files = await payload(root), meta = await metadata(root);
  await structuralChecks(root, files);
  const scripts = files.filter(f => f.path.endsWith('.mjs'));
  for (let i = 0; i < scripts.length; i += 4) await Promise.all(scripts.slice(i, i + 4).map(f => execute(process.execPath, ['--check', path.join(root, f.path)], { timeout: 30000, windowsHide: true })));
  const tests = scripts.filter(f => f.path.endsWith('.test.mjs')).map(f => path.join(root, f.path));
  if (!tests.length) throw Error('No offline behavior tests packaged');
  let stdout = '', stderr = '', failure;
  try {
    ({ stdout, stderr } = await execute(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, env: { ...process.env, TIKTOK_DISCOVERY_STATE_DIR: path.join(out, 'isolated-policy-state') }, timeout: 180000, maxBuffer: 12 * 1024 * 1024, windowsHide: true }));
  } catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; failure = error; }
  await fs.writeFile(path.join(out, 'validation.tap'), stdout);
  if (stderr) await fs.writeFile(path.join(out, 'stderr.txt'), stderr);
  const count = key => Number(stdout.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1]);
  const stats = { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') };
  if (failure || !stats.tests || stats.passed !== stats.tests || stats.failed !== 0 || stats.skipped !== 0 || stats.cancelled !== 0) throw Error('OFFLINE_TESTS_FAILED: see ' + path.join(out, 'validation.tap'));
  if (!same(files, await payload(root))) throw Error('SOURCE_CHANGED_DURING_VALIDATION');
  let changes = null;
  if (await exists(path.join(root, 'baseline.json'))) {
    const base = await json(path.join(root, 'baseline.json')), previous = new Map(base.files.map(f => [f.path, f.sha256]));
    changes = [...files.filter(f => previous.get(f.path) !== f.sha256).map(f => f.path), ...base.files.filter(f => !files.some(x => x.path === f.path)).map(f => f.path)];
    if (base.version === meta.version && changes.length) throw Error('RELEASE_VERSION_MUST_CHANGE: candidate differs from installed baseline');
  }
  const result = { schemaVersion: 1, status: 'passed', version: meta.version, payloadHash: sha256(JSON.stringify(files)), files, changedFiles: changes, checkedAt: new Date().toISOString(),
    nodeVersion: process.version, actualHost: { platform: process.platform, architecture: process.arch }, offlineTests: stats,
    verification: ['packaged MD links and local imports', 'all module syntax', 'offline behavioral tests including installation and rollback', 'three Skill frontmatters'],
    limits: ['synthetic offline fixtures only', 'Agent must review generality, documentation and evidence semantics', 'no live TikTok or throughput/accuracy claim', 'no macOS/Linux real-device browser test'] };
  await save(path.join(out, 'validation.json'), result);
  return { ...result, files: files.length, validationFile: path.join(out, 'validation.json') };
}
export async function assertValidated(root, validationFile) {
  const files = await payload(root), meta = await metadata(root), validation = await json(validationFile);
  const stats = validation.offlineTests;
  if (validation.status !== 'passed' || validation.version !== meta.version || validation.payloadHash !== sha256(JSON.stringify(files)) || !same(files, validation.files) || !stats?.tests || stats.passed !== stats.tests || stats.failed !== 0 || stats.skipped !== 0 || stats.cancelled !== 0) throw Error('VALIDATION_STALE_OR_FAILED');
  return { files, meta, validation };
}
export async function buildPackage({ sourceRoot, validationFile, outDir }) {
  if (!sourceRoot || !validationFile || !outDir) throw Error('sourceRoot, validationFile and outDir required');
  const root = path.resolve(sourceRoot), out = path.resolve(outDir); separate(root, out);
  const { files, meta, validation } = await assertValidated(root, validationFile);
  await fs.mkdir(out);
  for (const file of files) { const target = path.join(out, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, await fs.readFile(path.join(root, file.path)), { flag: 'wx' }); }
  if (!same(files, await inventory(out))) throw Error('RELEASE_COPY_HASH_MISMATCH');
  await save(path.join(out, 'QA.json'), { packageVersion: meta.version, createdAt: new Date().toISOString(), payloadHash: validation.payloadHash, actualHost: validation.actualHost, nodeVersion: validation.nodeVersion, offlineTests: validation.offlineTests, verification: validation.verification, limits: validation.limits });
  const manifest = { packageVersion: meta.version, files: await inventory(out) };
  await save(path.join(out, 'manifest.json'), manifest);
  return { status: 'packaged_verified', packageDir: out, version: meta.version, files: manifest.files.length + 1, next: 'Install this directory; archive it with the local OS ZIP tool. Keep task data and local QA logs outside.' };
}
export async function cli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv, args = {};
  const options = { stage: ['skills-dir', 'out'], check: ['source', 'out'], package: ['source', 'validation', 'out'] };
  if (!options[command]) throw Error('Commands: stage, check, package');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || !options[command].includes(key) || !rest[i + 1] || Object.hasOwn(args, key)) throw Error('Invalid or duplicate argument');
    args[key] = rest[i + 1];
  }
  const result = command === 'stage' ? await stage({ skillsDir: args['skills-dir'], outDir: args.out })
    : command === 'check' ? await check({ sourceRoot: args.source, outDir: args.out })
    : await buildPackage({ sourceRoot: args.source, validationFile: args.validation, outDir: args.out });
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (isMain(import.meta.url)) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
