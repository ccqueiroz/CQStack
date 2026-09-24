import { mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBus } from '../dist/runtime/src/surface.js';
import { WorkflowService } from '../dist/runtime/src/workflow/service.js';
import { fixtureInfo } from '../dist/runtime/src/workflow/engineering/fixture.js';
import { hash } from '../dist/runtime/src/storage.js';
const bus=createBus(),service=new WorkflowService(bus);
const roots=process.argv.slice(2); if(!roots.length) roots.push('PHASE2-PAGINATION','PHASE2-APPLY-DEMO','PHASE2-COMPLETION-DEMO','PHASE2-CONTROLLED-APPLY','PHASE2-FIXTURE-END-TO-END','PHASE2-OWNED-WRITE');
const relevantTasks=new Set();
const target=resolve('artifacts/phase-2-completion-demo');mkdirSync(target,{recursive:true});
function save(file,value) {const path=join(target,file);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n');}
for(const root of roots) {
  const events=bus.events.list(root),children=events.filter(e=>e.event_type==='workflow.child.created').map(e=>e.payload.child_task);
  save(`${root}/final-state.json`,service.show(root));save(`${root}/artifacts.json`,service.allArtifacts(root));
  cpSync(bus.storage.path('workflows',root),join(target,root,'workflow'),{recursive:true});
  for(const task of [...new Set([root,...children])]) {
    relevantTasks.add(task);
    save(`${root}/capsules/${task}.json`,bus.events.get(task).capsule);
    save(`${root}/events/${task}.json`,bus.events.list(task));
    if(bus.storage.exists('results',task+'.json')) save(`${root}/results/${task}.json`,bus.result(task));
    if(bus.storage.exists('engineering-verifications',task+'.json')) save(`${root}/verification/${task}.json`,bus.storage.read('engineering-verifications',task+'.json'));
    for(const e of bus.events.list(task).filter(e=>e.event_type==='provider.observed')) save(`${root}/provider-observations/${e.payload.artifact}`,bus.storage.read('provider-observations',e.payload.artifact));
  }
  for(const event of events.filter(e=>e.event_type==='engineering.worktree.created')) {
    const w=event.payload.worktree;save(`${root}/worktrees/${w.id}/descriptor.json`,w);
    if(bus.storage.exists('ownership',w.id+'.json')) save(`${root}/worktrees/${w.id}/ownership.json`,bus.storage.read('ownership',w.id+'.json'));
    if(bus.storage.exists('quarantine',w.id+'.json')) save(`${root}/worktrees/${w.id}/quarantine.json`,bus.storage.read('quarantine',w.id+'.json'));
  }
  save(`${root}/role-resolutions.json`,children.flatMap(task=>bus.events.list(task).filter(e=>e.event_type==='agent.delegated').map(e=>e.payload)));
}
save('fixture-registration.json',fixtureInfo(bus));
const observations=readdirSync(bus.storage.path('provider-observations')).map(file=>{
  const o=bus.storage.read('provider-observations',file);return {task_id:o.task_id,role:o.role,provider:o.provider,model_alias:o.model_alias,model:o.model,exit_code:o.exit_code,elapsed_ms:o.elapsed_ms,prompt_bytes:o.prompt_bytes,cwd:o.cwd,timeout_ms:o.timeout_ms,sandbox:o.args?.includes("--sandbox")?o.args[o.args.indexOf("--sandbox")+1]:null,tools:o.args?.includes("--tools")?o.args[o.args.indexOf("--tools")+1]:null,usage:o.usage??o.envelope?.usage??null,reported_models:Object.keys(o.envelope?.modelUsage??{}),observation:file};
}).filter(o=>relevantTasks.has(o.task_id));
if(observations.some(o=>/fable/i.test([o.model,o.model_alias,...o.reported_models].join(' ')))) throw new Error('FABLE_OBSERVED');
save('provider-executions.json',observations);
writeFileSync(join(target,'README.md'),'# Phase 2 completion evidence\n\nThis export preserves canonical capsules, immutable artifacts/results, task events, role resolutions, provider observations, Git diffs and real local test outputs. The fixture source checkout stays at its initial commit; verified unit checkpoints remain in owned worktrees. No application files are exported or changed.\n\nDemo A and Demo B are the proposal/review and controlled Apply segments of the accepted fixture workflow. Earlier Cartera no-op and fixture attempts remain exported with their actual blocked states and validation failures. CLI/MCP projections and final review evidence are recorded alongside these directories.\n');
console.log(JSON.stringify({roots,states:roots.map(root=>service.show(root).state),target,evidence_hash:hash(observations)}));
