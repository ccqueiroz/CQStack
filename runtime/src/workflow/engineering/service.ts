import { closeSync, openSync, unlinkSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentBus } from "../../agent-bus/index.js";
import { assertScope } from "../../agent-bus/index.js";
import type { AgentResult, ReviewResult, TaskCapsule, TaskState, WorktreeDescriptor } from "../../contracts.js";
import { hash, id, scopePath } from "../../storage.js";
import { manifest } from "../artifacts.js";
import { assertLiveGate, compatibilityHash, config, bounded } from "../service.js";
import type { Artifact, ApplyResult, EngineeringManifest, Proposal, Unit } from "./contracts.js";
import { hasEngineering, engineeringManifest, understanding, ref, decision, latest, records, readEngineeringArtifact, validateEngineeringArtifact, approvedProposal, assertEligible, applySubject, proposalReviewSubject, isContractPair, contractOutput, definedContract, contractReview, contractReviews, approvedContract, publishedVerification } from "./artifacts.js";
import { proposalCapsule, proposalReviewCapsule, implementationCapsule, applyReviewCapsule, childId, apiContractCapsule, apiContractReviewCapsule } from "./adapters.js";
import { fixtureInfo, checkpoint, assertCheckpoint, treeSnapshot, git } from "./fixture.js";

const TEST_MODULES=new Set(["node:test","node:assert","node:assert/strict"]);
const DANGEROUS_IDENTIFIER=/\b(?:process|globalThis|global|require|module|Buffer|eval|Function|Reflect|Proxy|WebAssembly|fetch)\b/;
const STATIC_IMPORT=/\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
function moduleFiles(path:string):string[] {
  if(!statSync(path).isDirectory()) return /\.m?js$/.test(path)?[path]:[];
  return readdirSync(path,{recursive:true,encoding:"utf8"}).filter(entry=>/\.m?js$/.test(entry)).map(entry=>join(path,entry));
}
// Defense in depth only; the Docker executor is the containment boundary. Scans the unit's
// own .js/.mjs files and every module the owned test reaches through static relative imports.
export function assertFixtureTestSafe(worktree:string,allowedPaths:string[],testPath:string) {
  const pending=[testPath],seen=new Set<string>();
  for(const allowed of allowedPaths) { const path=scopePath(worktree,allowed); if(existsSync(path)) pending.push(...moduleFiles(path)); }
  while(pending.length) {
    const path=pending.pop()!,name=relative(worktree,path);
    if(seen.has(path)) continue; seen.add(path);
    if(!existsSync(path)) throw new Error(`OWNED_TEST_MODULE_MISSING: ${name}`);
    const source=readFileSync(path,"utf8");
    const unsafe=(reason:string)=>new Error(`UNSAFE_FIXTURE_TEST: ${name}: ${reason}`);
    const blocked=["child_process","worker_threads","createRequire","fromCharCode","fromCodePoint","decodeURIComponent","decodeURI","atob","fs/promises","import(","node:fs","node:net","node:http","node:https","node:dgram","node:dns","node:tls","node:vm","node:module"];
    // Comments are scanned too: stripping them would hide code after a string containing "//".
    const normalized=source.replace(/\s/g,"");
    const dangerousCalls=["writeFile","appendFile","rmSync","unlinkSync","mkdirSync","createWriteStream","exec","execFile","spawn","fork"];
    const token=blocked.find(token=>source.includes(token));
    if(token) throw unsafe(token);
    if(/\bimport\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/.test(source) || source.includes("\\u") || source.includes("\\x")) throw unsafe("dynamic import or escaped source");
    const identifier=DANGEROUS_IDENTIFIER.exec(source)?.[0];
    if(identifier) throw unsafe(identifier);
    const call=dangerousCalls.find(token=>normalized.includes(token+"(")||normalized.includes(token+"["));
    if(call) throw unsafe(call);
    for(const match of source.matchAll(STATIC_IMPORT)) {
      const specifier=match[1]??match[2];
      if(TEST_MODULES.has(specifier)) continue;
      if(!specifier.startsWith("./")&&!specifier.startsWith("../")) throw unsafe(`import ${specifier}`);
      const target=resolve(dirname(path),specifier),inside=relative(worktree,target);
      if(inside.startsWith("..")||isAbsolute(inside)) throw unsafe(`import outside the worktree ${specifier}`);
      pending.push(target);
    }
  }
}

export class EngineeringStages {
  constructor(readonly bus:AgentBus) {}
  private authority() { if(this.bus.callerRole!=="master-orchestrator") throw new Error("WORKERS_DO_NOT_ORCHESTRATE_WORKERS"); }
  private compatibility() { return hash({core:compatibilityHash(this.bus),roles:["opsx-proposer","opsx-propose-reviewer","opsx-implementation-worker","opsx-apply-reviewer","api-contract-architect","api-contract-frontend-reviewer","api-contract-backend-reviewer","frontend-worker","backend-worker"].map(r=>this.bus.router.role(r)),execution_policy:this.bus.executionPolicy}); }
  private enroll(root:string) {
    if(hasEngineering(this.bus,root)&&this.bus.events.list(root).some(e=>e.event_type==="engineering.enrolled")) return engineeringManifest(this.bus,root);
    if(this.bus.events.get(root).state!=="GAP_DEFINED") throw new Error("VERIFIED_GAP_REQUIRED");
    const all=understanding(this.bus,root);
    const m:EngineeringManifest={version:1,root_task:root,understanding_manifest_hash:hash(manifest(this.bus,root)),
      gap:ref(all.find(a=>a.stage==="gap")!),truth:ref(all.find(a=>a.stage==="truth")!),compatibility_hash:this.compatibility()};
    if(hasEngineering(this.bus,root)) {
      if(hash(this.bus.storage.read("workflows",id(root),"engineering","manifest.json"))!==hash(m)||this.bus.events.list(root).some(e=>e.event_type.startsWith("engineering.action."))) throw new Error("ENGINEERING_INITIALIZATION_REQUIRES_INSPECTION");
    } else this.bus.storage.create(["workflows",id(root),"engineering","manifest.json"],m);
    this.bus.events.append(root,"engineering.enrolled",{manifest_hash:hash(m)}); return m;
  }
  private async operation<T>(root:string,action:string,fn:()=>Promise<T>, options:Record<string,unknown>={}) {
    this.authority(); assertLiveGate(this.bus);
    const lock=this.bus.storage.path("workflow-execution-"+id(root)+".lock"),fd=openSync(lock,"wx",0o600);
    writeFileSync(fd,JSON.stringify({pid:process.pid,root,action,created_at:new Date().toISOString()}));
    try {
      const m=this.enroll(root);
      if(m.compatibility_hash!==this.compatibility()) throw new Error("ENGINEERING_VERSION_INCOMPATIBLE");
      const started=this.bus.events.append(root,"engineering.action.started",{action,options});
      try { const result=await fn(); this.bus.events.append(root,"engineering.action.completed",{action,action_event_id:started.event_id}); return result; }
      catch(error) {
        const events=this.bus.events.list(root),position=events.findIndex(e=>e.event_id===started.event_id);
        const child=events.slice(position+1).filter(e=>e.event_type==="engineering.child.selected").at(-1)?.payload.child_task??null;
        this.bus.events.append(root,"engineering.action.failed",{action,action_event_id:started.event_id,child_task:child,error:error instanceof Error?error.message:String(error)}); throw error;
      }
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  private advance(root:string,state:TaskState,review?:ReviewResult) {
    const record=this.bus.events.get(root); if(record.state!==state) this.bus.transition(root,state,record.revision,review);
  }
  private recordDecision(root:string,text:string) {
    if(!text.trim() || text.length>12000) throw new Error("EXPLICIT_USER_DECISION_REQUIRED");
    if(decision(this.bus,root)?.payload.text!==text) this.bus.events.append(root,"engineering.user-decision",{text,source:"explicit-cockpit-input"});
  }
  private ensureChild(c:TaskCapsule) {
    if(Buffer.byteLength(JSON.stringify(c))>config().max_context_bytes) throw new Error("WORKFLOW_CONTEXT_BUDGET_EXCEEDED");
    const events=this.bus.events.list(c.task_id);
    if(!events.length) this.bus.init(c);
    else if(hash(this.bus.events.get(c.task_id).capsule)!==hash(c)) throw new Error("ENGINEERING_CAPSULE_MISMATCH");
    const root=c.parent_task_id!;
    const authorization=this.bus.events.list(root).find(e=>e.event_type==="workflow.child.created"&&e.payload.child_task===c.task_id);
    if(authorization && authorization.payload.capsule_hash!==hash(c)) throw new Error("CHILD_AUTHORIZATION_INCOMPATIBLE");
    if(!authorization) {
      if(events.some(e=>!["task.created","worktree.created"].includes(e.event_type))) throw new Error("CHILD_AUTHORIZATION_MISSING_AFTER_EXECUTION");
      this.bus.events.append(root,"workflow.child.created",{child_task:c.task_id,capsule_hash:hash(c),stage:JSON.parse(c.inputs[0]).action});
    }
  }
  private async executeChild(c:TaskCapsule):Promise<AgentResult> {
    this.ensureChild(c);
    this.bus.events.append(c.parent_task_id!,"engineering.child.selected",{child_task:c.task_id,action:JSON.parse(c.inputs[0]).action});
    if(this.bus.storage.exists("results",c.task_id+".json")) {
      if(c.permissions==="read-only") return this.bus.recoverWorkflowResult(c.task_id);
      const r=this.bus.result(c.task_id);
      if(!this.bus.events.list(c.task_id).some(e=>["agent.completed","agent.failed"].includes(e.event_type)&&e.payload.result_hash===hash(r))) throw new Error("WRITE_RESULT_REQUIRES_INSPECTION");
      return r;
    }
    if(this.bus.events.list(c.task_id).some(e=>["agent.started","agent.failed"].includes(e.event_type))) throw new Error("EXPLICIT_NEW_TASK_REQUIRED_AFTER_FAILURE");
    if(c.permissions!=="read-only") {
      if(this.bus.events.get(c.task_id).state==="TASK_RECEIVED") this.advance(c.task_id,"TASK_CLASSIFIED");
      if(this.bus.events.get(c.task_id).state==="TASK_CLASSIFIED") this.advance(c.task_id,"IMPLEMENTATION_RUNNING");
    }
    return this.bus.delegateEngineering(c.task_id);
  }
  private async contractGate(root:string,p:Artifact<Proposal>) {
    if(this.bus.events.get(root).state==="PROPOSAL_APPROVED") this.advance(root,"API_CONTRACT_REQUIRED");
    if(this.bus.events.get(root).state==="API_CONTRACT_REQUIRED") {
      await this.executeChild(apiContractCapsule(this.bus,root,p));
      this.bus.createContract(contractOutput(this.bus,root));
      this.advance(root,"API_CONTRACT_DEFINED");
    }
    if(this.bus.events.get(root).state==="API_CONTRACT_DEFINED") {
      for(const role of ["api-contract-frontend-reviewer","api-contract-backend-reviewer"] as const) {
        await this.executeChild(apiContractReviewCapsule(this.bus,root,p,role));
        const review=contractReview(this.bus,root,p,role,definedContract(this.bus,root));
        if(review.verdict!=="approved") { this.advance(root,"BLOCKED"); throw new Error("API_CONTRACT_REVIEW_REQUIRED"); }
      }
      this.advance(root,"API_CONTRACT_REVIEWED");
    }
    if(this.bus.events.get(root).state==="API_CONTRACT_REVIEWED") {
      const {reference,backend,frontend}=contractReviews(this.bus,root);
      this.bus.lockContract(reference,backend,frontend);
      this.advance(root,"API_CONTRACT_LOCKED");
    }
    approvedContract(this.bus,root);
  }
  private existing(root:string,path:string):Artifact|null {
    if(!this.bus.storage.exists("workflows",root,"engineering",path)) return null;
    const a=readEngineeringArtifact(this.bus,root,path);
    if(!records(this.bus,root).some(e=>e.payload.path===path&&e.payload.content_hash===a.content_hash)) this.bus.events.append(root,"engineering.artifact.created",{kind:a.kind,path,child_task:a.child_task,content_hash:a.content_hash,recovered:true});
    return a;
  }
  private publish<T>(root:string,path:string,kind:Artifact["kind"],c:TaskCapsule,result:AgentResult,content:T):Artifact<T> {
    const route=this.bus.events.list(c.task_id).find(e=>e.event_type==="agent.delegated")!.payload;
    const body:Omit<Artifact<T>,"content_hash">={kind,root_task:root,child_task:c.task_id,role:c.role,provider:String(route.provider),model_alias:String(route.model_alias),model:String(route.model),created_at:new Date().toISOString(),source_agent_result:{child_task:c.task_id,content_hash:hash(result)},input_artifact_references:JSON.parse(c.inputs[0]).input_references,content};
    const artifact={...body,content_hash:hash(body)};
    validateEngineeringArtifact(this.bus,root,artifact);
    this.bus.storage.create(["workflows",root,"engineering",path],artifact);
    this.bus.events.append(root,"engineering.artifact.created",{kind,path,child_task:c.task_id,content_hash:artifact.content_hash}); return artifact;
  }
  async propose(root:string,execute=false,decisionText?:string,revise=false,resumeVersion?:number) {
    this.authority();
    if(!execute) return {root_task:root,action:"propose",role:"opsx-proposer",execute:false,requires_explicit_decision:!decision(this.bus,root)};
    const current=latest<Proposal>(this.bus,root,"proposal");
    const targetVersion=resumeVersion??(revise?(current?.content.version??0)+1:current?.content.version??1);
    return this.operation(root,"propose",async()=>{
      if(decisionText) this.recordDecision(root,decisionText);
      const previous=latest<Proposal>(this.bus,root,"proposal");
      if(previous?.content.version===targetVersion) { if(this.bus.events.get(root).state==="GAP_DEFINED") this.advance(root,"PROPOSAL_CREATED"); return this.show(root); }
      if(previous&&!revise) { if(this.bus.events.get(root).state==="GAP_DEFINED") this.advance(root,"PROPOSAL_CREATED"); return this.show(root); }
      const priorReview=latest<ReviewResult>(this.bus,root,"proposal-review"),version=targetVersion;
      if(revise) {
        if(!previous || version>3 || this.bus.events.get(root).state!=="PROPOSAL_CREATED") throw new Error("PROPOSAL_REVISION_NOT_ALLOWED");
        const reviewAllows=priorReview?.content.verdict==="changes_required"&&priorReview.content.subject_hash===proposalReviewSubject(this.bus,root,previous);
        const decisionChanged=previous.content.open_decisions.length>0&&decision(this.bus,root)?.event_id!==JSON.parse(this.bus.events.get(previous.child_task).capsule.inputs[0]).decision.event_id;
        if(!reviewAllows&&!decisionChanged) throw new Error("PROPOSAL_REVISION_REQUIRES_REVIEW_OR_DECISION");
      }
      const path=`proposal-v${version}.json`,existing=this.existing(root,path);
      if(!existing) {
        const c=proposalCapsule(this.bus,root,version,previous,priorReview),r=await this.executeChild(c);
        if(r.status!=="completed"||!r.proposal) throw new Error("PROPOSAL_NOT_COMPLETED");
        this.publish(root,path,"proposal",c,r,r.proposal);
      }
      if(this.bus.events.get(root).state==="GAP_DEFINED") this.advance(root,"PROPOSAL_CREATED");
      return this.show(root);
    },{revise,version:targetVersion});
  }
  async reviewProposal(root:string,execute=false) {
    this.authority(); if(!execute) return {root_task:root,action:"proposal-review",role:"opsx-propose-reviewer",execute:false};
    return this.operation(root,"proposal-review",async()=>{
      const p=latest<Proposal>(this.bus,root,"proposal"); if(!p) throw new Error("PROPOSAL_REQUIRED");
      if(p.content.open_decisions.length) throw new Error("WAITING_FOR_USER_DECISION");
      const path=`proposal-review-v${p.content.version}.json`;
      let a=this.existing(root,path);
      if(!a) {const c=proposalReviewCapsule(this.bus,root,p),r=await this.executeChild(c); if(!r.review_result) throw new Error("REVIEW_ARTIFACT_REQUIRED"); a=this.publish(root,path,"proposal-review",c,r,r.review_result);}
      if(a.content.verdict==="approved"&&this.bus.events.get(root).state==="PROPOSAL_CREATED") this.advance(root,"PROPOSAL_APPROVED");
      return this.show(root);
    });
  }
  private quarantine(c:TaskCapsule,reason:string) {
    if(c.worktree&&!this.bus.storage.exists("quarantine",c.worktree.id+".json")) this.bus.storage.create(["quarantine",c.worktree.id+".json"],{task_id:c.task_id,worktree_id:c.worktree.id,reason,timestamp:new Date().toISOString()});
  }
  private ownedWorktree(root:string,p:Artifact<Proposal>,unit:Unit,base:string):WorktreeDescriptor {
    const task=childId(this.bus,root,`${root}-apply-${unit.id}-v${p.content.version}`);
    const event=this.bus.events.list(root).find(e=>e.event_type==="engineering.worktree.created"&&e.payload.task_id===task);
    let w=event?.payload.worktree as WorktreeDescriptor|undefined;
    if(!w) {
      const owned=this.bus.worktrees.list().filter(w=>w.task_id===task);
      if(owned.length>1) throw new Error("WORKTREE_CREATION_REQUIRES_INSPECTION");
      w=owned[0]??this.bus.createWorktree({task_id:task,role:unit.role,repository:fixtureInfo(this.bus).repository,base_ref:base});
      if(w.role!==unit.role||w.base_commit!==base||w.repository!==fixtureInfo(this.bus).repository) throw new Error("WORKTREE_BASE_MISMATCH");
      this.bus.events.append(root,"engineering.worktree.created",{task_id:task,unit_id:unit.id,proposal_hash:p.content_hash,worktree:w});
    }
    this.bus.worktrees.validate(w); return w;
  }
  private async verifyUnit(c:TaskCapsule,p:Artifact<Proposal>,unit:Unit,r:AgentResult):Promise<ApplyResult> {
    const path=["engineering-verifications",c.task_id+".json"],w=c.worktree!;
    if(this.bus.storage.exists("quarantine",w.id+".json")) throw new Error("QUARANTINED_WORKTREE");
    let verification:any;
    if(this.bus.storage.exists(...path)) verification=this.bus.storage.read(...path);
    else {
      const before=treeSnapshot(w.path),commands:any[]=[];
      let passed=r.status==="completed"&&!r.deviations.length&&!r.known_issues.length&&!r.scope_expanded&&!r.requested_followups.length&&r.api_contract_status!=="change_requested"&&r.visual_lock_status!=="approval_required"&&!r.proposal_deviation&&!this.bus.storage.exists("quarantine",w.id+".json");
      // The worker's tests_executed/tests_not_executed are claims, never verification:
      // only the sandboxed runs below decide whether the owned tests passed.
      if(passed) for(const test of p.content.tests_required.filter(t=>unit.owned_test_ids.includes(t.id))) {
        const started=Date.now();
        assertFixtureTestSafe(w.path,c.allowed_paths,scopePath(w.path,test.args[1]));
        const out=await this.bus.executionSandbox.execute({task_id:c.task_id,implementation_unit:unit.id,worktree:w.path,command:process.execPath,args:["--experimental-permission","--allow-child-process",`--allow-fs-read=${w.path}`,`--allow-fs-write=${w.path}`,...test.args],cwd:w.path,timeout_ms:30000,env:{PATH:process.env.PATH??"",LANG:"C"},mode:"ISOLATED_WRITE_TEST"});
        commands.push({command:[test.command,...test.args].join(" "),args:test.args,cwd:w.path,...out,elapsed_ms:Date.now()-started});
        if(out.exit_code!==0) passed=false;
      }
      if(hash(before)!==hash(treeSnapshot(w.path))) {this.quarantine(c,"TEST_EXECUTION_MUTATED_WORKTREE");throw new Error("TEST_EXECUTION_MUTATED_WORKTREE");}
      const changed=[...new Set([...git(w.path,["diff","--name-only",w.base_commit]).split("\n"),...git(w.path,["ls-files","--others","--exclude-standard"]).split("\n")].filter(Boolean))].sort();
      for(const path of changed) assertScope(c,path,w.path);
      if(hash(changed)!==hash([...r.changed_files].sort())) {this.quarantine(c,"CHANGED_FILES_EVIDENCE_MISMATCH");throw new Error("CHANGED_FILES_EVIDENCE_MISMATCH");}
      const commit=passed?checkpoint(this.bus,w,changed):null;
      verification={task_id:c.task_id,proposal_hash:p.content_hash,result_hash:hash(r),worktree_hash:hash(before),base_commit:w.base_commit,commands,passed,checkpoint:commit,
        diff:commit?git(w.path,["diff","--binary",w.base_commit,commit]):git(w.path,["diff","--binary",w.base_commit])};
      try { this.bus.storage.create(path,verification); }
      catch(error) { Object.assign(error as object,{recoverable_verification_publication:true}); throw error; }
      this.bus.events.append(c.parent_task_id!,"engineering.verification.recorded",{task_id:c.task_id,verification_hash:hash(verification)});
    }
    if(verification.result_hash!==hash(r)||verification.proposal_hash!==p.content_hash||verification.worktree_hash!==hash(treeSnapshot(w.path))) throw new Error("VERIFICATION_SOURCE_CHANGED");
    if(!this.bus.events.list(c.parent_task_id!).some(e=>e.event_type==="engineering.verification.recorded"&&e.payload.task_id===c.task_id&&e.payload.verification_hash===hash(verification))) this.bus.events.append(c.parent_task_id!,"engineering.verification.recorded",{task_id:c.task_id,verification_hash:hash(verification),recovered:true});
    if(!verification.passed) this.quarantine(c,r.status!=="completed"?r.status:"OWNED_VERIFICATION_FAILED");
    return {version:2,proposal_id:p.content.proposal_id,implementation_unit:unit.id,task_id:c.task_id,status:verification.passed?"completed":["needs_scope_expansion","proposal_deviation","failed"].includes(r.status)?r.status:"blocked",changed_files:r.changed_files,evidence:r.evidence,deviations:r.deviations,scope_expansion_requested:r.status==="needs_scope_expansion",known_issues:r.known_issues,worktree:w,checkpoint:verification.checkpoint,verification_hash:hash(verification),verification:publishedVerification(verification),worker_claims:{tests_executed:r.tests_executed,tests_not_executed:r.tests_not_executed}};
  }
  async apply(root:string,execute=false) {
    this.authority(); if(!execute) return {root_task:root,action:"apply",execute:false,authority:"Explicit fixture-only execution; application writes disabled"};
    return this.operation(root,"apply",async()=>{
      const {proposal:p}=assertEligible(this.bus,root,false),pair=isContractPair(p.content);
      if(!["PROPOSAL_APPROVED","API_CONTRACT_REQUIRED","API_CONTRACT_DEFINED","API_CONTRACT_REVIEWED","API_CONTRACT_LOCKED","IMPLEMENTATION_RUNNING","LOCAL_VERIFICATION"].includes(this.bus.events.get(root).state)) throw new Error("APPLY_STATE_REQUIRED");
      if(pair) await this.contractGate(root,p);
      assertEligible(this.bus,root);
      const fixtureBase=p.content.no_op?null:fixtureInfo(this.bus).base_commit;
      if(!this.bus.events.list(root).some(e=>e.event_type==="engineering.apply.authorized"&&e.payload.proposal_hash===p.content_hash)) this.bus.events.append(root,"engineering.apply.authorized",{proposal_hash:p.content_hash,fixture_base:fixtureBase,write_fixture_execution:!p.content.no_op,write_application_execution:false});
      if(["PROPOSAL_APPROVED","API_CONTRACT_LOCKED"].includes(this.bus.events.get(root).state)) this.advance(root,"IMPLEMENTATION_RUNNING");
      const applyUnit=async(unitId:string,base:string):Promise<string>=>{
        const unit=p.content.implementation_units.find(u=>u.id===unitId)!,path=`apply-${unit.id}-v${p.content.version}.json`;
        let a=this.existing(root,path) as Artifact<ApplyResult>|null;
        if(!a) {
          const w=this.ownedWorktree(root,p,unit,base),c=implementationCapsule(this.bus,root,p,unit,w);
          try {
            const r=await this.executeChild(c);
            if(r.status==="needs_contract_change" || r.api_contract_status==="change_requested") {
              this.quarantine(c,"needs_contract_change");this.advance(root,"BLOCKED");throw new Error("CONTRACT_CHANGE_BLOCKED");
            }
            const applied=await this.verifyUnit(c,p,unit,r);a=this.publish(root,path,"apply",c,r,applied);
          }
          catch(error) {
            // Once a complete artifact was durably written, a failure recording
            // its parent event is recoverable. Keep the worktree inspectable and
            // let resume attach the missing event; quarantine remains reserved
            // for invalid/mutated verification and failed writes.
            if(!this.bus.storage.exists("workflows",root,"engineering",path) && !this.bus.storage.exists("engineering-verifications",c.task_id+".json") && !(error as any)?.recoverable_verification_publication) this.quarantine(c,error instanceof Error?error.message:String(error));
            throw error;
          }
        }
        if(a.content.status!=="completed") throw new Error(`IMPLEMENTATION_BLOCKED: ${a.content.status}: ${a.child_task}`);
        return a.content.checkpoint;
      };
      if(pair) {
        const results=await bounded(p.content.ordering.map(unit=>()=>applyUnit(unit,fixtureBase!)),config().concurrency);
        const failure=results.find((r):r is PromiseRejectedResult=>r.status==="rejected");
        if(failure) { this.advance(root,"BLOCKED"); throw failure.reason; }
      } else {
        let base=fixtureBase;
        for(const unit of p.content.ordering) base=await applyUnit(unit,base!);
      }
      const subject=applySubject(this.bus,root);
      if(!this.bus.events.list(root).some(e=>e.event_type==="engineering.local-verification.completed"&&e.payload.subject_hash===subject.subject_hash)) this.bus.events.append(root,"engineering.local-verification.completed",{subject_hash:subject.subject_hash,no_op:p.content.no_op,units:p.content.ordering});
      if(this.bus.events.get(root).state==="IMPLEMENTATION_RUNNING") this.advance(root,"LOCAL_VERIFICATION");
      return this.show(root);
    });
  }
  async reviewApply(root:string,execute=false) {
    this.authority(); if(!execute) return {root_task:root,action:"apply-review",role:"opsx-apply-reviewer",execute:false};
    if(this.bus.events.get(root).state==="DONE") return this.show(root);
    return this.operation(root,"apply-review",async()=>{
      const {proposal:p}=assertEligible(this.bus,root),path=`apply-review-v${p.content.version}.json`;
      if(this.bus.events.get(root).state==="LOCAL_VERIFICATION") this.advance(root,"ADVERSARIAL_REVIEW");
      let a=this.existing(root,path);
      if(!a) {const c=applyReviewCapsule(this.bus,root),r=await this.executeChild(c);if(!r.review_result) throw new Error("REVIEW_ARTIFACT_REQUIRED");a=this.publish(root,path,"apply-review",c,r,r.review_result);}
      if(a.content.verdict==="approved") {
        if(this.bus.events.get(root).state==="ADVERSARIAL_REVIEW") this.advance(root,"REVIEW_GATE_APPLY");
        if(this.bus.events.get(root).state==="REVIEW_GATE_APPLY") this.advance(root,"DONE",a.content);
      }
      return this.show(root);
    });
  }
  async resume(root:string,execute=false):Promise<any> {
    if(!execute || this.bus.events.get(root).state==="DONE") return this.show(root);
    const action=this.bus.events.list(root).filter(e=>e.event_type==="engineering.action.started").at(-1);
    if(!action) return this.show(root);
    if(this.bus.events.list(root).some(e=>e.event_type==="engineering.action.completed"&&e.payload.action_event_id===action.event_id)) return this.show(root);
    const opts=action.payload.options as any;
    switch(action.payload.action) {
      case "propose": return this.propose(root,true,undefined,opts.revise===true,opts.version);
      case "proposal-review": return this.reviewProposal(root,true);
      case "apply": return this.apply(root,true);
      case "apply-review": return this.reviewApply(root,true);
      default: return this.show(root);
    }
  }
  retry(root:string,task:string,reason:string) {
    this.authority(); if(!reason.trim()) throw new Error("EXPLICIT_RETRY_REASON_REQUIRED");
    const lock=this.bus.storage.path("workflow-execution-"+id(root)+".lock"),fd=openSync(lock,"wx",0o600);
    try {
    engineeringManifest(this.bus,root);
    const c=this.bus.events.get(task).capsule;
    if(c.parent_task_id!==root||!c.constraints.includes("CORE_ENGINEERING_V1")||c.permissions!=="read-only"||records(this.bus,root).some(e=>e.payload.child_task===task)) throw new Error("ONLY_FAILED_READ_ONLY_CHILD_CAN_BE_REPLACED");
    const noncompleted=this.bus.storage.exists("results",task+".json")&&this.bus.result(task).status!=="completed";
    const rejectedArtifact=this.bus.events.list(root).some(e=>e.event_type==="engineering.action.failed"&&e.payload.child_task===task);
    if(!noncompleted&&!rejectedArtifact&&!this.bus.events.list(task).some(e=>e.event_type==="agent.failed")) throw new Error("ONLY_FAILED_READ_ONLY_CHILD_CAN_BE_REPLACED");
    const events=this.bus.events.list(root),old=events.find(e=>e.event_type==="engineering.child.replaced"&&e.payload.replacement_child===task);
    const base=String(old?.payload.original_child??task),count=events.filter(e=>e.event_type==="engineering.child.replaced"&&e.payload.original_child===base).length;
    if(count>=2) throw new Error("EXPLICIT_RETRY_LIMIT_REACHED");
    const replacement=id(`${base}-retry-${count+1}`);
    this.bus.events.append(root,"engineering.child.replaced",{original_child:base,previous_child:task,replacement_child:replacement,reason});
    return {root_task:root,replacement_child:replacement,execute:false};
    } finally {closeSync(fd);unlinkSync(lock);}
  }
  artifacts(root:string) {return records(this.bus,root).map(e=>readEngineeringArtifact(this.bus,root,String(e.payload.path)));}
  show(root:string) {
    engineeringManifest(this.bus,root);
    const p=latest<Proposal>(this.bus,root,"proposal"),reviewCandidate=latest<ReviewResult>(this.bus,root,"proposal-review"),applied=latest<ReviewResult>(this.bus,root,"apply-review");
    const review=p&&reviewCandidate&&reviewCandidate.content.subject_hash===proposalReviewSubject(this.bus,root,p)?reviewCandidate:null;
    const state=this.bus.events.get(root).state;
    let blocked:string|null=null;
    if(p?.content.open_decisions.length||!decision(this.bus,root)) blocked="WAITING_FOR_USER_DECISION";
    else if(review&&review.content.verdict!=="approved") blocked=review.content.verdict.toUpperCase();
    else if(review) {try {assertEligible(this.bus,root);} catch(error) {blocked=error instanceof Error?error.message:String(error);}}
    if(applied&&applied.content.verdict!=="approved") blocked=applied.content.verdict.toUpperCase();
    const failures=this.bus.events.list(root).filter(e=>e.event_type==="engineering.action.failed").map(e=>e.payload);
    const events=this.bus.events.list(root),types=events.map(e=>e.event_type),lastFailed=types.lastIndexOf("engineering.action.failed"),lastCompleted=types.lastIndexOf("engineering.action.completed"),lastStarted=types.lastIndexOf("engineering.action.started");
    if(!blocked&&lastFailed>lastCompleted&&lastFailed>lastStarted) blocked=String(events[lastFailed].payload.error);
    const units=p?.content.ordering.map(unit=>{
      const u=p.content.implementation_units.find(u=>u.id===unit)!, task=childId(this.bus,root,`${root}-apply-${unit}-v${p.content.version}`);
      const a=records(this.bus,root,"apply").find(e=>e.payload.child_task===task),events=this.bus.events.list(task);
      const result=a?readEngineeringArtifact<ApplyResult>(this.bus,root,String(a.payload.path)):null;
      const failure=events.find(e=>e.event_type==="agent.failed");
      return {unit,task_id:task,role:u.role,provider:events.find(e=>e.event_type==="agent.delegated")?.payload.provider??this.bus.routing(root)?.routes[u.role]?.provider??null,status:result?.content.status??(failure?"failed":events.some(e=>e.event_type==="agent.started")?"awaiting-verification":"pending"),worktree:result?.content.worktree??events.find(e=>e.event_type==="worktree.created")?.payload.worktree??null};
    })??[];
    if(units.some(u=>["failed","blocked","needs_scope_expansion","proposal_deviation"].includes(u.status))) blocked="IMPLEMENTATION_BLOCKED";
    return {root_task:root,state,proposal:p?{proposal_id:p.content.proposal_id,version:p.content.version,no_op:p.content.no_op,content_hash:p.content_hash}:null,proposal_review:review?.content??null,units,apply_review:applied?.content??null,blocked:state==="DONE"?null:blocked,failures};
  }
}
