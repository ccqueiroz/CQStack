import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const str = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: str, uniqueItems: true };
const paths = { $ref: 'common.schema.json#/definitions/pathArray' };
const evidence = { type: 'array', items: { $ref: 'common.schema.json#/definitions/evidence' }, minItems: 1 };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const array = items => ({ type: 'array', items });
const ref = object({ child_task: str, content_hash: { $ref: 'common.schema.json#/definitions/hash' } });
const test = object({ id: str, unit_id: str, command: { const: 'node' }, args: { type: 'array', items: str, minItems: 2 }, purpose: str });
const unit = object({ id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,19}$' }, role: { const: 'opsx-implementation-worker' }, repository: str, responsibility: str, allowed_paths: paths, forbidden_paths: paths, acceptance_criteria: strings, owned_test_ids: strings, depends_on: strings, evidence });
const proposal = object({ proposal_id: str, root_task_id: str, version: { type: 'integer', minimum: 1, maximum: 3 }, previous_proposal_hash: { type: ['string', 'null'] }, goal: str, verified_gap_refs: array(ref), solution_summary: str, no_op: { type: 'boolean' }, affected_repositories: strings, affected_slices: strings, affected_files_or_areas: paths, implementation_units: array(unit), dependencies: strings, ordering: strings, parallelizable_units: array(strings), tests_required: array(test), risks: strings, scope_boundaries: strings, out_of_scope: strings, requires_api_contract: {type:'boolean'}, requires_visual_approval:{type:'boolean'}, requires_database_change:{type:'boolean'}, requires_external_resource:{type:'boolean'}, open_decisions: strings, evidence });
const deviation = object({ reason: str, affected_unit: str, expected_behavior: str, required_change: str });
const apply = object({ proposal_id: str, implementation_unit: str, task_id: str, status: {enum:['completed','blocked','failed','needs_scope_expansion','proposal_deviation']}, changed_files: paths, tests_executed: array(object({ command: str, exit_code: {type:'integer'}, evidence: str })), tests_not_executed: array(object({command:str,reason:str})), evidence, deviations: strings, scope_expansion_requested: {type:'boolean'}, known_issues: strings, worktree: {$ref:'common.schema.json#/definitions/worktree'}, checkpoint: {type:['string','null']}, verification_hash: str });
const save = (name, value) => writeFileSync(resolve(root,'schemas',name+'.schema.json'), JSON.stringify({$schema:'http://json-schema.org/draft-07/schema#',$id:name+'.schema.json',...value},null,2)+'\n');
apply.properties.evidence = array({$ref:'common.schema.json#/definitions/evidence'});
save('proposal',proposal); save('proposal-deviation',deviation); save('apply-result',apply);
const resultPath = resolve(root,'schemas/agent-result.schema.json');
const result = JSON.parse(readFileSync(resultPath));
if(!result.properties.status.enum.includes('proposal_deviation')) result.properties.status.enum.push('proposal_deviation');
result.properties.proposal = {$ref:'proposal.schema.json'};
result.properties.proposal_deviation = {anyOf:[{$ref:'proposal-deviation.schema.json'},{type:'null'}]};
if(!result.allOf.some(x=>x.if?.properties?.status?.const==='proposal_deviation')) result.allOf.push({if:{properties:{status:{const:'proposal_deviation'}},required:['status']},then:{required:['proposal_deviation'],properties:{proposal_deviation:{$ref:'proposal-deviation.schema.json'}}}});
writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
const reviewPath=resolve(root,'schemas/review-result.schema.json'), review=JSON.parse(readFileSync(reviewPath));
review.properties.verdict.enum=['approved','rejected','changes_required','blocked_by_future_phase','blocked'];
review.properties.details=array(object({finding:str,severity:{enum:['blocking','warning','info']},section:str,evidence,required_change:{type:'string'}}));
review.properties.future_gates=strings;
writeFileSync(reviewPath,JSON.stringify(review,null,2)+'\n');
const rolesPath=resolve(root,'roles/registry.json'), roles=JSON.parse(readFileSync(rolesPath));
for(const [role,alias,provider,permission,purpose] of [
 ['opsx-proposer','astra','codex','read-only','Design the smallest proposal that solves verified Gap and implements the explicit PO decision'],
 ['opsx-propose-reviewer','sonnet','claude','read-only','Independently review proposal scope, evidence, units, decisions and future requirements'],
 ['opsx-implementation-worker','sol','codex','restricted-path-write','Implement one approved proposal unit in an owned worktree'],
 ['opsx-apply-reviewer','sonnet','claude','read-only','Independently inspect approved proposal, diff, test outputs and implementation scope']
]) if(!roles.some(r=>r.role===role)) roles.push({role,purpose,allowed_capabilities:['read','return-result',...(permission==='read-only'?[]:['write-scoped'])],mutation_permission:permission,default_provider:provider,default_model_alias:alias,fallback_model_alias:null,required_artifacts:['task-capsule'],expected_output_schema:'agent-result'});
writeFileSync(rolesPath,JSON.stringify(roles,null,2)+'\n');
