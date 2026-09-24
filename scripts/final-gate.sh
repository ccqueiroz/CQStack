#!/bin/zsh
# usage: scripts/final-gate.sh [evidence-dir]
# Single reproducible closure gate. Reads the baseline show and the smoke proofs from the
# evidence directory, never calls a provider, and writes everything to <evidence-dir>/final-gate.
setopt null_glob
H=${0:A:h:h}; EV=${1:-$H/artifacts/p2-closure-20260924}; EV=${EV:A}; G=$EV/final-gate
cd $H || exit 1
rm -rf $G; mkdir -p $G/show
srchash() { find runtime/src runtime/tests cli mcp schemas config roles governance dist package.json package-lock.json tsconfig.json -type f -not -name '.DS_Store' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1; }
residues() { print -l state/engineering-test-*(N) | grep -c . ; }

date -u +%FT%TZ > $G/started_at
srchash > $G/source-hash.before
residues > $G/residues.before
npm run build > $G/build.log 2>&1; echo $? > $G/build.exit
npx tsc --noEmit -p tsconfig.json > $G/tsc.log 2>&1; echo $? > $G/tsc.exit
CMD='node --test --test-reporter=tap dist/runtime/tests/*.test.js'
print -r -- "$CMD" > $G/command.txt
eval $CMD > $G/suite.tap 2> $G/suite.stderr; echo $? > $G/suite.exit
shasum -a 256 $G/suite.tap | cut -d' ' -f1 > $G/suite.tap.sha256
residues > $G/residues.after

for r in $(ls state/workflows); do npm run -s cli -- workflow show $r > $G/show/$r.json 2> $G/show/$r.err; done
diff -r $EV/baseline/show $G/show > $G/show-diff.txt; echo $? > $G/show-diff.exit

node --input-type=module - "$H" "$EV" "$G" > $G/checks.json <<'EOF'
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const [H, EV, G] = process.argv.slice(2);
const { hash } = await import(`${H}/dist/runtime/src/storage.js`);
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const proofs = json(`${EV}/smoke-proofs.json`);
const proofRoots = new Set(Object.values(proofs.aliases).map((p) => p.root));
// Only roots created by the live proofs may be absent from the baseline show.
const baseline = new Set(readdirSync(`${EV}/baseline/show`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const current = readdirSync(`${G}/show`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const newRoots = current.filter((r) => !baseline.has(r));
const unexpectedRoots = newRoots.filter((r) => !proofRoots.has(r));
const changedBaselineRoots = [...baseline].filter((r) => ["json", "err"].some((x) =>
  !existsSync(`${G}/show/${r}.${x}`) || readFileSync(`${EV}/baseline/show/${r}.${x}`, "utf8") !== readFileSync(`${G}/show/${r}.${x}`, "utf8")));
const profiles = json(`${H}/config/routing-profiles.json`).profiles;
const routing = readdirSync(`${H}/state/routing`).filter((f) => f.endsWith(".json")).map((f) => {
  const s = json(`${H}/state/routing/${f}`), orchestration = profiles[s.profile]?.orchestration, problems = [];
  if (s.version !== 1) problems.push(`version=${s.version}`);
  for (const [role, route] of Object.entries(s.routes)) {
    if (Boolean(route.route_reason) !== (route.model_alias === orchestration)) problems.push(`${role}: route_reason must mark exactly the orchestration alias`);
    if (/fable/i.test(route.model_alias) && !route.route_reason) problems.push(`${role}: fable outside orchestration`);
  }
  return { snapshot: f, profile: s.profile, ok: problems.length === 0, problems };
});
const smoke = Object.entries(proofs.aliases).map(([alias, p]) => {
  const observation = json(`${H}/${p.observation}`);
  const event = readFileSync(`${H}/state/events/${p.task}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .find((e) => e.event_type === "provider.observed" && `state/provider-observations/${e.payload.artifact}` === p.observation);
  const snapshot = json(`${H}/${p.routing_snapshot}`);
  const checks = { event_found: Boolean(event), hash_matches_event: Boolean(event) && hash(observation) === event.payload.content_hash && p.content_hash === event.payload.content_hash,
    provider_invoked_true: observation.provider_invoked === true, exit_code_zero: observation.exit_code === 0,
    snapshot_resolves_alias: snapshot.routes[observation.role]?.model_alias === alias && observation.model_alias === alias };
  return { alias, task: p.task, model: observation.model, created_at: observation.created_at, ...checks, ok: Object.values(checks).every(Boolean) };
});
const configHashes = Object.fromEntries(readdirSync(`${H}/config`).filter((f) => f.endsWith(".json")).sort().map((f) => [f, createHash("sha256").update(readFileSync(`${H}/config/${f}`)).digest("hex")]));
console.log(JSON.stringify({ new_roots: newRoots, unexpected_roots: unexpectedRoots, changed_baseline_roots: changedBaselineRoots, show_ok: unexpectedRoots.length === 0 && changedBaselineRoots.length === 0,
  routing_ok: routing.every((r) => r.ok), routing, smoke_ok: smoke.length === 6 && smoke.every((s) => s.ok), smoke, config_sha256: configHashes }, null, 2));
EOF
echo $? > $G/checks.exit

srchash > $G/source-hash.after
cmp -s $G/source-hash.before $G/source-hash.after && echo equal > $G/source-hash.match || echo DIFFERENT > $G/source-hash.match
date -u +%FT%TZ > $G/finished_at

node --input-type=module - "$G" > $G/manifest.json <<'EOF'
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const [G] = process.argv.slice(2);
const read = (f) => readFileSync(`${G}/${f}`, "utf8").trim();
const version = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const checks = JSON.parse(read("checks.json"));
console.log(JSON.stringify({ started_at: read("started_at"), finished_at: read("finished_at"),
  versions: { claude: version("claude --version"), codex: version("codex --version"), node: process.version, docker: version("docker --version") },
  config_sha256: checks.config_sha256, proof_tasks: checks.smoke.map((s) => ({ alias: s.alias, task: s.task, model: s.model, created_at: s.created_at })),
  exits: { build: read("build.exit"), tsc: read("tsc.exit"), suite: read("suite.exit"), checks: read("checks.exit") },
  source_hash: { before: read("source-hash.before"), after: read("source-hash.after"), match: read("source-hash.match") },
  suite_tap_sha256: read("suite.tap.sha256") }, null, 2));
EOF

C=$G/checks.json
field() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$C','utf8')).$1))"; }
{
  echo "build=$(cat $G/build.exit) tsc=$(cat $G/tsc.exit) suite=$(cat $G/suite.exit)"
  grep -E '^# (tests|pass|fail|cancelled|skipped|todo)' $G/suite.tap
  echo "show_ok=$(field show_ok) new_roots=$(field new_roots) unexpected_roots=[$(field unexpected_roots)] changed_baseline_roots=[$(field changed_baseline_roots)]"
  echo "routing_invariants_ok=$(field routing_ok)"
  echo "smoke_proofs_ok=$(field smoke_ok) ($(node -e "const c=JSON.parse(require('fs').readFileSync('$C','utf8'));process.stdout.write(c.smoke.filter(s=>s.ok).length+'/'+c.smoke.length)"))"
  echo "residues=$(cat $G/residues.before)->$(cat $G/residues.after)"
  echo "source-hash=$(cat $G/source-hash.after) match=$(cat $G/source-hash.match)"
  pass=true
  [[ $(cat $G/build.exit) == 0 && $(cat $G/tsc.exit) == 0 && $(cat $G/suite.exit) == 0 && $(cat $G/checks.exit) == 0 ]] || pass=false
  grep -q '^# fail 0$' $G/suite.tap || pass=false
  [[ $(field show_ok) == true && $(field routing_ok) == true && $(field smoke_ok) == true ]] || pass=false
  [[ $(cat $G/residues.before) == $(cat $G/residues.after) && $(cat $G/source-hash.match) == equal ]] || pass=false
  $pass && echo "GATE: PASS" || echo "GATE: FAIL"
} > $G/summary.txt
cat $G/summary.txt
