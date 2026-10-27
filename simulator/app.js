const el = id => document.getElementById(id);
const white = [0,2,4,6,7,9,11,12,14,16,18,19,21,23,24,26];
const black = [1,3,5,8,10,13,15,17,20,22,25];
const names = ['F3','F♯3','G3','G♯3','A3','A♯3','B3','C4','C♯4','D4','D♯4','E4','F4','F♯4','G4','G♯4','A4','A♯4','B4','C5','C♯5','D5','D♯5','E5','F5','F♯5','G5'];
const threadNumber=key=>String(white.indexOf(key)+1).padStart(2,'0');
const keys = new Map();
let view = null, busy = false, lastList = '', noticeTimer, config = null, editingProvider = 't3';
const providerLabels = {t3:'T3 Code',codex:'Codex',claude:'Claude Code'};
const labels = {empty:'Available',idle:'Ready',working:'Working',attention:'Needs you',unavailable:'Unavailable',snoozed:'Snoozed'};
for (let key=0;key<27;key++) {
  const button=document.createElement('button');button.type='button';button.className='thread-key';button.dataset.key=String(key);button.dataset.state='empty';button.setAttribute('aria-pressed','false');
  const led=document.createElement('i');led.className='key-led';led.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.className='key-label';label.textContent=black.includes(key)?String(black.indexOf(key)+1):threadNumber(key);button.append(led,label);
  if(black.includes(key)) {button.classList.add('black');button.style.left=`${white.filter(k=>k<key).length/16*100}%`;}
  button.addEventListener('click',()=>act(black.includes(key)?'choose':'select',key));el('keyboard').append(button);keys.set(key,button);
}
document.body.classList.add('loading');
function notice(message) {el('notice').textContent=message;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{el('notice').textContent='';},7000);}
async function post(path,data) {
  const res=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const result=await res.json();if(!res.ok)throw new Error(result.error??'Action failed');
  return result;
}
async function act(action,key=view?.selected,value) {
  if(!view||busy||!view.connected)return;
  const slot=view.slots[key];if(!slot)return;
  busy=true;render(view);
  try{await post('/api/action',{action,key,token:['choose','confirm','question','page'].includes(action)?view.question?.token??0:slot.token,value});notice('');}catch(error){notice(error.message);}finally{busy=false;if(view)render(view);}
}
function render(data) {
  el('save-source').disabled=busy;
  view=data;document.body.classList.toggle('loading',!data.slots.length&&!data.error);document.body.classList.toggle('disconnected',!data.connected);
  const provider=providerLabels[data.provider]??'T3 Code', history=data.provider&&data.provider!=='t3';
  el('source-label').textContent=`FM-1 × ${provider.toUpperCase()}`;
  el('intro').textContent=history?(data.integration?.mode==='live'?'White keys select threads. Black keys choose answers and PLAY sends them. Black keys also choose approvals.':'White keys select saved threads. Resume a thread with live tracking using the command below.'):'White keys keep your threads. Black keys choose answers for the selected thread. PLAY sends them.';
  const machines=data.environments??[], online=machines.filter(e=>e.connected).length;
  el('connection').textContent=data.demo?'Demo mode':machines.length>1?`${online}/${machines.length} machines connected`:data.connected?(history?`${provider} ${data.integration?.mode==='live'?'live':'history'}`:`${provider} connected`):`${provider} disconnected`;
  el('connection').title=machines.map(e=>`${e.label}: ${e.connected?'connected':e.error??'disconnected'}`).join('\n');
  const selected=data.slots[data.selected];
  if(selected){
    el('project').textContent=selected.project||'THREADBOARD';el('key-number').textContent=threadNumber(data.selected);
    el('thread-title').textContent=selected.threadId?selected.title:'This key is available';el('thread-state').textContent=data.connected?labels[selected.state].toUpperCase():'DISCONNECTED';
    el('detail').textContent=data.connected?(data.result?.text??data.preview?.text??selected.detail):`Your assignments are preserved. Reconnect ${provider} to continue.`;
    el('detail').parentElement.classList.toggle('has-result',!!(data.result||data.preview));
    if(data.connected&&!data.slots.some(s=>s.threadId)){el('thread-title').textContent='No threads yet';el('detail').textContent=`Start a thread in ${provider}. It will appear here automatically.`;}
  }else{
    el('project').textContent='THREADBOARD';el('thread-title').textContent=data.error?'Choose your thread source':'Loading your threads…';el('thread-state').textContent=data.error?'DISCONNECTED':'CONNECTING';el('detail').textContent=data.error??'';
  }
  el('resume-panel').hidden=!data.resumeCommand||!data.connected;el('resume-command').textContent=data.resumeCommand??'';
  el('integration-panel').hidden=!data.integration;el('integration-detail').textContent=data.integration?.detail??'';
  el('integration-setup').hidden=!data.integration?.setupCommand;el('setup-command').textContent=data.integration?.setupCommand??'';
  el('answer-help').textContent=`Black keys choose or toggle these answers. PLAY sends the completed answers. Use ${provider} for a custom answer.`;
  const need=data.slots.filter(s=>s.threadId&&s.state==='attention').length;
  for(const slot of data.slots){const key=keys.get(slot.key),answer=black.includes(slot.key);key.dataset.state=slot.state;key.setAttribute('aria-pressed',String(answer?slot.status==='answer-selected':slot.key===data.selected));key.setAttribute('aria-label',answer?`Answer key ${black.indexOf(slot.key)+1}, ${slot.token?slot.title:'No question choice'}`:`Thread ${threadNumber(slot.key)}, ${names[slot.key]}, ${slot.title}, ${labels[slot.state]}`);key.title=answer?slot.title:`${threadNumber(slot.key)}: ${slot.title}`;key.disabled=busy||!data.connected||(answer&&(!slot.token||data.question?.submitted));}
  const q=data.question;el('question-panel').hidden=!q;el('send-answers').hidden=!q;el('send-answers').disabled=busy||!data.connected||!q?.canSubmit;
  if(q){
    el('send-answers').textContent=q.kind==='approval'?'PLAY · Confirm decision':'PLAY · Send answers';
    el('answer-help').textContent=q.kind==='approval'?'Choose an approval decision, then press PLAY to confirm. Nothing is approved by selecting a thread.':`Black keys choose or toggle these answers. PLAY sends the completed answers. Use ${provider} for a custom answer.`;
    el('question-progress').textContent=q.kind==='approval'?(q.submitted?'Decision sent. Waiting for the provider.':'Review the request, then choose a decision.'):`Question ${q.index+1} of ${q.total} · ${q.answered} answered${q.pages>1?` · Options page ${q.page+1}/${q.pages}`:''}`;
    el('question-title').textContent=q.header;el('question-text').textContent=q.text;
    el('question-prev').hidden=el('question-next').hidden=q.total<2;
    el('question-prev').disabled=el('question-next').disabled=busy||q.submitted||q.total<2;
    el('page-prev').hidden=el('page-next').hidden=q.pages<2;el('page-prev').disabled=el('page-next').disabled=busy||q.submitted;
    el('answer-options').replaceChildren();
    for(const [n,c]of q.choices.entries()){
      const button=document.createElement('button');button.type='button';button.className='answer-option';button.dataset.key=c.key;button.setAttribute('aria-pressed',String(c.selected));button.disabled=busy||q.submitted||!data.connected;button.addEventListener('click',()=>act('choose',c.key));
      const label=document.createElement('span');label.textContent=`${n+1}. ${c.label}`;const description=document.createElement('small');description.textContent=c.description;button.append(label,description);el('answer-options').append(button);
    }
    if(!q.choices.length)el('answer-options').textContent=`${q.kind==='approval'?'Review this approval':'Answer this question'} in ${provider}.`;
  }
  el('next').disabled=busy||!data.connected||!need;el('stop').hidden=data.capabilities?.stop===false;el('stop').disabled=busy||!data.connected||!selected?.threadId||!(selected.state==='working'||['preparing','queued','starting','running','waiting'].includes(selected.status));
  el('settle').disabled=busy||!data.connected||!selected?.threadId||selected.state==='unavailable';
  el('hardware').textContent=data.demo?'Interactive simulator':data.midi.connected?`FM-1 connected · ${data.midi.name}`:data.midi.error||'Connect your FM-1 after installing Threadboard firmware.';
  el('demo-label').hidden=!data.demo;el('demo-controls').hidden=!data.demo;
  el('overflow').hidden=!data.overflow;el('overflow').textContent=`${data.overflow} more threads are waiting for a free key. Existing assignments will stay in place.`;
  if(data.error)el('notice').textContent=data.error;
  const signature=JSON.stringify(data.slots.map(s=>[s.key,s.token,s.title,s.project,s.state]))+data.selected+data.connected+busy;
  if(signature!==lastList){
    lastList=signature;el('assignments').replaceChildren();
    for(const slot of data.slots.filter(s=>s.threadId)){
      const row=document.createElement('button');row.type='button';row.className='assignment';row.disabled=busy||!data.connected;row.setAttribute('aria-pressed',String(slot.key===data.selected));row.addEventListener('click',()=>act('select',slot.key));
      const number=document.createElement('span');number.className='assignment-key';number.textContent=threadNumber(slot.key);
      const title=document.createElement('span');title.className='assignment-title';title.textContent=slot.title;
      const project=document.createElement('span');project.className='assignment-project';project.textContent=slot.project;title.append(project);
      const status=document.createElement('span');status.className='assignment-status';status.textContent=labels[slot.state];row.append(number,title,status);el('assignments').append(row);
    }
  }
}
fetch('/api/config').then(async response=>{
  if(!response.ok)throw new Error('Could not load thread source settings. Reload to retry.');
  config=await response.json();if(!config)return;
  editingProvider=config.provider;document.querySelector(`input[name="provider"][value="${editingProvider}"]`).checked=true;el('source-home').value=config.homes[editingProvider];el('source-settings').hidden=false;
  el('codex-socket').value=config.codexSocket??'';el('codex-socket-setting').hidden=editingProvider!=='codex';
  if(view&&!view.connected)el('source-settings').open=true;
}).catch(error=>notice(error.message));
for(const input of document.querySelectorAll('input[name="provider"]'))input.addEventListener('change',()=>{
  if(!config)return;
  config.homes[editingProvider]=el('source-home').value;editingProvider=input.value;el('source-home').value=config.homes[editingProvider];el('config-status').textContent='';
  el('codex-socket-setting').hidden=editingProvider!=='codex';
});
el('source-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!config||busy)return;
  config.homes[editingProvider]=el('source-home').value;busy=true;if(view)render(view);
  for(const control of el('source-form').elements)control.disabled=true;
  el('config-status').textContent='Loading threads…';
  try{
    config=await post('/api/config',{provider:editingProvider,homes:config.homes,codexSocket:el('codex-socket').value||undefined});
    el('source-home').value=config.homes[editingProvider];el('config-status').textContent=`${providerLabels[config.provider]} source saved.`;
    notice('');
  }catch(error){el('config-status').textContent=error.message;}
  finally{busy=false;for(const control of el('source-form').elements)control.disabled=false;if(view)render(view);}
});
el('next').addEventListener('click',()=>act('next'));el('stop').addEventListener('click',()=>act('stop'));el('settle').addEventListener('click',()=>act('settle'));
el('send-answers').addEventListener('click',()=>act('confirm'));
el('question-prev').addEventListener('click',()=>act('question',view.selected,-1));el('question-next').addEventListener('click',()=>act('question',view.selected,1));
el('page-prev').addEventListener('click',()=>act('page',view.selected,-1));el('page-next').addEventListener('click',()=>act('page',view.selected,1));
for(const button of document.querySelectorAll('[data-state]'))if(button.closest('#demo-controls'))button.addEventListener('click',async()=>{try{await post('/api/demo',{key:view.selected,state:button.dataset.state});}catch(error){notice(error.message);}});
const stream=new EventSource('/events');stream.onmessage=e=>render(JSON.parse(e.data));stream.onerror=()=>{if(view)render({...view,connected:false});};
