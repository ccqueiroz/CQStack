import { readFileSync } from "node:fs";
import { resolve, posix } from "node:path";
import type { AgentBus } from "../../agent-bus/index.js";
import type { AgentResult, ApiContract, ArtifactReference, Evidence, ReviewResult, TaskCapsule, TaskState } from "../../contracts.js";
import { hash, scopePath, within, id } from "../../storage.js";
import { validate } from "../../validation/index.js";
import { assertClosedEvidence, closedEvidenceAllowlist } from "../../validation/evidence.js";
import { manifest, expectedChildren, readArtifact, WORKSPACE } from "../artifacts.js";
import { STAGES } from "../contracts.js";
import type { Artifact, ApplyResult, ApplyResultV2, EngineeringManifest, Proposal, Reference } from "./contracts.js";
import { assertCheckpoint, fixtureInfo } from "./fixture.js";

export function hasEngineering(bus: AgentBus, root: string) { return bus.storage.exists("workflows", id(root), "engineering", "manifest.json"); }
export function understanding(bus: AgentBus, root: string) {
  const m = manifest(bus, root);
  return STAGES.flatMap(s => expectedChildren(m, s, bus)).map(c => readArtifact(bus, root, c));
}
export const ref = (a: {child_task: string; content_hash: string}): Reference => ({ child_task: a.child_task, content_hash: a.content_hash });
export function engineeringManifest(bus: AgentBus, root: string, basic?:ReturnType<typeof understanding>): EngineeringManifest {
  const m = bus.storage.read<EngineeringManifest>("workflows", id(root), "engineering", "manifest.json");
  if (m.version !== 1 || m.root_task !== root || m.understanding_manifest_hash !== hash(manifest(bus, root)) || !bus.events.list(root).some(e => e.event_type === "engineering.enrolled" && e.payload.manifest_hash === hash(m))) throw new Error("ENGINEERING_MANIFEST_INVALID");
  const artifacts = basic??understanding(bus, root);
  for (const [stage, r] of [["gap", m.gap], ["truth", m.truth]] as const) if (!artifacts.some(a => a.stage === stage && hash(ref(a)) === hash(r))) throw new Error("ENGINEERING_INPUT_CHANGED");
  return m;
}
export function gapIsEmpty(bus: AgentBus, root: string, basic?:ReturnType<typeof understanding>) {
  const gap = (basic??understanding(bus, root)).find(a => a.stage === "gap")!.output.content;
  return ["missing_behaviors", "missing_integrations", "missing_contracts"].every(k => gap[k].length === 0);
}
export function decision(bus: AgentBus, root: string) {
  return bus.events.list(root).filter(e => e.event_type === "engineering.user-decision").at(-1);
}
export function evidenceInScope(evidence: Evidence[], c: TaskCapsule, inputs: Reference[], base = WORKSPACE) {
  for (const e of evidence) for (const source of e.source.split(";").map(s => s.trim())) {
    if (source === `task:${c.parent_task_id}` || inputs.some(r => source === `artifact:${r.child_task}`)) continue;
    const match = /^(.*?):([0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)$/.exec(source);
    if (!match) throw new Error("ENGINEERING_EVIDENCE_REFERENCE_REQUIRED: " + source);
    const path = scopePath(base, match[1]);
    if (!c.allowed_paths.some(p => within(scopePath(base, p), path)) || c.forbidden_paths.some(p => within(scopePath(base,p),path))) throw new Error("ENGINEERING_EVIDENCE_OUT_OF_SCOPE");
    const lines = readFileSync(path, "utf8").split("\n").length;
    for (const range of match[2].split(",")) { const [a,b=a] = range.split("-").map(Number); if (a < 1 || b < a || b > lines) throw new Error("EVIDENCE_LINE_MISSING"); }
  }
}
// Proposal and API contract reviewers gather no evidence of their own: the
// runtime closes their evidence.source to the references they received plus the
// sources already present in the validated artifacts and subject in their inputs.
export function reviewEvidenceAllowlist(c: TaskCapsule): Set<string> {
  const pkg = JSON.parse(c.inputs[0]);
  const inherited = [...((pkg.artifacts ?? []) as { output: unknown }[]).map(a => a.output), ...(pkg.proposal ? [pkg.proposal] : [])];
  return closedEvidenceAllowlist(inherited, [`task:${c.parent_task_id}`, ...(pkg.input_references as Reference[]).map(r => `artifact:${r.child_task}`)]);
}
export const REVIEW_EVIDENCE_NOT_IN_INPUTS = "ENGINEERING_EVIDENCE_NOT_IN_INPUTS";
export function validateProposal(bus: AgentBus, root: string, p: Proposal, c: TaskCapsule, inputs: Reference[], basic?:ReturnType<typeof understanding>) {
  validate("proposal", p);
  const m = manifest(bus, root), em = engineeringManifest(bus, root,basic);
  if (p.root_task_id !== root || p.proposal_id !== `${root}-proposal-v${p.version}` || hash(p.verified_gap_refs) !== hash([em.gap])) throw new Error("PROPOSAL_PROVENANCE_INVALID");
  const identity=JSON.parse(c.inputs[0]).proposal_identity;
  if(hash(identity)!==hash({proposal_id:p.proposal_id,root_task_id:p.root_task_id,version:p.version,previous_proposal_hash:p.previous_proposal_hash})) throw new Error("PROPOSAL_IDENTITY_MISMATCH");
  if (p.no_op !== gapIsEmpty(bus, root,basic)) throw new Error("PROPOSAL_GAP_MISMATCH");
  if (p.no_op && (p.implementation_units.length || p.tests_required.length || p.ordering.length)) throw new Error("ZERO_GAP_REQUIRES_NO_IMPLEMENTATION");
  if (!p.no_op && !p.implementation_units.length) throw new Error("MISSING_IMPLEMENTATION_UNITS");
  const allowed = (path: string) => {
    const full = scopePath(WORKSPACE,path);
    if (!m.request.allowed_paths.some(a=>within(scopePath(WORKSPACE,a),full)) || m.request.forbidden_paths.some(a=>within(scopePath(WORKSPACE,a),full))) throw new Error("PROPOSAL_SCOPE_EXPANSION");
  };
  for (const path of p.affected_files_or_areas) allowed(path);
  if (p.affected_repositories.some(r=>!m.request.repository_scope.includes(r))) throw new Error("PROPOSAL_REPOSITORY_EXPANSION");
  const ids = p.implementation_units.map(u=>u.id);
  if (new Set(ids).size !== ids.length || hash([...p.ordering].sort()) !== hash([...ids].sort())) throw new Error("INVALID_UNIT_ORDER");
  if (new Set(p.tests_required.map(t=>t.id)).size !== p.tests_required.length) throw new Error("DUPLICATE_TEST_ID");
  for (const unit of p.implementation_units) {
    if (!p.affected_repositories.includes(unit.repository) || !m.request.repository_scope.includes(unit.repository) || !unit.allowed_paths.length || !unit.acceptance_criteria.length) throw new Error("INVALID_IMPLEMENTATION_UNIT");
    for (const path of [...unit.allowed_paths,...unit.forbidden_paths]) scopePath(resolve(WORKSPACE,unit.repository),path);
    for (const path of unit.allowed_paths) {
      if (path.split("/").some(s=>s===".git" || s==="node_modules" || s.startsWith(".env"))) throw new Error("PROPOSAL_FORBIDDEN_PATH");
      allowed(`${unit.repository}/${path}`);
      if (unit.forbidden_paths.some(f=>within(scopePath(unit.repository,f),scopePath(unit.repository,path)))) throw new Error("PROPOSAL_FORBIDDEN_PATH");
    }
    if (unit.depends_on.some(d=>!ids.includes(d) || p.ordering.indexOf(d)>=p.ordering.indexOf(unit.id))) throw new Error("INVALID_UNIT_DEPENDENCY");
    if (!unit.owned_test_ids.length || unit.owned_test_ids.some(t=>!p.tests_required.some(x=>x.id===t && x.unit_id===unit.id))) throw new Error("OWNED_TESTS_REQUIRED");
    evidenceInScope(unit.evidence,c,inputs);
  }
  for (const t of p.tests_required) {
    const unit=p.implementation_units.find(u=>u.id===t.unit_id);
    if (!unit || !unit.owned_test_ids.includes(t.id) || t.command!=="node" || t.args.length!==2 || t.args[0]!=="--test" || !/^tests\/[a-zA-Z0-9_./-]+\.(mjs|js)$/.test(t.args[1])) throw new Error("UNSUPPORTED_OWNED_TEST");
    scopePath(WORKSPACE,t.args[1]);
    if (!unit.allowed_paths.some(a=>within(scopePath(WORKSPACE,a),scopePath(WORKSPACE,t.args[1])))) throw new Error("TEST_OUTSIDE_UNIT_SCOPE");
  }
  for (const group of p.parallelizable_units) if (group.some(u=>!ids.includes(u))) throw new Error("UNKNOWN_PARALLEL_UNIT");
  evidenceInScope(p.evidence,c,inputs);
}
// The proposer receives scope as the relation validateProposal checks: areas are
// workspace-relative paths inside request.allowed_paths; unit paths are those same
// paths projected relative to each repository of repository_scope (a repository that
// lies inside an allowed path admits any repository-relative path).
export function proposalScopePatterns(allowedPaths: string[], repositories: string[]): { areas: string; units: string | null } {
  const normalize = (path: string) => posix.normalize(path).replace(/^\.\/+/, "").replace(/\/+$/, "");
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const under = (prefix: string) => prefix === "" ? ".+" : `${escape(prefix)}(?:/.+)?`;
  const allowed = allowedPaths.map(normalize), scopes = repositories.map(normalize);
  const prefixes = [...new Set(scopes.flatMap(repository => allowed.flatMap(path => path === repository || repository.startsWith(path + "/") ? [""] : path.startsWith(repository + "/") ? [path.slice(repository.length + 1)] : [])))];
  return { areas: `^(?:${allowed.map(under).join("|")})$`, units: prefixes.length ? `^(?:${prefixes.map(under).join("|")})$` : null };
}
export function records(bus: AgentBus, root: string, kind?: Artifact["kind"]) {
  return bus.events.list(root).filter(e=>e.event_type==="engineering.artifact.created" && (!kind || e.payload.kind===kind));
}
interface ReadContext { basic:ReturnType<typeof understanding>; validated:Map<string,Artifact> }
export function readEngineeringArtifact<T=any>(bus: AgentBus, root: string, path: string, seen=new Set<string>(), context?:ReadContext): Artifact<T> {
  if (!/^[a-z0-9-]+\.json$/.test(path)) throw new Error("INVALID_ENGINEERING_ARTIFACT_PATH");
  const a=bus.storage.read<Artifact<T>>("workflows",id(root),"engineering",path);
  return validateEngineeringArtifact(bus,root,a,seen,context);
}
export function resolveReference(bus: AgentBus, root: string, r: Reference, seen=new Set<string>(), context?:ReadContext): any {
  const basic=(context?.basic??understanding(bus,root)).find(a=>hash(ref(a))===hash(r)); if(basic) return basic;
  const event=records(bus,root).find(e=>e.payload.child_task===r.child_task && e.payload.content_hash===r.content_hash);
  if(!event) throw new Error("ENGINEERING_INPUT_REFERENCE_INVALID");
  return readEngineeringArtifact(bus,root,String(event.payload.path),seen,context);
}
export function validateEngineeringArtifact<T>(bus: AgentBus, root: string, a: Artifact<T>, seen=new Set<string>(), context?:ReadContext): Artifact<T> {
  context??={basic:understanding(bus,root),validated:new Map()};
  if(seen.has(a.child_task)) throw new Error("ARTIFACT_REFERENCE_CYCLE"); seen.add(a.child_task);
  const cached=context.validated.get(a.child_task);
  if(cached) { if(hash(cached)!==hash(a)) throw new Error("ENGINEERING_REFERENCE_CHANGED"); return cached as Artifact<T>; }
  engineeringManifest(bus,root,context.basic);
  const {content_hash,...body}=a, c=bus.events.get(a.child_task).capsule, result=bus.result(a.child_task);
  const route=bus.events.list(a.child_task).find(e=>e.event_type==="agent.delegated")?.payload;
  if(hash(body)!==content_hash || a.root_task!==root || c.parent_task_id!==root || a.role!==c.role || a.provider!==route?.provider || a.model_alias!==route?.model_alias || a.model!==route?.model || a.source_agent_result.child_task!==a.child_task || a.source_agent_result.content_hash!==hash(result)) throw new Error("ENGINEERING_ARTIFACT_PROVENANCE_INVALID");
  if(!bus.events.list(a.child_task).some(e=>["agent.completed","agent.failed"].includes(e.event_type)&&e.payload.result_hash===hash(result))) throw new Error("AGENT_COMPLETION_REQUIRED");
  if(!bus.events.list(root).some(e=>e.event_type==="workflow.child.created"&&e.payload.child_task===a.child_task&&e.payload.capsule_hash===hash(c))) throw new Error("WORKFLOW_CHILD_NOT_AUTHORIZED");
  for(const input of a.input_artifact_references) resolveReference(bus,root,input,new Set(seen),context);
  const pkg=JSON.parse(c.inputs[0]);
  if(hash(pkg.input_references)!==hash(a.input_artifact_references)) throw new Error("ENGINEERING_INPUT_SET_MISMATCH");
  if(a.kind==="proposal") {
    if(c.role!=="opsx-proposer" || hash(a.content)!==hash(result.proposal) || result.status!=="completed") throw new Error("PROPOSAL_RESULT_MISMATCH");
    validateProposal(bus,root,a.content as Proposal,c,a.input_artifact_references,context.basic);
    evidenceInScope(result.evidence,c,a.input_artifact_references);
  } else if(a.kind==="proposal-review" || a.kind==="apply-review") {
    const review=a.content as ReviewResult;
    if(c.role!==(a.kind==="proposal-review"?"opsx-propose-reviewer":"opsx-apply-reviewer") || hash(review)!==hash(result.review_result) || result.status!=="completed" || review.subject_hash!==pkg.subject_hash) throw new Error("ENGINEERING_REVIEW_PROVENANCE_INVALID");
    bus.verifyReview(review,root,pkg.subject_hash);
    if(!review.details || !review.future_gates) throw new Error("STRUCTURED_REVIEW_REQUIRED");
    if(review.verdict==="approved" && (review.details.some(f=>f.severity==="blocking") || review.details.filter(f=>f.severity==="warning").length>2 || review.findings.length>review.details.length)) throw new Error("REVIEW_RUBRIC_NOT_PASSED");
    evidenceInScope(review.evidence,c,a.input_artifact_references);
    for(const finding of review.details) evidenceInScope(finding.evidence,c,a.input_artifact_references);
    if(a.kind==="proposal-review") assertClosedEvidence({review,result_evidence:result.evidence},reviewEvidenceAllowlist(c),REVIEW_EVIDENCE_NOT_IN_INPUTS);
  } else if(a.kind==="apply") {
    validate("apply-result",a.content);
    const applied=a.content as ApplyResult;
    if(!["opsx-implementation-worker","frontend-worker","backend-worker"].includes(c.role) || c.role!==pkg.unit.role || !c.worktree || hash(c.worktree)!==hash(applied.worktree) || applied.task_id!==c.task_id || hash(applied.changed_files)!==hash(result.changed_files)) throw new Error("APPLY_RESULT_PROVENANCE_INVALID");
    if(c.role!=="opsx-implementation-worker" && hash(c.api_contract_reference)!==hash(approvedContract(bus,root))) throw new Error("APPLY_CONTRACT_MISMATCH");
    const verification=bus.storage.read<any>("engineering-verifications",c.task_id+".json");
    if(hash(verification)!==applied.verification_hash || verification.result_hash!==hash(result) || verification.task_id!==c.task_id || verification.proposal_hash!==pkg.proposal_hash || applied.proposal_id!==pkg.proposal_id || applied.implementation_unit!==pkg.unit.id || hash(applied.version===2?applied.worker_claims:{tests_executed:applied.tests_executed,tests_not_executed:applied.tests_not_executed})!==hash({tests_executed:result.tests_executed,tests_not_executed:result.tests_not_executed}) || (applied.version===2&&hash(applied.verification)!==hash(publishedVerification(verification))) || hash(applied.deviations)!==hash(result.deviations) || hash(applied.evidence)!==hash(result.evidence) || hash(applied.known_issues)!==hash(result.known_issues) || applied.scope_expansion_requested!==(result.status==="needs_scope_expansion")) throw new Error("APPLY_VERIFICATION_INVALID");
    if(!bus.events.list(root).some(e=>e.event_type==="engineering.verification.recorded"&&e.payload.task_id===c.task_id&&e.payload.verification_hash===applied.verification_hash)) throw new Error("VERIFICATION_EVENT_REQUIRED");
    if(applied.status==="completed") { if(bus.storage.exists("quarantine",c.worktree.id+".json") || result.status!=="completed" || result.deviations.length || result.known_issues.length || result.scope_expanded || result.requested_followups.length || result.api_contract_status==="change_requested" || result.visual_lock_status==="approval_required" || result.proposal_deviation || !applied.checkpoint || !verification.passed || verification.checkpoint!==applied.checkpoint || verification.commands.some((t:any)=>t.exit_code!==0) || hash(verification.commands.map((t:any)=>t.command))!==hash(c.owned_tests)) throw new Error("APPLY_NOT_VERIFIED"); bus.worktrees.validate(c.worktree); assertCheckpoint(c.worktree,applied.checkpoint); }
    evidenceInScope(result.evidence,c,a.input_artifact_references,c.worktree.path);
  } else throw new Error("UNKNOWN_ENGINEERING_ARTIFACT");
  context.validated.set(a.child_task,a);return a;
}
// The harness run, not the worker's claim, is what a v2 ApplyResult reports as tested.
export function publishedVerification(verification:{passed:boolean;commands:{command:string;exit_code:number|null}[]}):ApplyResultV2["verification"] {
  return {passed:verification.passed,commands:verification.commands.map(t=>({command:t.command,exit_code:t.exit_code}))};
}
export function latest<T=any>(bus: AgentBus, root: string, kind: Artifact["kind"]): Artifact<T> | null {
  const e=records(bus,root,kind).at(-1); return e?readEngineeringArtifact<T>(bus,root,String(e.payload.path)):null;
}
export function proposalReviewSubject(bus: AgentBus,root:string,p:Artifact<Proposal>) {
  const em=engineeringManifest(bus,root);
  return hash({original_request:manifest(bus,root).request,truth:em.truth,gap:em.gap,proposal:ref(p),decision:JSON.parse(bus.events.get(p.child_task).capsule.inputs[0]).decision});
}
export function approvedProposal(bus:AgentBus,root:string) {
  const p=latest<Proposal>(bus,root,"proposal"), review=latest<ReviewResult>(bus,root,"proposal-review");
  if(!p || !review || review.content.verdict!=="approved" || review.content.subject_hash!==proposalReviewSubject(bus,root,p)) throw new Error("APPROVED_PROPOSAL_REQUIRED");
  const reviewedDecision=JSON.parse(bus.events.get(review.child_task).capsule.inputs[0]).decision?.event_id;
  if(decision(bus,root)?.event_id!==reviewedDecision) throw new Error("PROPOSAL_DECISION_CHANGED");
  if(p.content.open_decisions.length) throw new Error("WAITING_FOR_USER_DECISION");
  return {proposal:p,review};
}
// The MVP supports exactly one independent frontend/backend pair in the registered fixture.
export function isContractPair(p:Proposal):boolean {
  return p.requires_api_contract && !p.no_op && p.implementation_units.length===2 &&
    hash(p.implementation_units.map(u=>u.role).sort())===hash(["backend-worker","frontend-worker"]) &&
    p.implementation_units.every(u=>u.depends_on.length===0) && p.parallelizable_units.length===1 &&
    hash([...p.parallelizable_units[0]].sort())===hash([...p.ordering].sort());
}
// An explicit engineering retry replaces a child; every reader resolves the latest replacement.
export function childId(bus:AgentBus,root:string,base:string) {
  return bus.events.list(root).filter(e=>e.event_type==="engineering.child.replaced"&&e.payload.original_child===base).at(-1)?.payload.replacement_child as string ?? base;
}
export function contractChildId(root:string,p:Proposal,role:string):string {
  return id(`${root}-${role}-v${p.version}`);
}
export function contractIdentity(root:string,p:Proposal) {
  return {contract_id:id(`${root}-api`),task_id:root,version:String(p.version)};
}
function contractChildResult(bus:AgentBus,root:string,p:Artifact<Proposal>,role:string):AgentResult {
  const task=childId(bus,root,contractChildId(root,p.content,role));
  if(!bus.storage.exists("results",task+".json")) throw new Error("API_CONTRACT_RESULT_REQUIRED");
  const c=bus.events.get(task).capsule,r=bus.result(task),pkg=JSON.parse(c.inputs[0]);
  if(c.role!==role || c.parent_task_id!==root || c.permissions!=="read-only" || r.task_id!==task || r.role!==role || r.status!=="completed" || r.changed_files.length || r.scope_expanded || pkg.proposal_hash!==p.content_hash ||
    !bus.events.list(root).some(e=>e.event_type==="workflow.child.created"&&e.payload.child_task===task&&e.payload.capsule_hash===hash(c)) ||
    !bus.events.list(task).some(e=>e.event_type==="agent.completed"&&e.role===role&&e.payload.result_hash===hash(r))) throw new Error("API_CONTRACT_PROVENANCE_INVALID");
  evidenceInScope(r.evidence,c,pkg.input_references);
  if(role!=="api-contract-architect") assertClosedEvidence({evidence:r.evidence,review:r.review_result},reviewEvidenceAllowlist(c),REVIEW_EVIDENCE_NOT_IN_INPUTS);
  return r;
}
// Canonical identity of the contract for reviewer evidence: the architect child
// that produced it, never the contract id, its hash or a state file name.
export function architectReference(bus:AgentBus,root:string,p:Artifact<Proposal>):Reference {
  const result=contractChildResult(bus,root,p,"api-contract-architect");
  return {child_task:result.task_id,content_hash:hash(result)};
}
export function contractOutput(bus:AgentBus,root:string):ApiContract {
  const {proposal:p}=approvedProposal(bus,root);
  const result=contractChildResult(bus,root,p,"api-contract-architect");
  const contract=validate<ApiContract>("api-contract",result.api_contract);
  if(hash({contract_id:contract.contract_id,task_id:contract.task_id,version:contract.version})!==hash(contractIdentity(root,p.content))) throw new Error("API_CONTRACT_IDENTITY_MISMATCH");
  return contract;
}
export function definedContract(bus:AgentBus,root:string):ArtifactReference {
  const contract=contractOutput(bus,root);
  const reference={id:contract.contract_id,version:contract.version,content_hash:hash(contract)};
  if(hash(bus.locks.get(reference).contract)!==reference.content_hash || !bus.events.list(root).some(e=>e.event_type==="contract.created"&&hash(e.payload.reference)===hash(reference))) throw new Error("API_CONTRACT_PROVENANCE_INVALID");
  return reference;
}
// Validates one contract reviewer's persisted result on its own, so the engineering
// action can attribute a rejection to the child that produced it.
export function contractReview(bus:AgentBus,root:string,p:Artifact<Proposal>,role:string,reference:ArtifactReference):ReviewResult {
  const r=contractChildResult(bus,root,p,role),review=r.review_result;
  const c=bus.events.get(r.task_id).capsule;
  if(!review || review.role!==role || review.reviewer!==r.task_id || hash(c.api_contract_reference)!==hash(reference)) throw new Error("API_CONTRACT_REVIEW_REQUIRED");
  bus.verifyReview(review,root,reference.content_hash);
  evidenceInScope(review.evidence,c,JSON.parse(c.inputs[0]).input_references);
  return review;
}
export function contractReviews(bus:AgentBus,root:string) {
  const {proposal:p}=approvedProposal(bus,root),reference=definedContract(bus,root);
  const reviews=["api-contract-frontend-reviewer","api-contract-backend-reviewer"].map(role=>{
    const review=contractReview(bus,root,p,role,reference);
    if(review.verdict!=="approved") throw new Error("API_CONTRACT_REVIEW_REQUIRED");
    return review;
  });
  return {reference,frontend:reviews[0],backend:reviews[1]};
}
export function approvedContract(bus:AgentBus,root:string):ArtifactReference {
  const {reference,frontend,backend}=contractReviews(bus,root);
  bus.locks.require(reference);
  const {lock}=bus.locks.get(reference);
  if(lock!.task_id!==root || lock!.frontend_reviewer!==frontend.reviewer || lock!.backend_reviewer!==backend.reviewer || !bus.events.list(root).some(e=>e.event_type==="contract.locked"&&hash(e.payload.lock)===hash(lock))) throw new Error("API_CONTRACT_LOCK_PROVENANCE_INVALID");
  return reference;
}
export function assertEligible(bus:AgentBus,root:string,requireContractLock=true) {
  const {proposal:p,review}=approvedProposal(bus,root);
  const pair=isContractPair(p.content);
  const flags=[p.content.requires_api_contract&&!pair,p.content.requires_visual_approval,p.content.requires_database_change,p.content.requires_external_resource];
  if(flags.some(Boolean) || review.content.future_gates!.some(g=>g!=="api-contract-system"||!pair) || manifest(bus,root).request.constraints.some(c=>["VISUAL_REVIEW_REQUIRED","DATABASE_CHANGE_REQUIRED","EXTERNAL_RESOURCE_REQUIRED",...(!pair?["API_CONTRACT_REQUIRED"]:[])].includes(c))) throw new Error("BLOCKED_BY_FUTURE_PHASE");
  if(!pair && p.content.implementation_units.some(u=>u.role!=="opsx-implementation-worker")) throw new Error("API_CONTRACT_REQUIRED");
  if(!p.content.no_op) { if(!bus.storage.exists("fixtures","registration.json")) throw new Error("APPLICATION_WRITE_DISABLED"); const f=fixtureInfo(bus); if(p.content.affected_repositories.length!==1 || p.content.affected_repositories[0]!==f.workspace_path || p.content.implementation_units.some(u=>u.repository!==f.workspace_path)) throw new Error("APPLICATION_WRITE_DISABLED"); }
  if(pair&&requireContractLock) approvedContract(bus,root);
  return {proposal:p,review};
}
export function applySubject(bus:AgentBus,root:string) {
  const {proposal,review}=assertEligible(bus,root);
  const applies=records(bus,root,"apply").map(e=>readEngineeringArtifact<ApplyResult>(bus,root,String(e.payload.path)));
  if(isContractPair(proposal.content)) applies.sort((a,b)=>proposal.content.ordering.indexOf(a.content.implementation_unit)-proposal.content.ordering.indexOf(b.content.implementation_unit));
  if(applies.length!==proposal.content.implementation_units.length || applies.some(a=>a.content.status!=="completed") || hash(applies.map(a=>a.content.implementation_unit))!==hash(proposal.content.ordering)) throw new Error("IMPLEMENTATION_UNITS_INCOMPLETE");
  const body={proposal:ref(proposal),proposal_review:ref(review),applies:applies.map(ref),no_op:proposal.content.no_op,...(isContractPair(proposal.content)?{api_contract:approvedContract(bus,root)}:{})};
  return {body,subject_hash:hash(body),applies};
}
export function assertEngineeringTransition(bus:AgentBus,root:string,to:TaskState) {
  engineeringManifest(bus,root);
  if(to==="PROPOSAL_CREATED") { if(!latest(bus,root,"proposal")) throw new Error("PROPOSAL_REQUIRED"); return; }
  if(to==="PROPOSAL_APPROVED") { approvedProposal(bus,root); return; }
  if(["API_CONTRACT_REQUIRED","API_CONTRACT_DEFINED","API_CONTRACT_REVIEWED","API_CONTRACT_LOCKED"].includes(to)) {
    if(!isContractPair(approvedProposal(bus,root).proposal.content)) throw new Error("FUTURE_PHASE_NOT_AUTHORIZED");
    assertEligible(bus,root,false);
    if(to==="API_CONTRACT_DEFINED") definedContract(bus,root);
    if(to==="API_CONTRACT_REVIEWED") contractReviews(bus,root);
    if(to==="API_CONTRACT_LOCKED") approvedContract(bus,root);
    return;
  }
  if(to==="IMPLEMENTATION_RUNNING") { assertEligible(bus,root); if(!bus.events.list(root).some(e=>e.event_type==="engineering.apply.authorized")) throw new Error("FIXTURE_EXECUTION_AUTHORIZATION_REQUIRED"); return; }
  if(["LOCAL_VERIFICATION","ADVERSARIAL_REVIEW","REVIEW_GATE_APPLY","DONE"].includes(to)) {
    const subject=applySubject(bus,root);
    if(!bus.events.list(root).some(e=>e.event_type==="engineering.local-verification.completed"&&e.payload.subject_hash===subject.subject_hash)) throw new Error("LOCAL_VERIFICATION_REQUIRED");
    if(to==="REVIEW_GATE_APPLY" || to==="DONE") {
      const review=latest<ReviewResult>(bus,root,"apply-review");
      if(!review || review.content.verdict!=="approved" || review.content.future_gates!.length || review.content.subject_hash!==subject.subject_hash) throw new Error("INDEPENDENT_APPLY_REVIEW_REQUIRED");
    }
    return;
  }
  if(to==="BLOCKED"||to==="FAILED") return;
  throw new Error("FUTURE_PHASE_NOT_AUTHORIZED");
}
