import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageReader, projectionMessages } from '../bridge/thread-messages.js';
import { demoSnapshot } from '../bridge/demo.ts';
import { resultExcerpt } from '../bridge/result.ts';

test('current-run final survives later user messages and excludes streaming, old runs, and tool output', () => {
  const message={id:'final',runId:'current',role:'assistant',text:'Saved final response.',streaming:false,updatedAt:'2026-10-26T10:00:00Z'};
  const projection={messages:[
    {...message,id:'old',runId:'previous',text:'Previous run.',updatedAt:'2026-10-26T09:00:00Z'},message,
    {...message,id:'user',role:'user',text:'A later user message.',updatedAt:'2026-10-26T11:00:00Z'},
    {...message,id:'stream',text:'Still writing.',streaming:true,updatedAt:'2026-10-26T12:00:00Z'},
  ],turnItems:[{type:'command_execution',text:'Tool output',updatedAt:'2026-10-26T13:00:00Z'}]};
  const result=projectionMessages({projection},'current');
  assert.equal(result.latestVisibleMessage?.text,'Still writing.');
  assert.equal(result.latestAssistantMessage?.text,message.text);
  assert.equal(projectionMessages(projection,'next').latestAssistantMessage,null);
  const thread={...demoSnapshot().threads[0]!,...result};
  assert.equal(resultExcerpt(thread),message.text);
});

test('visible timeline messages and conversation text restore omitted turn-item text', () => {
  const message={messageId:'m',type:'assistant_message',runId:'r',status:'completed',streaming:false,text:'',updatedAt:'2026-10-26T10:00:00Z'};
  const projection={visibleTurnItems:[{item:{...message,text:'Visible result.'}}],turnItems:[],messages:[]};
  assert.equal(projectionMessages(projection,'r').latestAssistantMessage?.text,'Visible result.');
  assert.equal(projectionMessages({...projection,turnItems:[message],messages:[{id:'m',role:'assistant',runId:'r',text:'Restored result.',updatedAt:message.updatedAt}]},'r').latestAssistantMessage?.text,'Restored result.');
});

test('message reads retry failures, refresh changed runs, cache successes, and never reuse an old final', async () => {
  const original=Date.now;let now=10000,reads=0,fail=true;
  Date.now=()=>now;
  const shell={...demoSnapshot().threads.find(t=>t.status==='completed')!,latestRunId:'r',latestVisibleMessage:null};
  const read=createMessageReader(async()=>{
    reads++;if(fail)throw Error('Disconnected');
    return {messages:[{id:'m',runId:'r',role:'assistant',text:'Recovered final.',streaming:false,updatedAt:'2026-10-26T10:00:00Z'}]};
  });
  try{
    let thread={...shell};await read([thread]);assert(thread.messageReadError);
    fail=false;now+=2001;thread={...shell};await read([thread]);assert.equal(thread.latestAssistantMessage?.text,'Recovered final.');
    thread={...shell};await read([thread]);assert.equal(reads,2);
    now+=30001;fail=true;thread={...shell};await read([thread]);assert.equal(thread.latestAssistantMessage?.text,'Recovered final.');
    thread={...shell,latestRunId:'new-run'};await read([thread]);assert(thread.messageReadError);assert.equal(thread.latestAssistantMessage,null);
    fail=false;now+=2001;thread={...shell,latestRunId:'new-run'};await read([thread]);assert.equal(thread.latestAssistantMessage,null);
    assert(!resultExcerpt(thread).includes('Recovered final.'));
  }finally{Date.now=original;}
});
