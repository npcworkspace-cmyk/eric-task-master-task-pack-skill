import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {run,semanticActionKey,normalizeHandle,parseInstagramWork,isCandidateEvidence,parseCommittedJSONL,validateInput,extractSnapshotDOM} from './collect.mjs';

const dirs=[];
after(async()=>{for(const dir of dirs){const absolute=path.resolve(dir),base=path.resolve(os.tmpdir());assert(absolute.startsWith(base+path.sep)&&path.basename(absolute).startsWith('ig-collector-test-'));await fs.rm(absolute,{recursive:true,force:true});}});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(actions,extra={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ig-collector-test-'));dirs.push(root);const baselinePath=path.join(root,'baseline.json'),bytes=JSON.stringify({handles:['baseline']});await fs.writeFile(baselinePath,bytes);
 return{root,input:{runId:'synthetic-study',batchId:'test-batch',runDir:path.join(root,'run'),baselinePath,baselineSha256:hash(bytes),targetCount:10,actions,waits:{navigationMs:1,mainMs:1,settleMs:0,listInitialMs:0,listScrollMs:0,gridMs:0},...extra},outputDir:path.join(root,'output')};
}
const profile=(seed='seed',routeId='profile_enrich')=>({routeId,seed,url:`https://www.instagram.com/${seed}/`,maxProfilePosts:2});
const list=(seed='seed',routeId='following')=>({...profile(seed,routeId),maxAccounts:2,maxScrolls:1});
const content=(work='AAA')=>({routeId:'keyword_content',query:'synthetic query',url:'https://www.instagram.com/explore/search/keyword/?q=synthetic',maxWorks:1,resolveLimit:1,maxScrolls:0,workUrls:[`https://www.instagram.com/reel/${work}/`]});
const snapshot=(url,extra={})=>({url,title:'synthetic page',scope:'main',text:'Visible synthetic page evidence',links:[],topLinks:[],authorHeaderFound:false,authorHeaderText:null,times:[],...extra});
class MockPage {
 constructor(onSnapshot,options={}){this.onSnapshot=onSnapshot;this.options=options;this.gotos=[];this.captures=[];this.url='';this.toggled=false;this.dialog=false;}
 async goto(url){this.url=url;this.gotos.push(url);this.toggled=false;this.dialog=false;return{status:()=>this.options.httpStatus||200};}
 locator(){return{waitFor:async()=>{}};}
 async waitForTimeout(){if(this.options.delayMs)await new Promise(r=>setTimeout(r,this.options.delayMs));}
 getByRole(role,{name}){const label=String(name),isToggle=role==='button',isAll=label.includes('See all');return{count:async()=>isAll&&this.options.noSeeAll?0:1,isVisible:async()=>true,click:async()=>{if(isToggle)this.toggled=true;else this.dialog=true;}};}
 async evaluate(fn,arg){if(arg&&'scope'in arg){const d=this.onSnapshot(this,arg);this.captures.push(structuredClone(d));return structuredClone(d);}return this.options.scroll!==false;}
}
const execute=(f,page,extra={})=>run({page,input:f.input,outputDir:f.outputDir,progress:async()=>{},wait:async()=>{},signal:{aborted:false},...extra});
async function rows(f,name){try{return parseCommittedJSONL(await fs.readFile(path.join(f.input.runDir,name),'utf8')).records;}catch(e){if(e.code==='ENOENT')return[];throw e;}}

test('keys cover nested budgets, filters, scope and batch while excluding root runtime fields',()=>{
 const a={routeId:'following',seed:'seed',url:'https://www.instagram.com/seed/',budget:{maxAccounts:5},window:{after:'A'}}; // Synthetic fixture.
 const key=semanticActionKey(a,'b');assert.equal(key.length,64);assert.equal(key,semanticActionKey({...a,status:'partial',attemptId:'x',durationMs:20},'b'));
 assert.notEqual(key,semanticActionKey({...a,budget:{maxAccounts:6}},'b'));assert.notEqual(key,semanticActionKey({...a,window:{after:'B'}},'b'));assert.notEqual(key,semanticActionKey(a,'c'));
 assert.notEqual(key,semanticActionKey({...a,budget:{maxAccounts:5,status:'semantic'}},'b'));assert.throws(()=>semanticActionKey({...a,batchId:'bad'},'b'),/Conflicting batch/);
});
test('normalization rejects non-IG domains, credentials and reserved routes; shortcode case retained',()=>{
 assert.equal(normalizeHandle(' @Example.Name '),'example.name');assert.equal(normalizeHandle('https://instagram.com/Example.Name/?x=1'),'example.name');
 for(const u of ['https://evil.example/name/','https://x:secret@instagram.com/name/','https://instagram.com/accounts/','https://instagram.com/api/'])assert.equal(normalizeHandle(u),null);
 assert.equal(parseInstagramWork('https://evil.example/reel/AAA/'),null);assert.equal(parseInstagramWork('/alice/reels/Ab_C-1/').key,'instagram:work:Ab_C-1');assert.notEqual(parseInstagramWork('/p/abc/').key,parseInstagramWork('/p/ABC/').key);
});
test('candidate attribution excludes background profile, wrong route and incomplete named cues',()=>{
 const base={handle:'person',seed:'person',routeId:'profile_credit_repost',evidenceKind:'profile',lookupOnly:true,routeVariant:'named_profile_lookup',parentSeed:'parent',sourceWorkUrl:'/p/AAA/',cueEvidenceId:'proof.json',sourceUrl:'https://www.instagram.com/person/'}; // Synthetic fixture.
 assert(isCandidateEvidence(base));assert(!isCandidateEvidence({...base,cueEvidenceId:null}));assert(!isCandidateEvidence({...base,routeId:'following'}));assert(!isCandidateEvidence({...base,routeId:'profile_enrich'}));
 assert(isCandidateEvidence({handle:'person',routeId:'following',evidence_kind:'account_card',sourceUrl:'https://www.instagram.com/seed/'}));assert(!isCandidateEvidence({handle:'person',routeId:'unknown',evidenceKind:'account_card'}));assert(!isCandidateEvidence({handle:'person',routeId:'following',evidenceKind:'content_author'})); // Synthetic fixture.
});
test('JSONL requires newline commit, keeps incomplete tail and rejects middle corruption',()=>{
 const p=parseCommittedJSONL('{"name":"骑车"}\n{"uncommitted":true}');assert.equal(p.records.length,1);assert.equal(p.ignoredTail,'{"uncommitted":true}');assert.equal(p.committedBytes,Buffer.byteLength('{"name":"骑车"}\n'));
 assert.throws(()=>parseCommittedJSONL('{"a":1}\nBROKEN\n{"b":2}\n'),/at line 2/);
});
test('explicit business budgets, routes and URL contracts fail closed',async()=>{
 const f=await fixture([list()]);assert.equal(validateInput(f.input),f.input);
 for(const changed of [{...list(),maxAccounts:0},{...list(),url:'https://evil.example/seed/'},{...list(),routeId:'unknown'},{...profile('seed','profile_credit_repost')},{...list(),budget:{maxAccounts:9}}])assert.throws(()=>validateInput({...f.input,actions:[changed]}));
 assert.throws(()=>validateInput({...f.input,targetCount:undefined}));
 assert.throws(()=>validateInput({...f.input,waits:{navigationMs:0}}));
});
test('actual run excludes seed profile, counts cards, journals target-unstarted and completed replay',async()=>{
 const f=await fixture([list(),list('other')],{targetCount:2});
 const p=new MockPage((p,a)=>snapshot(p.url,a.scope==='dialog'?{scope:'dialog',links:[{href:'/one/',text:'One'},{href:'/two/',text:'Two'}]}:{}));
 const r=await execute(f,p);assert.equal(r.netNew,2);assert.equal(r.state,'complete');assert.equal(r.executed,1);assert.equal((await rows(f,'accounts.jsonl')).length,3);assert.equal((await rows(f,'dispatch.jsonl'))[0].reason,'target_reached');
 const q=new MockPage(()=>{throw Error('Replay should not browse');});const replay=await execute(f,q);assert.equal(replay.netNew,2);assert.equal(q.gotos.length,0);assert((await rows(f,'dispatch.jsonl')).some(x=>x.reason==='already_completed'));
});
test('Similar toggle loading failure is saved and stops later actions of that route',async()=>{
 const f=await fixture([list('seed','profile_similar'),list('other','profile_similar')]);const p=new MockPage(p=>snapshot(p.url,{text:p.toggled?'加载失败':'Visible seed profile'}));
 const r=await execute(f,p);assert.equal(r.state,'partial');assert.equal(r.netNew,0);assert.equal(r.routeStops.profile_similar,'load_failed');assert.equal(p.gotos.length,1);assert.equal((await rows(f,'actions.jsonl')).at(-1).stopReason,'load_failed');
 const evidence=await rows(f,'evidence.jsonl');assert.equal(evidence.length,2);const saved=JSON.parse(await fs.readFile(path.join(f.input.runDir,'snapshots',evidence[1].evidenceId),'utf8'));assert.equal(saved.phase,'similar_toggle_result');assert.equal(saved.state,'load_failed');
});
test('verification waits once then returns partial, preserving remaining unstarted actions',async()=>{
 const f=await fixture([profile(),profile('second')]);const p=new MockPage(()=>snapshot('https://www.instagram.com/challenge/'));let waited=0;
 const r=await execute(f,p,{wait:async({reason})=>{assert.equal(reason,'verification');waited++;}});assert.equal(waited,1);assert.equal(r.state,'partial');assert.equal(r.stopReason,'VERIFICATION_RESUME_RECHECK_REQUIRED');assert.equal(p.gotos.length,1);assert.equal((await rows(f,'dispatch.jsonl')).at(-1).status,'unstarted');
});
test('expected profile redirect is not accepted as the seed',async()=>{
 const f=await fixture([profile()]);const r=await execute(f,new MockPage(()=>snapshot('https://www.instagram.com/wrong/')));assert.equal(r.state,'partial');assert.equal((await rows(f,'accounts.jsonl')).length,0);assert.equal((await rows(f,'identity-events.jsonl'))[0].observedHandle,'wrong');
});
test('evidenced named lookup verifies actual profile and contributes one candidate',async()=>{
 const action={...profile('named_person','profile_credit_repost'),lookupOnly:true,routeVariant:'named_profile_lookup',parentSeed:'parent',sourceWorkUrl:'https://www.instagram.com/reel/PRIOR/',cueEvidenceId:'prior-work-proof.json'}; // Synthetic fixture.
 const f=await fixture([action],{targetCount:1});const r=await execute(f,new MockPage(p=>snapshot(p.url)));assert.equal(r.netNew,1);assert.equal(r.targetReached,true);const record=(await rows(f,'accounts.jsonl'))[0];assert.equal(record.lookupOnly,true);assert.equal(record.parentSeed,'parent');assert.equal(record.sourceWorkUrl,action.sourceWorkUrl);
});
test('requested shortcode mismatch cannot create authors even with a visible header',async()=>{
 const f=await fixture([content()]);const p=new MockPage(p=>snapshot(p.url.includes('/reel/')?'https://www.instagram.com/reel/OTHER/':p.url,{authorHeaderFound:true,topLinks:[{href:'/wrong_author/'}]}));
 const r=await execute(f,p);assert.equal(r.netNew,0);assert.equal(r.routeStops.keyword_content,'content_identity_mismatch');assert.equal((await rows(f,'contents.jsonl')).length,0);
});
test('content author comes only from header; caption mentions remain reference evidence',async()=>{
 const f=await fixture([content()],{targetCount:1});const p=new MockPage(p=>snapshot(p.url,{authorHeaderFound:true,authorHeaderText:'Actual Author',topLinks:[{href:'/author/'}],links:[{href:'/commenter/',text:'@commenter'}]}));
 const r=await execute(f,p);assert.equal(r.netNew,1);assert.equal((await rows(f,'accounts.jsonl'))[0].handle,'author');assert.equal((await rows(f,'accounts.jsonl'))[0].batchId,'test-batch');assert.equal((await rows(f,'accounts.jsonl'))[0].query,'synthetic query');assert.equal((await rows(f,'contents.jsonl'))[0].caption,null);assert.equal((await rows(f,'relations.jsonl'))[0].verificationStatus,'reference_only');
});
test('queue exhaustion below target is partial, never business completion',async()=>{
 const f=await fixture([list()],{targetCount:9});const p=new MockPage((p,a)=>snapshot(p.url,a.scope==='dialog'?{scope:'dialog',links:[{href:'/one/'},{href:'/two/'}]}:{}));const r=await execute(f,p);assert.equal(r.netNew,2);assert.equal(r.goalNotReached,true);assert.equal(r.state,'partial');assert.equal(r.stopReason,'queue_exhausted_before_target');
});
test('time budget stops at a boundary and journals untouched actions',async()=>{
 const f=await fixture([profile(),profile('second')],{maxDurationMs:15});const p=new MockPage(p=>snapshot(p.url),{delayMs:25});const r=await execute(f,p);assert.equal(r.stopReason,'TIME_BUDGET_EXCEEDED');assert.equal(r.state,'partial');assert(p.gotos.length<=1);assert((await rows(f,'dispatch.jsonl')).length>=1);
});
test('same-batch changed input and changed baseline/module binding are rejected before browsing',async()=>{
 const f=await fixture([profile()]);await execute(f,new MockPage(p=>snapshot(p.url)));const p=new MockPage(()=>{throw Error('Must not browse');});
 await assert.rejects(execute({...f,input:{...f.input,actions:[{...profile(),maxProfilePosts:1}]}},p),/BATCH_INPUT_FINGERPRINT_MISMATCH/);
 await assert.rejects(execute({...f,input:{...f.input,targetCount:11}},p),/RUN_RECOVERY_FINGERPRINT_MISMATCH/);assert.equal(p.gotos.length,0);
});
test('uncommitted tails are retained before trimming; middle corruption remains fatal',async()=>{
 const f=await fixture([profile()]);await execute(f,new MockPage(p=>snapshot(p.url)));const file=path.join(f.input.runDir,'accounts.jsonl');await fs.appendFile(file,'{"tail":');await execute(f,new MockPage(()=>{throw Error('Completed action must skip');}));
 assert((await fs.readdir(path.join(f.input.runDir,'recovery-tails'))).some(n=>n.endsWith('.bin')));assert((await fs.readFile(file,'utf8')).endsWith('\n'));
 await fs.appendFile(file,'CORRUPT\n');await assert.rejects(execute(f,new MockPage(()=>{throw Error('Must not browse');})),/Invalid committed JSONL/);
});
test('recovery refuses modified evidence bytes',async()=>{
 const f=await fixture([profile()]);await execute(f,new MockPage(p=>snapshot(p.url)));const evidence=(await rows(f,'evidence.jsonl'))[0];await fs.appendFile(path.join(f.input.runDir,'snapshots',evidence.evidenceId),' ');
 await assert.rejects(execute(f,new MockPage(()=>{throw Error('Must not browse');})),/RECOVERY_EVIDENCE_HASH_MISMATCH/);
});
test('invalid exact author evidence cannot return through content cache or satisfy target',async()=>{
 const f=await fixture([content()],{targetCount:2});const first=new MockPage(p=>snapshot(p.url,{authorHeaderFound:true,authorHeaderText:'Author',topLinks:[{href:'/author/'}]}));await execute(f,first);
 const old=(await rows(f,'contents.jsonl'))[0];await fs.appendFile(path.join(f.input.runDir,'invalid-observations.jsonl'),JSON.stringify({handle:'@AUTHOR',evidenceId:'snapshots/'+old.evidenceId})+'\n');
 const second=new MockPage(p=>snapshot(p.url,{authorHeaderFound:true,authorHeaderText:'Fresh author',topLinks:[{href:'/fresh_author/'}]}));const r=await execute({...f,input:{...f.input,batchId:'next-batch'}},second);
 assert.equal(r.netNew,1);assert.equal(r.targetReached,false);assert(second.gotos.some(u=>u.includes('/reel/AAA/')));assert.equal((await rows(f,'actions.jsonl')).at(-1).cacheHits,0);assert((await rows(f,'accounts.jsonl')).some(x=>x.handle==='author'));
});
test('valid cached authors retain original evidence time and do not claim a fresh work read',async()=>{
 const f=await fixture([content()],{targetCount:2});await execute(f,new MockPage(p=>snapshot(p.url,{authorHeaderFound:true,authorHeaderText:'Author',topLinks:[{href:'/author/'}]})));const old=(await rows(f,'contents.jsonl'))[0];
 const p=new MockPage(p=>snapshot(p.url));await execute({...f,input:{...f.input,batchId:'cached-batch'}},p);assert.equal(p.gotos.length,1);const reused=(await rows(f,'accounts.jsonl')).at(-1);assert.equal(reused.evidenceKind,'cached_content_author');assert.equal(reused.originalObservedAt,old.observedAt);assert.equal(reused.evidenceId,old.evidenceId);
});
test('profile grid alt is preview evidence, never a literal caption',async()=>{
 const f=await fixture([profile()]);await execute(f,new MockPage(p=>snapshot(p.url,{links:[{href:'/reel/AAA/',alt:'Photo by Example. May be an image.'}]})));const item=(await rows(f,'profiles.jsonl'))[0].posts[0];assert.equal(item.caption,null);assert.equal(item.previewTextSource,'image_alt');assert(item.gridPreviewText.includes('Photo by'));
});
test('zero selected profile posts does not mean zero loaded posts or private',async()=>{
 const f=await fixture([{...profile(),maxProfilePosts:0}]);await execute(f,new MockPage(p=>snapshot(p.url,{links:[{href:'/reel/AAA/',alt:'Loaded item'}]})));const r=(await rows(f,'profiles.jsonl'))[0];assert.equal(r.posts.length,0);assert.equal(r.coverage.loadedPostCount,1);assert.equal(r.coverage.selectedPostCount,0);assert.equal(r.private,false);
});

class Element {
 constructor(tag,attrs={},children=[],text=''){this.tag=tag;this.attrs=attrs;this.children=children;this.innerText=text||children.map(c=>c.innerText).join('\n');for(const child of children)child.parentElement=this;}
 getAttribute(k){return this.attrs[k]??null;}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 querySelectorAll(s){const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);return all.filter(e=>s==='*'||s==='a[href]'&&e.tag==='a'&&e.attrs.href||s==='article'&&e.tag==='article'||s==='button'&&e.tag==='button'||s==='button,[role="button"]'&&(e.tag==='button'||e.attrs.role==='button')||s==='time'&&e.tag==='time'||s==='img'&&e.tag==='img'||s==='svg'&&e.tag==='svg');}
}
function header(h){return new Element('header',{},[new Element('a',{href:`/${h}/`},[],h),new Element('button',{'aria-label':'More options'},[],'Options')]);}
function domSnapshot(root,url='https://www.instagram.com/reel/AAA/'){const priorDocument=globalThis.document,priorLocation=globalThis.location;globalThis.document={title:'test',body:root,querySelector:s=>s==='main'?root:null};globalThis.location=new URL(url);try{return extractSnapshotDOM({scope:'main'});}finally{globalThis.document=priorDocument;globalThis.location=priorLocation;}} // Synthetic fixture.
test('DOM fixture selects current permalink article, not a preloaded sibling header',()=>{
 const wrong=new Element('article',{},[header('wrong'),new Element('a',{href:'/reel/BBB/'})]);const correct=new Element('article',{},[header('correct'),new Element('a',{href:'/reel/AAA/'})]);const d=domSnapshot(new Element('main',{},[wrong,correct]));assert.equal(d.authorScope,'current_permalink_article');assert.equal(d.authorHeaderFound,true);assert.deepEqual(d.topLinks.map(l=>l.href),['/correct/']);
});
test('DOM fixture leaves multiple unbound headers unresolved rather than choosing first',()=>{
 const d=domSnapshot(new Element('main',{},[new Element('article',{},[header('one')]),new Element('article',{},[header('two')])]));assert.equal(d.authorHeaderFound,false);assert.equal(d.authorHeaderCandidates,2);assert.deepEqual(d.topLinks,[]);
});
test('DOM fixture refuses a single unbound vertical header and a conflicting article permalink',()=>{
 const vertical=domSnapshot(new Element('main',{},[new Element('article',{},[header('possibly_preloaded')])]),'https://www.instagram.com/reels/AAA/');assert.equal(vertical.authorHeaderFound,false);assert.equal(vertical.authorScope,'vertical_unbound'); // Synthetic fixture.
 const conflict=domSnapshot(new Element('main',{},[new Element('article',{},[header('wrong'),new Element('a',{href:'/p/BBB/'})])]));assert.equal(conflict.authorHeaderFound,false);assert.equal(conflict.authorScope,'conflicting_article');
});
