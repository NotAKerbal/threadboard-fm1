// Shared by the local client and desktop adapter. Keep this browser-safe.
export function projectionMessages(projection, latestRunId) {
  const data=projection.projection??projection;
  const messages=new Map();
  for(const row of data.visibleTurnItems??[]){
    const item=row.item;
    if(item?.type==='user_message'||item?.type==='assistant_message')messages.set(item.messageId,{...item,id:item.messageId,role:item.type==='user_message'?'user':'assistant'});
  }
  for(const item of data.turnItems??[]){
    if(item.type==='user_message'||item.type==='assistant_message')messages.set(item.messageId,{...item,id:item.messageId,role:item.type==='user_message'?'user':'assistant'});
  }
  // Some projections omit turn-item text and retain it on conversation messages.
  for(const message of data.messages??[])messages.set(message.id,{...messages.get(message.id),...message});
  const ordered=[...messages.values()].filter(m=>typeof m.text==='string'&&m.text.trim()).sort((a,b)=>time(a.updatedAt)-time(b.updatedAt));
  const summary=m=>m?{id:m.id,role:m.role,text:m.text.slice(0,5000),updatedAt:iso(m.updatedAt)}:null;
  return {
    latestVisibleMessage:summary(ordered.findLast(m=>m.role==='user'||m.role==='assistant')),
    latestAssistantMessage:summary(ordered.findLast(m=>m.role==='assistant'&&m.runId===latestRunId&&!m.streaming&&(!m.status||m.status==='completed'))),
  };
}
function iso(value){return typeof value?.toJSON==='function'?value.toJSON():value;}
function time(value){return Date.parse(iso(value))||0;}

export function createMessageReader(readProjection) {
  const cache=new Map();
  return async threads=>{
    const pending=threads.filter(t=>!t.archivedAt&&!t.deletedAt&&t.settledOverride!=='settled'&&t.lineage?.relationshipToParent!=='subagent');
    const active=new Set(pending.map(t=>t.id));
    for(const key of cache.keys())if(!active.has(key))cache.delete(key);
    await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
      for(let thread;(thread=pending.shift());){
        const key=JSON.stringify([thread.latestRunId,thread.status,thread.updatedAt,thread.latestVisibleMessage]);
        let entry=cache.get(thread.id);
        if(entry?.key!==key||entry.expires<Date.now()){
          try{
            const value=projectionMessages(await readProjection(thread.id),thread.latestRunId);
            entry={key,value,error:false,expires:Date.now()+(thread.status==='completed'&&value.latestAssistantMessage?30000:2000)};
            cache.set(thread.id,entry);
          }catch{
            // Preserve a successful read of the same revision during an outage.
            entry={key,value:entry?.key===key?entry.value:null,error:true,expires:Date.now()+2000};
            cache.set(thread.id,entry);
          }
        }
        if(entry?.value){
          if(entry.value.latestVisibleMessage)thread.latestVisibleMessage=entry.value.latestVisibleMessage;
          thread.latestAssistantMessage=entry.value.latestAssistantMessage;
          thread.messageReadError=entry.error;
        }else{
          thread.latestAssistantMessage=null;
          thread.messageReadError=true;
        }
      }
    }));
  };
}

// Approval choices use the same explicit selection and PLAY confirmation as questions.
export function approvalQuestion(id, revision, text, options) {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(options)) return null;
  // The FM-1 cannot render Unicode or more than 1,100 characters of approval detail.
  // Keep these requests in the provider instead of approving an incomplete preview.
  const lines = text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/30)),0);
  const readable = text.length <= 1100 && lines <= 44 && !/[^\x20-\x7e\n]/.test(text);
  return {id,kind:'approval',revision,responseCapability:'live',questions:[{
    id:'decision',header:'Approval requested',question:readable ? text : 'Review this approval in the provider. Its full details cannot be shown on the FM-1.',
    options:readable ? options : [],
  }]};
}
