import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBus } from "../src/agent-bus/index.js";
import { HARNESS_ROOT, Storage, hash, id } from "../src/storage.js";
import { WorkflowService, config } from "../src/workflow/service.js";
import { EngineeringStages } from "../src/workflow/engineering/service.js";
import { createFixture, fixtureInfo, git } from "../src/workflow/engineering/fixture.js";
import { latest, records, readEngineeringArtifact, applySubject, evidenceInScope, reviewEvidenceAllowlist, proposalScopePatterns, contractReviews } from "../src/workflow/engineering/artifacts.js";
import { flowEvidenceAllowlist } from "../src/workflow/producers/flow.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { validate } from "../src/validation/index.js";
import { invoke, TOOL_DESCRIPTORS } from "../src/surface.js";
import type { AgentExecutionRequest, AgentResult, Evidence, ReviewResult, TaskCapsule } from "../src/contracts.js";
import type { Proposal } from "../src/workflow/engineering/contracts.js";
import { HostExecutor } from "../src/execution/sandbox.js";
import { Ajv } from "ajv";
import { bootstrapGapCheckpoint, REPLAY_ACTOR, REPLAY_EVENT } from "../dev/gap-checkpoint.js";
import { ENGINEERING_TEST_PREFIX, sweepDeadTestResidues } from "./test-state.js";

// createFixture requires the fixture inside the workspace, so temporaries live in the
// canonical state/ and must be removed by the runner lifecycle, not only per case.
const STATE_DIRECTORY=join(HARNESS_ROOT,"state");
sweepDeadTestResidues(STATE_DIRECTORY);
const createdTestRoots=new Set<string>();
after(()=>{for(const root of createdTestRoots) rmSync(root,{recursive:true,force:true});});

const ROOT="ENGINEERING-TEST";
const evidence=(source:string):Evidence[]=>[{assertion:"Scoped behavior was inspected",source,observation:"The supplied source supports this fixture claim"}];
function result(req:AgentExecutionRequest):AgentResult {
  return {task_id:req.capsule.task_id,role:req.capsule.role,status:"completed",summary:"Scoped fixture responsibility completed",changed_files:[],evidence:evidence("original-task"),tests_executed:[],tests_not_executed:[],api_contract_status:"not_applicable",visual_lock_status:"not_applicable",scope_expanded:false,deviations:[],risks:[],known_issues:[],requested_followups:[]};
}
async function fixture(options:{empty?:boolean;phase3?:boolean;escalations?:Record<string,string>;change?:(req:AgentExecutionRequest,r:AgentResult)=>Promise<AgentResult>}={}) {
  mkdirSync(STATE_DIRECTORY,{recursive:true});
  const root=mkdtempSync(join(STATE_DIRECTORY,`${ENGINEERING_TEST_PREFIX}${process.pid}-`)),calls:AgentExecutionRequest[]=[];
  createdTestRoots.add(root);
  let source="",repository="";
  const provider={async execute(req:AgentExecutionRequest) {
    const r=result(req),c=req.capsule;
    if(c.constraints.includes("READ_ONLY_SMOKE")) {r.evidence=evidence(".cartera/harness/README.md:3");req.observe?.({exit_code:0,test_double:true});return r;}
    calls.push(req);
    const stage=c.constraints.find(x=>x.startsWith("WORKFLOW_STAGE:"))?.split(":")[1];
    if(stage) {
      const ev=evidence((options.phase3&&!c.allowed_paths[0]?.endsWith(".mjs")?source:c.allowed_paths[0]??source)+":1"),claim={id:"verified",assertion:options.empty?"Explicit pagination already exists":"Default pagination parameters are missing",evidence:ev};
      const content:Record<string,any>={
        "task-sense":{intent:options.empty?"Verify explicit pagination":"Add default pagination parameters",explicit_requirements:["Preserve explicit pagination"],implicit_requirements:[],out_of_scope:["Application writes"],ambiguities:[],likely_domains:["fixture"],likely_frontend_impact:false,likely_backend_impact:false,possible_api_impact:false,possible_visual_impact:false},
        discovery:{scope:c.allowed_paths,files_inspected:c.allowed_paths,symbols:["paginate"],patterns:[],existing_behavior:[claim],tests_found:[],contracts_found:[],dependencies:[],evidence:ev,uncertainties:[],ambiguity_triage:[]},
        flow:{entry_points:[claim],steps:[claim],components:[],data_transformations:[],side_effects:[],external_dependencies:[],error_paths:[],frontend_backend_edges:[],persistence_edges:[],evidence:ev,unknowns:[]},
        truth:{confirmed:[claim],rejected:[],contradicted:[],unverified:[],missing_evidence:[],actual_system_truth:["verified"]},
        gap:{missing_behaviors:options.empty?[]:[{assertion:"Default page 0 and size 20 are missing",truth_claim_ids:["verified"],evidence:ev}],missing_integrations:[],missing_contracts:[],affected_surfaces:[source],confirmed_non_gaps:[],out_of_scope:["Product implementation"],unknowns:[],evidence:ev},
      };
      r.workflow_output={stage:stage as any,content:content[stage]};r.evidence=ev;
    } else {
      const pkg=JSON.parse(c.inputs[0]);r.evidence=evidence(`artifact:${pkg.input_references[0].child_task}`);
      if(c.role==="opsx-proposer") {
        const gap=pkg.artifacts.find((a:any)=>a.output.stage==="gap"),empty=gap.output.content.missing_behaviors.length===0;
        r.proposal={...pkg.proposal_identity,goal:c.goal,verified_gap_refs:[gap.reference],solution_summary:empty?"No implementation required":"Add default arguments and a focused regression test",no_op:empty,
          affected_repositories:empty?[]:[repository],affected_slices:empty?[]:["pagination"],affected_files_or_areas:empty?[]:[source,repository+"/tests/pagination.test.mjs"],
          implementation_units:empty?[]:[{id:"pagination-defaults",role:"opsx-implementation-worker",repository,responsibility:"Default omitted page and size while preserving explicit pagination",allowed_paths:["src/pagination.mjs","tests/pagination.test.mjs"],forbidden_paths:[],acceptance_criteria:["Defaults page 0 and size 20; explicit parameters preserved"],owned_test_ids:["defaults"],depends_on:[],evidence:evidence(`artifact:${gap.reference.child_task}`)}],
          dependencies:[],ordering:empty?[]:["pagination-defaults"],parallelizable_units:[],tests_required:empty?[]:[{id:"defaults",unit_id:"pagination-defaults",command:"node",args:["--test","tests/pagination.test.mjs"],purpose:"Check default and explicit pagination"}],risks:[],scope_boundaries:["Only fixture pagination and its owned test"],out_of_scope:["Applications, contracts, visual, database and services"],requires_api_contract:false,requires_visual_approval:false,requires_database_change:false,requires_external_resource:false,open_decisions:[],evidence:evidence(`artifact:${gap.reference.child_task}`)};
        if(options.phase3) {
          const p=r.proposal!,backend=p.implementation_units[0];
          backend.role="backend-worker";
          p.requires_api_contract=true;
          p.out_of_scope=["Applications, visual, database and services"];
          p.implementation_units.push({...backend,id:"pagination-client",role:"frontend-worker",responsibility:"Build pagination query parameters using the API defaults",allowed_paths:["src/client.mjs","tests/client.test.mjs"],owned_test_ids:["client"]});
          p.ordering.push("pagination-client");p.parallelizable_units=[[...p.ordering]];
          p.affected_files_or_areas.push(repository+"/src/client.mjs",repository+"/tests/client.test.mjs");
          p.tests_required.push({id:"client",unit_id:"pagination-client",command:"node",args:["--test","tests/client.test.mjs"],purpose:"Verify client pagination defaults and explicit parameters"});
        }
      } else if(c.role==="api-contract-architect") {
        r.api_contract={...pkg.contract_identity,method:"GET",path:"/pagination",path_parameters:{},query_parameters:{type:"object",properties:{page:{type:"integer",default:0},size:{type:"integer",default:20}}},headers:{},request_body:null,success_status:200,success_schema:{type:"object",required:["content","page","size","totalElements"]},errors:[],nullable_semantics:"Pagination values cannot be null",optional_semantics:"Omitted page defaults to 0 and size to 20",dates:"Not applicable",money:"Not applicable",enums:{},pagination:{page:0,size:20}};
      } else if(c.role.endsWith("-reviewer")) {
        r.review_result={task_id:c.parent_task_id!,reviewer:c.task_id,role:c.role,subject_hash:pkg.subject_hash,verdict:"approved",evidence:r.evidence,findings:[],details:[],future_gates:[]};
      } else if(c.role==="frontend-worker") {
        writeFileSync(join(req.cwd,"src/client.mjs"),"export function paginationQuery(page = 0, size = 20) { return { page, size }; }\n");
        writeFileSync(join(req.cwd,"tests/client.test.mjs"),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { paginationQuery } from '../src/client.mjs';\ntest('uses contract defaults and preserves explicit pagination', () => { assert.deepEqual(paginationQuery(), {page:0,size:20}); assert.deepEqual(paginationQuery(2,5), {page:2,size:5}); });\n");
        r.changed_files=["src/client.mjs","tests/client.test.mjs"];
        r.tests_executed=c.owned_tests.map(command=>({command,exit_code:0,evidence:"Provider double; runtime executes the real fixture test"}));
        r.api_contract_status="unchanged";
      } else if(c.role==="opsx-implementation-worker"||c.role==="backend-worker") {
        const file=join(req.cwd,"src/pagination.mjs"),tests=join(req.cwd,"tests/pagination.test.mjs");
        writeFileSync(file,readFileSync(file,"utf8").replace("items, page, size","items, page = 0, size = 20"));
        writeFileSync(tests,readFileSync(tests,"utf8")+"\ntest('uses default page zero and size twenty', () => {\n  const items = Array.from({length: 25}, (_, i) => i);\n  assert.deepEqual(paginate(items), { content: items.slice(0, 20), page: 0, size: 20, totalElements: 25 });\n});\n");
        r.changed_files=["src/pagination.mjs","tests/pagination.test.mjs"];
        r.tests_executed=c.owned_tests.map(command=>({command,exit_code:0,evidence:"Mock provider claim; runtime separately executes the real fixture test"}));
        r.proposal_deviation=null;
      }
    }
    return options.change?options.change(req,r):r;
  }};
  const bus=new AgentBus(new Storage(root),{codex:provider,claude:provider},"cockpit","master-orchestrator",new HostExecutor()),f=createFixture(bus);
  repository=f.workspace_path;source=repository+"/src/pagination.mjs";
  for(const [i,provider] of ["codex","claude"].entries()) await bus.smoke(provider,config().provider_smoke_tasks[i],true);
  const service=new WorkflowService(bus),engineering=new EngineeringStages(bus);
  const request={task_id:ROOT,user_request:options.empty?"Verify existing explicit pagination; no implementation required":"Add default page 0 and size 20 to the controlled fixture paginate function, preserve explicit parameters, and add a focused regression test.",task_type:"fixture",repository_scope:[repository],allowed_paths:[source,repository+"/tests/pagination.test.mjs"],forbidden_paths:["cartera-backend","cartera-frontend"],constraints:["Fixture only; no external resources or application mutation"],discovery:[{name:"discovery-code",role:"discovery-backend",paths:[source]},{name:"discovery-tests",role:"discovery-tests",paths:[repository+"/tests/pagination.test.mjs"]}]};
  if(options.phase3) {
    request.user_request="Implement pagination defaults in the controlled backend fixture and a frontend query builder using the same reviewed HTTP contract.";
    request.allowed_paths=[repository+"/src",repository+"/tests"];
  }
  if(options.escalations) Object.assign(request,{routing_escalations:options.escalations});
  await service.start(request,true);
  return {bus,service,engineering,calls,root,f,source,request,
    propose:()=>service.propose(ROOT,true,"Implement only the requested fixture behavior; no product policy changes"),
    approved:async()=>{await service.propose(ROOT,true,"Implement only the requested fixture behavior; no product policy changes");await service.proposalReview(ROOT,true);},
    clean:()=>rmSync(root,{recursive:true,force:true})};
}

test("verified Gap becomes an immutable scoped Proposal reviewed by an independent capsule on the persisted route",async()=>{
  const f=await fixture();try {
    f.bus.events.append(ROOT,"private.orchestrator.note",{transcript:"PRIVATE_BUILDER_REASONING"});
    await f.approved();
    assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
    const p=latest<Proposal>(f.bus,ROOT,"proposal")!,review=latest<ReviewResult>(f.bus,ROOT,"proposal-review")!;
    const routes=f.bus.routing(ROOT)!.routes;
    assert.equal(p.provider,routes["opsx-proposer"].provider);assert.equal(p.model,routes["opsx-proposer"].model);
    assert.equal(review.provider,routes["opsx-propose-reviewer"].provider);assert.equal(review.model,routes["opsx-propose-reviewer"].model);
    assert.notEqual(p.child_task,review.child_task);
    assert.equal(p.content.verified_gap_refs[0].child_task,ROOT+"-gap");
    assert.ok(f.calls.filter(c=>c.capsule.role.startsWith("opsx-")).every(c=>!c.prompt.includes("PRIVATE_BUILDER_REASONING")));
    assert.equal(f.bus.runtime.model_execution_enabled,false);assert.equal(f.bus.executionPolicy.write_application_execution,false);
    const count=f.calls.length;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);
    assert.equal(f.service.show(ROOT).engineering!.units[0].status,"pending");
    assert.equal((await invoke(f.bus,"workflow_proposal",{task_id:ROOT}) as any).state,"PROPOSAL_APPROVED");
  } finally {f.clean();}
});

test("Proposal schema, Gap identity and authorized file scope are enforced before publication",async()=>{
  for(const mode of ["schema","scope","identity","gap","no-op"] as const) {
    const f=await fixture({change:async(req,r)=>{
      if(r.proposal) {
        if(mode==="schema") (r.proposal as any).goal=42;
        if(mode==="scope") r.proposal.implementation_units[0].allowed_paths.push("unrelated.mjs");
        if(mode==="identity") r.proposal.version=2;
        if(mode==="gap") r.proposal.verified_gap_refs=[];
        if(mode==="no-op") r.proposal.no_op=true;
      } return r;
    }});
    try {await assert.rejects(f.propose());assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");assert.equal(latest(f.bus,ROOT,"proposal"),null);assert.ok(!f.calls.some(c=>c.capsule.permissions!=="read-only"));}
    finally {f.clean();}
  }
});

test("sweeps residues of dead test processes and keeps live ones",()=>{
  const directory=mkdtempSync(join(tmpdir(),"cartera-sweep-test-"));
  try {
    const dead=`${ENGINEERING_TEST_PREFIX}2147483646-abc123`,live=`${ENGINEERING_TEST_PREFIX}${process.pid}-def456`,legacy=`${ENGINEERING_TEST_PREFIX}Xy12Ab`,history="workflows";
    for(const name of [dead,live,legacy,history]) mkdirSync(join(directory,name));
    assert.deepEqual(sweepDeadTestResidues(directory),[dead]);
    assert.equal(existsSync(join(directory,dead)),false);
    for(const name of [live,legacy,history]) assert.equal(existsSync(join(directory,name)),true,name);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

for(const [name,expected,breakOwnership] of [
  ["rejects a proposal whose required test is not owned by its unit",/UNSUPPORTED_OWNED_TEST/,(p:Proposal)=>{p.tests_required.push({...p.tests_required[0],id:"unowned"});}],
  ["rejects a proposal whose owned test id has no matching required test",/OWNED_TESTS_REQUIRED/,(p:Proposal)=>{p.implementation_units[0].owned_test_ids.push("missing");}],
] as const) test(name,async()=>{
  const f=await fixture({change:async(req,r)=>{if(r.proposal) breakOwnership(r.proposal);return r;}});
  try {await assert.rejects(f.propose(),expected);assert.equal(latest(f.bus,ROOT,"proposal"),null);}
  finally {f.clean();}
});

test("proposal producer is explicitly instructed that ordering contains only implementation unit IDs",async()=>{
  const f=await fixture();
  try {
    await f.propose();
    const call=f.calls.find(c=>c.capsule.role==="opsx-proposer")!;
    assert.match(call.capsule.responsibility,/ordering field MUST be exclusively the dependency sequence of unit\.id values/);
    assert.match(call.capsule.responsibility,/every ordering value MUST exactly match an existing unit\.id/);
    assert.match(call.capsule.responsibility,/Never put workflow phase names, role names, responsibilities, descriptions/);
  } finally { f.clean(); }
});

test("proposer output schema delivered to the provider keeps the canonical implementation unit id pattern",async()=>{
  const f=await fixture();
  try {
    await f.propose();
    const call=f.calls.find(c=>c.capsule.role==="opsx-proposer")!;
    const wire=JSON.parse(readFileSync(call.result_schema_path,"utf8"));
    const canonical=JSON.parse(readFileSync(join(HARNESS_ROOT,"schemas","proposal.schema.json"),"utf8")).properties.implementation_units.items.properties.id.pattern;
    assert.equal(canonical,"^[a-z][a-z0-9-]{0,19}$");
    assert.equal(wire.properties.proposal.anyOf[0].properties.implementation_units.items.properties.id.pattern,canonical);
    assert.doesNotMatch(call.capsule.responsibility,/\[a-z\]\[a-z0-9-\]/,"the rule is enforced by schema, never duplicated in prompt");
  } finally { f.clean(); }
});

test("the proposer wire schema carries the exact evidence.source shape the gate accepts, replacing the prose about allowed forms",async()=>{
  for(const phase3 of [false,true]) {
    const f=await fixture({phase3});
    try {
      await f.propose();
      const proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!,c=proposer.capsule,inputs=JSON.parse(c.inputs[0]).input_references;
      const wire=JSON.parse(readFileSync(proposer.result_schema_path,"utf8")),p=wire.properties.proposal.anyOf[0].properties;
      const patterns=[wire.properties.evidence,p.evidence,p.implementation_units.items.properties.evidence].map(node=>node.items.properties.source.pattern as string|undefined);
      assert.ok(patterns[0]&&patterns.every(x=>x===patterns[0]),"the same pattern reaches the top-level, proposal and unit evidence nodes");
      const regex=new RegExp(patterns[0]!),tests=`${f.f.workspace_path}/tests/pagination.test.mjs`;
      for(const accepted of [`${f.source}:1`,`${f.source}:1-3`,`${f.source}:2,4`,`${tests}:1`,`${f.source}:1; ${tests}:1`,`artifact:${ROOT}-gap`,`artifact:${ROOT}-task-sense`,`task:${ROOT}`]) {
        assert.match(accepted,regex,accepted);
        assert.doesNotThrow(()=>evidenceInScope([{assertion:"x",source:accepted,observation:"y"}],c,inputs),accepted);
      }
      for(const rejected of ["src/pagination.mjs:1","tests/pagination.test.mjs:5",f.source,`${f.f.workspace_path}/src`,`/${f.source}:1`,`artifact:${ROOT}-api`,`artifact:${ROOT}-proposal-v1`,"(listagem de arquivos)"]) {
        assert.doesNotMatch(rejected,regex,rejected);
        assert.throws(()=>evidenceInScope([{assertion:"x",source:rejected,observation:"y"}],c,inputs),rejected);
      }
      assert.doesNotMatch(c.responsibility,/accepts exactly three forms|Never cite a directory/,"the accepted shape is a pin, never prose");
      assert.match(c.responsibility,/does not exist yet, cite the artifact:<child_task> of the Gap or Truth.*or the task:<root_task>.*without evidence, never with an invented directory source/);
      for(const call of f.calls.filter(c=>c.capsule.role!=="opsx-proposer")) assert.equal(JSON.parse(readFileSync(call.result_schema_path,"utf8")).properties.evidence.items.properties.source.pattern,undefined,`${call.capsule.role} carries no proposer pattern`);
    } finally { f.clean(); }
  }
});

test("proposer top-level evidence is validated like the proposal evidence before publication",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-proposer") r.evidence=evidence("src/pagination.mjs:1");return r;}});
  try {
    await assert.rejects(f.propose(),/ENGINEERING_EVIDENCE_OUT_OF_SCOPE/);
    assert.equal(latest(f.bus,ROOT,"proposal"),null);assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");
  } finally {f.clean();}
});

test("explicitly escalated engineering roles run on the frontier model with their recorded reason and a capsule that never forbids it by model name",async()=>{
  const escalations={"opsx-proposer":"extreme-architecture","api-contract-architect":"extreme-architecture","opsx-apply-reviewer":"extreme-review","backend-worker":"extreme-debugging"};
  const f=await fixture({phase3:true,escalations});
  try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const engineering=f.calls.filter(c=>c.capsule.constraints.includes("CORE_ENGINEERING_V1"));
    assert.deepEqual([...new Set(engineering.map(c=>c.capsule.role))].sort(),["api-contract-architect","api-contract-backend-reviewer","api-contract-frontend-reviewer","backend-worker","frontend-worker","opsx-apply-reviewer","opsx-propose-reviewer","opsx-proposer"]);
    for(const call of engineering) {
      const reason=escalations[call.capsule.role as keyof typeof escalations];
      if(reason) assert.deepEqual({model:call.route.model,route_reason:call.route.route_reason},{model:"claude-fable-5-1[1m]",route_reason:reason},call.capsule.role);
      else {assert.equal(call.route.model,"claude-opus-5-5",call.capsule.role);assert.equal(call.route.route_reason,undefined,call.capsule.role);}
      assert.ok(call.capsule.constraints.every(x=>!/fable/i.test(x)),`${call.capsule.role} capsule forbids no model by name`);
      assert.ok(call.capsule.constraints.some(x=>x.includes("worker delegation")),`${call.capsule.role} capsule still forbids worker delegation`);
    }
    assert.deepEqual(f.bus.routing(ROOT)!.routes["opsx-proposer"].route_reason,"extreme-architecture");
  } finally {f.clean();}
});

test("apply reviewer receives each worker's scope and outputs, never the worker's full capsule",async()=>{
  const f=await fixture({phase3:true});
  try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const reviewer=f.calls.find(c=>c.capsule.role==="opsx-apply-reviewer")!,pkg=JSON.parse(reviewer.capsule.inputs[0]);
    assert.equal(pkg.implementation.length,2);
    for(const unit of pkg.implementation) {
      const worker=f.calls.find(c=>c.capsule.task_id===unit.capsule.task_id)!.capsule;
      assert.deepEqual(Object.keys(unit.capsule).sort(),["acceptance_criteria","allowed_paths","forbidden_paths","owned_tests","role","task_id"]);
      for(const key of ["role","allowed_paths","forbidden_paths","acceptance_criteria","owned_tests"] as const) assert.deepEqual(unit.capsule[key],worker[key],key);
      assert.equal(unit.artifact.task_id,worker.task_id);assert.equal(unit.result.task_id,worker.task_id);
      assert.ok(!reviewer.capsule.inputs[0].includes(worker.responsibility),"the worker prompt is not repeated into the reviewer package");
    }
  } finally {f.clean();}
});

test("proposal scope paths reach the proposer as patterns derived from request.allowed_paths and repository_scope",async()=>{
  for(const phase3 of [false,true]) {
    const f=await fixture({phase3});
    try {
      await f.propose();
      const proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!,p=JSON.parse(readFileSync(proposer.result_schema_path,"utf8")).properties.proposal.anyOf[0].properties;
      const areas=new RegExp(p.affected_files_or_areas.items.pattern),units=new RegExp(p.implementation_units.items.properties.allowed_paths.items.pattern),repository=f.f.workspace_path;
      for(const accepted of [f.source,`${repository}/tests/pagination.test.mjs`,...(phase3?[`${repository}/src/client.mjs`]:[])]) assert.match(accepted,areas,accepted);
      for(const rejected of ["src/pagination.mjs",`${repository}/other.mjs`,`/${f.source}`,...(phase3?[]:[`${repository}/src/client.mjs`])]) assert.doesNotMatch(rejected,areas,rejected);
      for(const accepted of ["src/pagination.mjs","tests/pagination.test.mjs",...(phase3?["src/client.mjs"]:[])]) assert.match(accepted,units,accepted);
      for(const rejected of [f.source,`${repository}/src/pagination.mjs`,"other.mjs","../src/pagination.mjs",...(phase3?[]:["src/client.mjs"])]) assert.doesNotMatch(rejected,units,rejected);
      assert.doesNotMatch(proposer.capsule.responsibility,/repository-relative unit paths|affected_files_or_areas are workspace-relative/,"the two path conventions are pins, never prose");
    } finally {f.clean();}
  }
});

test("scope patterns project each allowed path relative to its own repository and admit everything under a repository inside an allowed path",()=>{
  const fixtureRepository=".cartera/harness/state/fixtures/apply-demo";
  const two=proposalScopePatterns([`${fixtureRepository}/src`,`${fixtureRepository}/tests/pagination.test.mjs`,".cartera/harness/README.md"],[fixtureRepository,".cartera/harness"]);
  const units=new RegExp(two.units!),areas=new RegExp(two.areas);
  for(const accepted of ["src/pagination.mjs","src/deep/client.mjs","tests/pagination.test.mjs","README.md"]) assert.match(accepted,units,accepted);
  for(const rejected of [".cartera/harness/README.md",`${fixtureRepository}/src/pagination.mjs`,"docs/x.md","tests/other.test.mjs","../README.md"]) assert.doesNotMatch(rejected,units,rejected);
  for(const accepted of [`${fixtureRepository}/src/pagination.mjs`,".cartera/harness/README.md"]) assert.match(accepted,areas,accepted);
  for(const rejected of ["README.md","src/pagination.mjs",".cartera/harness/package.json"]) assert.doesNotMatch(rejected,areas,rejected);
  const ancestor=proposalScopePatterns(["cartera-backend/"],["cartera-backend/src"]);
  assert.match("anything/inside/the/repository.ts",new RegExp(ancestor.units!));
  assert.match("cartera-backend/src/anything.ts",new RegExp(ancestor.areas));assert.doesNotMatch("cartera-frontend/x.ts",new RegExp(ancestor.areas));
  assert.equal(proposalScopePatterns([".cartera/harness/README.md"],[fixtureRepository]).units,null,"no allowed path meets the repository: no unit path can be pinned");
});

test("a proposal with workspace-relative unit paths, as in smoke PHASE3-SMOKE-20260922-27, or repository-relative areas is rejected before publication",async()=>{
  for(const mode of ["units","areas"] as const) {
    const f=await fixture({change:async(req,r)=>{if(r.proposal) {const unit=r.proposal.implementation_units[0];if(mode==="units") unit.allowed_paths=unit.allowed_paths.map(p=>`${r.proposal!.affected_repositories[0]}/${p}`);else r.proposal.affected_files_or_areas=["src/pagination.mjs"];} return r;}});
    try {await assert.rejects(f.propose(),/PROPOSAL_SCOPE_EXPANSION/,mode);assert.equal(latest(f.bus,ROOT,"proposal"),null,mode);} finally {f.clean();}
  }
});

test("an apply reviewer claiming the workers' changed files, as in smoke PHASE3-SMOKE-20260922-28, is rejected before its review is persisted",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-apply-reviewer") r.changed_files=["src/pagination.mjs"];return r;}});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    await assert.rejects(f.service.applyReview(ROOT,true),/SCOPE_VIOLATION|READ_ONLY_MUTATION/);
    assert.notEqual(f.bus.events.get(ROOT).state,"DONE");assert.equal(latest(f.bus,ROOT,"apply-review"),null);
    const reviewer=f.calls.find(c=>c.capsule.role==="opsx-apply-reviewer")!;
    assert.equal(f.bus.storage.exists("results",reviewer.capsule.task_id+".json"),false,"the invalid review was never persisted");
    assert.equal(JSON.parse(readFileSync(reviewer.result_schema_path,"utf8")).properties.changed_files.maxItems,0,"the wire never admitted changed files for a read-only reviewer");
  } finally {f.clean();}
});

test("a proposal citing repository-relative unit evidence, as in smoke PHASE3-SMOKE-20260921-21, is rejected before publication",async()=>{
  const f=await fixture({change:async(req,r)=>{if(r.proposal) r.proposal.implementation_units[0].evidence=evidence("src/pagination.mjs:1");return r;}});
  try {
    await assert.rejects(f.propose(),/ENGINEERING_EVIDENCE_OUT_OF_SCOPE/);
    assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");assert.equal(latest(f.bus,ROOT,"proposal"),null);
    const pattern=JSON.parse(readFileSync(f.calls.find(c=>c.capsule.role==="opsx-proposer")!.result_schema_path,"utf8")).properties.proposal.anyOf[0].properties.implementation_units.items.properties.evidence.items.properties.source.pattern;
    assert.doesNotMatch("src/pagination.mjs:1",new RegExp(pattern),"the wire never admitted the repository-relative citation");
  } finally {f.clean();}
});

test("proposer receives repository_scope and the wire schema pins repository identities instead of prose",async()=>{
  const f=await fixture();
  try {
    await f.propose();
    const proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!;
    const pkg=JSON.parse(proposer.capsule.inputs[0]);
    assert.deepEqual(pkg.repository_scope,f.request.repository_scope);
    const wire=JSON.parse(readFileSync(proposer.result_schema_path,"utf8")).properties.proposal.anyOf[0].properties;
    assert.deepEqual(wire.affected_repositories.items.enum,f.request.repository_scope);
    assert.deepEqual(wire.implementation_units.items.properties.repository.enum,f.request.repository_scope);
    assert.doesNotMatch(proposer.capsule.responsibility,/affected_repositories MUST/,"the rule is enforced by schema, never duplicated in prompt");
  } finally { f.clean(); }
});

test("proposer must reference owned tests by the exact tests_required id of the same unit",async()=>{
  const f=await fixture();
  try {
    await f.propose();
    const proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!;
    assert.match(proposer.capsule.responsibility,/every value in implementation_units\[\]\.owned_test_ids MUST be copied exactly from a tests_required\[\]\.id whose unit_id is that same unit id/);
    assert.match(proposer.capsule.responsibility,/define the test entry first, then reference its id byte for byte/);
    assert.match(proposer.capsule.responsibility,/Never invent a different id for the reference \(for example owned_test_ids \[backend-pagination-test\] while tests_required has id test-backend-pagination is invalid\)/);
    for(const call of f.calls.filter(c=>c.capsule.role!=="opsx-proposer")) assert.doesNotMatch(call.capsule.responsibility,/owned_test_ids MUST/);
  } finally { f.clean(); }
});

test("narrative workflow steps in proposal ordering remain rejected as invalid unit IDs",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-proposer") r.proposal!.ordering=["Proposal aprovado","pagination-defaults"];
    return r;
  }});
  try {
    await assert.rejects(f.propose(),/INVALID_UNIT_ORDER/);
    assert.equal(latest(f.bus,ROOT,"proposal"),null);
  } finally { f.clean(); }
});

test("rejected proposals cannot authorize Apply or silently create a new proposal",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-propose-reviewer") {r.review_result!.verdict="rejected";r.review_result!.findings=["Unsupported scope"];r.review_result!.details=[{finding:"Unsupported scope",severity:"blocking",section:"implementation_units",evidence:r.evidence,required_change:"Submit a new scoped request"}];}return r;}});
  try {await f.approved();assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_CREATED");await assert.rejects(f.service.apply(ROOT,true),/APPROVED_PROPOSAL_REQUIRED/);await assert.rejects(f.service.propose(ROOT,true,undefined,true),/REVISION_REQUIRES/);assert.equal(f.bus.worktrees.list().length,0);}
  finally {f.clean();}
});

test("changes-required revisions retain prior proposal and findings and stop after two revisions",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-propose-reviewer") {r.review_result!.verdict="changes_required";r.review_result!.findings=["Clarify acceptance"];r.review_result!.details=[{finding:"Clarify acceptance",severity:"blocking",section:"acceptance_criteria",evidence:r.evidence,required_change:"Make acceptance explicit"}];}return r;}});
  try {
    await f.approved();const first=latest<Proposal>(f.bus,ROOT,"proposal")!;
    await f.service.propose(ROOT,true,undefined,true);const second=latest<Proposal>(f.bus,ROOT,"proposal")!;
    assert.equal(second.content.previous_proposal_hash,first.content_hash);assert.equal(second.content.version,2);
    assert.ok(second.input_artifact_references.some(r=>r.child_task.includes("propose-review-v1")));
    const count=f.calls.length;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);assert.equal(latest<Proposal>(f.bus,ROOT,"proposal")!.content.version,2);
    assert.equal(readEngineeringArtifact(f.bus,ROOT,"proposal-v1.json").content_hash,first.content_hash);
    await f.service.proposalReview(ROOT,true);await f.service.propose(ROOT,true,undefined,true);await f.service.proposalReview(ROOT,true);
    await assert.rejects(f.service.propose(ROOT,true,undefined,true),/REVISION_NOT_ALLOWED/);
  }finally {f.clean();}
});

test("API, visual, database, external resources and reviewer-detected future gates block writes",async()=>{
  for(const flag of ["requires_api_contract","requires_visual_approval","requires_database_change","requires_external_resource","review"] as const) {
    const f=await fixture({change:async(req,r)=>{if(r.proposal&&flag!=="review") r.proposal[flag]=true;if(r.review_result&&flag==="review") r.review_result.future_gates=["api_contract"];return r;}});
    try {await f.approved();assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");await assert.rejects(f.service.apply(ROOT,true),/BLOCKED_BY_FUTURE_PHASE/);assert.equal(f.bus.worktrees.list().length,0);assert.equal(f.service.show(ROOT).engineering!.blocked,"BLOCKED_BY_FUTURE_PHASE");assert.throws(()=>f.bus.transition(ROOT,"API_CONTRACT_REQUIRED",f.bus.events.get(ROOT).revision),/FUTURE_PHASE_NOT_AUTHORIZED/);}
    finally {f.clean();}
  }
});

test("PO decisions are explicit and unresolved proposal decisions require a reviewed immutable revision",async()=>{
  const f=await fixture({change:async(req,r)=>{if(r.proposal?.version===1) r.proposal.open_decisions=["Choose expected behavior explicitly"];return r;}});
  try {
    const count=f.calls.length;await assert.rejects(f.service.propose(ROOT,true),/WAITING_FOR_USER_DECISION/);assert.equal(f.calls.length,count);
    await f.propose();assert.equal(f.service.show(ROOT).engineering!.blocked,"WAITING_FOR_USER_DECISION");
    await assert.rejects(f.service.proposalReview(ROOT,true),/WAITING_FOR_USER_DECISION/);
    await assert.rejects(f.service.propose(ROOT,true,undefined,true),/REVISION_REQUIRES/);
    await f.service.propose(ROOT,true,"Use defaults page zero and size twenty; preserve explicit inputs",true);
    await f.service.proposalReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
  }finally {f.clean();}
});

test("approved Proposal executes in an owned worktree with actual tests and independent review gates DONE",async()=>{
  const f=await fixture();try {
    await f.approved();await f.service.apply(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"LOCAL_VERIFICATION");
    const a=latest<any>(f.bus,ROOT,"apply")!,c=f.bus.events.get(a.child_task).capsule;
    assert.equal(c.permissions,"restricted-path-write");assert.equal(c.worktree!.base_commit,f.f.base_commit);
    assert.equal(git(c.worktree!.path,["rev-parse","HEAD"]),f.f.base_commit);
    assert.notEqual(a.content.checkpoint,f.f.base_commit);
    const verification=f.bus.storage.read<any>("engineering-verifications",a.child_task+".json");
    assert.equal(verification.commands[0].exit_code,0);assert.match(verification.commands[0].stdout,/uses default page zero and size twenty/);
    assert.match(verification.diff,/page = 0, size = 20/);assert.equal(hash(verification),a.content.verification_hash);
    assert.doesNotMatch(readFileSync(join(f.f.repository,"src/pagination.mjs"),"utf8"),/page = 0/);
    assert.throws(()=>f.bus.transition(ROOT,"DONE",f.bus.events.get(ROOT).revision),/INVALID_STATE_TRANSITION/);
    await f.service.applyReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const reviewer=latest<ReviewResult>(f.bus,ROOT,"apply-review")!;assert.equal(reviewer.provider,f.bus.routing(ROOT)!.routes["opsx-apply-reviewer"].provider);assert.equal(reviewer.content.subject_hash,applySubject(f.bus,ROOT).subject_hash);
    const reviewCall=f.calls.find(c=>c.capsule.role==="opsx-apply-reviewer")!;assert.ok(reviewCall.capsule.required_context.some(p=>p.includes("engineering-verifications")));assert.equal(reviewCall.capsule.permissions,"read-only");
    const count=f.calls.length;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);fixtureInfo(f.bus);
    writeFileSync(join(c.worktree!.path,"src/pagination.mjs"),"changed after review\n");assert.throws(()=>f.service.show(ROOT),/IMPLEMENTATION_CHANGED_AFTER_VERIFICATION/);
  }finally {f.clean();}
});

test("zero verified Gap completes through no-op proposal and independent reviews without implementation workers",async()=>{
  const f=await fixture({empty:true});try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");assert.equal(f.bus.worktrees.list().length,0);
    assert.ok(!f.calls.some(c=>c.capsule.role==="opsx-implementation-worker"));
    assert.ok(f.bus.events.list(ROOT).some(e=>e.event_type==="engineering.local-verification.completed"&&e.payload.no_op===true));
    assert.equal(latest<Proposal>(f.bus,ROOT,"proposal")!.content.implementation_units.length,0);
  }finally {f.clean();}
});

test("scope expansion, proposal deviation, failed output and invalid output quarantine writes",async()=>{
  for(const mode of ["scope","expansion","deviation","failed","invalid","followup","api-gate","visual-gate"] as const) {
    const f=await fixture({change:async(req,r)=>{
      if(req.capsule.role==="opsx-implementation-worker") {
        if(mode==="scope") {writeFileSync(join(req.cwd,"outside.txt"),"unexpected");r.changed_files.push("outside.txt");}
        if(mode==="expansion") {r.status="needs_scope_expansion";r.requested_followups=[{reason:"Need another file",required_paths:["other.mjs"],required_behavior:"Additional behavior",impact:"Scope decision required"}];}
        if(mode==="deviation") {r.status="proposal_deviation";r.proposal_deviation={reason:"Approved approach cannot be followed",affected_unit:"pagination-defaults",expected_behavior:"Use defaults",required_change:"Revise the proposal"};}
        if(mode==="failed") r.status="failed";
        if(mode==="invalid") (r as any).status="invalid";
        if(mode==="followup") r.requested_followups=[{reason:"Additional scope",required_paths:["other.mjs"],required_behavior:"Additional behavior",impact:"Scope decision required"}];
        if(mode==="api-gate") r.api_contract_status="change_requested";
        if(mode==="visual-gate") r.visual_lock_status="approval_required";
      }return r;
    }});
    try {await f.approved();await assert.rejects(f.service.apply(ROOT,true));const w=f.bus.worktrees.list()[0];assert.ok(f.bus.storage.exists("quarantine",w.id+".json"));assert.throws(()=>f.bus.worktrees.remove(w.id),/QUARANTINED/);const count=f.calls.length;await assert.rejects(f.service.resume(ROOT,true));assert.equal(f.calls.length,count);await assert.rejects(f.service.applyReview(ROOT,true));assert.notEqual(f.bus.events.get(ROOT).state,"DONE");}
    finally {f.clean();}
  }
});

test("dirty or unowned worktrees are refused before the implementation provider starts",async()=>{
  for(const mode of ["dirty","unowned"] as const) {
    const f=await fixture(),delegate=f.bus.delegateEngineering.bind(f.bus);
    f.bus.delegateEngineering=async task=>{const c=f.bus.events.get(task).capsule;if(c.permissions!=="read-only") {if(mode==="dirty") writeFileSync(join(c.worktree!.path,"dirty.txt"),"operator content");else {const path=f.bus.storage.path("ownership",c.worktree!.id+".json"),record=JSON.parse(readFileSync(path,"utf8"));record.descriptor_hash="0".repeat(64);writeFileSync(path,JSON.stringify(record));}}return delegate(task);};
    try {await f.approved();await assert.rejects(f.service.apply(ROOT,true),mode==="dirty"?/WORKTREE_DIRTY/:/OWNERSHIP_HASH_MISMATCH/);assert.ok(!f.calls.some(c=>c.capsule.permissions!=="read-only"));}
    finally {f.clean();}
  }
});

test("Apply review rejection and forged approval never grant DONE",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-apply-reviewer") {r.review_result!.verdict="rejected";r.review_result!.findings=["Implementation rejected"];r.review_result!.details=[{finding:"Implementation rejected",severity:"blocking",section:"diff",evidence:r.evidence,required_change:"New reviewed correction required"}];}return r;}});
  try {await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"ADVERSARIAL_REVIEW");assert.throws(()=>f.bus.transition(ROOT,"REVIEW_GATE_APPLY",f.bus.events.get(ROOT).revision),/INDEPENDENT_APPLY_REVIEW_REQUIRED/);}
  finally {f.clean();}
});

test("Apply resumes persisted worker results without duplicate execution after verification publication interruption",async()=>{
  const f=await fixture(),create=f.bus.storage.create.bind(f.bus.storage);let interrupted=false;
  f.bus.storage.create=(path,value)=>{if(!interrupted&&path[0]==="engineering-verifications") {interrupted=true;throw new Error("SIMULATED_PUBLICATION_INTERRUPTION");}return create(path,value);};
  try {await f.approved();await assert.rejects(f.service.apply(ROOT,true),/SIMULATED_PUBLICATION/);const count=f.calls.length;f.bus.storage.create=create;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);assert.ok(f.bus.worktrees.list().every(w=>!f.bus.storage.exists("quarantine",w.id+".json")));}
  finally {f.clean();}
});

test("duplicate concurrent Apply is locked and a completed action does not call workers again",async()=>{
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r;}),running=new Promise<void>(r=>{started=r;});
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-implementation-worker") {started();await wait;}return r;}});
  try {await f.approved();const first=f.service.apply(ROOT,true);await running;await assert.rejects(f.service.apply(ROOT,true),/EEXIST/);release();await first;const count=f.calls.length;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);assert.equal(f.calls.filter(c=>c.capsule.role==="opsx-implementation-worker").length,1);}
  finally {release();f.clean();}
});

test("CLI/MCP engineering actions share the workflow service and dry Apply has no authority",async()=>{
  const f=await fixture();try {
    for(const name of ["workflow_propose","workflow_proposal_review","workflow_apply","workflow_apply_review"]) assert.ok(TOOL_DESCRIPTORS.some(t=>t.name===name));
    const count=f.calls.length;const planned=await invoke(f.bus,"workflow_apply",{task_id:ROOT}) as any;assert.equal(planned.execute,false);assert.equal(f.calls.length,count);assert.equal(f.bus.worktrees.list().length,0);
    await assert.rejects(invoke(f.bus,"workflow_apply",{task_id:ROOT,execute:true,write_application_execution:true}),/INVALID_ARGUMENTS/);
    await assert.rejects(f.service.apply(ROOT,true),/APPROVED_PROPOSAL_REQUIRED/);
    assert.throws(()=>validate("apply-result",{status:"completed"}));
  }finally {f.clean();}
});

test("Apply resumes after an intact unit artifact without rerunning implementation or tests",async()=>{
  const f=await fixture(),append=f.bus.events.append.bind(f.bus.events);let interrupted=false;
  f.bus.events.append=(...args)=>{if(!interrupted&&args[1]==="engineering.local-verification.completed") {interrupted=true;throw new Error("SIMULATED_ROOT_TRANSITION_INTERRUPTION");}return append(...args);};
  try {
    await f.approved();await assert.rejects(f.service.apply(ROOT,true),/SIMULATED_ROOT_TRANSITION/);
    const a=latest<any>(f.bus,ROOT,"apply")!,verification=readFileSync(f.bus.storage.path("engineering-verifications",a.child_task+".json"),"utf8"),count=f.calls.length;
    f.bus.events.append=append;await f.service.resume(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"LOCAL_VERIFICATION");assert.equal(f.calls.length,count);
    assert.equal(readFileSync(f.bus.storage.path("engineering-verifications",a.child_task+".json"),"utf8"),verification);
    await f.service.applyReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"DONE");
  }finally {f.clean();}
});

test("revised Proposal resumes its pinned version after artifact publication instead of creating another revision",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-propose-reviewer"&&req.capsule.task_id.includes("v1")) r.review_result!.verdict="changes_required";return r;}});
  const append=f.bus.events.append.bind(f.bus.events);let interrupted=false;
  try {
    await f.approved();f.bus.events.append=(...args)=>{if(!interrupted&&args[1]==="engineering.artifact.created"&&args[2].path==="proposal-v2.json") {interrupted=true;throw new Error("SIMULATED_PROPOSAL_EVENT_INTERRUPTION");}return append(...args);};
    await assert.rejects(f.service.propose(ROOT,true,undefined,true),/SIMULATED_PROPOSAL/);f.bus.events.append=append;
    const count=f.calls.length;await f.service.resume(ROOT,true);assert.equal(f.calls.length,count);
    assert.equal(latest<Proposal>(f.bus,ROOT,"proposal")!.content.version,2);
    await f.service.proposalReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
  }finally {f.clean();}
});

test("the global model flag alone never grants write authority",async()=>{
  const f=await fixture();try {
    const c={...f.bus.events.get(ROOT+"-discovery-code").capsule,task_id:"UNAUTHORIZED-WRITE",parent_task_id:null,role:"backend-worker",permissions:"restricted-path-write" as const,constraints:[],worktree:null};
    assert.throws(()=>f.bus.init({...c,role:"opsx-implementation-worker"}),/ENGINEERING_CHILD_REQUIRED/);
    f.bus.runtime.model_execution_enabled=true;f.bus.init(c);f.bus.transition(c.task_id,"TASK_CLASSIFIED",0);f.bus.transition(c.task_id,"IMPLEMENTATION_RUNNING",1);
    await assert.rejects(f.bus.delegate(c.task_id,false),/APPLICATION_WRITE_DISABLED/);
    f.bus.executionPolicy.write_application_execution=true;
    await assert.rejects(f.bus.delegate(c.task_id,false),/OWNED_WORKTREE_REQUIRED/);
  }finally {f.clean();}
});

test("serial units inherit verified checkpoints without sharing writable worktrees or moving source HEAD",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(r.proposal) {
      const unit=r.proposal.implementation_units[0],owned=r.proposal.tests_required[0];
      r.proposal.implementation_units=[{...unit,id:"page-default",owned_test_ids:["page-test"]},{...unit,id:"size-default",owned_test_ids:["size-test"],depends_on:["page-default"]}];
      r.proposal.ordering=["page-default","size-default"];r.proposal.tests_required=[{...owned,id:"page-test",unit_id:"page-default"},{...owned,id:"size-test",unit_id:"size-default"}];
    }
    if(req.capsule.role==="opsx-implementation-worker") {
      const pkg=JSON.parse(req.capsule.inputs[0]),base=req.capsule.worktree!.base_commit;
      const source=git(req.cwd,["show",`${base}:src/pagination.mjs`]),tests=git(req.cwd,["show",`${base}:tests/pagination.test.mjs`]);
      if(pkg.unit.id==="page-default") {
        writeFileSync(join(req.cwd,"src/pagination.mjs"),source.replace("items, page, size","items, page = 0, size")+"\n");
        writeFileSync(join(req.cwd,"tests/pagination.test.mjs"),tests+"\ntest('defaults an omitted page', () => { assert.equal(paginate([1,2,3], undefined, 2).page, 0); });\n");
      } else {
        writeFileSync(join(req.cwd,"src/pagination.mjs"),source.replace("page = 0, size)","page = 0, size = 20)")+"\n");
        writeFileSync(join(req.cwd,"tests/pagination.test.mjs"),tests+"\ntest('defaults page and size together', () => { const items = Array.from({length: 25}, (_,i) => i); assert.deepEqual(paginate(items), { content: items.slice(0,20), page: 0, size: 20, totalElements: 25 }); });\n");
      }
    }return r;
  }});
  try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    const first=readEngineeringArtifact<any>(f.bus,ROOT,"apply-page-default-v1.json"),second=readEngineeringArtifact<any>(f.bus,ROOT,"apply-size-default-v1.json");
    assert.notEqual(first.content.worktree.path,second.content.worktree.path);assert.equal(second.content.worktree.base_commit,first.content.checkpoint);
    assert.equal(git(first.content.worktree.path,["rev-parse","HEAD"]),f.f.base_commit);assert.equal(git(f.f.repository,["rev-parse","HEAD"]),f.f.base_commit);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
  }finally {f.clean();}
});

test("proposal reviewers cannot forge subject hashes or review as the proposer",async()=>{
  for(const mode of ["subject","self"] as const) {
    const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-propose-reviewer") {if(mode==="subject") r.review_result!.subject_hash="0".repeat(64);else r.review_result!.reviewer=ROOT+"-proposal-v1";}return r;}});
    try {await f.propose();await assert.rejects(f.service.proposalReview(ROOT,true));assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_CREATED");await assert.rejects(f.service.apply(ROOT,true),/APPROVED_PROPOSAL_REQUIRED/);}
    finally {f.clean();}
  }
});

test("a blocked read-only proposer requires an explicit fresh child and does not retry itself",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.task_id===ROOT+"-proposal-v1") r.status="blocked";return r;}});
  try {
    await assert.rejects(f.propose(),/PROPOSAL_NOT_COMPLETED/);const count=f.calls.length;
    await assert.rejects(f.service.resume(ROOT,true),/WORKFLOW_RESULT_NOT_RECOVERABLE/);assert.equal(f.calls.length,count);
    const replacement=f.service.engineeringRetry(ROOT,ROOT+"-proposal-v1","Explicitly repeat the blocked read-only responsibility");
    assert.equal(replacement.replacement_child,ROOT+"-proposal-v1-retry-1");
    await f.service.resume(ROOT,true);assert.equal(latest<Proposal>(f.bus,ROOT,"proposal")!.child_task,replacement.replacement_child);
    assert.equal(f.service.show(ROOT).engineering!.blocked,null);
  }finally {f.clean();}
});

test("post-provider proposal validation failure permits only explicit bounded read-only replacement",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.task_id===ROOT+"-proposal-v1") r.proposal!.implementation_units[0].allowed_paths.push("unrelated.mjs");return r;}});
  try {
    await assert.rejects(f.propose(),/PROPOSAL_SCOPE_EXPANSION/);
    assert.equal(f.bus.result(ROOT+"-proposal-v1").status,"completed");assert.equal(latest(f.bus,ROOT,"proposal"),null);
    const count=f.calls.length;await assert.rejects(f.service.resume(ROOT,true),/PROPOSAL_SCOPE_EXPANSION/);assert.equal(f.calls.length,count);
    f.service.engineeringRetry(ROOT,ROOT+"-proposal-v1","Explicit correction of the out-of-scope proposal output");
    await f.service.resume(ROOT,true);assert.equal(latest<Proposal>(f.bus,ROOT,"proposal")!.content.version,1);
  }finally {f.clean();}
});


test("unstructured positive review findings cannot authorize Apply and an explicit corrected review can resume",async()=>{
  let invalid=true;
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-propose-reviewer"&&invalid) {r.review_result!.findings=["No blocking findings","Scope is correct"];r.review_result!.details=[];}
    return r;
  }});
  try {
    await f.service.propose(ROOT,true,"Use the scoped fixture correction");
    await assert.rejects(f.service.proposalReview(ROOT,true),/REVIEW_RUBRIC_NOT_PASSED/);
    assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_CREATED");
    await assert.rejects(f.service.apply(ROOT,true),/APPROVED_PROPOSAL_REQUIRED/);
    assert.ok(!f.calls.some(c=>c.capsule.permissions!=="read-only"));
    invalid=false;
    f.service.engineeringRetry(ROOT,`${ROOT}-propose-review-v1`,"Correct structured review findings after explicit inspection");
    await f.service.proposalReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
    assert.equal(f.calls.filter(c=>c.capsule.role==="opsx-proposer").length,1);
    assert.equal(f.calls.filter(c=>c.capsule.role==="opsx-propose-reviewer").length,2);
  } finally {f.clean();}
});


test("approved unit exclusions are deduplicated against mandatory worktree protections",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-proposer") r.proposal!.implementation_units[0].forbidden_paths=[".git","node_modules",".env"];
    return r;
  }});
  try {await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const worker=f.calls.find(c=>c.capsule.role==="opsx-implementation-worker")!;
    assert.equal(worker.capsule.forbidden_paths.length,new Set(worker.capsule.forbidden_paths).size);
    for(const path of [".git","node_modules",".env"]) assert.ok(worker.capsule.forbidden_paths.includes(path));
  } finally {f.clean();}
});

test("quarantined worktrees cannot be reused from a persisted passed verification",async()=>{
  const f=await fixture();
  try {
    await f.approved();
    await f.service.apply(ROOT,true);
    const worktree=f.bus.worktrees.list()[0];
    f.bus.storage.create(["quarantine",worktree.id+".json"],{task_id:ROOT,worktree_id:worktree.id,reason:"post-verification inspection",timestamp:new Date().toISOString()});
    assert.ok(f.bus.storage.exists("quarantine",worktree.id+".json"));
    const before=f.calls.length;
    await assert.rejects(f.service.applyReview(ROOT,true),/QUARANTINED_WORKTREE|APPLY_NOT_VERIFIED|IMPLEMENTATION_UNITS_INCOMPLETE/);
    assert.equal(f.calls.length,before);
  } finally {f.clean();}
});

test("fixture verification rejects tests that can escape the controlled local scope",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-proposer") r.proposal!.tests_required[0].args=["--test","tests/unsafe.test.mjs"];
    return r;
  }});
  try {
    await assert.rejects(f.approved(),/UNSUPPORTED_OWNED_TEST|TEST_OUTSIDE_UNIT_SCOPE/);
  } finally {f.clean();}
});

test("Phase 3 locks one architect contract before running both roles concurrently and reviewing Apply",async()=>{
  const workers:AgentExecutionRequest[]=[];
  let release!:()=>void;
  const bothStarted=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(["frontend-worker","backend-worker"].includes(req.capsule.role)) {
      const reference=req.capsule.api_contract_reference!;
      assert.ok(reference);f.bus.locks.require(reference);
      assert.ok(f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
      workers.push(req);if(workers.length===2) release();
      await Promise.race([bothStarted,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error("WORKERS_DID_NOT_OVERLAP")),5000);timer.unref();})]);
    }
    return r;
  }});
  try {
    await f.approved();
    await invoke(f.bus,"workflow_apply",{task_id:ROOT,execute:true});
    const architect=f.calls.find(c=>c.capsule.role==="api-contract-architect")!;
    const front=f.calls.find(c=>c.capsule.role==="api-contract-frontend-reviewer")!;
    const back=f.calls.find(c=>c.capsule.role==="api-contract-backend-reviewer")!;
    assert.ok(architect);assert.ok(front);assert.ok(back);
    const contract=f.bus.result(architect.capsule.task_id).api_contract;
    validate("api-contract",contract);
    assert.equal(front.capsule.api_contract_reference!.content_hash,hash(contract));
    for(const call of [architect,front,back,...workers]) {
      const schema=JSON.parse(readFileSync(call.result_schema_path,"utf8"));
      assert.equal(Boolean(schema.properties.api_contract),call===architect);
    }
    assert.deepEqual(front.capsule.api_contract_reference,back.capsule.api_contract_reference);
    assert.ok(f.calls.indexOf(architect)<f.calls.indexOf(front));assert.ok(f.calls.indexOf(front)<f.calls.indexOf(back));
    assert.ok(workers.every(w=>f.calls.indexOf(back)<f.calls.indexOf(w)));
    assert.equal(workers.length,2);assert.deepEqual(workers[0].capsule.api_contract_reference,workers[1].capsule.api_contract_reference);
    assert.notEqual(workers[0].cwd,workers[1].cwd);
    assert.ok(workers.every(w=>w.capsule.worktree!.base_commit===f.f.base_commit));
    const applies=applySubject(f.bus,ROOT).applies;
    assert.deepEqual(applies.map(a=>a.role),["backend-worker","frontend-worker"]);
    for(const a of applies) assert.equal(f.bus.storage.read<any>("engineering-verifications",a.child_task+".json").commands[0].exit_code,0);
    await invoke(f.bus,"workflow_apply_review",{task_id:ROOT,execute:true});
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    assert.equal(f.bus.executionPolicy.write_application_execution,false);fixtureInfo(f.bus);
  } finally {release();f.clean();}
});

for(const role of ["api-contract-frontend-reviewer","api-contract-backend-reviewer"]) test(`Phase 3 cannot lock or start workers when ${role} rejects`,async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(req.capsule.role===role) r.review_result!.verdict="rejected";
    return r;
  }});
  try {
    await f.approved();await assert.rejects(f.service.apply(ROOT,true),/API_CONTRACT_REVIEW_REQUIRED/);
    assert.equal(f.bus.events.get(ROOT).state,"BLOCKED");
    assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
    assert.equal(f.bus.worktrees.list().length,0);
    assert.ok(!f.calls.some(c=>["frontend-worker","backend-worker"].includes(c.capsule.role)));
    await assert.rejects(f.service.applyReview(ROOT,true));
  } finally {f.clean();}
});

const ARCHITECT_CHILD=ROOT+"-api-contract-architect-v1";
const CONTRACT_REVIEWERS=["api-contract-frontend-reviewer","api-contract-backend-reviewer"] as const;
test("Phase 3 contract reviewers receive the architect child as a canonical input reference and may cite exactly it",async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(CONTRACT_REVIEWERS.includes(req.capsule.role as never)) {
      r.evidence=[{assertion:"The contract under review was inspected",source:`artifact:${ARCHITECT_CHILD}`,observation:"Exact architect child reference"}];
      r.review_result!.evidence=r.evidence;
    }
    return r;
  }});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    const reviewers=f.calls.filter(c=>CONTRACT_REVIEWERS.includes(c.capsule.role as never));
    assert.deepEqual(reviewers.map(c=>c.capsule.role),[...CONTRACT_REVIEWERS]);
    const architect=f.bus.result(ARCHITECT_CHILD);
    assert.ok(architect.api_contract);
    const packages=reviewers.map(c=>JSON.parse(c.capsule.inputs[0]));
    for(const pkg of packages) {
      assert.deepEqual(pkg.input_references.at(-1),{child_task:ARCHITECT_CHILD,content_hash:hash(architect)});
      assert.equal(pkg.contract_source,`artifact:${ARCHITECT_CHILD}`);
      assert.ok(!pkg.input_references.some((ref:any)=>ref.child_task===`${ROOT}-api`));
    }
    assert.deepEqual(packages[0].input_references,packages[1].input_references);
    for(const c of reviewers) assert.match(c.capsule.responsibility,new RegExp(`cite exactly artifact:${ARCHITECT_CHILD}`));
    for(const c of reviewers) {
      assert.deepEqual(c.capsule.required_context,[],"contract reviewers receive no code context");
      assert.deepEqual(c.capsule.allowed_paths,f.request.allowed_paths,"scope is kept only as access control, never as provenance");
      assert.doesNotMatch(c.capsule.responsibility,/scoped code/);
    }
    assert.ok(f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
    assert.equal(f.bus.events.get(ROOT).state,"LOCAL_VERIFICATION");
  } finally {f.clean();}
});
for(const role of CONTRACT_REVIEWERS) for(const [label,source] of [["the contract id",`artifact:${ROOT}-api`],["a child absent from its inputs",`artifact:${ROOT}-task-sense`]] as const) test(`Phase 3 rejects ${role} evidence citing ${label} before any lock or worker`,async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(req.capsule.role===role) { r.evidence=[{assertion:"Contract statement",source,observation:"invalid provenance"}]; r.review_result!.evidence=r.evidence; }
    return r;
  }});
  try {
    await f.approved();
    await assert.rejects(f.service.apply(ROOT,true),new RegExp(`ENGINEERING_EVIDENCE_REFERENCE_REQUIRED: ${source}`));
    assert.ok(f.calls.some(c=>c.capsule.role===role),"the reviewer ran; its output was rejected without normalization");
    assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
    assert.equal(f.bus.worktrees.list().length,0);
    assert.ok(!f.calls.some(c=>["frontend-worker","backend-worker"].includes(c.capsule.role)));
  } finally {f.clean();}
});

test("Phase 3 refuses approval for a different contract hash",async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(req.capsule.role==="api-contract-backend-reviewer") r.review_result!.subject_hash="0".repeat(64);
    return r;
  }});
  try {
    await f.approved();await assert.rejects(f.service.apply(ROOT,true),/REVIEW_PROVENANCE_REQUIRED/);
    assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
    assert.equal(f.bus.worktrees.list().length,0);
    assert.notEqual(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});

test("Phase 3 rejects a backend result returned by the frontend worker",async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(req.capsule.role==="frontend-worker") r.role="backend-worker";
    return r;
  }});
  try {
    await f.approved();await assert.rejects(f.service.apply(ROOT,true),/AGENT_RESULT_IDENTITY_MISMATCH/);
    assert.equal(f.bus.events.get(ROOT).state,"BLOCKED");
    await assert.rejects(f.service.applyReview(ROOT,true));
    assert.ok(!f.calls.some(c=>c.capsule.role==="opsx-apply-reviewer"));
  } finally {f.clean();}
});

for(const status of ["failed","needs_contract_change"] as const) test(`Phase 3 ends BLOCKED when one worker returns ${status}`,async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{
    if(req.capsule.role==="frontend-worker") {r.status=status;if(status==="needs_contract_change") r.api_contract_status="change_requested";}
    return r;
  }});
  try {
    await f.approved();await assert.rejects(f.service.apply(ROOT,true),status==="needs_contract_change"?/CONTRACT_CHANGE_BLOCKED/:/QUARANTINED_WORKTREE/);
    assert.equal(f.bus.events.get(ROOT).state,"BLOCKED");
    const count=f.calls.length;
    await assert.rejects(f.service.apply(ROOT,true));
    await assert.rejects(f.service.applyReview(ROOT,true));
    assert.equal(f.calls.length,count);
    assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.change.requested"));
    assert.equal(f.bus.events.list(ROOT).filter(e=>e.event_type==="contract.locked").length,1);
  } finally {f.clean();}
});

test("wire schemas pin every identity, reference, hash and test ownership the gates verify",async()=>{
  const f=await fixture({phase3:true});
  try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const schema=(role:string)=>{const call=f.calls.find(c=>c.capsule.role===role)!;assert.ok(call,role);return {call,wire:JSON.parse(readFileSync(call.result_schema_path,"utf8"))};};
    for(const call of f.calls) {
      const wire=JSON.parse(readFileSync(call.result_schema_path,"utf8"));
      assert.deepEqual(wire.properties.task_id.enum,[call.capsule.task_id]);
      assert.deepEqual(wire.properties.role.enum,[call.capsule.role]);
      assert.deepEqual(wire.properties.scope_expanded,{type:"boolean",const:false},`${call.capsule.role} cannot claim scope expansion`);
      assert.equal(wire.properties.changed_files.maxItems,call.capsule.permissions==="read-only"?0:undefined,`${call.capsule.role} changed_files follows its permission`);
    }
    const {call:proposer,wire:proposerWire}=schema("opsx-proposer"),identity=JSON.parse(proposer.capsule.inputs[0]).proposal_identity,p=proposerWire.properties.proposal.anyOf[0].properties;
    assert.deepEqual(p.proposal_id.enum,[identity.proposal_id]);assert.deepEqual(p.root_task_id.enum,[ROOT]);
    assert.deepEqual(p.version,{type:"integer",minimum:1,maximum:1});assert.deepEqual(p.previous_proposal_hash,{type:"null"});
    assert.equal(p.verified_gap_refs.minItems,1);assert.equal(p.verified_gap_refs.maxItems,1);
    assert.deepEqual(p.verified_gap_refs.items.properties.child_task.enum,[ROOT+"-gap"]);
    assert.deepEqual(p.verified_gap_refs.items.properties.content_hash.enum,[latest<Proposal>(f.bus,ROOT,"proposal")!.content.verified_gap_refs[0].content_hash]);
    assert.equal(p.no_op.const,false);assert.equal(p.no_op.type,"boolean");
    for(const role of ["opsx-propose-reviewer","api-contract-frontend-reviewer","api-contract-backend-reviewer","opsx-apply-reviewer"]) {
      const {call,wire}=schema(role),pkg=JSON.parse(call.capsule.inputs[0]),review=wire.properties.review_result.properties;
      assert.deepEqual(review.task_id.enum,[ROOT]);assert.deepEqual(review.reviewer.enum,[call.capsule.task_id]);
      assert.deepEqual(review.role.enum,[role]);assert.deepEqual(review.subject_hash.enum,[pkg.subject_hash]);
      const sources=(node:any)=>new Set<string>(node.items.properties.source.enum);
      if(role==="opsx-apply-reviewer") {
        assert.equal(review.future_gates.maxItems,0,"apply review leaves no future gate");
        assert.equal(wire.properties.evidence.items.properties.source.enum,undefined,"the apply reviewer reopens code and is not closed to inherited evidence");
      } else {
        const allowlist=reviewEvidenceAllowlist(call.capsule);
        assert.deepEqual(sources(wire.properties.evidence),allowlist,`${role} top-level evidence is closed to the runtime allowlist`);
        assert.deepEqual(sources(review.evidence),allowlist,`${role} review evidence is closed to the runtime allowlist`);
        if(role==="opsx-propose-reviewer") {
          assert.deepEqual(sources(review.details.items.properties.evidence),allowlist,"proposal review finding evidence is closed to the runtime allowlist");
          assert.deepEqual(review.future_gates.items.enum,["api-contract-system"],"an eligible pair may name only the API contract gate");
          assert.equal(review.future_gates.maxItems,undefined);
        } else assert.equal(review.details,undefined);
      }
    }
    const {call:architect,wire:architectWire}=schema("api-contract-architect"),contractIdentity=JSON.parse(architect.capsule.inputs[0]).contract_identity,contract=architectWire.properties.api_contract.anyOf[0].properties;
    assert.deepEqual(contract.contract_id.enum,[contractIdentity.contract_id]);assert.deepEqual(contract.task_id.enum,[ROOT]);assert.deepEqual(contract.version.enum,[contractIdentity.version]);
    for(const role of ["frontend-worker","backend-worker"]) {
      const {call,wire}=schema(role);
      assert.ok(call.capsule.owned_tests.length);
      assert.ok(wire.properties.evidence.items.properties.source.pattern,`${role} evidence shape is pinned`);
      assert.deepEqual(wire.properties.tests_executed.items.properties.command.enum,call.capsule.owned_tests);
      assert.deepEqual(wire.properties.tests_not_executed.items.properties.command.enum,call.capsule.owned_tests);
      assert.ok(wire.properties.proposal_deviation,"a worker instructed to return proposal_deviation must be allowed to return it");
      assert.ok(wire.required.includes("proposal_deviation"));
    }
    for(const role of ["opsx-proposer","api-contract-architect","opsx-propose-reviewer","opsx-apply-reviewer"]) assert.equal(schema(role).wire.properties.proposal_deviation,undefined);
    for(const role of ["opsx-propose-reviewer","api-contract-frontend-reviewer","api-contract-backend-reviewer","opsx-apply-reviewer"]) assert.deepEqual(schema(role).wire.properties.status.enum,["completed"],`${role} gate publishes only completed`);
    for(const role of ["opsx-proposer","api-contract-architect"]) assert.deepEqual(schema(role).wire.properties.status.enum,["completed","blocked","failed"],`${role} may stop honestly but never answer needs_review`);
    for(const role of ["frontend-worker","backend-worker"]) {
      const status=schema(role).wire.properties.status.enum as string[];
      assert.ok(!status.includes("needs_review"),`${role} cannot answer needs_review`);
      for(const honest of ["completed","blocked","needs_scope_expansion","proposal_deviation","needs_contract_change","failed"]) assert.ok(status.includes(honest),`${role} keeps ${honest}`);
    }
    const {call:flow,wire:flowWire}=schema("flow"),flowInputs=JSON.parse(flow.capsule.inputs[0]).artifacts.map((a:any)=>({...a.reference,stage:a.output.stage,output:a.output}));
    const flowAllowlist=flowEvidenceAllowlist(flowInputs);
    assert.ok(flowAllowlist.size>0);
    assert.deepEqual(new Set(flowWire.properties.evidence.items.properties.source.enum),flowAllowlist,"flow top-level evidence is closed to Task Sense/Discovery sources");
    const evidenceNodes=(node:any,found:any[]=[]):any[]=>{if(!node||typeof node!=="object") return found;if(node.properties?.source&&node.properties?.assertion) found.push(node);for(const value of Object.values(node)) evidenceNodes(value,found);return found;};
    const flowNodes=evidenceNodes(flowWire);
    assert.equal(flowNodes.length,11,"top-level evidence plus the ten evidence arrays of workflow_output");
    for(const node of flowNodes) assert.deepEqual(new Set(node.properties.source.enum),flowAllowlist,"every flow evidence.source node is closed to the same allowlist");
    for(const role of ["discovery-backend","truth","gap","opsx-proposer"]) assert.equal(schema(role).wire.properties.evidence.items.properties.source.enum,undefined,`${role} gathers its own evidence and is not closed`);
    // Every rule that became a pin left the prose.
    assert.doesNotMatch(schema("opsx-propose-reviewer").call.capsule.responsibility,/AgentResult\.status="completed"|needs_review is for subjects|accepts exactly three forms|[Tt]he runtime rejects any other source|It MUST be \[\] when no such capability is needed|as future gates|future_gates contains ONLY/);
    assert.doesNotMatch(schema("api-contract-architect").call.capsule.responsibility,/Return completed/);
    assert.doesNotMatch(schema("opsx-apply-reviewer").call.capsule.responsibility,/AgentResult\.status="completed"|needs_review is for subjects|otherwise return \[\]/);
    for(const role of ["api-contract-frontend-reviewer","api-contract-backend-reviewer"]) assert.doesNotMatch(schema(role).call.capsule.responsibility,/scoped code|Return completed|accepts only artifact|the runtime rejects any other source/);
  } finally {f.clean();}
});

test("Phase 2 wire schemas pin reviewer status, proposer and worker honest stops and empty future gates",async()=>{
  const f=await fixture();try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const wire=(role:string)=>JSON.parse(readFileSync(f.calls.find(c=>c.capsule.role===role)!.result_schema_path,"utf8"));
    for(const role of ["opsx-propose-reviewer","opsx-apply-reviewer"]) assert.deepEqual(wire(role).properties.status.enum,["completed"],role);
    assert.deepEqual(wire("opsx-proposer").properties.status.enum,["completed","blocked","failed"]);
    const worker=wire("opsx-implementation-worker").properties.status.enum as string[];
    assert.ok(!worker.includes("needs_review"));
    for(const honest of ["completed","blocked","needs_scope_expansion","proposal_deviation","failed"]) assert.ok(worker.includes(honest),honest);
    assert.equal(wire("opsx-propose-reviewer").properties.review_result.properties.future_gates.maxItems,0,"a single-unit proposal admits no future gate");
    assert.equal(wire("opsx-apply-reviewer").properties.review_result.properties.future_gates.maxItems,0);
    for(const call of f.calls.filter(c=>c.capsule.constraints.some(x=>x.startsWith("WORKFLOW_STAGE:")))) assert.ok((JSON.parse(readFileSync(call.result_schema_path,"utf8")).properties.status.enum as string[]).includes("needs_review"),`${call.capsule.role} keeps needs_review`);
  } finally {f.clean();}
});

test("a proposer answering needs_review, as in smoke PHASE3-SMOKE-20260921-20, is rejected before publication",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.task_id===ROOT+"-proposal-v1") r.status="needs_review";return r;}});
  try {
    await assert.rejects(f.propose(),/PROPOSAL_NOT_COMPLETED/);
    assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");assert.equal(latest(f.bus,ROOT,"proposal"),null);
    const wire=JSON.parse(readFileSync(f.calls.find(c=>c.capsule.role==="opsx-proposer")!.result_schema_path,"utf8"));
    assert.ok(!(wire.properties.status.enum as string[]).includes("needs_review"),"the wire schema never offered needs_review to the proposer");
  } finally {f.clean();}
});

test("an apply review naming a future gate that the old wire enum allowed never grants DONE",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-apply-reviewer") r.review_result!.future_gates=["environment-isolation"];return r;}});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    await assert.rejects(f.service.applyReview(ROOT,true),/INDEPENDENT_APPLY_REVIEW_REQUIRED/);
    assert.notEqual(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});

test("a proposal review of an eligible pair naming any gate other than the API contract blocks Apply",async()=>{
  const f=await fixture({phase3:true,change:async(req,r)=>{if(req.capsule.role==="opsx-propose-reviewer") r.review_result!.future_gates=["visual-approval-system"];return r;}});
  try {
    await f.approved();assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
    await assert.rejects(f.service.apply(ROOT,true),/BLOCKED_BY_FUTURE_PHASE/);
    assert.equal(f.bus.worktrees.list().length,0);assert.ok(!f.calls.some(c=>c.capsule.role==="api-contract-architect"));
  } finally {f.clean();}
});

test("implementation worker wire schema carries the worktree-relative evidence shape and task:<own id>, as in smoke PHASE3-SMOKE-20260921-22, is rejected",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-implementation-worker") r.evidence=[...evidence("src/pagination.mjs:1"),...evidence(`task:${req.capsule.task_id}`)];return r;}});
  try {
    await f.approved();
    await assert.rejects(f.service.apply(ROOT,true),new RegExp(`ENGINEERING_EVIDENCE_REFERENCE_REQUIRED: task:${ROOT}-apply-pagination-defaults-v1`));
    assert.equal(latest(f.bus,ROOT,"apply"),null);
    const worker=f.calls.find(c=>c.capsule.role==="opsx-implementation-worker")!,c=worker.capsule,inputs=JSON.parse(c.inputs[0]).input_references;
    const pattern=JSON.parse(readFileSync(worker.result_schema_path,"utf8")).properties.evidence.items.properties.source.pattern as string|undefined;
    assert.ok(pattern);const regex=new RegExp(pattern!);
    for(const accepted of ["src/pagination.mjs:1","tests/pagination.test.mjs:1-2","src/pagination.mjs:1; tests/pagination.test.mjs:1",`artifact:${ROOT}-proposal-v1`,`task:${ROOT}`]) {
      assert.match(accepted,regex,accepted);
      assert.doesNotThrow(()=>evidenceInScope([{assertion:"x",source:accepted,observation:"y"}],c,inputs,c.worktree!.path),accepted);
    }
    for(const rejected of [`task:${c.task_id}`,`${f.source}:1`,"src","src/pagination.mjs",`artifact:${ROOT}-gap`]) {
      assert.doesNotMatch(rejected,regex,rejected);
      assert.throws(()=>evidenceInScope([{assertion:"x",source:rejected,observation:"y"}],c,inputs,c.worktree!.path),rejected);
    }
    assert.doesNotMatch(c.responsibility,/worktree-relative file:line/,"the accepted shape is a pin, never prose");
  } finally {f.clean();}
});

test("open_decisions means only a decision requiring a human answer; wording never unblocks the fail-closed runtime",async()=>{
  const delegated="PO não decidiu o formato do envelope; a resolver pelo API Contract Architect e revisores antes do lock (não bloqueante).";
  for(const placement of ["open_decisions","risks"] as const) {
    const f=await fixture({change:async(req,r)=>{if(r.proposal?.version===1) (r.proposal as any)[placement]=[delegated];return r;}});
    try {
      await f.propose();
      const proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!;
      assert.match(proposer.capsule.responsibility,/open_decisions has exactly one meaning: a product decision that requires a human answer before this proposal can be reviewed; any entry blocks the workflow until the PO answers/);
      assert.match(proposer.capsule.responsibility,/Never put in open_decisions a choice delegated to the API Contract Architect or to reviewers, a warning, an assumption, a non-blocking doubt, or anything the request, the decision or the contract already resolves with a safe default; record those in risks, scope_boundaries or the unit description and proceed/);
      assert.match(proposer.capsule.responsibility,/Return open_decisions=\[\] whenever the supplied decision and request allow the work to proceed/);
      assert.doesNotMatch(proposer.capsule.responsibility,/open_decisions records missing PO decisions/);
      for(const call of f.calls.filter(c=>c.capsule.role!=="opsx-proposer")) assert.doesNotMatch(call.capsule.responsibility,/open_decisions has exactly one meaning/);
      const count=f.calls.length;
      if(placement==="open_decisions") {
        await assert.rejects(f.service.proposalReview(ROOT,true),/WAITING_FOR_USER_DECISION/);
        assert.equal(f.calls.length,count,"no reviewer runs while a decision is open, whatever its wording");
        assert.equal(f.service.show(ROOT).engineering!.blocked,"WAITING_FOR_USER_DECISION");
        assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_CREATED");
      } else {
        await f.service.proposalReview(ROOT,true);
        assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED");
        assert.deepEqual(latest<Proposal>(f.bus,ROOT,"proposal")!.content.risks,[delegated]);
        assert.deepEqual(latest<Proposal>(f.bus,ROOT,"proposal")!.content.open_decisions,[]);
      }
    } finally {f.clean();}
  }
});

test("a worker that completes with known_issues fails owned verification deterministically and is told the rule",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-implementation-worker") r.known_issues=["tests/pagination.test.mjs não cobre o caminho de defaults"];return r;}});
  try {
    await f.approved();
    await assert.rejects(f.service.apply(ROOT,true),/IMPLEMENTATION_BLOCKED: blocked/);
    const worker=f.calls.find(c=>c.capsule.role==="opsx-implementation-worker")!;
    assert.match(worker.capsule.responsibility,/A completed unit MUST return deviations=\[\], known_issues=\[\] and requested_followups=\[\]; owned verification fails on any entry\. Put non-blocking observations in risks\./);
    assert.ok(JSON.parse(readFileSync(worker.result_schema_path,"utf8")).properties.proposal_deviation);
    const w=f.bus.worktrees.list()[0];
    assert.equal(f.bus.storage.read<any>("quarantine",w.id+".json").reason,"OWNED_VERIFICATION_FAILED");
    assert.equal(f.service.show(ROOT).engineering!.blocked,"IMPLEMENTATION_BLOCKED");
    await assert.rejects(f.service.applyReview(ROOT,true));
  } finally {f.clean();}
});

test("GAP_DEFINED checkpoint replays validated understanding into a fresh root through the real workflow and that root reaches DONE",async()=>{
  const f=await fixture({phase3:true}),target=ROOT+"-CHECKPOINT";
  try {
    const before=f.calls.length;
    const shown=await bootstrapGapCheckpoint({storage_root:f.root,source_root:ROOT,target_root:target,executor:new HostExecutor()});
    assert.equal(shown.state,"GAP_DEFINED");
    assert.equal(f.calls.length,before,"no configured provider ran for the checkpoint");
    assert.equal(f.bus.routing(target)!.profile,f.bus.routing(ROOT)!.profile);
    const sourceArtifacts=f.service.artifacts(ROOT),targetArtifacts=f.service.artifacts(target);
    assert.equal(targetArtifacts.length,sourceArtifacts.length);assert.equal(targetArtifacts.length,6);
    for(const a of targetArtifacts) {
      const source=sourceArtifacts.find(s=>s.child_task===a.child_task.replace(target,ROOT))!;
      assert.ok(source,a.child_task);
      assert.deepEqual(a.output,source.output);assert.equal(a.root_task,target);assert.equal(a.stage,source.stage);assert.notEqual(a.content_hash,source.content_hash);
      assert.ok(f.bus.events.list(a.child_task).some(e=>e.event_type==="agent.completed"&&e.actor===REPLAY_ACTOR));
      const observed=f.bus.events.list(a.child_task).find(e=>e.event_type==="provider.observed")!;
      const observation=f.bus.storage.read<any>("provider-observations",String(observed.payload.artifact));
      assert.equal(observation.replay,true);assert.equal(observation.provider_invoked,false);
      assert.equal(observation.replay_source.root,ROOT);assert.equal(observation.replay_source.child_task,source.child_task);assert.equal(observation.replay_source.artifact_hash,source.content_hash);
    }
    const replayed=f.bus.events.list(target).find(e=>e.event_type===REPLAY_EVENT)!;
    assert.equal(replayed.actor,REPLAY_ACTOR);assert.equal(replayed.payload.source_root,ROOT);
    assert.deepEqual((replayed.payload.artifacts as any[]).map(a=>a.target_hash).sort(),targetArtifacts.map(a=>a.content_hash).sort());
    assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED","the source root is only read");
    assert.equal((await invoke(f.bus,"workflow_show",{task_id:target}) as any).state,"GAP_DEFINED");
    await f.service.propose(target,true,"Implement only the requested fixture behavior; no product policy changes");
    await f.service.proposalReview(target,true);await f.service.apply(target,true);await f.service.applyReview(target,true);
    assert.equal(f.bus.events.get(target).state,"DONE");
    assert.ok(f.calls.some(c=>c.capsule.parent_task_id===target&&c.capsule.role==="frontend-worker"));
    await assert.rejects(bootstrapGapCheckpoint({storage_root:f.root,source_root:ROOT,target_root:target,executor:new HostExecutor()}),/TASK_EXISTS/);
    const second=await bootstrapGapCheckpoint({storage_root:f.root,source_root:target,target_root:ROOT+"-SECOND",executor:new HostExecutor()});
    assert.equal(second.state,"GAP_DEFINED","a source that advanced past GAP_DEFINED still has immutable validated understanding");
    await f.service.start({...f.request,task_id:ROOT+"-UNSTARTED"},false);
    await assert.rejects(bootstrapGapCheckpoint({storage_root:f.root,source_root:ROOT+"-UNSTARTED",target_root:ROOT+"-THIRD",executor:new HostExecutor()}),/SOURCE_GAP_REQUIRED/);
    assert.equal(f.bus.events.list(ROOT+"-THIRD").length,0);
  } finally {f.clean();}
});

const PROPOSAL_REVIEWER="opsx-propose-reviewer";
type Fixture=Awaited<ReturnType<typeof fixture>>;
// The change hook already runs during fixture(); the fixture paths become known only after it returns.
function reviewerCiting(role:string,late:{f?:Fixture;source:string},cite:(f:Fixture)=>string,assertion="Scoped behavior was inspected") {
  return async(req:AgentExecutionRequest,r:AgentResult)=>{
    if(req.capsule.role!==role) return r;
    late.source=cite(late.f!);
    r.evidence=[{assertion,source:late.source,observation:"Reviewer citation under test"}]; r.review_result!.evidence=r.evidence;
    return r;
  };
}

test("proposal reviewer evidence is closed to inherited input sources, artifact:<input child> and task:<root>",async()=>{
  for(const [label,cite] of [["evidence inherited from the validated Truth/Gap inputs",(f:Fixture)=>`${f.source}:1`],["artifact:<child> present in input_references",()=>`artifact:${ROOT}-gap`],["task:<root>",()=>`task:${ROOT}`]] as const) {
    const late:{f?:Fixture;source:string}={source:""};
    const f=late.f=await fixture({change:reviewerCiting(PROPOSAL_REVIEWER,late,cite)});
    try {
      await f.approved();
      assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_APPROVED",label);
      const review=latest<ReviewResult>(f.bus,ROOT,"proposal-review")!;
      assert.equal(review.content.evidence[0].source,late.source);
      const c=f.calls.find(c=>c.capsule.role===PROPOSAL_REVIEWER)!.capsule,pkg=JSON.parse(c.inputs[0]);
      assert.deepEqual([...reviewEvidenceAllowlist(c)].sort(),[`artifact:${ROOT}-gap`,`artifact:${pkg.input_references.at(-1).child_task}`,`artifact:${ROOT}-truth`,`${f.source}:1`,`task:${ROOT}`].sort(),"the allowlist is derived only from validated inputs and received references");
    } finally {f.clean();}
  }
});

test("proposal reviewer cannot cite a directory from allowed_paths, a new file:line inside allowed_paths or an invented absence",async()=>{
  const cases:[string,boolean,(f:Fixture)=>string,string,RegExp][]=[
    ["a directory present in allowed_paths",true,f=>f.f.workspace_path+"/src","Scoped behavior was inspected",/ENGINEERING_EVIDENCE_REFERENCE_REQUIRED/],
    ["a new file:line that exists inside allowed_paths",false,f=>`${f.source}:2`,"Scoped behavior was inspected",/ENGINEERING_EVIDENCE_NOT_IN_INPUTS: .*pagination\.mjs:2$/],
    ["an absence claim on a file that does not exist",true,f=>f.f.workspace_path+"/src/client.mjs:1","src/client.mjs does not exist yet",/ENOENT|ENGINEERING_EVIDENCE/],
    ["an absence claim on a directory",true,f=>f.f.workspace_path+"/src","src/client.mjs does not exist yet",/ENGINEERING_EVIDENCE_REFERENCE_REQUIRED/],
  ];
  for(const [label,phase3,cite,assertion,expected] of cases) {
    const late:{f?:Fixture;source:string}={source:""};
    const f=late.f=await fixture({phase3,change:reviewerCiting(PROPOSAL_REVIEWER,late,cite,assertion)});
    try {
      await f.propose();
      await assert.rejects(f.service.proposalReview(ROOT,true),expected,label);
      const c=f.calls.find(c=>c.capsule.role===PROPOSAL_REVIEWER)!.capsule;
      if(label.startsWith("a new file:line")) assert.doesNotThrow(()=>evidenceInScope([{assertion,source:late.source,observation:"x"}],c,JSON.parse(c.inputs[0]).input_references),"scope control alone accepts the citation; only the closed allowlist rejects it");
      assert.equal(f.bus.events.get(ROOT).state,"PROPOSAL_CREATED",label);
      assert.equal(latest(f.bus,ROOT,"proposal-review"),null,label);
      await assert.rejects(f.service.apply(ROOT,true),/APPROVED_PROPOSAL_REQUIRED/);
    } finally {f.clean();}
  }
});

test("proposal reviewer receives no code context and the Claude adapter grants it no read tools, unlike the proposer",async()=>{
  const f=await fixture();try {
    await f.approved();
    const reviewer=f.calls.find(c=>c.capsule.role===PROPOSAL_REVIEWER)!.capsule,proposer=f.calls.find(c=>c.capsule.role==="opsx-proposer")!.capsule;
    assert.deepEqual(reviewer.required_context,[]);
    assert.deepEqual(reviewer.allowed_paths,f.request.allowed_paths,"scope is kept only as access control, never as provenance");
    assert.match(reviewer.responsibility,/No code, tools or Discovery are available: do not reopen, read or search code and do not gather new evidence/);
    assert.doesNotMatch(reviewer.responsibility,/accepts exactly three forms/,"the closed allowlist reaches the provider as the enum of evidence.source, never as prose");
    const seen:string[][]=[];
    const runner=(c:typeof reviewer)=>async(input:{args:string[]})=>{
      seen.push(input.args);
      const done:AgentResult={...result({capsule:c} as AgentExecutionRequest),evidence:evidence(`task:${ROOT}`)};
      return {exit_code:0,stdout:JSON.stringify({structured_output:done}),stderr:"",signal:null};
    };
    const schema=join(f.root,"schema.json");writeFileSync(schema,"{}");
    for(const c of [reviewer,proposer]) await new ClaudeProvider(runner(c) as never).execute({capsule:c,cwd:f.root,prompt:"p",result_schema_path:schema,timeout_ms:1000,route:{provider:"claude",model_alias:"sonnet",model:"sonnet",effort:"medium",role:{} as never}});
    const tools=(args:string[])=>args[args.indexOf("--tools")+1];
    assert.equal(tools(seen[0]),"");
    assert.ok(!seen[0].includes("--allowedTools"));
    assert.equal(tools(seen[1]),"Read,Grep,Glob");
  } finally {f.clean();}
});

test("Phase 3 contract reviewers keep inherited proposal evidence and lose new file:line citations inside allowed_paths",async()=>{
  for(const [label,line,approved] of [["inherited",1,true],["new",2,false]] as const) {
    const late:{f?:Fixture;source:string}={source:""};
    const cite=reviewerCiting("api-contract-backend-reviewer",late,f=>`${f.source}:${line}`);
    const f=late.f=await fixture({phase3:true,change:async(req,r)=>{
      if(r.proposal) r.proposal.evidence=[...r.proposal.evidence,...evidence(`${late.f!.source}:1`)];
      return cite(req,r);
    }});
    try {
      await f.approved();
      if(approved) {
        await f.service.apply(ROOT,true);
        assert.ok(f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"),label);
        assert.equal(f.bus.result(f.calls.find(c=>c.capsule.role==="api-contract-backend-reviewer")!.capsule.task_id).evidence[0].source,late.source);
      } else {
        await assert.rejects(f.service.apply(ROOT,true),/ENGINEERING_EVIDENCE_NOT_IN_INPUTS: .*pagination\.mjs:2$/,label);
        assert.ok(f.calls.some(c=>c.capsule.role==="api-contract-backend-reviewer"),"the reviewer ran; its output was rejected without normalization");
        assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
        assert.equal(f.bus.worktrees.list().length,0);
        assert.ok(!f.calls.some(c=>["frontend-worker","backend-worker"].includes(c.capsule.role)));
      }
    } finally {f.clean();}
  }
});

test("implementation worker evidence is validated against its owned worktree before the apply artifact is published",async()=>{
  const cases:[string,(f:Fixture)=>string[],RegExp|null][]=[
    ["a directory",()=>["src"],/ENGINEERING_EVIDENCE_REFERENCE_REQUIRED: src/],
    ["a workspace-relative path, which is outside the worktree",f=>[`${f.source}:1`],/ENGINEERING_EVIDENCE_OUT_OF_SCOPE/],
    ["the proposal reference and a worktree-relative file:line",()=>[`artifact:${ROOT}-proposal-v1`,"src/pagination.mjs:3"],null],
  ];
  for(const [label,cite,expected] of cases) {
    const late:{f?:Fixture}={};
    const f=late.f=await fixture({change:async(req,r)=>{
      if(req.capsule.role==="opsx-implementation-worker") r.evidence=cite(late.f!).map(source=>({assertion:"Unit behavior was implemented",source,observation:"Worker citation under test"}));
      return r;
    }});
    try {
      await f.approved();
      if(expected) {
        await assert.rejects(f.service.apply(ROOT,true),expected,label);
        assert.equal(latest(f.bus,ROOT,"apply"),null,label);
        assert.notEqual(f.bus.events.get(ROOT).state,"LOCAL_VERIFICATION",label);
      } else {
        await f.service.apply(ROOT,true);
        assert.equal(f.bus.events.get(ROOT).state,"LOCAL_VERIFICATION",label);
        assert.deepEqual(latest<any>(f.bus,ROOT,"apply")!.content.evidence.map((e:Evidence)=>e.source),cite(f));
        await f.service.applyReview(ROOT,true);assert.equal(f.bus.events.get(ROOT).state,"DONE",label);
        const worktree=latest<any>(f.bus,ROOT,"apply")!.content.worktree;
        writeFileSync(join(worktree.path,"src/pagination.mjs"),"changed after review\n");
        assert.throws(()=>f.service.show(ROOT),/IMPLEMENTATION_CHANGED_AFTER_VERIFICATION/,"worktree and checkpoint checks precede evidence revalidation");
        rmSync(worktree.path,{recursive:true,force:true});
        assert.throws(()=>f.service.show(ROOT),/WORKTREE_PATH_MISSING/,"a missing worktree surfaces its named error, never a raw ENOENT");
      }
    } finally {f.clean();}
  }
});

test("every producer whose status set admits an honest stop may block with evidence=[] and null payloads; completed keeps requiring evidence; reviewers stay completed-only",async()=>{
  const f=await fixture({phase3:true});try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const covered=new Set<string>();
    for(const call of f.calls) {
      const wire=JSON.parse(readFileSync(call.result_schema_path,"utf8")),check=new Ajv({allErrors:true}).compile(wire),role=call.capsule.role;
      const stop:any={task_id:call.capsule.task_id,role,status:"blocked",summary:"Required evidence is unavailable",changed_files:[],evidence:[],tests_executed:[],tests_not_executed:[],api_contract_status:"not_applicable",visual_lock_status:"not_applicable",scope_expanded:false,deviations:[],risks:[],known_issues:["Required evidence is unavailable"],requested_followups:[]};
      for(const payload of ["workflow_output","proposal","api_contract","proposal_deviation"]) if(wire.properties[payload]) stop[payload]=null;
      assert.throws(()=>validate("agent-result",{...stop,status:"completed"}),/\/evidence must NOT have fewer than 1 items/,`${role}: completed without evidence stays canonically invalid`);
      if((wire.properties.status.enum as string[]).every(s=>s==="completed")) {
        assert.equal(wire.properties.evidence.minItems,1,`${role} is completed-only and keeps evidence.minItems`);
        assert.equal(check({...stop,status:"completed"}),false);
        assert.ok(check.errors!.some(e=>e.instancePath==="/evidence"&&e.keyword==="minItems"),role);
        assert.equal(check(stop),false,`${role} cannot block`);
      } else {
        assert.equal(wire.properties.evidence.minItems,undefined,`${role} is not forced to invent evidence`);
        assert.ok(check(stop),`${role}: ${JSON.stringify(check.errors)}`);
        assert.equal(validate<AgentResult>("agent-result",stop).status,"blocked");
      }
      covered.add(role);
    }
    for(const role of ["task-sense","discovery-backend","flow","truth","gap","opsx-proposer","opsx-propose-reviewer","api-contract-architect","api-contract-frontend-reviewer","api-contract-backend-reviewer","frontend-worker","backend-worker","opsx-apply-reviewer"]) assert.ok(covered.has(role),role);
  } finally {f.clean();}
});

test("an honestly blocked proposer returns evidence=[] and proposal=null, is persisted as blocked and publishes no Proposal",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-proposer") {r.status="blocked";r.evidence=[];r.proposal=null;r.known_issues=["The verified Gap does not support a proposal"];}return r;}});
  try {
    await assert.rejects(f.propose(),/PROPOSAL_NOT_COMPLETED/);
    assert.equal(f.bus.result(ROOT+"-proposal-v1").status,"blocked");
    assert.equal(latest(f.bus,ROOT,"proposal"),null);assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");
  } finally {f.clean();}
});

test("a proposer claiming completed without evidence or without a proposal publishes no Proposal",async()=>{
  for(const [change,error] of [[(r:AgentResult)=>{r.evidence=[];},/INVALID_AGENT_RESULT: agent-result: \/evidence/],[(r:AgentResult)=>{r.proposal=null;},/PROPOSAL_NOT_COMPLETED/]] as const) {
    const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-proposer") change(r);return r;}});
    try {
      await assert.rejects(f.propose(),error);
      assert.equal(latest(f.bus,ROOT,"proposal"),null);assert.equal(f.bus.events.get(ROOT).state,"GAP_DEFINED");
    } finally {f.clean();}
  }
});

test("an honestly blocked architect returns evidence=[] and api_contract=null and no contract is created, locked or implemented",async()=>{
  for(const [change,error] of [[(r:AgentResult)=>{r.status="blocked";r.evidence=[];r.api_contract=null;},/API_CONTRACT_PROVENANCE_INVALID/],[(r:AgentResult)=>{r.api_contract=null;},/INVALID_AGENT_RESULT: agent-result: \/api_contract/]] as const) {
    const f=await fixture({phase3:true,change:async(req,r)=>{if(req.capsule.role==="api-contract-architect") change(r);return r;}});
    try {
      await f.approved();
      await assert.rejects(f.service.apply(ROOT,true),error);
      assert.ok(!f.bus.events.list(ROOT).some(e=>["contract.created","contract.locked","engineering.apply.authorized"].includes(e.event_type)));
      assert.ok(!f.calls.some(c=>c.capsule.role.endsWith("-worker")||c.capsule.role.endsWith("-reviewer")&&c.capsule.role.startsWith("api-contract")));
    } finally {f.clean();}
  }
});

test("a rejected contract review is attributed to the reviewer that produced it and only that child becomes replaceable",async()=>{
  for(const [invalid,valid] of [["api-contract-frontend-reviewer","api-contract-backend-reviewer"],["api-contract-backend-reviewer","api-contract-frontend-reviewer"]]) {
    const late:{f?:Fixture;source:string}={source:""};
    const f=late.f=await fixture({phase3:true,change:reviewerCiting(invalid,late,f=>`${f.source}:2`)});
    try {
      await f.approved();
      await assert.rejects(f.service.apply(ROOT,true),/ENGINEERING_EVIDENCE_NOT_IN_INPUTS: .*pagination\.mjs:2$/,invalid);
      const failed=f.bus.events.list(ROOT).filter(e=>e.event_type==="engineering.action.failed").at(-1)!;
      assert.equal(failed.payload.child_task,`${ROOT}-${invalid}-v1`,`${invalid} is blamed, never ${valid}`);
      assert.ok(!f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"));
      const validRan=f.calls.some(c=>c.capsule.role===valid);
      assert.equal(validRan,invalid==="api-contract-backend-reviewer","the frontend review is validated before the backend reviewer starts");
      if(validRan) assert.throws(()=>f.service.engineeringRetry(ROOT,`${ROOT}-${valid}-v1`,"Replace the approved reviewer"),/ONLY_FAILED_READ_ONLY_CHILD_CAN_BE_REPLACED/);
      assert.equal(f.service.engineeringRetry(ROOT,`${ROOT}-${invalid}-v1`,"Replace the rejected reviewer").replacement_child,`${ROOT}-${invalid}-v1-retry-1`);
    } finally {f.clean();}
  }
});

test("an explicit replacement of a rejected contract child is the one executed and validated, and the root reaches DONE",async()=>{
  for(const role of ["api-contract-frontend-reviewer","api-contract-backend-reviewer","api-contract-architect"]) {
    const original=`${ROOT}-${role}-v1`,late:{f?:Fixture;source:string}={source:""};
    const cite=reviewerCiting(role,late,f=>`${f.source}:2`);
    const f=late.f=await fixture({phase3:true,change:async(req,r)=>{
      if(req.capsule.task_id!==original) return r;
      if(role!=="api-contract-architect") return cite(req,r);
      r.status="blocked";r.evidence=[];r.api_contract=null;return r;
    }});
    try {
      await f.approved();
      await assert.rejects(f.service.apply(ROOT,true),role==="api-contract-architect"?/API_CONTRACT_PROVENANCE_INVALID/:/ENGINEERING_EVIDENCE_NOT_IN_INPUTS/,role);
      const {replacement_child}=f.service.engineeringRetry(ROOT,original,"Replace the rejected contract child");
      await f.service.apply(ROOT,true);
      assert.ok(f.calls.some(c=>c.capsule.task_id===replacement_child),`${role}: the replacement ran`);
      assert.equal(f.calls.filter(c=>c.capsule.task_id===original).length,1,`${role}: the original ran once`);
      assert.ok(f.bus.events.list(ROOT).some(e=>e.event_type==="contract.locked"),`${role}: the contract is locked`);
      if(role!=="api-contract-architect") assert.equal((role==="api-contract-frontend-reviewer"?contractReviews(f.bus,ROOT).frontend:contractReviews(f.bus,ROOT).backend).reviewer,replacement_child);
      else for(const reviewer of f.calls.filter(c=>c.capsule.role.startsWith("api-contract-")&&c.capsule.role.endsWith("-reviewer"))) assert.ok(JSON.parse(reviewer.capsule.inputs[0]).input_references.some((r:{child_task:string})=>r.child_task===replacement_child),"reviewers receive the replacement architect");
      await f.service.applyReview(ROOT,true);
      assert.equal(f.bus.events.get(ROOT).state,"DONE",role);
    } finally {f.clean();}
  }
});

test("wire projection preserves only each provider's accepted keywords while canonical schemas and every pin stay intact",async()=>{
  const schemaDirectory=join(HARNESS_ROOT,"schemas"),canonical=()=>Object.fromEntries(readdirSync(schemaDirectory).map(file=>[file,readFileSync(join(schemaDirectory,file),"utf8")]));
  const before=canonical();
  const f=await fixture({phase3:true});try {
    await f.approved();await f.service.apply(ROOT,true);await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
    const project=(capsule:TaskCapsule,provider:string)=>JSON.parse(readFileSync((f.bus as unknown as {providerSchema(c:TaskCapsule,p:string):string}).providerSchema(capsule,provider),"utf8"));
    const keywords=(node:any,found=new Set<string>()):Set<string>=>{if(node&&typeof node==="object") for(const [k,v] of Object.entries(node)) {found.add(k);keywords(v,found);} return found;};
    const relativePath=JSON.parse(before["common.schema.json"]).definitions.relativePath.pattern;
    // Codex is the Claude wire minus the keywords only Claude accepted; every pattern Codex carries is a pin Claude carries too.
    const sameExceptClaudeKeywords=(claude:any,codex:any,path:string):void=>{
      if(!claude||typeof claude!=="object") return assert.deepEqual(claude,codex,path);
      assert.equal(Array.isArray(claude),Array.isArray(codex),path);
      for(const key of new Set([...Object.keys(claude),...Object.keys(codex)])) {
        if(key==="uniqueItems"&&!Array.isArray(claude)) {assert.equal(key in codex,false,`${path}/${key}`);continue;}
        if(key==="pattern"&&!Array.isArray(claude)&&!(key in codex)) continue;
        assert.ok(key in claude&&key in codex,`${path}/${key}`);
        sameExceptClaudeKeywords(claude[key],codex[key],`${path}/${key}`);
      }
    };
    const covered=new Set<string>();
    for(const call of f.calls) {
      const c=call.capsule,role=c.role,claude=project(c,"claude"),codex=project(c,"codex");
      assert.deepEqual(JSON.parse(readFileSync(call.result_schema_path,"utf8")),project(c,call.route.provider),`${role} receives its routed provider's wire`);
      assert.deepEqual(project(c,"unregistered-provider"),codex,`${role}: an unlisted provider keeps the full strip`);
      for(const [provider,wire] of [["claude",claude],["codex",codex]] as const) {
        for(const keyword of ["allOf","if","then","$id","$schema"]) assert.equal(keywords(wire).has(keyword),false,`${provider} ${role} drops ${keyword}`);
        assert.deepEqual(wire.properties.task_id.enum,[c.task_id]);assert.deepEqual(wire.properties.scope_expanded,{type:"boolean",const:false});
        if(c.permissions==="read-only") assert.equal(wire.properties.changed_files.maxItems,0,`${provider} ${role} read-only changed_files`);
        if(role.endsWith("-reviewer")) assert.deepEqual(wire.properties.status.enum,["completed"]);
        if(role==="opsx-apply-reviewer") assert.equal(wire.properties.review_result.properties.future_gates.maxItems,0);
        if(role==="opsx-propose-reviewer") assert.ok(wire.properties.review_result.properties.future_gates.items.enum.length);
      }
      assert.equal(keywords(codex).has("uniqueItems"),false,`codex ${role} inherits no Claude keyword`);
      assert.equal(claude.properties.changed_files.uniqueItems,true,`claude ${role} keeps uniqueItems`);
      assert.equal(claude.properties.changed_files.items.pattern,relativePath,`claude ${role} keeps the canonical path pattern`);
      assert.equal(codex.properties.changed_files.items.pattern,undefined,`codex ${role} drops the canonical path pattern`);
      sameExceptClaudeKeywords(claude,codex,role);
      const source=(wire:any)=>wire.properties.evidence.items.properties.source.pattern;
      if(role==="opsx-proposer"||role.endsWith("-worker")) assert.ok(source(claude)&&source(claude)===source(codex),`${role} keeps the dynamic evidence pin`);
      if(role==="opsx-proposer") for(const wire of [claude,codex]) {
        const p=wire.properties.proposal.anyOf[0].properties;
        assert.ok(p.affected_files_or_areas.items.pattern,"proposal scope pin");
        assert.equal(p.implementation_units.items.properties.id.pattern,JSON.parse(before["proposal.schema.json"]).properties.implementation_units.items.properties.id.pattern,"unit id pin");
      }
      covered.add(role);
    }
    for(const role of ["task-sense","opsx-proposer","api-contract-backend-reviewer","backend-worker","opsx-apply-reviewer"]) assert.ok(covered.has(role),role);
  } finally {f.clean();}
  assert.deepEqual(canonical(),before,"canonical schemas are never rewritten by projection");
});

const implementationCall=(f:{calls:AgentExecutionRequest[]})=>f.calls.find(c=>c.capsule.role==="opsx-implementation-worker")!;
const verificationOf=(f:any,task:string)=>f.bus.storage.read("engineering-verifications",task+".json") as any;

test("owned tests stay the worker's Definition of Done while only the harness executes them, even when the worker ran nothing",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-implementation-worker") {r.tests_executed=[];r.tests_not_executed=[];}return r;}});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    const worker=implementationCall(f),owned=worker.capsule.owned_tests;
    assert.deepEqual(owned,["node --test tests/pagination.test.mjs"]);
    assert.match(worker.capsule.responsibility,/owned_tests are this unit's Definition of Done: implement so they pass, but do not run them/);
    assert.doesNotMatch(worker.capsule.responsibility,/Run ONLY the owned tests/);
    const verification=verificationOf(f,worker.capsule.task_id);
    assert.equal(verification.passed,true);
    assert.deepEqual(verification.commands.map((t:any)=>[t.command,t.exit_code]),[[owned[0],0]]);
    assert.equal(latest<any>(f.bus,ROOT,"apply")!.content.status,"completed");
    await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});

test("a failing owned test blocks Apply even when the worker claims it passed, and nothing is checkpointed as success",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-implementation-worker") {
      const file=join(req.cwd,"src/pagination.mjs");
      writeFileSync(file,readFileSync(file,"utf8").replace("page = 0","page = 1"));
      assert.deepEqual(r.tests_executed.map(t=>t.exit_code),[0],"the worker's claim says the owned test passed");
    }
    return r;
  }});
  try {
    await f.approved();
    await assert.rejects(f.service.apply(ROOT,true),/IMPLEMENTATION_BLOCKED: blocked/);
    const worker=implementationCall(f),verification=verificationOf(f,worker.capsule.task_id);
    assert.equal(verification.passed,false);
    assert.equal(verification.checkpoint,null);
    assert.notEqual(verification.commands[0].exit_code,0);
    assert.equal(f.bus.storage.read<any>("quarantine",f.bus.worktrees.list()[0].id+".json").reason,"OWNED_VERIFICATION_FAILED");
    assert.equal(latest<any>(f.bus,ROOT,"apply")!.content.status,"blocked");
    await assert.rejects(f.service.applyReview(ROOT,true));
    assert.notEqual(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});

test("how the worker says it ran the owned test is irrelevant: the harness still runs the declared command",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-implementation-worker") {
      const [owned]=req.capsule.owned_tests;
      r.tests_executed=[{command:`${owned}; echo "exit=$?"`,exit_code:0,evidence:"chained form"},{command:`node --test ${join(req.cwd,"tests/pagination.test.mjs")}`,exit_code:0,evidence:"absolute path form"}];
      r.tests_not_executed=[{command:owned,reason:"Bash was denied"}];
    }
    return r;
  }});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    const worker=implementationCall(f),verification=verificationOf(f,worker.capsule.task_id);
    assert.equal(verification.passed,true);
    assert.deepEqual(verification.commands.map((t:any)=>t.command),worker.capsule.owned_tests);
    assert.deepEqual(verification.commands[0].args,["--test","tests/pagination.test.mjs"]);
    assert.equal(latest<any>(f.bus,ROOT,"apply")!.content.status,"completed");
  } finally {f.clean();}
});

const publishedVerification=(verification:any)=>({passed:verification.passed,commands:verification.commands.map((t:any)=>({command:t.command,exit_code:t.exit_code}))});

test("the ApplyResult publishes the harness verification even when the worker claims nothing, keeping the empty claim apart",async()=>{
  const f=await fixture({change:async(req,r)=>{if(req.capsule.role==="opsx-implementation-worker") {r.tests_executed=[];r.tests_not_executed=[];}return r;}});
  try {
    await f.approved();await f.service.apply(ROOT,true);
    const worker=implementationCall(f),applied=latest<any>(f.bus,ROOT,"apply")!.content;
    assert.equal(applied.version,2);
    assert.deepEqual(applied.verification,{passed:true,commands:[{command:worker.capsule.owned_tests[0],exit_code:0}]});
    assert.deepEqual(applied.verification,publishedVerification(verificationOf(f,worker.capsule.task_id)));
    assert.deepEqual(applied.worker_claims,{tests_executed:[],tests_not_executed:[]});
    assert.equal("tests_executed" in applied,false,"a v2 ApplyResult has no top-level claim a reader could mistake for verification");
    await f.service.applyReview(ROOT,true);
    assert.equal(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});

test("the ApplyResult publishes the real failing exit code when the worker falsely claims the owned test passed",async()=>{
  const f=await fixture({change:async(req,r)=>{
    if(req.capsule.role==="opsx-implementation-worker") {
      const file=join(req.cwd,"src/pagination.mjs");
      writeFileSync(file,readFileSync(file,"utf8").replace("page = 0","page = 1"));
    }
    return r;
  }});
  try {
    await f.approved();
    await assert.rejects(f.service.apply(ROOT,true),/IMPLEMENTATION_BLOCKED: blocked/);
    const worker=implementationCall(f),applied=latest<any>(f.bus,ROOT,"apply")!.content;
    assert.equal(applied.status,"blocked");
    assert.equal(applied.verification.passed,false);
    assert.notEqual(applied.verification.commands[0].exit_code,0);
    assert.deepEqual(applied.verification,publishedVerification(verificationOf(f,worker.capsule.task_id)));
    assert.deepEqual(applied.worker_claims.tests_executed.map((t:any)=>t.exit_code),[0],"the false claim is preserved as a claim, never as verification");
  } finally {f.clean();}
});

test("a v2 ApplyResult whose published verification diverges from the harness run is rejected on read",async()=>{
  const f=await fixture();
  try {
    await f.approved();await f.service.apply(ROOT,true);
    const record=records(f.bus,ROOT,"apply").at(-1)!,file=f.bus.storage.path("workflows",id(ROOT),"engineering",String(record.payload.path));
    const original=readFileSync(file,"utf8");
    const forge=(edit:(verification:any)=>void)=>{
      const {content_hash,...body}=JSON.parse(original);edit(body.content.verification);
      writeFileSync(file,JSON.stringify({...body,content_hash:hash(body)}));
      assert.throws(()=>readEngineeringArtifact(f.bus,ROOT,String(record.payload.path)),/APPLY_VERIFICATION_INVALID/);
    };
    forge(v=>{v.commands[0].exit_code=1;});
    forge(v=>{v.commands=[];});
    forge(v=>{v.passed=false;});
    writeFileSync(file,original);
    assert.equal(readEngineeringArtifact<any>(f.bus,ROOT,String(record.payload.path)).content.verification.passed,true);
  } finally {f.clean();}
});

test("a legacy ApplyResult without version stays valid while a v2 one must carry verification and worker claims",()=>{
  const worktree={id:"W",task_id:"T",role:"backend-worker",repository:"/r",path:"/r/w",base_ref:"a".repeat(40),base_commit:"a".repeat(40),contract_version:null,created_at:"2026-09-23T00:00:00.000Z"};
  const common={proposal_id:"P",implementation_unit:"u",task_id:"T",status:"completed",changed_files:["src/a.mjs"],evidence:[],deviations:[],scope_expansion_requested:false,known_issues:[],worktree,checkpoint:"b".repeat(40),verification_hash:"h"};
  const claims={tests_executed:[],tests_not_executed:[]};
  validate("apply-result",{...common,...claims});
  validate("apply-result",{...common,version:2,verification:{passed:true,commands:[{command:"node --test t.mjs",exit_code:0}]},worker_claims:claims});
  assert.throws(()=>validate("apply-result",{...common,version:2,worker_claims:claims}));
  assert.throws(()=>validate("apply-result",{...common,version:2,verification:{passed:true,commands:[]},worker_claims:claims,...claims}));
  assert.throws(()=>validate("apply-result",{...common,...claims,verification:{passed:true,commands:[]}}));
});

test("an unavailable isolated executor fails Apply closed as infrastructure, never as a verified or failed implementation",async()=>{
  const f=await fixture();
  try {
    await f.approved();
    (f.bus as unknown as {executionSandbox:unknown}).executionSandbox={async execute(){throw new Error("ISOLATED_EXECUTOR_UNAVAILABLE: docker is not running");}};
    await assert.rejects(f.service.apply(ROOT,true),/ISOLATED_EXECUTOR_UNAVAILABLE/);
    const worker=implementationCall(f);
    assert.equal(f.bus.storage.exists("engineering-verifications",worker.capsule.task_id+".json"),false,"no verification result is invented");
    const reason=f.bus.storage.read<any>("quarantine",f.bus.worktrees.list()[0].id+".json").reason;
    assert.match(reason,/^ISOLATED_EXECUTOR_UNAVAILABLE: /,"the worktree is held for the infrastructure failure");
    assert.notEqual(reason,"OWNED_VERIFICATION_FAILED","infrastructure is not blamed on the implementation");
    assert.equal(latest<any>(f.bus,ROOT,"apply"),null);
    assert.notEqual(f.bus.events.get(ROOT).state,"DONE");
  } finally {f.clean();}
});
