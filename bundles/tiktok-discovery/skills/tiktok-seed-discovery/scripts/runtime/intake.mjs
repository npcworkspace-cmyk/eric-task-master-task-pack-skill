import fs from 'node:fs/promises';
import path from 'node:path';
import { isMain } from './environment.mjs';
import { createHash } from 'node:crypto';

export const INTAKE_SCHEMA = 'tiktok-reference-intake-v2';
const clean = value => String(value ?? '').trim();
const relationTypes = new Set(['competitor', 'brand_partner', 'style_reference']);
export function calendarWindow(asOf, months = 6) {
  const end = new Date(asOf);
  if (!Number.isFinite(end.valueOf()) || ![6, 12].includes(months)) throw Error('Valid asOf and lookbackMonths 6 or 12 required');
  const start = new Date(end);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  return { start: start.toISOString(), end: end.toISOString(), lookbackMonths: months, semantics: 'inclusive_UTC_calendar_month_window' };
}
export function validateIntake(input, now = new Date().toISOString()) {
  const questions = [], errors = [];
  const countries = [...new Set((input.countries ?? input.targetCountries ?? (input.country ? [input.country] : [])).map(value => clean(value).toUpperCase()))];
  if (!countries.length) questions.push({ field: 'countries', question: '要推广哪些国家？' });
  else if (countries.some(value => !/^[A-Z]{2}$/.test(value))) errors.push('countries must use ISO 3166-1 alpha-2 codes; Agent normalizes customer country names explicitly');
  const min = input.followersMin, max = input.followersMax;
  if (min === undefined || max === undefined) questions.push({ field: 'followers', question: '希望红人的粉丝数在哪个区间？请给下限和上限。' });
  else if (![min, max].every(value => Number.isSafeInteger(value) && value >= 0) || min > max) errors.push('Invalid follower interval');
  const references = Array.isArray(input.references) ? input.references : [];
  if (references.length < 3 || references.length > 5) questions.push({ field: 'references', question: '请提供 3–5 条参考链接，并逐条注明：竞品、品牌已合作红人，或希望合作的红人风格参考。' });
  const normalized = [], seen = new Set();
  for (const [index, ref] of references.entries()) {
    let url;
    try { url = new URL(ref.url); if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error(); } catch { errors.push(`references[${index}].url must be a public HTTPS URL`); continue; }
    url.hash = '';
    if (seen.has(url.href)) { errors.push(`Duplicate reference at index ${index}`); continue; }
    seen.add(url.href);
    if (!relationTypes.has(ref.type)) questions.push({ field: `references[${index}].type`, question: `第 ${index + 1} 条参考链接属于竞品、品牌已合作红人，还是风格参考？` });
    normalized.push({ id: ref.id ?? `ref-${index + 1}`, url: url.href, type: ref.type, note: clean(ref.note), relationSource: 'user_declared_not_independently_verified', platform: /(^|\.)tiktok\.com$/i.test(url.hostname) ? 'tiktok' : 'external_needs_tiktok_mapping' });
  }
  if (new Set(normalized.map(ref => ref.id)).size !== normalized.length || normalized.some(ref => !/^[\w-]{1,80}$/.test(ref.id))) errors.push('Reference IDs must be distinct simple identifiers');
  const creatorDescription = clean(input.creatorDescription);
  if (!creatorDescription) questions.push({ field: 'creatorDescription', question: '要找哪类红人、什么内容风格？例如领域、擅长的内容、希望接近或避开的特点。' });
  let window;
  try { window = calendarWindow(input.asOf ?? now, input.lookbackMonths ?? 6); } catch (error) { errors.push(error.message); }
  const inputStatus = errors.length ? 'invalid_input' : questions.length ? 'needs_user_input' : 'ready';
  const id = input.id ?? `tk-${createHash('sha256').update(JSON.stringify({ countries, min, max, references: normalized, creatorDescription, window })).digest('hex').slice(0, 16)}`;
  return { schemaVersion: INTAKE_SCHEMA, status: inputStatus, questions, errors,
    brief: { id, topic: clean(input.topic) || creatorDescription, creatorDescription, creatorCategories: input.creatorCategories ?? [], countries, targetCountries: countries, country: countries[0], followersMin: min, followersMax: max, countryMeaning: input.countryMeaning ?? 'promotion_market', references: normalized, referenceWindow: window, topicTerms: input.topicTerms ?? [], brandTerms: [], locationTermsByCountry: input.locationTermsByCountry ?? {}, locationCues: input.locationCues ?? [], referenceInputStatus: inputStatus, referenceAnalysisStatus: 'pending' },
    execution: { profile: input.execution?.profile ?? null, notBefore: input.execution?.notBefore ?? null, policyFile: input.execution?.policyFile ?? null },
    customerQuestionPolicy: 'Ask all missing required business fields together; retain supplied values; never invent links or reference types.' };
}
export async function prepareIntake(input, outDir) {
  let existingBrief = null;
  try { existingBrief = JSON.parse((await fs.readFile(path.join(outDir, 'brief.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = validateIntake({ ...input, asOf: input.asOf ?? existingBrief?.referenceWindow?.end });
  if (existingBrief && JSON.stringify(existingBrief) !== JSON.stringify(result.brief)) throw Error('JOB_BRIEF_CONFLICT: preserve the frozen Brief/window; use a new job directory for changed requirements');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'intake-status.json'), JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'ready') return result;
  const defaults = { maxScrollsPerReference: 200, maxPostsPerReference: 5000, maxWallMs: 1800000, pageWaitMs: 20000, scrollWaitMs: 1800, noNewScrollLimit: 3 };
  const limits = { ...defaults, ...(input.referenceLimits ?? {}) };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (key === 'maxScrollsPerReference' ? 0 : 1)) throw Error(`Invalid reference limit ${key}`);
  if (limits.maxPostsPerReference > 50000 || limits.maxScrollsPerReference > 2000 || limits.maxWallMs > 43200000) throw Error('Reference collection exceeds bounded budget');
  const browserInput = { version: 'reference-browser-v2', briefId: result.brief.id, references: result.brief.references, window: result.brief.referenceWindow, limits, notBefore: result.execution.notBefore, controlFile: path.resolve(outDir, 'control.json') };
  if (existingBrief) {
    const oldInput = JSON.parse((await fs.readFile(path.join(outDir, 'reference-input.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (JSON.stringify(oldInput) !== JSON.stringify(browserInput)) throw Error('JOB_EXECUTION_CONFLICT: do not overwrite an existing batch configuration while resuming');
  }
  await fs.writeFile(path.join(outDir, 'brief.json'), JSON.stringify(result.brief, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'reference-input.json'), JSON.stringify(browserInput, null, 2) + '\n');
  // Preserve existing pause/cooldown state on repeated intake.
  try { await fs.writeFile(path.join(outDir, 'control.json'), JSON.stringify({ status: 'ready', notBefore: result.execution.notBefore }, null, 2) + '\n', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { ...result, outDir: path.resolve(outDir), referenceInput: path.resolve(outDir, 'reference-input.json'), unresolvedReferences: result.brief.references.filter(ref => ref.platform !== 'tiktok').map(ref => ref.id) };
}
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
    if (!args.includes('--input') || !args.includes('--out')) throw Error('Usage: intake.mjs --input <customer-brief.json> --out <job-directory>');
    const data = JSON.parse((await fs.readFile(value('--input'), 'utf8')).replace(/^\uFEFF/, ''));
    const result = await prepareIntake(data, path.resolve(value('--out')));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'invalid_input') process.exitCode = 1;
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
