import {randomBytes} from 'node:crypto';
import {ANSWER_KEYS} from './types.ts';
import type {QuestionRequest,QuestionView,Slot,Thread,BoardAction} from './types.ts';

interface Draft {signature:string;token:number;index:number;page:number;answers:Map<string,string[]>;submitted:boolean}
const token=()=>randomBytes(4).readUInt32LE()||1;
function validRequest(r:QuestionRequest):boolean{
  if(r.kind==='approval'&&(r.responseCapability!=='live'||r.questions?.length!==1||r.questions[0]?.id!=='decision'||r.questions[0]?.multiSelect))return false;
  return typeof r.id==='string'&&['live','message','not_resumable'].includes(r.responseCapability)&&Array.isArray(r.questions)&&r.questions.length>0&&r.questions.length<=100&&new Set(r.questions.map(q=>q?.id)).size===r.questions.length&&r.questions.every(q=>q&&typeof q.id==='string'&&typeof q.header==='string'&&typeof q.question==='string'&&Array.isArray(q.options)&&q.options.length<=100&&q.options.every(o=>o&&typeof o.label==='string'&&typeof o.description==='string'&&(o.value===undefined||typeof o.value==='string')));
}
export class Questions {
  private drafts=new Map<string,Draft>();
  private current:{thread:Thread;request:QuestionRequest;draft:Draft}|null=null;
  view(thread:Thread|undefined,slots:Slot[]):QuestionView|null {
    this.current=null;
    const request=thread?.questionRequest;
    const inputKind=thread?.pendingRuntimeRequest?.kind;
    const matchesKind=request?.kind==='approval'?['approval','permission','command','file-read','file-change','mcp-elicitation'].includes(inputKind??''):['user_input','user-input'].includes(inputKind??'');
    if(!thread||thread.unavailable||!request||!validRequest(request)||thread.pendingRuntimeRequest?.id!==request.id||!matchesKind||request.responseCapability==='not_resumable')return null;
    const signature=JSON.stringify(request),key=JSON.stringify([thread.id,request.id]);
    let draft=this.drafts.get(key);
    if(!draft||draft.signature!==signature){draft={signature,token:token(),index:0,page:0,answers:new Map(),submitted:false};this.drafts.set(key,draft);}
    // Keep drafts bounded without persisting answers to disk.
    if(this.drafts.size>100)for(const k of this.drafts.keys()){if(k!==key){this.drafts.delete(k);break;}}
    this.current={thread,request,draft};
    const q=request.questions[draft.index]!,pages=Math.max(1,Math.ceil(q.options.length/ANSWER_KEYS.length));
    draft.page=Math.min(draft.page,pages-1);
    const selected=draft.answers.get(q.id)??[],answered=request.questions.filter(q=>(draft!.answers.get(q.id)?.length??0)>0).length;
    const choices=q.options.slice(draft.page*ANSWER_KEYS.length,(draft.page+1)*ANSWER_KEYS.length).map((o,n)=>({key:ANSWER_KEYS[n]!,label:o.label,description:o.description,selected:selected.includes(o.value??o.label)}));
    const canSubmit=!draft.submitted&&request.questions.every(q=>q.required===false||(draft!.answers.get(q.id)?.length??0)>0)&&answered>0;
    for(const choice of choices)Object.assign(slots[choice.key]!,{token:draft.token,title:choice.label,detail:choice.description,project:q.header,state:draft.submitted?'unavailable':choice.selected?'attention':'idle',status:choice.selected?'answer-selected':'answer-option',attentionSerial:0});
    return {...request.kind?{kind:request.kind}:{},token:draft.token,threadId:thread.id,requestId:request.id,header:q.header,text:q.question,index:draft.index,total:request.questions.length,page:draft.page,pages,answered,multiSelect:q.multiSelect===true,canSubmit,submitted:draft.submitted,choices};
  }
  act(input:BoardAction,selected:Slot):{threadId:string;requestId:string;answers?:Record<string,string|string[]>;decision?:string;questionSignature:string}|null {
    const current=this.current;
    if(!current||input.token!==current.draft.token||selected.threadId!==current.thread.id)throw new Error('This question changed. Refresh before answering.');
    const {thread,request,draft}=current;
    if(draft.submitted)throw new Error('Answers were already sent. Check the provider for confirmation.');
    const q=request.questions[draft.index]!;
    if(input.action==='choose'){
      const n=ANSWER_KEYS.findIndex(k=>k===input.key),option=n>=0?q.options[draft.page*ANSWER_KEYS.length+n]:undefined;
      if(!option)throw new Error('This black key has no answer option.');
      const value=option.value??option.label,previous=draft.answers.get(q.id)??[];
      draft.answers.set(q.id,q.multiSelect?previous.includes(value)?previous.filter(v=>v!==value):[...previous,value]:[value]);
      // Move forward only after a single-choice answer. Multi-select stays for toggles.
      if(!q.multiSelect&&draft.index+1<request.questions.length){draft.index++;draft.page=0;}
    }else if(input.action==='question'){
      draft.index=(draft.index+(input.value!<0?-1:1)+request.questions.length)%request.questions.length;draft.page=0;
    }else if(input.action==='page'){
      const pages=Math.max(1,Math.ceil(q.options.length/ANSWER_KEYS.length));draft.page=(draft.page+(input.value!<0?-1:1)+pages)%pages;
    }else if(input.action==='confirm'){
      if(input.key!==selected.key||!request.questions.every(q=>q.required===false||(draft.answers.get(q.id)?.length??0)>0)||!draft.answers.size)throw new Error('Choose an answer for every required question before pressing PLAY.');
      const answers:Record<string,string|string[]>={};
      for(const question of request.questions){const values=draft.answers.get(question.id);if(values?.length)answers[question.id]=question.multiSelect?[...values]:values[0]!;}
      if(!Object.keys(answers).length)throw new Error('Choose at least one answer.');
      draft.submitted=true;draft.token=token();
      return {threadId:thread.id,requestId:request.id,...request.kind==='approval'?{decision:answers.decision as string}:{answers},questionSignature:draft.signature};
    }else throw new Error('Invalid question action');
    draft.token=token();return null;
  }
}
