import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBus } from '../dist/runtime/src/surface.js';
import { WorkflowService } from '../dist/runtime/src/workflow/service.js';
const root=process.argv[2]??'PHASE2-OWNED-WRITE',bus=createBus(),service=new WorkflowService(bus);
const before=bus.events.list(root).length;
const client=new Client({name:'phase-2-completion-verification',version:'1.0.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/mcp/server.js']}));
const outputs={};
try {
 const tools=await client.listTools(); assert.equal(tools.tools.length,25);outputs.tools=tools.tools.map(t=>t.name);
 for(const name of ['workflow_show','workflow_proposal','workflow_artifacts','workflow_resume','workflow_apply','workflow_apply_review']) {
  const out=await client.callTool({name,arguments:{task_id:root}});assert.ok(!out.isError,JSON.stringify(out));outputs[name]=JSON.parse(out.content[0].text);
 }
 assert.equal(outputs.workflow_show.state,'DONE');assert.equal(outputs.workflow_proposal.state,'DONE');assert.equal(outputs.workflow_apply.execute,false);
 const denied=await client.callTool({name:'workflow_apply',arguments:{task_id:root,write_application_execution:true}});assert.equal(denied.isError,true);outputs.arbitrary_authority_rejected=denied;
 const cli=JSON.parse(execFileSync(process.execPath,['dist/cli/main.js','workflow','show',root],{encoding:'utf8'}));assert.deepEqual(cli,outputs.workflow_show);
 assert.deepEqual(service.show(root),cli);assert.equal(bus.events.list(root).length,before);
 mkdirSync('artifacts/phase-2-completion-demo',{recursive:true});writeFileSync('artifacts/phase-2-completion-demo/surfaces.json',JSON.stringify({root,tools:25,state:'DONE',events_unchanged:true,cli_mcp_core_equal:true,outputs},null,2)+'\n');
 console.log(JSON.stringify({root,tools:25,cli_mcp_core_equal:true,events_unchanged:true,state:'DONE'}));
} finally {await client.close();}
