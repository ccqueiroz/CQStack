import { relative } from "node:path";
import type { AgentBus } from "../../agent-bus/index.js";
import type { TaskCapsule, WorktreeDescriptor, ReviewResult } from "../../contracts.js";
import { hash } from "../../storage.js";
import { manifest, WORKSPACE } from "../artifacts.js";
import type { Artifact, Proposal, Unit, Reference } from "./contracts.js";
import { understanding, ref, decision, latest, proposalReviewSubject, applySubject, approvedProposal, assertEligible, engineeringManifest, readEngineeringArtifact, isContractPair, contractIdentity, contractChildId, childId, definedContract, approvedContract, architectReference } from "./artifacts.js";
import { git, fixtureInfo } from "./fixture.js";

export { childId };
function capsule(bus:AgentBus,root:string,task:string,role:string,responsibility:string,pkg:any,paths:string[],required=paths):TaskCapsule {
  const r=manifest(bus,root).request;
  return {task_id:childId(bus,root,task),parent_task_id:root,role,responsibility,goal:r.user_request,
    inputs:[JSON.stringify(pkg)],required_context:required,allowed_paths:paths,forbidden_paths:r.forbidden_paths,
    existing_patterns:[],api_contract_reference:null,visual_lock_reference:null,
    constraints:[...r.constraints,"CORE_ENGINEERING_V1","No services, credentials, application mutation, worker delegation, or visual/database/external-resource workflow implementation. Return concise structured AgentResult in Portuguese. Evidence sources must use workspace file:line or artifact:<child_task> from input_references or task:<root_task>. Read-only commands must not create temp files: no here-documents, here-strings or output redirections."],
    acceptance_criteria:["Evidence-backed result within the assigned responsibility"],owned_tests:[],permissions:"read-only",worktree:null,expected_output:"agent-result"};
}
export function proposalCapsule(bus:AgentBus,root:string,version:number,previous:Artifact<Proposal>|null,priorReview:Artifact<ReviewResult>|null):TaskCapsule {
  const all=understanding(bus,root), r=manifest(bus,root).request;
  const selected=all.filter(a=>["task-sense","truth","gap"].includes(a.stage));
  const d=decision(bus,root); if(!d) throw new Error("WAITING_FOR_USER_DECISION");
  const references:Reference[]=[...all.map(ref),...(previous?[ref(previous)]:[]),...(priorReview?[ref(priorReview)]:[])];
  const pkg={action:"proposal",original_request:r.user_request,repository_scope:r.repository_scope,constraints:r.constraints,decision:{event_id:d.event_id,text:d.payload.text},
    proposal_identity:{proposal_id:`${root}-proposal-v${version}`,root_task_id:root,version,previous_proposal_hash:previous?.content_hash??null},
    input_references:references,artifacts:selected.map(a=>({reference:ref(a),output:a.output})),evidence_references:all.filter(a=>["discovery","flow"].includes(a.stage)).map(ref),
    previous_proposal:previous?.content??null,review_findings:priorReview?.content??null};
  return capsule(bus,root,`${root}-proposal-v${version}`,"opsx-proposer",
    "Adapt opsx:propose: implement the explicit PO decision using verified Truth/Gap and existing evidence. Return proposal with the supplied identity and verified_gap_refs containing only the Gap reference. Design smallest semantic implementation units, dependency order and owned tests. Do not rediscover unnecessarily. Do not invent policy. open_decisions has exactly one meaning: a product decision that requires a human answer before this proposal can be reviewed; any entry blocks the workflow until the PO answers. Never put in open_decisions a choice delegated to the API Contract Architect or to reviewers, a warning, an assumption, a non-blocking doubt, or anything the request, the decision or the contract already resolves with a safe default; record those in risks, scope_boundaries or the unit description and proceed. Return open_decisions=[] whenever the supplied decision and request allow the work to proceed. Detect API, visual, database and external-resource requirements honestly. Empty verified Gap MUST yield no_op=true, zero units, zero tests and zero ordering; never invent work. For nonempty Gap use opsx-implementation-worker roles. The ordering field MUST be exclusively the dependency sequence of unit.id values from implementation_units; every ordering value MUST exactly match an existing unit.id. Never put workflow phase names, role names, responsibilities, descriptions or any other narrative text in ordering. For the Phase 3 fixture MVP requiring an API contract, use exactly one frontend-worker and one backend-worker with no depends_on, disjoint allowed paths and one parallelizable_units group containing both IDs; set requires_api_contract=true. In Phase 2, runnable tests use node with args [--test, tests/path.test.mjs]. No writes or OpenSpec scaffold/moves; immutable proposal/design/tasks semantics are represented by the structured proposal artifact. Cite only lines read and verified in this execution. To state that a file such as src/client.mjs does not exist yet, cite the artifact:<child_task> of the Gap or Truth that supports the conclusion or the task:<root_task> request that asks for its creation; if none supports it, record the absence in the unit description or in known_issues without evidence, never with an invented directory source. Owned tests: every value in implementation_units[].owned_test_ids MUST be copied exactly from a tests_required[].id whose unit_id is that same unit id; define the test entry first, then reference its id byte for byte. Never invent a different id for the reference (for example owned_test_ids [backend-pagination-test] while tests_required has id test-backend-pagination is invalid).",pkg,r.allowed_paths);
}
export function proposalReviewCapsule(bus:AgentBus,root:string,p:Artifact<Proposal>) {
  const r=manifest(bus,root).request, all=understanding(bus,root).filter(a=>["truth","gap"].includes(a.stage));
  const pkg={action:"proposal-review",original_request:r.user_request,decision:JSON.parse(bus.events.get(p.child_task).capsule.inputs[0]).decision,
    input_references:[...all.map(ref),ref(p)],artifacts:all.map(a=>({reference:ref(a),output:a.output})),proposal:p.content,subject_hash:proposalReviewSubject(bus,root,p)};
  return capsule(bus,root,`${root}-propose-review-v${p.content.version}`,"opsx-propose-reviewer",
    "Adapt review-gate:propose as an independent blind review. Challenge Proposal against original request, explicit PO decision and the supplied verified Truth/Gap artifacts. No code, tools or Discovery are available: do not reopen, read or search code and do not gather new evidence. Check scope creep, reinvention, unnecessary dependencies/complexity, semantic testable units, dependency order, owned tests, unsupported assumptions and future gates. Do not rewrite or implement. Return canonical review_result with task_id=root, reviewer=this child, supplied subject_hash, verdict approved/rejected/changes_required/blocked_by_future_phase, structured details (finding,severity,section,evidence,required_change), future_gates and evidence. findings lists ONLY defects requiring attention, not positive confirmations or no-defect statements. Every findings entry MUST have its own matching details entry with severity and evidence; do not return findings without details. If there are no defects return findings=[] and details=[]; put successful checks in evidence. Absence of a file or behavior is never evidence: cite the artifact:<child_task> that supports it or state it in the finding text without evidence. Approval requires no blocking findings and at most two warnings. A no-op proposal is correct for empty verified Gap. The API contract capability is available only for an independent frontend-worker/backend-worker pair in the registered fixture; an eligible pair requiring API review is not blocked_by_future_phase. Report visual/bank/external needs as blocking findings with verdict blocked_by_future_phase; never waive them or invent product policy. No proposer private reasoning or orchestrator transcript is available.",pkg,r.allowed_paths,[]);
}
export function implementationCapsule(bus:AgentBus,root:string,p:Artifact<Proposal>,unit:Unit,w:WorktreeDescriptor):TaskCapsule {
  const review=approvedProposal(bus,root).review;
  const tests=p.content.tests_required.filter(t=>unit.owned_test_ids.includes(t.id));
  const files=git(w.path,["ls-tree","-r","--name-only",w.base_commit]).split("\n");
  const pkg={action:"apply",input_references:[ref(p),ref(review)],proposal_id:p.content.proposal_id,proposal_hash:p.content_hash,
    unit,tests,constraints:p.content.scope_boundaries,out_of_scope:p.content.out_of_scope};
  const c=capsule(bus,root,`${root}-apply-${unit.id}-v${p.content.version}`,unit.role,
    `Implement only approved unit: ${unit.responsibility}. Follow supplied acceptance criteria and proposal. Use existing code; no unrelated refactors. owned_tests are this unit's Definition of Done: implement so they pass, but do not run them; the harness executes them deterministically after you return and only that run verifies the unit. Return tests_executed=[] and tests_not_executed=[]. Do not commit or modify Git metadata. If scope is insufficient, STOP with needs_scope_expansion and followups; if the approved approach cannot be followed, STOP with proposal_deviation (reason,affected_unit,expected_behavior,required_change). Never silently improvise. Return proposal_deviation=null on success. A completed unit MUST return deviations=[], known_issues=[] and requested_followups=[]; owned verification fails on any entry. Put non-blocking observations in risks.`,pkg,unit.allowed_paths,unit.allowed_paths.filter(path=>files.includes(path)));
  c.worktree=w; c.permissions="restricted-path-write"; c.forbidden_paths=[...new Set([...unit.forbidden_paths,".git","node_modules",".env"])];
  c.constraints=[...manifest(bus,root).request.constraints,"CORE_ENGINEERING_V1",`APPROVED_PROPOSAL_HASH:${p.content_hash}`,"Fixture-only write authority. No application source checkout writes, external services, credentials, Git metadata changes, broad tests or worker delegation."];
  c.acceptance_criteria=unit.acceptance_criteria; c.owned_tests=tests.map(t=>[t.command,...t.args].join(" "));
  if(isContractPair(p.content)) {
    c.api_contract_reference=approvedContract(bus,root);
    c.responsibility+=" Follow the supplied locked API contract exactly. If it cannot be followed, stop with needs_contract_change; this MVP blocks without changing the contract.";
  }
  return c;
}
export function apiContractCapsule(bus:AgentBus,root:string,p:Artifact<Proposal>):TaskCapsule {
  const review=approvedProposal(bus,root).review;
  const c=capsule(bus,root,contractChildId(root,p.content,"api-contract-architect"),"api-contract-architect",
    "Define only the HTTP contract required by the approved fixture proposal. Return structured api_contract using the supplied contract_identity. Cover only what the approved units implement: request parameters, the success response and pagination semantics, with their nullability and optionality. When no unit handles transport, return errors=[] and headers as an empty object schema; never specify status codes, headers or validation no unit produces. Reopen scoped sources. Do not implement or approve the contract.",
    {action:"api-contract",proposal_hash:p.content_hash,proposal:p.content,contract_identity:contractIdentity(root,p.content),input_references:[ref(p),ref(review)]},manifest(bus,root).request.allowed_paths);
  c.constraints=c.constraints.filter(s=>s!=="API_CONTRACT_REQUIRED");
  return c;
}
export function apiContractReviewCapsule(bus:AgentBus,root:string,p:Artifact<Proposal>,role:"api-contract-frontend-reviewer"|"api-contract-backend-reviewer"):TaskCapsule {
  const reference=definedContract(bus,root),review=approvedProposal(bus,root).review,architect=architectReference(bus,root,p);
  const contractSource=`artifact:${architect.child_task}`;
  const c=capsule(bus,root,contractChildId(root,p.content,role),role,
    `Independently review the supplied HTTP contract from the ${role==="api-contract-frontend-reviewer"?"frontend":"backend"} perspective against the approved fixture proposal. No code or tools are available: do not reopen or search code. Return review_result: task_id=root, reviewer=this child, role=this role, supplied subject_hash, verdict and evidence. Approve only if this side can implement the exact contract. Do not modify, implement or approve on behalf of the other reviewer. No architect reasoning or other reviewer output is supplied. To support any statement about the contract itself cite exactly ${contractSource}, the architect result listed in input_references; the contract id, its version, its hash or any state file name are never evidence sources.`,
    {action:"api-contract-review",proposal_hash:p.content_hash,proposal:p.content,subject_hash:reference.content_hash,contract_source:contractSource,input_references:[ref(p),ref(review),architect]},manifest(bus,root).request.allowed_paths,[]);
  c.api_contract_reference=reference;
  return c;
}
export function applyReviewCapsule(bus:AgentBus,root:string) {
  const {proposal,review}=approvedProposal(bus,root), subject=applySubject(bus,root);
  const verifications=subject.applies.map(a=>relative(WORKSPACE,bus.storage.path("engineering-verifications",a.child_task+".json")));
  const code=subject.applies.flatMap(a=>a.content.changed_files.map(p=>relative(WORKSPACE,a.content.worktree.path)+"/"+p));
  const paths=[...new Set([...manifest(bus,root).request.allowed_paths,...code,...verifications])];
  const pkg={action:"apply-review",original_request:manifest(bus,root).request.user_request,input_references:[ref(proposal),ref(review),...subject.applies.map(ref)],
    // Each worker enters as its scope, not its whole capsule: responsibility, constraints
    // and inputs already sit in the proposal and would double the package size.
    proposal:proposal.content,proposal_review:review.content,implementation:subject.applies.map(a=>{const w=bus.events.get(a.child_task).capsule;return {artifact:a.content,capsule:{task_id:w.task_id,role:w.role,allowed_paths:w.allowed_paths,forbidden_paths:w.forbidden_paths,acceptance_criteria:w.acceptance_criteria,owned_tests:w.owned_tests},result:bus.result(a.child_task)};}),
    verification_files:verifications,no_op:proposal.content.no_op,subject_hash:subject.subject_hash};
  const c=capsule(bus,root,`${root}-apply-review-v${proposal.content.version}`,"opsx-apply-reviewer",
    "Adapt review-gate:apply as an independent blind reviewer. Reopen supplied changed files and runtime verification files containing Git diff and actual test stdout/stderr/exit. Compare implementation with APPROVED Proposal and each capsule. Check authorized paths, requirements, scope, deviations, known issues, sufficient owned tests and real outputs. Worker completed is not approval. For no_op verify empty Gap-backed proposal and absence of implementation units; no tests or writes are needed. Return review_result with supplied subject_hash, root task_id, this reviewer ID, verdict approved/rejected/changes_required/blocked, structured details, future_gates and evidence. findings lists ONLY defects requiring attention, not positive confirmations or no-defect statements. Every findings entry MUST have its own matching details entry with severity and evidence. If there are no defects return findings=[] and details=[]; put successful checks in evidence. Every code evidence.source MUST include an exact workspace-relative file path from allowed_paths and line number; never an absolute path, bare path or bare filename. Approve only with zero blocking findings and at most two warnings. Do not run tests, write, delegate, access services or launch processes requiring teardown.",pkg,paths);
  if(isContractPair(proposal.content)) {
    c.api_contract_reference=approvedContract(bus,root);
    c.responsibility+=" Verify both frontend and backend results against the exact supplied API lock; one role cannot satisfy the other role's responsibility.";
  }
  return c;
}
export function assertEngineeringChild(bus:AgentBus,task:string) {
  const c=bus.events.get(task).capsule, root=c.parent_task_id;
  if(!root || !c.constraints.includes("CORE_ENGINEERING_V1")) throw new Error("ENGINEERING_CHILD_REQUIRED");
  engineeringManifest(bus,root);
  if(!bus.events.list(root).some(e=>e.event_type==="workflow.child.created"&&e.payload.child_task===task&&e.payload.capsule_hash===hash(c))) throw new Error("WORKFLOW_CHILD_NOT_AUTHORIZED");
  const pkg=JSON.parse(c.inputs[0]), state=bus.events.get(root).state;
  let expected:TaskCapsule;
  if(pkg.action==="proposal") {
    if(!["GAP_DEFINED","PROPOSAL_CREATED"].includes(state)) throw new Error("PROPOSAL_STATE_REQUIRED");
    const version=pkg.proposal_identity.version;
    const previous=version>1 ? readEngineeringArtifact<Proposal>(bus,root,`proposal-v${version-1}.json`) : null;
    const previousReview=version>1 && bus.storage.exists("workflows",root,"engineering",`proposal-review-v${version-1}.json`) ? readEngineeringArtifact<ReviewResult>(bus,root,`proposal-review-v${version-1}.json`) : null;
    expected=proposalCapsule(bus,root,version,previous,previousReview);
  } else if(pkg.action==="proposal-review") {
    if(state!=="PROPOSAL_CREATED") throw new Error("PROPOSAL_STATE_REQUIRED");
    const p=latest<Proposal>(bus,root,"proposal"); if(!p || p.content.open_decisions.length) throw new Error("WAITING_FOR_USER_DECISION");
    expected=proposalReviewCapsule(bus,root,p);
  } else if(pkg.action==="api-contract" || pkg.action==="api-contract-review") {
    const {proposal}=assertEligible(bus,root,false);
    if(!isContractPair(proposal.content)) throw new Error("API_CONTRACT_PAIR_REQUIRED");
    if(pkg.action==="api-contract") {
      if(state!=="API_CONTRACT_REQUIRED") throw new Error("API_CONTRACT_STATE_REQUIRED");
      expected=apiContractCapsule(bus,root,proposal);
    } else {
      if(state!=="API_CONTRACT_DEFINED" || !["api-contract-frontend-reviewer","api-contract-backend-reviewer"].includes(c.role)) throw new Error("API_CONTRACT_REVIEW_STATE_REQUIRED");
      expected=apiContractReviewCapsule(bus,root,proposal,c.role as "api-contract-frontend-reviewer"|"api-contract-backend-reviewer");
    }
  } else if(pkg.action==="apply") {
    if(state!=="IMPLEMENTATION_RUNNING" || !c.worktree) throw new Error("IMPLEMENTATION_STATE_REQUIRED");
    const {proposal}=assertEligible(bus,root), f=fixtureInfo(bus);
    if(!bus.events.list(root).some(e=>e.event_type==="engineering.apply.authorized"&&e.payload.proposal_hash===proposal.content_hash&&e.payload.fixture_base===f.base_commit)) throw new Error("FIXTURE_EXECUTION_AUTHORIZATION_REQUIRED");
    const unit=proposal.content.implementation_units.find(u=>u.id===pkg.unit.id); if(!unit) throw new Error("UNKNOWN_IMPLEMENTATION_UNIT");
    if(c.worktree.repository!==f.repository) throw new Error("APPLICATION_WRITE_DISABLED");
    const w=bus.events.list(root).find(e=>e.event_type==="engineering.worktree.created"&&e.payload.task_id===task);
    if(!w || hash(w.payload.worktree)!==hash(c.worktree)) throw new Error("WORKTREE_TASK_MISMATCH");
    const preceding=isContractPair(proposal.content)?[]:proposal.content.ordering.slice(0,proposal.content.ordering.indexOf(unit.id));
    let base=f.base_commit;
    for(const id of preceding) {
      const record=readEngineeringArtifact<any>(bus,root,`apply-${id}-v${proposal.content.version}.json`);
      if(record.content.status!=="completed") throw new Error("DEPENDENCY_NOT_VERIFIED");
      base=record.content.checkpoint;
    }
    if(c.worktree.base_commit!==base || c.worktree.base_ref!==base) throw new Error("WORKTREE_BASE_MISMATCH");
    expected=implementationCapsule(bus,root,proposal,unit,c.worktree);
  } else if(pkg.action==="apply-review") {
    if(!["LOCAL_VERIFICATION","ADVERSARIAL_REVIEW"].includes(state)) throw new Error("APPLY_REVIEW_STATE_REQUIRED");
    expected=applyReviewCapsule(bus,root);
  } else throw new Error("UNKNOWN_ENGINEERING_ACTION");
  if(hash(expected)!==hash(c)) throw new Error("ENGINEERING_CAPSULE_MISMATCH");
}
