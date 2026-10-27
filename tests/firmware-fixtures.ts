import { snapshotFrames, ackFrame, decodeFrame, frame } from '../bridge/protocol.ts';
import type { BoardView } from '../bridge/types.ts';
import { THREAD_KEYS } from '../bridge/types.ts';
import { Board } from '../bridge/board.ts';
const base: BoardView = {
  environmentId:'test',connected:true,error:null,selected:4,overflow:2,revision:1,midi:{connected:true,name:'test',error:null},
  slots:Array.from({length:27},(_,key)=>{const n=THREAD_KEYS.findIndex(k=>k===key),assigned=n>=0&&n<3;return {key,token:assigned?101+n:0,threadId:assigned?`t${n}`:null,title:n===0?'Reader controls':n===1?'Checking persistence':n===2?'Choose the next step':'Unassigned',project:assigned?'Reading app':'',detail:n===2?'Question waiting: Should the thread keys cover all projects together, or one project at a time?':'The thread keeps this key until you settle it.',state:n===0?'idle':n===1?'working':n===2?'attention':'empty',status:n===1?'running':'completed'};})
};
const hex=(frame:number[])=>frame.map(n=>n.toString(16).padStart(2,'0')).join(' ');
const renewed=structuredClone(base);renewed.revision=2;
const frames=snapshotFrames(base,42);
base.slots[4]!.attentionSerial=1;
const events=Array.from({length:5},(_,n)=>{const next=structuredClone(base);next.revision=3+n;next.slots[4]!.attentionSerial=n===0?2:n===1?2:n+1;return snapshotFrames(next,77).map(hex);});
const malformed=Buffer.from(decodeFrame(frames[3]!)!);malformed[11]=0;
const board=new Board(null,'unused',true);await board.refresh();
const q1=structuredClone(board.view);q1.question!.token=1001;for(const c of q1.question!.choices)q1.slots[c.key]!.token=1001;
await board.act({action:'choose',key:1,token:board.view.question!.token});
const q2=structuredClone(board.view);q2.question!.token=1002;for(const c of q2.question!.choices)q2.slots[c.key]!.token=1002;
await board.act({action:'choose',key:1,token:board.view.question!.token});
const ready=structuredClone(board.view);ready.question!.token=1003;for(const c of ready.question!.choices)ready.slots[c.key]!.token=1003;
const finished=structuredClone(base);finished.revision=10;finished.result={threadId:'t2',text:'The implementation is complete. Tests passed. Review the changes before settling. '.repeat(14).slice(0,1000)};
const resultFrames=snapshotFrames(finished,88);
const firstResult=resultFrames.findIndex(f=>decodeFrame(f)![1]===7);
const sleeping=structuredClone(base);sleeping.revision=12;sleeping.slots[0]!.state='snoozed';
const awake=structuredClone(base);awake.revision=13;
await board.demoState(board.view.selected,'approval');
board.snapshot!.threads.find(t=>t.id===board.view.question!.threadId)!.questionRequest!.questions[0]!.question='Run this command? '+('long readable command '.repeat(22))+' END OF REQUEST';
await board.refresh();
const approval=structuredClone(board.view);approval.revision=14;approval.question!.token=2001;for(const c of approval.question!.choices)approval.slots[c.key]!.token=2001;
await board.act({action:'choose',key:3,token:board.view.question!.token});
const approved=structuredClone(board.view);approved.revision=15;approved.question!.token=2002;for(const c of approved.question!.choices)approved.slots[c.key]!.token=2002;
console.log(JSON.stringify({approvals:[approval,approved].map(v=>snapshotFrames(v,88).map(hex)),approvalLength:approval.question!.text.length,approvalAcks:[7,8].map(n=>hex(ackFrame(88,n,true))),sleeping:snapshotFrames(sleeping,88).map(hex),awake:snapshotFrames(awake,88).map(hex),frames:frames.map(hex),malformed:hex(frame(malformed)),renewed:snapshotFrames(renewed,77).map(hex),events,questions:[q1,q2,ready].map(v=>snapshotFrames(v,88).map(hex)),result:resultFrames.map(hex),firstResult,resultLength:finished.result.text.length,resultClear:snapshotFrames({...finished,result:null,revision:11},88).map(hex),questionAcks:[4,5,6].map(n=>hex(ackFrame(88,n,true))),ack3:hex(ackFrame(77,3,true)),ack1:hex(ackFrame(42,1,true)),wrongAck:hex(ackFrame(43,1,true)),ack2:hex(ackFrame(42,2,false))}));
