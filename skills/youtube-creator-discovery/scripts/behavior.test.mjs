// All account IDs, URLs, dates and page content below are synthetic test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {aggregate,freezeSample,buildIdentityQueue,summarizeAssessments,processRun} from './process.mjs';
import {run,validate,actionKey,parseMetric,capturePage} from './browser.mjs';
const ids=['UC'+'a'.repeat(22),'UC'+'b'.repeat(22),'UC'+'c'.repeat(22)];
const act={route:'search',url:'https://www.youtube.com/results?search_query=test',maxScrolls:0,maxCards:20};
const card=(id,video)=>({kind:'video',id:video,title:video,url:'https://www.youtube.com/watch?v='+video,owner:{channelId:id,name:id,url:'https://www.youtube.com/channel/'+id}});
const snap=(route,cards,time,countDiscovery=true)=>({observedAt:`2026-01-01T00:00:0${time}Z`,evidenceFile:'evidence/'+time+'.json',action:{route},actionKey:route,url:'https://www.youtube.com/',cards,countDiscovery});
test('stable identity dedup, baseline exclusion, overflow and route attribution remain distinct',()=>{
 const p={targetCount:1,baselineIds:[ids[2]]};const rs=[snap('a',[card(ids[0],'v1'),card(ids[2],'v2')],1),snap('b',[card(ids[0],'v3'),card(ids[1],'v4')],2),snap('enrich',[card(ids[1],'v5')],0,false)];
 const d=aggregate(p,rs,['a','b','enrich'].map(route=>({route,durationMs:60000,status:'completed'})));
 assert.equal(d.formal.length,1);assert.equal(d.formal[0].channelId,ids[0]);assert.equal(d.overflow[0].channelId,ids[1]);assert.equal(d.metrics.find(m=>m.route==='b').independentUnique,2);assert.equal(d.metrics.find(m=>m.route==='b').firstAttributed,0);assert.equal(d.metrics.find(m=>m.route==='enrich').independentUnique,0);assert.equal(d.formal[0].works.length,2);assert.deepEqual(freezeSample(d),freezeSample(d));
});
test('playlist curator and provisional author never become counted channels',()=>{
 const d=aggregate({targetCount:5,baselineIds:[]},[snap('p',[{...card(ids[0],'PLx'),kind:'playlist'},{...card(null,'v'),owner:{url:'https://www.youtube.com/@unknown'}}],1)],[{route:'p',durationMs:1,status:'completed'}]);assert.equal(d.formal.length,0);assert.equal(d.unresolved.length,1);
});
test('budgets and external domains are rejected; meaningful action parameters alter the key',()=>{
 assert.throws(()=>validate({}));assert.notEqual(actionKey(act),actionKey({...act,maxCards:40}));assert.notEqual(actionKey(act),actionKey({...act,chip:'Related'}));
});
test('restart replays evidence and skips completed actions without resetting the baseline',async()=>{
 const root=await fs.mkdtemp(path.join(process.cwd(),'yt-test-'));const runDir=path.join(root,'run'),out=path.join(root,'out');await fs.mkdir(out);
 const input={projectId:'fixture',briefVersion:'1',runDir,targetCount:5,maxMinutes:2,actions:[act],batchId:'one'};let visits=0;
 const page={goto:async()=>{visits++;return{status:()=>200}},waitForTimeout:async()=>{},locator:()=>({innerText:async()=>''}),url:()=>act.url,evaluate:async fn=>({url:act.url,observedAt:new Date().toISOString(),cards:[card(ids[0],'v')],profile:null,hasContinuation:false})};
 const args={page,input,outputDir:out,progress:async()=>{},wait:async()=>{},signal:{aborted:false}};
 const first=await run(args);assert.equal(first.uniqueObserved,1);
 const second=await run({...args,input:{...input,batchId:'two'}});assert.equal(second.executed,0);assert.equal(second.uniqueObserved,1);assert.equal(visits,1);
 await assert.rejects(()=>run(args),/BATCH_ID_ALREADY_USED/);
 await assert.rejects(()=>run({...args,input:{...input,targetCount:6}}),/PROJECT_CONTRACT_MISMATCH/);
 const p=JSON.parse(await fs.readFile(path.join(runDir,'checkpoint.json'),'utf8'));assert.equal(p.uniqueObserved,1);
 // Isolated fixture cleanup is limited to this verified generated directory.
 assert.ok(root.startsWith(process.cwd()+path.sep));await fs.rm(root,{recursive:true});
});
test('missing metrics remain unknown, zero stays zero, abbreviated values retain precision flag',()=>{assert.equal(parseMetric(null).value,null);assert.equal(parseMetric('隐藏').value,null);assert.equal(parseMetric('0 subscribers').value,0);assert.deepEqual(parseMetric('15.6万位订阅者'),{raw:'15.6万位订阅者',value:156000,approximate:true});assert.equal(parseMetric('1,234 views').value,1234);});
test('a failure after the first persisted page retains discoveries and leaves the action resumable',async()=>{
 const root=await fs.mkdtemp(path.join(process.cwd(),'yt-test-')),runDir=path.join(root,'run'),out=path.join(root,'out');await fs.mkdir(out);let fail=true;
 const input={projectId:'failure',briefVersion:'1',runDir,targetCount:10,maxMinutes:2,actions:[{...act,maxScrolls:1}],batchId:'fail'};
 const page={goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},locator:()=>({innerText:async()=>''}),url:()=>act.url,evaluate:async fn=>{if(fn.name!=='capturePage'){if(fail)throw Error('fixture_scroll_failure');return;}return{url:act.url,observedAt:new Date().toISOString(),cards:[card(ids[0],'v')],hasContinuation:true};}};
 const args={page,input,outputDir:out,progress:async()=>{},wait:async()=>{},signal:{aborted:false}};const result=await run(args);assert.equal(result.uniqueObserved,1);
 const log=(await fs.readFile(path.join(runDir,'actions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(log[0].status,'failed');
 assert.equal(JSON.parse(await fs.readFile(path.join(runDir,'checkpoint.json'),'utf8')).completedActionKeys.length,0);
 fail=false;const recovered=await run({...args,input:{...input,batchId:'recover'}});assert.equal(recovered.uniqueObserved,1);assert.equal(recovered.executed,1);
 assert.equal(JSON.parse(await fs.readFile(path.join(runDir,'checkpoint.json'),'utf8')).completedActionKeys.length,1);
 assert.ok(root.startsWith(process.cwd()+path.sep));await fs.rm(root,{recursive:true});
});
test('DOM capture excludes ads and distinguishes a playlist from its first-video preview',()=>{
 const names=['window','document','location'];const old=new Map(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
 const anchor=(href,text='')=>({href:'https://www.youtube.com'+href,innerText:text,getAttribute:()=>href});
 const owner={runs:[{text:'Actual author',navigationEndpoint:{browseEndpoint:{browseId:ids[0],canonicalBaseUrl:'/@actual'}}}]};
 const elem=(tag,anchors,data,ad=false)=>({tagName:tag,innerText:'Real card',data,getClientRects:()=>[{}],closest:()=>ad?{}:null,querySelectorAll:()=>anchors,querySelector:()=>({textContent:'Visible title'})});
 const video=elem('YTD-VIDEO-RENDERER',[anchor('/watch?v=abcdefghijk'),anchor('/@actual','Actual author')],{videoId:'abcdefghijk',ownerText:owner,title:{simpleText:'Video'}});
 const playlist=elem('YT-LOCKUP-VIEW-MODEL',[anchor('/watch?v=xxxxxxxxxxx&list=PLTEST'),anchor('/playlist?list=PLTEST'),anchor('/@curator','Curator')],null);
 const ad=elem('YTD-VIDEO-RENDERER',[anchor('/watch?v=adadadadada')],{videoId:'adadadadada',ownerText:owner},true);
 try{globalThis.location={href:'https://www.youtube.com/results?search_query=test',pathname:'/results'};globalThis.window={ytInitialData:{contents:{}}};globalThis.document={title:'Test',body:{innerText:'Search'},querySelector:()=>null,querySelectorAll:s=>s.startsWith('ytd-video-renderer')?[ad,video,playlist]:[]};const d=capturePage();assert.equal(d.cards.length,2);assert.equal(d.cards[0].owner.channelId,ids[0]);assert.equal(d.cards[1].kind,'playlist');assert.equal(d.cards[1].id,'PLTEST');assert.equal(d.cards[1].url,'https://www.youtube.com/playlist?list=PLTEST');}
 finally{for(const n of names){const p=old.get(n);if(p)Object.defineProperty(globalThis,n,p);else delete globalThis[n];}}
});

test('new Shorts shelf retains unresolved owner and format; own Shorts tab can use verified profile',()=>{
 const names=['window','document','location'];const old=new Map(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
 const a={href:'https://www.youtube.com/shorts/abcdefghijk',innerText:'Carrier comparison',getAttribute:()=>'/shorts/abcdefghijk'};
 const e={tagName:'YTM-SHORTS-LOCKUP-VIEW-MODEL',innerText:'Carrier comparison\n10K views',data:{overlayMetadata:{primaryText:{content:'Carrier comparison'}}},getClientRects:()=>[{}],closest:()=>null,querySelectorAll:()=>[a],querySelector:()=>null};
 try{globalThis.location={href:'https://www.youtube.com/results?search_query=carrier',pathname:'/results'};globalThis.window={ytInitialData:{contents:{}}};globalThis.document={title:'Test',body:{innerText:'Search'},querySelector:()=>null,querySelectorAll:s=>s.startsWith('ytd-video-renderer')?[e]:[]};
 const d=capturePage();assert.equal(d.cards[0].contentFormat,'shorts');assert.equal(d.cards[0].url,a.href);assert.equal(d.cards[0].owner,null);
 const agg=aggregate({targetCount:3,baselineIds:[]},[snap('shorts_search',d.cards,1)],[{route:'shorts_search',durationMs:1,status:'completed'}]);assert.equal(agg.formal.length,0);assert.equal(agg.unresolved[0].videoId,'abcdefghijk');
 globalThis.location={href:'https://www.youtube.com/@actual/shorts',pathname:'/@actual/shorts'};globalThis.window.ytInitialData.metadata={channelMetadataRenderer:{externalId:ids[0],title:'Actual',vanityChannelUrl:'https://www.youtube.com/@actual'}};
 assert.equal(capturePage().cards[0].owner.channelId,ids[0]);
 globalThis.location={href:'https://www.youtube.com/shorts/abcdefghijk',pathname:'/shorts/abcdefghijk'};globalThis.window.ytInitialPlayerResponse={videoDetails:{videoId:'wrongvideo1',channelId:ids[1]}};assert.equal(capturePage().details,null);
 globalThis.window.ytInitialPlayerResponse.videoDetails.videoId='abcdefghijk';assert.equal(capturePage().details.channelId,ids[1]);
 }finally{for(const n of names){const p=old.get(n);if(p)Object.defineProperty(globalThis,n,p);else delete globalThis[n];}}
});

test('author resolution counts only exact current video and archives submitted module',async()=>{
 const root=await fs.mkdtemp(path.join(process.cwd(),'yt-test-')),runDir=path.join(root,'run'),out=path.join(root,'out');await fs.mkdir(out);
 const input={projectId:'resolve',briefVersion:'1',runDir,targetCount:10,maxMinutes:2,batchId:'resolve',actions:[{...act,currentVideoOnly:true,expectedVideoId:'abcdefghijk',sourceContentFormat:'shorts'}]};
 const page={goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},locator:()=>({innerText:async()=>''}),url:()=>act.url,evaluate:async()=>({url:act.url,observedAt:new Date().toISOString(),cards:[card(ids[1],'unrelated')],details:{id:'abcdefghijk',channelId:ids[0],title:'Actual',contentFormat:'shorts'}})};
 const r=await run({page,input,outputDir:out,progress:async()=>{},wait:async()=>{},signal:{aborted:false}});assert.equal(r.uniqueObserved,1);
 const files=(await fs.readdir(path.join(runDir,'evidence'))).filter(n=>!n.includes('complete'));const ev=JSON.parse(await fs.readFile(path.join(runDir,'evidence',files[0])));assert.equal(ev.cards[0].owner.channelId,ids[0]);assert.equal(ev.cards[0].contentFormat,'shorts');
 const module=await fs.readFile(path.join(runDir,'modules',r.moduleHash+'.mjs'),'utf8');assert.ok(module.includes('export async function run'));
 assert.ok(root.startsWith(process.cwd()+path.sep));await fs.rm(root,{recursive:true});
});

test('review counts close the formal pool without counting unreviewed as pending or sampling as full coverage',()=>{
 const all=[...ids,'UC'+'d'.repeat(22),'UC'+'e'.repeat(22)];
 const d=aggregate({targetCount:4,baselineIds:[]},[snap('search',all.map((id,i)=>card(id,'v'+i)),1)],[{route:'search',durationMs:1,status:'completed'}]);
 const as=(id,decision)=>({channelId:id,decision,rubricVersion:'r1',reason:'fixture assessment',evidenceFiles:['evidence/1.json']});
 const a=[as(all[0],'qualified'),as(all[1],'pending'),as(all[2],'rejected'),as(all[4],'qualified')];
 const r=summarizeAssessments(d,a,{mode:'fixed_sample',rubricVersion:'r1',channelIds:[all[0],all[1],all[2],all[4]]});
 assert.equal(r.reviewed,3);assert.equal(r.qualified,1);assert.equal(r.pending,1);assert.equal(r.rejected,1);assert.equal(r.unreviewed,1);assert.equal(r.outsideFormalReviewed,1);assert.equal(r.reviewCoverage,.75);assert.equal(r.decidedCoverage,.5);assert.equal(r.scope.status,'reviewed');assert.equal(r.allFormalReviewed,false);assert.equal(r.overallEstimatedHitRate,null);
 const allScope=summarizeAssessments(d,a,{mode:'all_formal',rubricVersion:'r1'});assert.equal(allScope.scope.status,'partial');assert.deepEqual(allScope.scope.missingChannelIds,[all[3]]);
 const none=summarizeAssessments(d);assert.equal(none.unreviewed,4);assert.equal(none.pending,0);
});

test('review reconciliation rejects mixed rubric, duplicate decisions and unobserved accounts',()=>{
 const d=aggregate({targetCount:3,baselineIds:[]},[snap('search',[card(ids[0],'v')],1)],[{route:'search',durationMs:1,status:'completed'}]);
 const a={channelId:ids[0],decision:'qualified',rubricVersion:'r1',reason:'fixture',evidenceFiles:['evidence/1.json']},scope={mode:'all_formal',rubricVersion:'r1'};
 assert.throws(()=>summarizeAssessments(d,[a,a],scope),/DUPLICATE/);
 assert.throws(()=>summarizeAssessments(d,[{...a,rubricVersion:'r2'}],scope),/RUBRIC/);
 assert.throws(()=>summarizeAssessments(d,[{...a,channelId:ids[1]}],scope),/UNOBSERVED/);
 assert.throws(()=>summarizeAssessments(d,[{...a,evidenceFiles:[]}],scope),/EVIDENCE/);
 assert.throws(()=>summarizeAssessments(d,[a],{...scope,mode:'fixed_sample',channelIds:[]}),/SCOPE_IDS/);
});

test('identity worklist deduplicates pending videos, skips known authors and preserves conflicting identities',()=>{
 const u=(videoId,evidenceFile)=>({videoId,videoUrl:'https://www.youtube.com/watch?v='+videoId,route:'search',evidenceFile});
 const d={works:[{id:'known',channelId:ids[0]},{id:'conflict',channelId:ids[0]},{id:'conflict',channelId:ids[1]}],unresolved:[u('known','a'),u('unknown','b'),u('unknown','c'),u('conflict','d'),{url:'https://www.youtube.com/@unresolved',evidenceFile:'e'}]};
 const q=buildIdentityQueue(d);assert.equal(q.rawObservations,5);assert.equal(q.uniqueVideoIds,3);assert.equal(q.pendingVideoIds,1);assert.equal(q.resolvedVideoIds,1);assert.equal(q.conflictingVideoIds,1);assert.equal(q.pending[0].sources.length,2);assert.equal(q.unresolvedChannelUrls.length,1);assert.deepEqual(q.conflicts[0].channelIds,ids.slice(0,2));
});

test('formal samples exclude overflow and frozen samples cannot be silently replaced on reprocessing',async()=>{
 const d=aggregate({targetCount:1,baselineIds:[]},[snap('search',[card(ids[0],'v1'),card(ids[1],'v2')],1)],[{route:'search',durationMs:1,status:'completed'}]);
 assert.deepEqual(freezeSample(d,24)[0].channelIds,[ids[0]]);assert.equal(freezeSample(d,24,'observed')[0].channelIds.length,2);
 const root=await fs.mkdtemp(path.join(process.cwd(),'yt-test-')),runDir=path.join(root,'run'),out=path.join(root,'out');
 try{await fs.mkdir(path.join(runDir,'evidence'),{recursive:true});await fs.writeFile(path.join(runDir,'project.json'),JSON.stringify({targetCount:2,baselineIds:[]}));await fs.writeFile(path.join(runDir,'actions.jsonl'),JSON.stringify({route:'search',durationMs:1,status:'completed'})+'\n');
 await fs.writeFile(path.join(runDir,'evidence','1.json'),JSON.stringify(snap('search',[card(ids[0],'v1')],1)));
 const cfg={runDir,outputDir:out,freezeSample:true};await processRun(cfg);const original=await fs.readFile(path.join(out,'frozen-sample.json'),'utf8'),canonical=await fs.readFile(path.join(out,'canonical.json'),'utf8');
 await processRun(cfg);assert.equal(await fs.readFile(path.join(out,'frozen-sample.json'),'utf8'),original);
 await fs.writeFile(path.join(runDir,'evidence','2.json'),JSON.stringify(snap('search',[card(ids[1],'v2')],2)));
 await assert.rejects(()=>processRun(cfg),/FROZEN_SAMPLE_CHANGED/);assert.equal(await fs.readFile(path.join(out,'frozen-sample.json'),'utf8'),original);assert.equal(await fs.readFile(path.join(out,'canonical.json'),'utf8'),canonical);
 }finally{assert.ok(root.startsWith(process.cwd()+path.sep));await fs.rm(root,{recursive:true});}
});

test('processor exports four review states and requires evidence and assessments on reviewed replays',async()=>{
 const root=await fs.mkdtemp(path.join(process.cwd(),'yt-test-')),runDir=path.join(root,'run'),out=path.join(root,'out');
 try{await fs.mkdir(path.join(runDir,'evidence'),{recursive:true});await fs.writeFile(path.join(runDir,'project.json'),JSON.stringify({targetCount:2,baselineIds:[]}));await fs.writeFile(path.join(runDir,'actions.jsonl'),JSON.stringify({route:'search',durationMs:1,status:'completed'})+'\n');await fs.writeFile(path.join(runDir,'evidence','1.json'),JSON.stringify(snap('search',[card(ids[0],'v1'),card(ids[1],'v2')],1)));
 const cfg={runDir,outputDir:out};const first=await processRun(cfg);assert.equal(first.review.unreviewed,2);assert.equal(first.review.pending,0);
 const a={channelId:ids[0],decision:'pending',rubricVersion:'r1',reason:'missing second product evidence',evidenceFiles:['evidence/1.json'],missingCriteria:['sustained_topic']},file=path.join(root,'assessments.json');await fs.writeFile(file,JSON.stringify([a]));const reviewed={...cfg,assessmentsFile:file,reviewScope:{mode:'all_formal',rubricVersion:'r1'}};
 const second=await processRun(reviewed);assert.equal(second.review.reviewed,1);assert.equal(second.review.pending,1);assert.equal(second.review.unreviewed,1);assert.equal(second.review.scope.status,'partial');
 assert.ok((await fs.readFile(path.join(out,'pending.csv'),'utf8')).includes(ids[0]));assert.ok(!(await fs.readFile(path.join(out,'pending.csv'),'utf8')).includes(ids[1]));assert.ok((await fs.readFile(path.join(out,'unreviewed.csv'),'utf8')).includes(ids[1]));
 await assert.rejects(()=>processRun(cfg),/ASSESSMENTS_REQUIRED/);await fs.writeFile(file,JSON.stringify([{...a,evidenceFiles:['evidence/nonexistent.json']}]));await assert.rejects(()=>processRun(reviewed),/EVIDENCE_NOT_FOUND/);
 }finally{assert.ok(root.startsWith(process.cwd()+path.sep));await fs.rm(root,{recursive:true});}
});
