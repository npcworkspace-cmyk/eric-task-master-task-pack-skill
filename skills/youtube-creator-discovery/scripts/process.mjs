import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,parseMetric} from './browser.mjs';
export const PROCESSOR_VERSION='0.1.4';
export function aggregate(project,records,actions){
 const baseline=new Set(project.baselineIds),channels=new Map(),edges=new Map(),works=new Map(),profiles=new Map(),unresolved=[];
 records=[...records].filter(x=>!x.actionComplete).sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.evidenceFile.localeCompare(b.evidenceFile));
 for(const r of records){
  if(r.profile?.channelId)profiles.set(r.profile.channelId,{...r.profile,subscribers:parseMetric(r.profile.subscriberRaw||r.profile.headerText?.match(/[\d.,]+\s*(?:万|亿|[KMB])?\s*(?:位订阅者|subscribers)/i)?.[0]),evidenceFile:r.evidenceFile,observedAt:r.observedAt,cards:r.cards});
  if(r.action.route==='playlist_search')continue; // Inventory, never curator-as-author evidence.
  for(const c of r.cards){
   if(c.kind==='playlist')continue;const id=c.owner?.channelId;
   if(!id){if(c.owner?.url||c.kind==='video'&&c.id)unresolved.push({url:c.owner?.url||null,videoUrl:c.url,videoId:c.id,contentFormat:c.contentFormat||null,title:c.title,evidenceFile:r.evidenceFile,route:r.action.route,actionKey:r.actionKey,countDiscovery:r.countDiscovery});continue;}
   if(!/^UC[\w-]{22}$/.test(id))throw Error('INVALID_STABLE_ID');
   if(!channels.has(id))channels.set(id,{channelId:id,name:c.owner.name||null,url:c.owner.url||'https://www.youtube.com/channel/'+id,aliases:[],discovered:false,baseline:baseline.has(id),firstSeenAt:r.observedAt,firstDiscovery:null,sources:[],works:[],profile:null});
   const entity=channels.get(id);if(!entity.name&&c.owner.name)entity.name=c.owner.name;if(c.owner.url&&!entity.aliases.includes(c.owner.url))entity.aliases.push(c.owner.url);
   const source={route:r.action.route,actionKey:r.actionKey,countDiscovery:r.countDiscovery,sourceUrl:r.url,videoId:c.kind==='video'?c.id:null,contentFormat:c.contentFormat||null,title:c.title,description:c.description,cardText:c.cardText,evidenceFile:r.evidenceFile,observedAt:r.observedAt,seed:r.action.seed||null,sourceVideo:r.action.sourceVideo||null,sourceEvidence:r.action.sourceEvidence||null,depth:r.action.depth??0};
   if(r.countDiscovery&&!baseline.has(id)){entity.discovered=true;if(!entity.firstDiscovery)entity.firstDiscovery=source;}
   const ek=hash([id,r.actionKey,c.id||c.url]);if(!edges.has(ek)){edges.set(ek,{edgeId:ek,channelId:id,relation:r.action.route.startsWith('watch')?'recommended_visible':r.action.route==='playlist_authors'?'playlist_video_author':'query_or_page_observed',countDiscovery:r.countDiscovery,...source});entity.sources.push(source);}
   if(c.kind==='video'&&c.id){const wk=id+':'+c.id;if(!works.has(wk)){const w={...c,channelId:id,evidenceFile:r.evidenceFile,observedAt:r.observedAt};works.set(wk,w);entity.works.push(w);}}
  }
 }
 for(const[id,p]of profiles){if(channels.has(id))channels.get(id).profile=p;}
 const discovered=[...channels.values()].filter(x=>x.discovered).sort((a,b)=>a.firstDiscovery.observedAt.localeCompare(b.firstDiscovery.observedAt)||a.firstDiscovery.evidenceFile.localeCompare(b.firstDiscovery.evidenceFile));
 const formal=discovered.slice(0,project.targetCount),overflow=discovered.slice(project.targetCount),formalSet=new Set(formal.map(x=>x.channelId));
 const routeMap=new Map();for(const a of actions){if(!routeMap.has(a.route))routeMap.set(a.route,{route:a.route,actions:0,failed:0,durationMs:0,independentIds:new Set(),firstAttributed:0});const m=routeMap.get(a.route);m.actions++;m.failed+=a.status==='failed'?1:0;m.durationMs+=a.durationMs;}
 for(const x of discovered){for(const route of new Set(x.sources.filter(s=>s.countDiscovery).map(s=>s.route)))routeMap.get(route)?.independentIds.add(x.channelId);if(formalSet.has(x.channelId)){const m=routeMap.get(x.firstDiscovery.route);if(m)m.firstAttributed++;}}
 const metrics=[...routeMap.values()].map(m=>({...m,independentIds:[...m.independentIds],independentUnique:m.independentIds.size,firstAttributedPerMinute:m.durationMs?m.firstAttributed/(m.durationMs/60000):null}));
 return{project,formal,overflow,channels:[...channels.values()],edges:[...edges.values()],works:[...works.values()],unresolved,metrics,profiles:[...profiles.values()]};
}
export function freezeSample(data,size=24,frame='formal'){
 if(!Number.isSafeInteger(size)||size<1)throw Error('INVALID_SAMPLE_SIZE');
 if(!['formal','observed'].includes(frame))throw Error('INVALID_SAMPLE_FRAME');
 const formal=new Set(data.formal.map(c=>c.channelId));
 return data.metrics.map(m=>{const ids=m.independentIds.filter(id=>frame==='observed'||formal.has(id));return{route:m.route,frame,sampleSize:Math.min(size,ids.length),frameSize:ids.length,method:'sha256(route:channelId); route sample, not an overall estimate',channelIds:ids.sort((a,b)=>hash(m.route+':'+a).localeCompare(hash(m.route+':'+b))).slice(0,size)};}).filter(m=>m.frameSize);
}
export function buildIdentityQueue(data){
 const owners=new Map(),videos=new Map(),urls=new Map();
 for(const w of data.works){if(!owners.has(w.id))owners.set(w.id,new Set());owners.get(w.id).add(w.channelId);}
 for(const u of data.unresolved){const key=u.videoId||u.url;if(!key)continue;const map=u.videoId?videos:urls;if(!map.has(key))map.set(key,[]);map.get(key).push(u);}
 const pending=[],resolved=[],conflicts=[];
 for(const[videoId,sources]of videos){const known=[...(owners.get(videoId)||[])];const item={videoId,channelIds:known,sources};if(known.length===1)resolved.push(item);else if(known.length>1)conflicts.push(item);else pending.push({...item,url:sources[0].videoUrl||'https://www.youtube.com/watch?v='+videoId});}
 return{processorVersion:PROCESSOR_VERSION,rawObservations:data.unresolved.length,uniqueVideoIds:videos.size,resolvedVideoIds:resolved.length,pendingVideoIds:pending.length,conflictingVideoIds:conflicts.length,pending,resolved,conflicts,unresolvedChannelUrls:[...urls].map(([url,sources])=>({url,sources})),note:'Offline identity worklist only. Choose bounded actions from pending; retain all source routes. Known authors do not need repeated resolution; conflicts need evidence review. No semantic qualification.'};
}
export function summarizeAssessments(data,assessments=[],scope={mode:'none'}){
 const modes=['none','all_formal','fixed_sample'];if(!modes.includes(scope.mode))throw Error('INVALID_REVIEW_SCOPE');
 const observed=new Set(data.channels.map(c=>c.channelId)),formal=new Set(data.formal.map(c=>c.channelId)),byId=new Map();
 for(const a of assessments){
  if(!observed.has(a.channelId))throw Error('UNOBSERVED_ASSESSMENT_CHANNEL');
  if(byId.has(a.channelId))throw Error('DUPLICATE_ASSESSMENT_CHANNEL');
  if(!['qualified','pending','rejected'].includes(a.decision)||!a.reason?.trim()||!scope.rubricVersion||a.rubricVersion!==scope.rubricVersion)throw Error('INVALID_ASSESSMENT_OR_RUBRIC');
  if(!Array.isArray(a.evidenceFiles)||!a.evidenceFiles.length)throw Error('ASSESSMENT_EVIDENCE_REQUIRED');
  byId.set(a.channelId,a);
 }
 const expected=scope.mode==='all_formal'?[...formal]:scope.mode==='fixed_sample'?scope.channelIds:[];
 if(!Array.isArray(expected)||(scope.mode==='fixed_sample'&&!expected.length)||new Set(expected).size!==expected.length||expected.some(id=>!observed.has(id)))throw Error('INVALID_REVIEW_SCOPE_IDS');
 const rows=data.formal.map(c=>({channelId:c.channelId,name:c.name,url:c.url,decision:byId.get(c.channelId)?.decision||'unreviewed',assessment:byId.get(c.channelId)||null}));
 const count=decision=>rows.filter(r=>r.decision===decision).length,qualified=count('qualified'),pending=count('pending'),rejected=count('rejected'),unreviewed=count('unreviewed'),reviewed=qualified+pending+rejected;
 const missing=expected.filter(id=>!byId.has(id));
 return{processorVersion:PROCESSOR_VERSION,formal:rows.length,reviewed,qualified,pending,rejected,unreviewed,reviewCoverage:rows.length?reviewed/rows.length:null,decidedCoverage:rows.length?(qualified+rejected)/rows.length:null,allFormalReviewed:rows.length>0&&unreviewed===0,allFormalDecided:rows.length>0&&unreviewed===0&&pending===0,outsideFormalReviewed:assessments.filter(a=>!formal.has(a.channelId)).length,scope:{mode:scope.mode,rubricVersion:scope.rubricVersion||null,expected:expected.length,reviewed:expected.length-missing.length,missingChannelIds:missing,status:scope.mode==='none'?'not_declared':missing.length?'partial':'reviewed'},overallEstimatedHitRate:null,note:'Counts reconcile the formal pool. Scope reviewed includes pending evidence; it is not full-pool qualification. No hit-rate estimate is inferred from route or purposive samples.',rows};
}
export function csv(rows,fields){const esc=x=>'"'+String(x??'').replaceAll('"','""')+'"';return '\ufeff'+fields.map(esc).join(',')+'\n'+rows.map(r=>fields.map(f=>esc(typeof r[f]==='object'&&r[f]!==null?JSON.stringify(r[f]):r[f])).join(',')).join('\n')+'\n';}
export async function processRun(config){
 const dir=path.resolve(config.runDir),out=path.resolve(config.outputDir);await fs.mkdir(out,{recursive:true});
 const project=JSON.parse(await fs.readFile(path.join(dir,'project.json'),'utf8'));
 const names=(await fs.readdir(path.join(dir,'evidence'))).filter(n=>n.endsWith('.json'));
 const records=await Promise.all(names.map(async n=>JSON.parse(await fs.readFile(path.join(dir,'evidence',n),'utf8'))));
 let actions=[];try{actions=(await fs.readFile(path.join(dir,'actions.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
 const data=aggregate(project,records,actions);
 const assessments=config.assessmentsFile?JSON.parse(await fs.readFile(path.resolve(config.assessmentsFile),'utf8')):[];
 const review=summarizeAssessments(data,assessments,config.reviewScope||{mode:'none'}),identities=buildIdentityQueue(data);
 const evidenceNames=new Set(records.map(r=>r.evidenceFile).filter(Boolean));
 for(const a of assessments)if(a.evidenceFiles.some(f=>!evidenceNames.has(f)))throw Error('ASSESSMENT_EVIDENCE_NOT_FOUND');
 const sample=config.freezeSample?freezeSample(data,config.sampleSize??24,config.sampleFrame??'formal'):null;
 const sampleFile=path.join(out,'frozen-sample.json');let sampleExists=false;
 if(sample){try{const previous=JSON.parse(await fs.readFile(sampleFile,'utf8'));sampleExists=true;if(JSON.stringify(previous)!==JSON.stringify(sample))throw Error('FROZEN_SAMPLE_CHANGED_USE_NEW_OUTPUT');}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(!config.assessmentsFile){try{const prior=JSON.parse(await fs.readFile(path.join(out,'review-summary.json'),'utf8'));if(prior.reviewed>0)throw Error('ASSESSMENTS_REQUIRED_FOR_REPLAY');}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(sample&&!sampleExists)await fs.writeFile(sampleFile,JSON.stringify(sample,null,2),{flag:'wx'});
 await fs.writeFile(path.join(out,'canonical.json'),JSON.stringify(data,null,2));
 const reviews=new Map(review.rows.map(r=>[r.channelId,r]));
 const flatten=x=>({channelId:x.channelId,name:x.name,url:x.url,firstRoute:x.firstDiscovery.route,firstSeenAt:x.firstDiscovery.observedAt,evidence:x.firstDiscovery.evidenceFile,workCount:x.works.length,profileObserved:!!x.profile,commercial:'unknown',assessment:reviews.get(x.channelId).decision});
 await fs.writeFile(path.join(out,'channels.csv'),csv(data.formal.map(flatten),['channelId','name','url','firstRoute','firstSeenAt','evidence','workCount','profileObserved','commercial','assessment']));
 await fs.writeFile(path.join(out,'route-metrics.csv'),csv(data.metrics,['route','actions','failed','durationMs','independentUnique','firstAttributed','firstAttributedPerMinute']));
 const {rows:reviewRows,...reviewCounts}=review;
 await fs.writeFile(path.join(out,'review-summary.json'),JSON.stringify(reviewCounts,null,2));
 await fs.writeFile(path.join(out,'identity-queue.json'),JSON.stringify(identities,null,2));
 for(const decision of ['qualified','pending','rejected','unreviewed'])await fs.writeFile(path.join(out,decision+'.csv'),csv(reviewRows.filter(r=>r.decision===decision).map(r=>({...r,reason:r.assessment?.reason||'not reviewed',rubricVersion:r.assessment?.rubricVersion||null,evidenceFiles:r.assessment?.evidenceFiles||[],commercial:'unknown'})),['channelId','name','url','decision','reason','rubricVersion','evidenceFiles','commercial']));
 await fs.writeFile(path.join(out,'review-followups.json'),JSON.stringify(reviewRows.filter(r=>['pending','unreviewed'].includes(r.decision)).map(r=>({channelId:r.channelId,url:r.url,state:r.decision,reason:r.assessment?.reason||'initial review not performed',missingCriteria:r.assessment?.missingCriteria||null,evidenceFiles:r.assessment?.evidenceFiles||[],nextStep:r.decision==='pending'?'Agent checks existing evidence and identifies the missing criterion before bounded enrichment':'initial content review'})),null,2));
 const summary={processorVersion:PROCESSOR_VERSION,formal:data.formal.length,overflow:data.overflow.length,observedStableChannels:data.channels.length,unresolvedObservations:data.unresolved.length,edges:data.edges.length,works:data.works.length,profiles:data.profiles.length,review:reviewCounts,identityQueue:{pendingVideoIds:identities.pendingVideoIds,resolvedVideoIds:identities.resolvedVideoIds,conflictingVideoIds:identities.conflictingVideoIds},metrics:data.metrics.map(({independentIds,...r})=>r)};
 await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
 return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const cfg=JSON.parse(await fs.readFile(process.argv[2],'utf8'));console.log(JSON.stringify(await processRun(cfg),null,2));}
