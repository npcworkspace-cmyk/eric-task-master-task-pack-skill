import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseListing, assessCoverage, run } from '../../../tiktok-seed-discovery/scripts/runtime/reference-browser.mjs';
import { validateIntake, prepareIntake } from '../../../tiktok-seed-discovery/scripts/runtime/intake.mjs';

// Offline synthetic protocol/fixture tests only. No browser or network is used.
const window = { start: '2026-03-06T00:00:00.000Z', end: '2026-09-06T00:00:00.000Z' };
const epoch = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
const item = (id = '10001', owner = 'fixturecreator', extra = {}) => ({ id, desc: 'Demonstration #fixture @brand', createTime: epoch, author: { id: '991', uniqueId: owner, nickname: 'Fixture Creator' }, stats: { playCount: 100, diggCount: 10 }, textExtra: [], ...extra });
const pageRecord = (requestCursor, nextCursor, hasMore, extra = {}) => ({ requestCursor, nextCursor, hasMore, identityVerified: true, businessStatusCode: 0, rejectedItems: 0, ...extra });
const coverage = (pages, posts, extra = {}) => assessCoverage({ pages, posts, identityVerified: true, stopReason: 'native_list_exhausted', window, ...extra });
const baseBrief = (extra = {}) => ({ countries: ['DE'], followersMin: 10000, followersMax: 500000, creatorDescription: '技术内容与真实产品演示', references: ['a','b','c'].map((name, index) => ({ id: `r${index}`, url: `https://www.tiktok.com/@${name}`, type: 'style_reference' })), ...extra });
async function temp(t) { const root = path.resolve(os.tmpdir()), dir = await fs.mkdtemp(path.join(root, 'tk-reference-review-')); t.after(async () => { if (path.dirname(path.resolve(dir)) !== root || !path.basename(dir).startsWith('tk-reference-review-')) throw Error('Invalid fixture cleanup target'); await fs.rm(dir, { recursive: true, force: true }); }); return dir; }

function fakePage({ responsePlan = [], owner = 'fixturecreator' } = {}) {
  const handlers = new Map(), navigations = []; let currentUrl = 'about:blank', profileLoads = 0, fired = false;
  const emit = (name, payload) => handlers.get(name)?.(payload);
  return {
    navigations,
    on(name, handler) { handlers.set(name, handler); }, off(name) { handlers.delete(name); },
    async goto(url) { currentUrl = url; navigations.push(url); if (url === `https://www.tiktok.com/@${owner}`) { profileLoads++; fired = false; } },
    async waitForTimeout() {}, async waitForFunction() {},
    async evaluate(fn) {
      if (fn.name === 'scrollProfile') return { before: 0, after: 400 };
      if (profileLoads && !fired) {
        fired = true;
        for (const entry of responsePlan) {
          const req = { url: () => `https://www.tiktok.com/api/post/item_list/?cursor=${entry.cursor ?? '0'}` };
          emit('request', req);
          emit('response', { request: () => req, status: () => entry.status ?? 200, headers: () => ({ 'content-type': 'application/json' }), json: async () => entry.body });
        }
      }
      return { url: currentUrl, text: '', verification: false, fields: [{ field: 'user-unique-id', text: owner }], links: [], anchorCaption: 'Visible reference caption' };
    }
  };
}
const runInput = (extra = {}) => ({ briefId: 'fixture-brief', references: [{ id: 'ref1', url: 'https://www.tiktok.com/@fixturecreator/video/10001', type: 'style_reference' }], window, limits: { maxPostsPerReference: 20, maxScrollsPerReference: 3, maxWallMs: 5000, pageWaitMs: 1000, scrollWaitMs: 1, noNewScrollLimit: 1 }, ...extra });
async function runOffline(t, page, input) { const outputDir = await temp(t); const result = await run({ page, input, outputDir, progress: async () => {}, wait: async () => {} }); return { result, corpus: JSON.parse(await fs.readFile(path.join(outputDir, 'reference-corpus.json'), 'utf8')) }; }

test('complete coverage requires a connected native cursor chain starting at head', () => {
  assert.equal(coverage([pageRecord('0','20',true),pageRecord('20','40',false)], [item()]).status, 'complete_visible_public_window');
  assert.equal(coverage([pageRecord('20','40',false)], [item()]).status, 'partial');
  assert.equal(coverage([pageRecord('0','20',true),pageRecord('40','60',false)], [item()]).status, 'partial');
  assert.equal(coverage([pageRecord('0','20',true),pageRecord('20','0',true)], [item()]).status, 'partial');
});
test('unknown dates prevent complete-window claims and pinned old posts do not stop enumeration', () => {
  const pages = [pageRecord('0',null,false)];
  const unknown = item('10002','fixturecreator',{createTime:null});
  assert.equal(coverage(pages, [unknown]).status, 'partial');
  assert.equal(coverage(pages, [unknown]).unknownDate, 1);
  assert.equal(coverage([pageRecord('0','20',true)], [item('10003','fixturecreator',{createTime:1,isPinned:true})]).status, 'partial');
});
test('foreign authored entries are rejected and break complete coverage', () => {
  const parsed = parseListing({statusCode:0,itemList:[item('10004','anothercreator')],hasMore:false,cursor:'0'}, 'fixturecreator');
  assert.equal(parsed.items.length,0); assert.equal(parsed.rejectedItems,1);
  assert.equal(coverage([pageRecord('0',null,false,parsed)], []).status, 'partial');
});
test('paused checkpoint protects against any browser navigation', async t => {
  const output = await temp(t), controlFile = path.join(output,'control.json');
  await fs.writeFile(controlFile,JSON.stringify({status:'paused_user_cooldown'}));
  const page = fakePage();
  const result = await run({page,input:runInput({controlFile}),outputDir:output,progress:async()=>{},wait:async()=>{}});
  assert.equal(page.navigations.length,0); assert.equal(result.stopReason,'USER_PAUSED');
});
test('successful passive fixture can enumerate a real-shaped list without screenshots', async t => {
  const page = fakePage({ responsePlan:[{body:{statusCode:0,itemList:[item()],hasMore:false,cursor:'0'}}] });
  const {result} = await runOffline(t,page,runInput());
  assert.equal(result.posts,1); assert.equal(result.fullyCoveredReferences,1);
});
test('access restriction detected after surface guard must prevent complete-reference claim', async t => {
  const page = fakePage({ responsePlan:[{body:{statusCode:0,itemList:[item()],hasMore:false,cursor:'0'}},{status:429,body:{}}] });
  const {result,corpus} = await runOffline(t,page,runInput());
  assert.equal(result.stopReason,'ACCESS_LIMIT');
  assert.equal(corpus.references[0].coverage.status,'partial');
  assert.equal(result.fullyCoveredReferences,0);
});
test('repeated intake preserves the first as-of window and brief identity', async t => {
  const dir = await temp(t), input = baseBrief();
  const before = await prepareIntake(input,dir);
  await new Promise(resolve=>setTimeout(resolve,10));
  const after = await prepareIntake(input,dir);
  assert.deepEqual(after.brief.referenceWindow,before.brief.referenceWindow);
  assert.equal(after.brief.id,before.brief.id);
});
test('repeated intake preserves an existing paused control file', async t => {
  const dir = await temp(t), input = baseBrief({asOf:'2026-09-06T00:00:00.000Z'});
  await prepareIntake(input,dir);
  const preserved = {status:'paused_user_cooldown',notBefore:'2036-09-07T01:00:00.000Z'};
  await fs.writeFile(path.join(dir,'control.json'),JSON.stringify(preserved));
  await prepareIntake(input,dir);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'control.json'),'utf8')),preserved);
});
test('promotion country is not silently changed into creator residence', () => {
  const result=validateIntake(baseBrief({asOf:'2026-09-06T00:00:00.000Z'}));
  assert.notEqual(result.brief.countryMeaning,'creator_location');
});
test('same reference author does not require repeating the complete profile enumeration', async t => {
  const page=fakePage({responsePlan:[{body:{statusCode:0,itemList:[item()],hasMore:false,cursor:'0'}}]});
  const refs=[1,2,3].map(number=>({id:`ref${number}`,url:`https://www.tiktok.com/@fixturecreator/video/${10000+number}`,type:'style_reference'}));
  const {result}=await runOffline(t,page,runInput({references:refs}));
  assert.equal(result.references,3);
  assert.equal(result.posts,1);
  assert.equal(result.postObservations,3);
  assert.equal(page.navigations.filter(url=>url==='https://www.tiktok.com/@fixturecreator').length,1);
});
