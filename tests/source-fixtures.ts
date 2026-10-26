import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedCodexFixture } from './shared-codex-fixture.ts';

export async function sourceFixture() {
  const root = await mkdtemp('/tmp/threadboard-');
  const claude = join(root, 'claude'), codex = join(root, 'codex'), state = join(root, 'state');
  await mkdir(join(claude, 'projects/project'), { recursive: true });
  await mkdir(codex);
  const transcript = join(claude, 'projects/project/session.jsonl');
  const entries = [
    { type: 'user', sessionId: 'claude-session', cwd: "/work/user's project", timestamp: '2026-10-26T12:00:00Z', message: { content: 'Fix the save flow' }, uuid: 'u1' },
    { type: 'assistant', timestamp: '2026-10-26T12:01:00Z', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Saving now works offline.' }, { type: 'tool_use', name: 'Bash' }] }, uuid: 'a1' },
    { type: 'user', timestamp: '2026-10-26T12:02:00Z', message: { content: [{ type: 'tool_result', content: 'private tool output' }] } },
    { type: 'custom-title', customTitle: 'Offline saves' },
  ];
  await writeFile(transcript, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(claude, 'projects/project/sidechain.jsonl'), JSON.stringify({ ...entries[0], sessionId: 'sidechain', isSidechain: true }) + '\n');
  await mkdir(join(claude, 'projects/project/session/subagents'), { recursive: true });
  await writeFile(join(claude, 'projects/project/session/subagents/agent-123.jsonl'), JSON.stringify({ ...entries[0], sessionId: 'subagent' }) + '\n');
  const cli = join(root, 'fake-codex.mjs');
  await writeFile(cli, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const livePath=join(process.env.CODEX_HOME,'live.json');
if(process.argv.includes('proxy')&&!existsSync(livePath))process.exit(1);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const live=()=>existsSync(livePath)?JSON.parse(readFileSync(livePath,'utf8')):null;
const thread=id=>({id,cwd:'/work/project',name:'Codex '+id,preview:'Fix things',createdAt:1793016000,updatedAt:1793016060,source:'cli',status:id==='first'&&live()?{type:live().status,activeFlags:live().question?['waitingOnUserInput']:[]}:{type:'notLoaded'}});
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);appendFileSync(join(process.env.CODEX_HOME,'requests.jsonl'),line+'\\n');
 if(!r.method){const s=live();if(s){s.question=false;writeFileSync(livePath,JSON.stringify(s));emit({method:'serverRequest/resolved',params:{threadId:'first',requestId:r.id}});}continue;}
 if(r.id===undefined)continue;
 let result;
 if(r.method==='initialize')result={userAgent:'test'};
 else if(r.method==='thread/list')result=r.params.cursor?{data:[thread('second')],nextCursor:null}:{data:[thread('first')],nextCursor:'page2'};
 else if(r.method==='thread/read')result={thread:thread(r.params.threadId)};
 else if(r.method==='thread/resume')result={thread:thread(r.params.threadId)};
 else if(r.method==='thread/turns/list')result={data:[{id:'turn1',status:live()?.turnStatus??'completed',completedAt:live()?.status==='idle'?1793016060:null,items:[{type:'userMessage',id:'u1',content:[{type:'text',text:'Please fix it'}]},{type:'commandExecution',id:'cmd',text:'private tool output'},{type:'agentMessage',id:'a1',text:'Codex saved response'}]}]};
 else if(r.method==='turn/interrupt'){const s=live();s.status='idle';s.turnStatus='interrupted';writeFileSync(livePath,JSON.stringify(s));emit({method:'turn/completed',params:{threadId:'first',turn:{id:'turn1',status:'interrupted',completedAt:1793016060,items:[]}}});result={};}
 else {emit({id:r.id,error:{code:-32601}});continue;}
 emit({id:r.id,result});
 if(r.method==='thread/resume'){
  emit({method:'turn/started',params:{threadId:'first',turn:{id:'turn1',status:'inProgress',items:[]}}});
  emit({method:'item/agentMessage/delta',params:{threadId:'first',itemId:'stream1',delta:'A live streamed response'}});
  if(live()?.question)emit({id:1,method:'item/tool/requestUserInput',params:{threadId:'first',turnId:'turn1',questions:[{id:'q1',header:'Choice',question:'Which path?',options:[{label:'Local',description:'Keep work local'},{label:'Remote',description:'Use remote work'}]}]}});
 }
}
`);
  await chmod(cli, 0o700);
  let closeLive: (() => Promise<void>) | null = null;
  const stopLive = async () => { await closeLive?.(); closeLive = null; };
  return { root, claude, codex, state, transcript, entries, cli, startLive: async () => { closeLive = await sharedCodexFixture(codex); }, stopLive, cleanup: async () => { await stopLive(); await rm(root, { recursive: true, force: true }); } };
}
