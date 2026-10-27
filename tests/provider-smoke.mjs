import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { CodexSource } from '../bridge/codex.ts';
import { CodexRpc } from '../bridge/codex-rpc.ts';
import { ClaudeSource } from '../bridge/claude.ts';
import { prepareClaudeHooks, liveStates } from '../bridge/claude-live.ts';

// The installed CLIs talk only to this local model fixture. No provider inference is used.
const root = await mkdtemp('/tmp/tb-provider-');
let codexStream, claudeStream, codexRequests = 0, claudeRequests = 0;
const mock = createServer(async (req, res) => {
  for await (const _ of req) {}
  if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return; }
  if (req.url?.includes('/responses')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: '+JSON.stringify({type:'response.created',response:{id:'resp_local',status:'in_progress'}})+'\n\n');
    codexStream = res; codexRequests++; return;
  }
  if (req.url?.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'msg_local',type:'message',role:'assistant',model:'claude-sonnet-4-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})+'\n\n');
    claudeStream = res; claudeRequests++; return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });res.end('{}');
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(), base = `http://127.0.0.1:${address.port}`;
const run = promisify(execFile);
const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'), stateDir = join(root, 'state'), socket = join(codexHome, 'app-server-control/app-server-control.sock');
await mkdir(codexHome); await mkdir(claudeHome);
await writeFile(join(codexHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "Local fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\n`);
let owner, codex, claude, claudeChild;
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(message);
}
function event(res, type, value) { res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`); }
try {
  await run('codex', ['app-server','daemon','start'], { cwd:root,env:{...process.env,CODEX_HOME:codexHome},timeout:20000 });
  await until(async () => { try { await stat(socket); return true; } catch { return false; } }, 'Codex socket did not start.');
  owner = new CodexRpc('codex', codexHome, ['proxy','--sock',socket], () => {}, () => {});
  await owner.request('initialize', { clientInfo: { name: 'threadboard_qa', version: '0.1.0' }, capabilities:{experimentalApi:true} }); owner.send({method:'initialized',params:{}});
  console.log('Installed Codex fixture connected to its isolated shared daemon.');
  const started = await owner.request('thread/start', { cwd: root, model: 'mock-model', modelProvider: 'mock', approvalPolicy: 'on-request', sandbox:'read-only' });
  const id = started.thread.id;
  await owner.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Return a short status.' }] });
  await until(() => !!codexStream, 'Codex did not reach the local fixture.');
  codex = new CodexSource(codexHome, stateDir, 'codex', socket);
  let snapshot = await codex.snapshot(), thread = snapshot.threads.find(t => t.id === id);
  assert.equal(codex.integration.mode, 'live'); assert.equal(thread.status, 'running');
  const item = { id:'msg_codex',type:'message',role:'assistant',content:[],status:'in_progress' };
  event(codexStream,'response.output_item.added',{output_index:0,item});
  event(codexStream,'response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  event(codexStream,'response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'Codex fixture streaming'});
  await until(async () => { const s=await codex.snapshot();return s.threads.find(t=>t.id===id)?.latestVisibleMessage?.text==='Codex fixture streaming'; }, 'Codex live text did not stream.');
  await codex.dispatch({ type:'thread.stop',threadId:id });
  snapshot = await codex.snapshot(); assert.equal(snapshot.threads.find(t => t.id===id).status, 'interrupted');
  console.log('Installed Codex passed: shared Unix server, live running state, streamed response, confirmed interruption.');
  const count = codexRequests;
  await owner.request('turn/start', { threadId: id, input: [{type:'text',text:'Ask which path to use.'}], collaborationMode:{mode:'plan',settings:{model:'mock-model',reasoning_effort:'low',developer_instructions:null}} });
  await until(()=>codexRequests>count,'Codex question turn did not reach the fixture.');
  const call = {type:'function_call',id:'fc_question',call_id:'call_question',name:'request_user_input',arguments:JSON.stringify({questions:[{id:'path',header:'Path',question:'Which path?',options:[{label:'Local',description:'Local work'},{label:'Remote',description:'Remote work'}]}]})};
  event(codexStream,'response.output_item.added',{output_index:0,item:{...call,arguments:''}});
  event(codexStream,'response.function_call_arguments.delta',{item_id:call.id,output_index:0,delta:call.arguments});
  event(codexStream,'response.function_call_arguments.done',{item_id:call.id,output_index:0,arguments:call.arguments});
  event(codexStream,'response.output_item.done',{output_index:0,item:call});
  event(codexStream,'response.completed',{response:{id:'resp_question',status:'completed',output:[call],usage:{input_tokens:1,output_tokens:4,total_tokens:5}}});codexStream.end();
  await until(async()=>{snapshot=await codex.snapshot();return !!snapshot.threads.find(t=>t.id===id)?.questionRequest;},'Codex did not deliver the live question to the second client.');
  const request = snapshot.threads.find(t=>t.id===id).questionRequest;
  await codex.dispatch({type:'runtime-request.respond',threadId:id,requestId:request.id,questionSignature:JSON.stringify(request),answers:{path:'Local'}});
  await codex.dispatch({type:'thread.stop',threadId:id});
  console.log('Installed Codex passed: a second client receives a real tool question and its answer is confirmed by the server.');

  for(const decision of ['accept','cancel']) {
    const count=codexRequests;
    await owner.request('turn/start',{threadId:id,input:[{type:'text',text:'Request approval for a harmless test command.'}]});
    await until(()=>codexRequests>count,'Codex approval turn did not reach fixture.');
    const call={type:'function_call',id:`fc_${decision}`,call_id:`call_${decision}`,name:'exec_command',arguments:JSON.stringify({cmd:'printf approved',sandbox_permissions:'require_escalated',justification:'Test explicit Threadboard approval.'})};
    event(codexStream,'response.output_item.added',{output_index:0,item:{...call,arguments:''}});
    event(codexStream,'response.function_call_arguments.delta',{item_id:call.id,output_index:0,delta:call.arguments});
    event(codexStream,'response.function_call_arguments.done',{item_id:call.id,output_index:0,arguments:call.arguments});
    event(codexStream,'response.output_item.done',{output_index:0,item:call});
    event(codexStream,'response.completed',{response:{id:`resp_${decision}`,status:'completed',output:[call],usage:{input_tokens:1,output_tokens:4,total_tokens:5}}});codexStream.end();
    await until(async()=>{snapshot=await codex.snapshot();return snapshot.threads.find(t=>t.id===id)?.questionRequest?.kind==='approval';},'Codex did not deliver the approval to the second client.');
    const request=snapshot.threads.find(t=>t.id===id).questionRequest;
    assert(request.questions[0].options.some(o=>o.value===decision),JSON.stringify(request));
    await codex.dispatch({type:'runtime-request.respond',threadId:id,requestId:request.id,questionSignature:JSON.stringify(request),decision});
    if(decision==='accept')await codex.dispatch({type:'thread.stop',threadId:id});
    else assert.notEqual((await codex.snapshot()).threads.find(t=>t.id===id).status,'running');
  }
  console.log('Installed Codex passed: real command approvals can be accepted or cancelled by the second client, with server confirmation.');

  const setup = await prepareClaudeHooks(stateDir, claudeHome);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete env[key];
  Object.assign(env, { CLAUDE_CONFIG_DIR:claudeHome, ANTHROPIC_API_KEY:'local-fixture-only', ANTHROPIC_BASE_URL:base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_AUTOUPDATER:'1' });
  let output = '';
  claudeChild = spawn('claude', ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio','--model','claude-sonnet-4-5','--settings',setup.settings,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--max-turns','6','--no-session-persistence'], { cwd:root,env,stdio:['pipe','pipe','pipe'] });
  claudeChild.stdin.write(JSON.stringify({type:'control_request',request_id:'init',request:{subtype:'initialize'}})+'\n');
  claudeChild.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Return a short status.'},parent_tool_use_id:null,session_id:''})+'\n');
  claudeChild.stdout.on('data',chunk=>{output+=chunk;});claudeChild.stderr.on('data',()=>{});
  await until(()=>!!claudeStream,'Claude did not reach the local fixture.');
  await until(async ()=>(await liveStates(setup.dir)).some(s=>s.status==='running'),'Claude did not run the lifecycle hooks.');
  claude = new ClaudeSource(claudeHome, stateDir);
  snapshot = await claude.snapshot(); assert(snapshot.threads.some(t=>t.status==='running'));
  const questionInput = {questions:[{header:'Path',question:'Which path?',multiSelect:false,options:[{label:'Local',description:'Local work'},{label:'Remote',description:'Remote work'}]}]};
  event(claudeStream,'content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_question',name:'AskUserQuestion',input:{}}});
  event(claudeStream,'content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(questionInput)}});
  event(claudeStream,'content_block_stop',{index:0});
  event(claudeStream,'message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:4}});
  event(claudeStream,'message_stop',{});claudeStream.end();
  await until(async()=>{snapshot=await claude.snapshot();return snapshot.threads.some(t=>t.questionRequest);},'Claude did not route AskUserQuestion through its hook.');
  const asking = snapshot.threads.find(t=>t.questionRequest), questionRequest = asking.questionRequest;
  await claude.dispatch({type:'runtime-request.respond',threadId:asking.id,requestId:questionRequest.id,questionSignature:JSON.stringify(questionRequest),answers:{'0':'Local'}});
  await until(()=>claudeRequests>1,'Claude did not continue after the confirmed tool answer.');
  for(const decision of ['accept','decline']) {
    const count=claudeRequests,marker=join(root,`claude-${decision}.txt`);
    const toolInput={command:`printf approved > '${marker}'`,description:'Test explicit Threadboard permission.'};
    event(claudeStream,'content_block_start',{index:0,content_block:{type:'tool_use',id:`toolu_${decision}`,name:'Bash',input:{}}});
    event(claudeStream,'content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(toolInput)}});
    event(claudeStream,'content_block_stop',{index:0});
    event(claudeStream,'message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:4}});
    event(claudeStream,'message_stop',{});claudeStream.end();
    await until(async()=>{snapshot=await claude.snapshot();return snapshot.threads.some(t=>t.questionRequest?.kind==='approval');},'Claude did not route PermissionRequest through its hook.');
    const thread=snapshot.threads.find(t=>t.questionRequest?.kind==='approval'),request=thread.questionRequest;
    const reply=claude.dispatch({type:'runtime-request.respond',threadId:thread.id,requestId:request.id,questionSignature:JSON.stringify(request),decision});
    await until(()=>claudeRequests>count,'Claude did not continue after permission response.');
    // Denials have no PostToolUse event, so confirm subsequent provider activity.
    event(claudeStream,'content_block_start',{index:0,content_block:{type:'text',text:''}});
    event(claudeStream,'content_block_delta',{index:0,delta:{type:'text_delta',text:`Permission ${decision} handled.`}});
    event(claudeStream,'content_block_stop',{index:0});
    await reply;
    assert.equal(await stat(marker).then(()=>true,()=>false),decision==='accept',output.slice(-10000));
  }
  console.log('Installed Claude passed: real permission allow executes the harmless command; deny leaves its file absent.');
  event(claudeStream,'content_block_start',{index:1,content_block:{type:'text',text:''}});
  event(claudeStream,'content_block_delta',{index:1,delta:{type:'text_delta',text:'Claude fixture complete.'}});
  event(claudeStream,'content_block_stop',{index:1});
  event(claudeStream,'message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}});
  event(claudeStream,'message_stop',{});claudeStream.end();
  claudeChild.stdin.end();
  await until(()=>claudeChild.exitCode!==null,'Claude fixture did not finish.');
  assert.equal(claudeChild.exitCode,0,output);
  snapshot = await claude.snapshot();
  assert(snapshot.threads.some(t=>t.status==='completed'&&t.latestAssistantMessage?.text.includes('Claude fixture complete.')));
  console.log('Installed Claude passed: hook lifecycle, real AskUserQuestion answer confirmed by PostToolUse, final response, completion.');
} finally {
  await claude?.close(); await codex?.close(); owner?.close(); claudeChild?.kill();
  await run('codex',['app-server','daemon','stop'],{env:{...process.env,CODEX_HOME:codexHome},timeout:10000}).catch(()=>{});
  mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
  await rm(root,{recursive:true,force:true});
}
