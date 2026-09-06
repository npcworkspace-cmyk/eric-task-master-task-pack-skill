#!/usr/bin/env node
/** Read-only, exact release gate for a portable Skill directory. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mjs', '.js', '.yaml', '.yml', '.txt']);
const REQUIRED_FULL_FILES = [
  'SKILL.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'skill-release.json',
  'agents/openai.yaml',
  'assets/reddit-comment-tree-pack/collect.mjs',
  'assets/reddit-comment-tree-pack/input.example.json',
  'assets/reddit-comment-tree-pack/pack.json',
  'references/self-iteration.md',
  'schemas/run-review.schema.json',
  'schemas/iteration-proposal.schema.json',
  'scripts/verify-pack.mjs',
  'scripts/verify-paused.mjs',
  'scripts/verify-review.mjs',
  'scripts/validate-release.mjs',
  'scripts/verify-release.mjs',
  'scripts/package-skill.mjs',
  'scripts/deploy-skill.mjs',
  'scripts/verify-portability.mjs',
  'scripts/release-skill.mjs',
  'validation.json',
];
const FORBIDDEN_JSON_KEYS = new Set([
  'taskid', 'basetaskid', 'finaltaskid', 'sourcetaskid', 'runtaskid',
  'runid', 'profile', 'profileid', 'profilename', 'postid', 'commentid',
  'liveredditcollection', 'previousliveattempt', 'offlinepausedsnapshot',
  'postsrequested', 'postsskipped', 'taskdate', 'rundate', 'runstatistics',
  'runtimecontract', 'runtimereference', 'sourcegitsha', 'testedscope',
]);
const PATTERNS = [
  { id: 'task_id', pattern: /\btask_[0-9a-f]{16,}\b/gi },
  // Prefix guard prevents the final letter of https: from looking like a drive.
  { id: 'windows_drive_absolute_path', pattern: /(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/gm },
  { id: 'windows_unc_path', pattern: /(?:^|[^A-Za-z0-9+.:-])\\\\[^\\/\s"'`<>]+\\[^\\/\s"'`<>]+/gm },
  { id: 'posix_user_or_temp_path', pattern: /(?:^|[\s("'`=])\/(?:Users|home|root|tmp)\/[^\s"'`<>)]*/gm },
  { id: 'fixed_task_master_version', pattern: /\b(?:Eric\s+)?Task\s+Master\s+(?:v(?:ersion)?\s*)?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/gi },
  { id: 'concrete_reddit_post_url', pattern: /https:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/[^\s/]+\/comments\/[a-z0-9]{5,}(?:\/|[?"'`\s])/gi },
  { id: 'concrete_profile_lease', pattern: /\bprofile_[0-9a-f]{12,}\b/gi },
];
const PLACEHOLDER = /^(?:REPLACE_WITH|PLACEHOLDER)(?:_[A-Z0-9]+)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUITE_SCRIPTS = Object.freeze({
  coreBehavior: 'scripts/verify-pack.mjs',
  pausedFinalization: 'scripts/verify-paused.mjs',
  postRunReview: 'scripts/verify-review.mjs',
  releaseCleanliness: 'scripts/verify-release.mjs',
  portablePackageAndDeploy: 'scripts/verify-portability.mjs',
});

const check = (condition, message) => { if (!condition) throw new Error(message); };
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = (root, file) => path.relative(root, file).split(path.sep).join('/');
const normalizeKey = key => String(key).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const isInside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    check(!info.isSymbolicLink(), `Symlinks are not allowed in a portable bundle: ${portable(root, absolute)}`);
    if (info.isDirectory()) files.push(...await walk(root, absolute));
    else if (info.isFile()) files.push(absolute);
    else throw new Error(`Unsupported filesystem entry: ${portable(root, absolute)}`);
  }
  return files;
}

function scanText(text, relative, findings) {
  for (const rule of PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) findings.push({ file: relative, rule: rule.id });
  }
}

function auditJson(value, relative, findings, pointer = '') {
  if (typeof value === 'string') {
    scanText(value, relative, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditJson(item, relative, findings, `${pointer}/${index}`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    check(!FORBIDDEN_JSON_KEYS.has(normalized), `Task-specific JSON field is not distributable: ${relative}:${pointer}/${key}`);
    if (normalized === 'posts' && Array.isArray(child)) {
      check(child.every(item => typeof item === 'string' && PLACEHOLDER.test(item)), `Concrete posts array is not distributable: ${relative}:${pointer}/${key}`);
    }
    auditJson(child, relative, findings, `${pointer}/${key}`);
  }
}

function auditInputExample(value, relative) {
  check(isObject(value), `${relative} must contain one JSON object`);
  check(Object.keys(value).length === 1 && Object.hasOwn(value, 'posts'), `${relative} may contain only the posts placeholder`);
  check(Array.isArray(value.posts) && value.posts.length === 1, `${relative} posts must contain exactly one placeholder`);
  check(typeof value.posts[0] === 'string' && PLACEHOLDER.test(value.posts[0]), `${relative} contains a concrete or invalid post value`);
}

async function verifyValidationInventory(root, relativeFiles, validation) {
  check(isObject(validation.artifacts), 'validation.json is missing artifacts');
  check(Array.isArray(validation.artifacts.filesExcludingValidation), 'validation.json is missing filesExcludingValidation');
  const expected = validation.artifacts.filesExcludingValidation;
  const expectedByPath = new Map();
  for (const record of expected) {
    check(isObject(record), 'validation artifact record must be an object');
    check(typeof record.path === 'string' && record.path.length > 0, 'validation artifact path is invalid');
    check(record.path === record.path.split('\\').join('/') && !record.path.startsWith('/') && !record.path.split('/').includes('..'), `validation artifact path is unsafe: ${record.path}`);
    check(record.path !== 'validation.json', 'validation.json must be excluded from its own artifact inventory');
    check(!expectedByPath.has(record.path), `duplicate validation artifact path: ${record.path}`);
    check(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `validation artifact bytes are invalid: ${record.path}`);
    check(typeof record.sha256 === 'string' && SHA256.test(record.sha256), `validation artifact SHA-256 is invalid: ${record.path}`);
    expectedByPath.set(record.path, record);
  }

  const actualPaths = relativeFiles.filter(relative => relative !== 'validation.json');
  check(expectedByPath.size === actualPaths.length, `validation artifact inventory count differs: expected ${expectedByPath.size}, actual ${actualPaths.length}`);
  const actualSet = new Set(actualPaths);
  for (const expectedPath of expectedByPath.keys()) check(actualSet.has(expectedPath), `validation artifact does not exist: ${expectedPath}`);
  for (const actualPath of actualPaths) check(expectedByPath.has(actualPath), `validation artifact inventory omits file: ${actualPath}`);

  for (const relative of actualPaths) {
    const bytes = await readFile(path.join(root, ...relative.split('/')));
    const record = expectedByPath.get(relative);
    check(record.bytes === bytes.length, `validation artifact byte count differs: ${relative}`);
    check(record.sha256 === hash(bytes), `validation artifact SHA-256 differs: ${relative}`);
  }

  const collectorPath = 'assets/reddit-comment-tree-pack/collect.mjs';
  const collector = expectedByPath.get(collectorPath);
  check(collector, `validation artifact inventory omits collector: ${collectorPath}`);
  check(typeof validation.artifacts.collectorSha256 === 'string' && SHA256.test(validation.artifacts.collectorSha256), 'validation collectorSha256 is invalid');
  check(validation.artifacts.collectorSha256 === collector.sha256, 'validation collectorSha256 differs from the collector artifact');
}

async function verifySuiteClaims(root, validation) {
  check(isObject(validation.checks), 'validation.json is missing checks');
  for (const [key, relative] of Object.entries(SUITE_SCRIPTS)) {
    const claim = validation.checks[key];
    check(isObject(claim), `validation check is missing: ${key}`);
    const source = await readFile(path.join(root, ...relative.split('/')), 'utf8');
    const declaredTests = (source.match(/(?:^|\n)\s*test\s*\(/g) ?? []).length;
    check(declaredTests > 0, `release test script declares no tests: ${relative}`);
    check(claim.status === 'passed', `validation suite is not passed: ${key}`);
    check(claim.tests === declaredTests, `validation suite test count differs: ${key}; expected ${declaredTests}, recorded ${claim.tests}`);
    check(claim.pass === declaredTests && claim.fail === 0, `validation suite pass/fail differs: ${key}`);
  }
}

function frontmatterIdentity(skillText) {
  const frontmatter = skillText.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  check(frontmatter, 'SKILL.md has no YAML frontmatter');
  const name = frontmatter.match(/^name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  const version = frontmatter.match(/^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  check(SKILL_NAME.test(name ?? ''), 'SKILL.md has no valid stable name');
  check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''), 'SKILL.md has no valid metadata.version');
  return { name, version };
}

function verifyReleaseMetadata(release, identity, pack) {
  check(isObject(release), 'skill-release.json must contain one JSON object');
  const keys = Object.keys(release).sort(lexical);
  const expectedKeys = [
    'maturity', 'name', 'no_credentials', 'no_real_data', 'no_task_config',
    'platform', 'schema', 'taskmaster_contract', 'version',
  ].sort(lexical);
  check(JSON.stringify(keys) === JSON.stringify(expectedKeys), 'skill-release.json contains missing or unsupported fields');
  check(release.schema === 1, 'skill-release.json schema must be 1');
  check(release.name === identity.name, 'Skill frontmatter and skill-release names differ');
  check(release.version === identity.version, 'Skill frontmatter and skill-release versions differ');
  check(release.platform === 'reddit', 'skill-release.json platform must be reddit');
  check(release.maturity === 'portable-offline-validated', 'skill-release.json maturity must describe the verified scope');
  check(release.no_task_config === true, 'skill-release.json must declare no_task_config');
  check(release.no_credentials === true, 'skill-release.json must declare no_credentials');
  check(release.no_real_data === true, 'skill-release.json must declare no_real_data');

  const contract = release.taskmaster_contract;
  check(isObject(contract), 'skill-release.json is missing taskmaster_contract');
  const contractKeys = Object.keys(contract).sort(lexical);
  const expectedContractKeys = ['adapter_rule', 'binding', 'optional_capabilities', 'required_capabilities', 'version_pinned'].sort(lexical);
  check(JSON.stringify(contractKeys) === JSON.stringify(expectedContractKeys), 'taskmaster_contract contains missing or unsupported fields');
  check(contract.binding === 'capability-based', 'Task Master binding must be capability-based');
  check(contract.version_pinned === false, 'Task Master version must not be pinned');
  check(Array.isArray(contract.required_capabilities) && contract.required_capabilities.length > 0, 'Task Master required capabilities are missing');
  check(Array.isArray(contract.optional_capabilities), 'Task Master optional capabilities must be an array');
  check(typeof contract.adapter_rule === 'string' && contract.adapter_rule.length > 0, 'Task Master adapter rule is missing');
  check(isObject(pack.required_runtime_capabilities), 'Pack required runtime capabilities are missing');
  for (const capability of ['page.goto', 'response-body-read', 'writable-output-directory']) {
    check(contract.required_capabilities.includes(capability), `Task Master contract omits ${capability}`);
  }

  const hashKey = key => /(?:^|_)(?:sha(?:256)?|hash(?:es)?)(?:_|$)/i.test(key);
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      check(!hashKey(key), `skill-release.json must not contain file hashes: ${key}`);
      visit(child);
    }
  };
  visit(release);
}

export async function validateRelease(skillDirectory, options = {}) {
  check(typeof skillDirectory === 'string', 'SKILL_DIR is required');
  const root = await realpath(path.resolve(skillDirectory));
  check((await lstat(root)).isDirectory(), 'SKILL_DIR must be a directory');
  const files = (await walk(root)).sort((a, b) => lexical(portable(root, a), portable(root, b)));
  const relativeFiles = files.map(file => portable(root, file));
  check(relativeFiles.includes('SKILL.md'), 'Portable bundle is missing SKILL.md');
  const full = options.full !== false;

  const findings = [];
  const jsonFiles = new Map();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const relative = relativeFiles[index];
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const bytes = await readFile(file);
    check(bytes.length <= 2_000_000, `Text file exceeds the portability audit limit: ${relative}`);
    const text = bytes.toString('utf8');
    scanText(text, relative, findings);
    if (extension === '.json') {
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw new Error(`${relative} is not valid JSON`); }
      jsonFiles.set(relative, parsed);
      auditJson(parsed, relative, findings);
      if (relative.endsWith('/input.example.json') || relative === 'input.example.json') auditInputExample(parsed, relative);
    }
    if (extension === '.md') {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!link || /^(?:https?:|mailto:)/i.test(link)) continue;
        const target = path.resolve(path.dirname(file), ...decodeURIComponent(link).split('/'));
        check(target === root || isInside(root, target), `Documentation link escapes the Skill: ${relative} -> ${link}`);
        let info;
        try { info = await lstat(target); } catch { throw new Error(`Documentation link is missing: ${relative} -> ${link}`); }
        check(info.isFile() && !info.isSymbolicLink(), `Documentation link is not a regular file: ${relative} -> ${link}`);
      }
    }
  }
  check(findings.length === 0, `Portable-bundle findings: ${findings.map(item => `${item.file}:${item.rule}`).join(', ')}`);

  if (full) for (const required of REQUIRED_FULL_FILES) check(relativeFiles.includes(required), `Portable bundle is missing ${required}`);

  const packPaths = relativeFiles.filter(file => /(^|\/)pack\.json$/.test(file));
  for (const relative of packPaths) {
    const pack = jsonFiles.get(relative);
    check(isObject(pack), `${relative} must contain one JSON object`);
    check(!Object.hasOwn(pack, 'runtime_reference'), `${relative} must declare capabilities, not a version-bound runtime_reference`);
    check(!Object.hasOwn(pack, 'tested_scope'), `${relative} must keep live-run evidence outside the distributable bundle`);
  }

  let skillVersion = null;
  let skillName = null;
  if (full) {
    const skillText = await readFile(path.join(root, 'SKILL.md'), 'utf8');
    const identity = frontmatterIdentity(skillText);
    skillName = identity.name;
    skillVersion = identity.version;
    const pack = jsonFiles.get('assets/reddit-comment-tree-pack/pack.json');
    const validation = jsonFiles.get('validation.json');
    const release = jsonFiles.get('skill-release.json');
    check(isObject(pack) && isObject(validation) && isObject(release), 'Pack, release metadata or validation JSON is missing');
    check(pack.version === skillVersion && validation.bundleVersion === skillVersion, 'Skill, Pack and validation versions differ');
    verifyReleaseMetadata(release, identity, pack);
    check(isObject(pack.required_runtime_capabilities) && !Object.hasOwn(pack, 'runtime_reference'), 'Pack must bind to capabilities instead of a runtime version');
    const collector = await readFile(path.join(root, 'assets/reddit-comment-tree-pack/collect.mjs'), 'utf8');
    check(collector.includes('run-retrospective.json') && collector.includes('autoMutationAllowed: false'), 'Collector must emit a non-mutating post-run retrospective');
    check(validation.releaseStatus === 'passed', 'validation.json must be finalized before release');
    await verifyValidationInventory(root, relativeFiles, validation);
    await verifySuiteClaims(root, validation);
  }

  return {
    status: 'passed', ...(skillVersion ? { name: skillName, version: skillVersion } : {}), files: files.length,
    rules: PATTERNS.map(rule => rule.id), jsonFilesChecked: jsonFiles.size,
    validationInventoryChecked: full,
  };
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length !== 3) throw new Error('Usage: node validate-release.mjs SKILL_DIR');
  process.stdout.write(`${JSON.stringify(await validateRelease(process.argv[2]))}\n`);
}
