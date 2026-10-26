// Adapter for T3 Nightly 0.1.3-nightly.20261025.3692. It uses the app's existing
// connections and dispatchers; no saved credentials are read or exported.
import {createMessageReader} from './thread-messages.js';
export async function install(base = 'http://127.0.0.1:4781') {
  if (location.origin !== 't3code://app') throw new Error('Install this in the T3 desktop console.');
  globalThis.threadboardDesktop?.stop();
  const [entities, utils, catalog, queries] = await Promise.all([
    import('t3code://app/assets/entities-CEe6JXi3.js'),
    import('t3code://app/assets/utils-zjvF2Js4.js'),
    import('t3code://app/assets/catalog-CnpjRTdp.js'),
    import('t3code://app/assets/queries-Bir6vfRq.js'),
  ]);
  const registry = utils.Dc, shells = entities.nt, connections = catalog.t;
  if (!registry?.get || !shells?.stateValueAtom || !connections?.catalogValueAtom || !queries.h?.v2?.dispatchCommand?.run) throw new Error('T3 updated. Threadboard needs a matching desktop adapter.');
  const readProjection=async(environmentId,threadId)=>{
    const result=await utils.Jl(registry,queries.h.v2.threadProjection({environmentId,input:{threadId}}),{refresh:true,reportFailure:false,signal:AbortSignal.timeout(5000)});
    if(result._tag!=='Success')throw new Error('Could not read this thread from T3.');
    return result.value;
  };
  return connect({registry,shells,connections,dispatchCommand:queries.h.v2.dispatchCommand,readProjection},base);
}

export function questionRequest(projection,id){
  const request=projection.runtimeRequests?.find(r=>r.id===id&&r.kind==='user_input'&&r.status==='pending');
  const item=projection.turnItems?.findLast(i=>i.type==='user_input_request'&&i.requestId===id);
  if(!request||!item||request.responseCapability?.type==='not_resumable')return null;
  return {id,questions:item.questions.map(q=>({id:q.id,header:q.header,question:q.question,options:q.options.map(o=>({label:o.label,description:o.description,...o.value===undefined?{}:{value:o.value}})),multiSelect:q.multiSelect===true,required:q.required!==false})),responseCapability:request.responseCapability.type};
}
export function validAnswers(request,answers){
  if(!request||!answers||typeof answers!=='object'||Array.isArray(answers))return false;
  if(Object.keys(answers).some(id=>!request.questions.some(q=>q.id===id)))return false;
  return request.questions.every(q=>{
    const answer=answers[q.id];if(answer===undefined)return q.required===false;
    const values=q.multiSelect?Array.isArray(answer)?answer:[]:typeof answer==='string'?[answer]:[];
    return values.length>0&&new Set(values).size===values.length&&values.every(v=>q.options.some(o=>(o.value??o.label)===v));
  });
}

// Kept separate from the version-specific imports so a future native T3 hook can
// provide these same runtime objects directly.
export async function connect({registry,shells,connections,dispatchCommand,readProjection},base) {
  const request = async (path, body, token) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? {'x-threadboard-desktop':token} : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Threadboard returned HTTP ${response.status}`);
    return response.json();
  };
  const iso = value => {
    if(value==null)return null;
    // Effect DateTime values serialize to ISO but do not expose epochMillis.
    const serialized=typeof value.toJSON==='function'?value.toJSON():value;
    if(typeof serialized==='string'&&Number.isFinite(Date.parse(serialized)))return serialized;
    if(typeof value.epochMillis==='number')return new Date(value.epochMillis).toISOString();
    throw new Error('Unsupported T3 timestamp. Existing assignments are preserved.');
  };
  const thread = t => ({
    id:t.id, projectId:t.projectId, title:t.title, status:t.status, activeRunId:t.activeRunId, latestRunId:t.latestRunId,
    latestRunCompletedAt:iso(t.latestRunCompletedAt), latestUserAuthoredMessageAt:iso(t.latestUserAuthoredMessageAt), lastVisitedAt:iso(t.lastVisitedAt),
    latestVisibleMessage:t.latestVisibleMessage ? {id:t.latestVisibleMessage.id,role:t.latestVisibleMessage.role,text:(t.latestVisibleMessage.text??'').slice(0,1000),updatedAt:iso(t.latestVisibleMessage.updatedAt)} : null,
    pendingRuntimeRequest:t.pendingRuntimeRequest ? {id:t.pendingRuntimeRequest.id,kind:t.pendingRuntimeRequest.kind} : null,
    hasActionableProposedPlan:t.hasActionableProposedPlan, pendingGuestMessageCount:t.pendingGuestMessageCount,
    pendingBackgroundTasks:t.pendingBackgroundTasks?.map(()=>({})), activityRunStatus:t.activityRunStatus, blockedOnThreadWait:t.blockedOnThreadWait,
    lineage:{relationshipToParent:t.lineage?.relationshipToParent??null}, settledOverride:t.settledOverride, archivedAt:iso(t.archivedAt),deletedAt:iso(t.deletedAt),updatedAt:iso(t.updatedAt),createdAt:iso(t.createdAt),snoozedUntil:iso(t.snoozedUntil),
  });
  const catalogSnapshot = () => [...registry.get(connections.catalogValueAtom).entries].map(([id,e]) => {
    const state = registry.get(shells.stateValueAtom(id)), s = state.snapshot._tag === 'Some' ? state.snapshot.value : null;
    return {id,label:e.target.label,connected:state.status==='live',snapshot:s ? {schemaVersion:2,snapshotSequence:s.snapshotSequence,threads:s.threads.map(thread),archivedThreads:s.archivedThreads.map(thread),projects:s.projects.map(p=>({id:p.id,title:p.title}))} : null};
  });
  const questionCache=new Map();
  const messageReaders=new Map();
  const snapshot=async()=>{
    const environments=catalogSnapshot();
    const active=new Set(environments.map(e=>e.id));
    for(const key of messageReaders.keys())if(!active.has(key))messageReaders.delete(key);
    await Promise.all(environments.map(async e=>{
      if(!e.connected||!e.snapshot||!readProjection)return;
      if(!messageReaders.has(e.id))messageReaders.set(e.id,createMessageReader(id=>readProjection(e.id,id)));
      await messageReaders.get(e.id)(e.snapshot.threads);
    }));
    await Promise.all(environments.flatMap(e=>!e.connected||!readProjection?[]:e.snapshot?.threads.filter(t=>t.pendingRuntimeRequest?.kind==='user_input').map(async t=>{
      const key=JSON.stringify([e.id,t.id,t.pendingRuntimeRequest.id]);
      let cached=questionCache.get(key);
      if(!cached||cached.expires<Date.now()){
        try{cached={value:questionRequest(await readProjection(e.id,t.id),t.pendingRuntimeRequest.id),expires:Date.now()+2000};questionCache.set(key,cached);}
        catch{cached={value:null,expires:0};}
      }
      t.questionRequest=cached.value;
    })??[]));
    if(questionCache.size>100)for(const [key,value]of questionCache)if(value.expires<Date.now())questionCache.delete(key);
    return environments;
  };
  let stopped=false, timer, token=null, lastError=null;
  const executed=new Set();
  const tick=async()=>{
    try {
      token ??= (await request('/desktop/attach',{})).token;
      const {commands}=await request('/desktop/snapshot',{environments:await snapshot()},token);
      for (const command of commands) {
        if (executed.has(command.id)) continue;
        executed.add(command.id); if(executed.size>1000)executed.delete(executed.values().next().value);
        let ok=false;
        let allowed=['thread.stop','thread.settle'].includes(command.input.type);
        if(command.input.type==='runtime-request.respond'&&readProjection){
          const fresh=questionRequest(await readProjection(command.environmentId,command.input.threadId),command.input.requestId);
          allowed=JSON.stringify(fresh)===command.expectedQuestion&&validAnswers(fresh,command.input.answers);
          questionCache.clear();
        }
        if (allowed && registry.get(shells.stateValueAtom(command.environmentId)).status==='live') {
          const result=await dispatchCommand.run(registry,{environmentId:command.environmentId,input:command.input});
          ok=result._tag==='Success';
          // Wait for the server's stream, not an optimistic UI change.
          if(ok&&Number.isFinite(result.value?.sequence))for(let n=0;n<40;n++){
            const state=registry.get(shells.stateValueAtom(command.environmentId));
            if(state.snapshot._tag==='Some'&&state.snapshot.value.snapshotSequence>=result.value.sequence)break;
            await new Promise(r=>setTimeout(r,50));
          }
        }
        await request('/desktop/snapshot',{environments:await snapshot(),result:{id:command.id,ok}},token);
      }
      lastError=null;
    } catch(error) { token=null; lastError=String(error); }
    finally { if(!stopped)timer=setTimeout(tick,1000); }
  };
  globalThis.threadboardDesktop={stop(){stopped=true;clearTimeout(timer);},status(){return {running:!stopped,error:lastError,machines:catalogSnapshot().map(({id,label,connected})=>({id,label,connected}))};}};
  await tick();
  console.info('Threadboard desktop adapter installed. It follows T3 connections automatically.');
  return globalThis.threadboardDesktop.status();
}
