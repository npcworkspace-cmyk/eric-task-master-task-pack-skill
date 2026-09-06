#!/usr/bin/env node
/** Deterministic, dependency-free ZIP builder for one portable Skill directory. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './validate-release.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const DOS_DATE = 33; // 1980-01-01, stable across machines and time zones.

const CRC_TABLE = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function canonicalTarget(file) {
  const resolved = path.resolve(file);
  let ancestor = path.dirname(resolved);
  const missing = [path.basename(resolved)];
  while (true) {
    try { return path.join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      check(parent !== ancestor, `Cannot resolve an existing output ancestor: ${resolved}`);
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
const identity = info => ({ dev: info.dev, ino: info.ino });
const sameIdentity = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
async function removeOwned(file, ownedIdentity) {
  if (!ownedIdentity) return;
  let current;
  try { current = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return; else throw error; }
  if (current.isFile() && !current.isSymbolicLink() && sameIdentity(identity(current), ownedIdentity)) {
    await rm(file, { force: false });
  }
}
async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    check(!info.isSymbolicLink(), `ZIP source contains a symlink: ${path.relative(root, absolute)}`);
    if (info.isDirectory()) files.push(...await walk(root, absolute));
    else if (info.isFile()) files.push(absolute);
    else throw new Error(`Unsupported ZIP source entry: ${path.relative(root, absolute)}`);
  }
  return files;
}
function localHeader(name, bytes, crc) {
  const result = Buffer.alloc(30);
  result.writeUInt32LE(0x04034b50, 0);
  result.writeUInt16LE(20, 4);
  result.writeUInt16LE(0x0800, 6);
  result.writeUInt16LE(0, 8);
  result.writeUInt16LE(0, 10);
  result.writeUInt16LE(DOS_DATE, 12);
  result.writeUInt32LE(crc, 14);
  result.writeUInt32LE(bytes.length, 18);
  result.writeUInt32LE(bytes.length, 22);
  result.writeUInt16LE(name.length, 26);
  return result;
}
function centralHeader(name, bytes, crc, offset) {
  const result = Buffer.alloc(46);
  result.writeUInt32LE(0x02014b50, 0);
  result.writeUInt16LE(20, 4);
  result.writeUInt16LE(20, 6);
  result.writeUInt16LE(0x0800, 8);
  result.writeUInt16LE(0, 10);
  result.writeUInt16LE(0, 12);
  result.writeUInt16LE(DOS_DATE, 14);
  result.writeUInt32LE(crc, 16);
  result.writeUInt32LE(bytes.length, 20);
  result.writeUInt32LE(bytes.length, 24);
  result.writeUInt16LE(name.length, 28);
  result.writeUInt32LE(offset, 42);
  return result;
}

export async function packageSkill(skillDirectory, newZipFile, options = {}) {
  check(typeof skillDirectory === 'string' && typeof newZipFile === 'string', 'SKILL_DIR and NEW_ZIP are required');
  const source = await realpath(path.resolve(skillDirectory));
  check((await lstat(source)).isDirectory(), 'SKILL_DIR must be a directory');
  if (options.validateRelease !== false) await validateRelease(source, { full: true });
  const skillName = path.basename(source);
  check(/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName), 'Skill directory name is not portable');
  const requestedTarget = path.resolve(newZipFile);
  check(path.extname(requestedTarget).toLowerCase() === '.zip', 'NEW_ZIP must end in .zip');
  const target = await canonicalTarget(requestedTarget);
  check(!inside(source, target), 'ZIP target must be outside the Skill source directory');
  try { await lstat(target); throw new Error('ZIP target already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }

  const files = (await walk(source)).sort((a, b) => lexical(
    path.relative(source, a).split(path.sep).join('/'),
    path.relative(source, b).split(path.sep).join('/'),
  ));
  check(files.length > 0 && files.length < 65535, 'ZIP file count is outside the classic ZIP limit');
  const localParts = [];
  const centralParts = [];
  const inventory = [];
  let offset = 0;
  for (const file of files) {
    const relative = path.relative(source, file).split(path.sep).join('/');
    check(relative && !relative.startsWith('/') && !relative.split('/').includes('..'), 'ZIP entry path is unsafe');
    const name = Buffer.from(`${skillName}/${relative}`, 'utf8');
    const bytes = await readFile(file);
    check(bytes.length <= 0xffffffff && offset <= 0xffffffff, 'ZIP64 is not supported by this small release builder');
    const crc = crc32(bytes);
    const header = localHeader(name, bytes, crc);
    localParts.push(header, name, bytes);
    centralParts.push(centralHeader(name, bytes, crc, offset), name);
    offset += header.length + name.length + bytes.length;
    inventory.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, central, end]);
  await mkdir(path.dirname(target), { recursive: true });
  let handle = null;
  let ownedIdentity = null;
  try {
    handle = await open(target, 'wx+');
    ownedIdentity = identity(await handle.stat());
    await handle.writeFile(archive);
    await handle.sync();
    if (typeof options.afterArchiveWritten === 'function') await options.afterArchiveWritten(target);
    const reread = Buffer.alloc(archive.length);
    let read = 0;
    while (read < reread.length) {
      const result = await handle.read(reread, read, reread.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const extra = await handle.read(trailing, 0, 1, archive.length);
    check(read === archive.length && extra.bytesRead === 0 && reread.equals(archive), 'ZIP changed while being written');
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try { await removeOwned(target, ownedIdentity); }
    catch (cleanupError) { error.cause = cleanupError; }
    throw error;
  }
  return {
    status: 'passed', skillName, files: inventory.length, bytes: archive.length,
    sha256: sha256(archive), inventory, releaseValidation: options.validateRelease === false ? 'skipped' : 'passed',
    outputIdentity: ownedIdentity,
  };
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length !== 4) throw new Error('Usage: node package-skill.mjs SKILL_DIR NEW_ZIP');
  const result = await packageSkill(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify({ status: result.status, files: result.files, bytes: result.bytes, sha256: result.sha256 })}\n`);
}
