import test from "node:test";
import assert from "node:assert/strict";
import type { ProcessRequest, ProcessResult } from "../src/contracts.js";
import { DockerExecutor, dockerClientEnv, type ExecutionRequest } from "../src/execution/sandbox.js";

const run: ExecutionRequest = { task_id: "t", implementation_unit: "u", worktree: "/tmp/worktree", command: "node", args: ["--test", "tests/pagination.test.mjs"], cwd: "/tmp/worktree", timeout_ms: 1000, env: { LANG: "C" }, mode: "ISOLATED_WRITE_TEST" };
function executor(result: Partial<ProcessResult> | Error, environment: NodeJS.ProcessEnv) {
  const seen: ProcessRequest[] = [];
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    seen.push(request);
    if (result instanceof Error) throw result;
    return { exit_code: 0, stdout: "", stderr: "", signal: null, ...result };
  };
  return { seen, docker: new DockerExecutor(runner, environment) };
}

test("Docker client environment forwards an explicit DOCKER_HOST and never invents a personal socket", () => {
  assert.deepEqual(dockerClientEnv({ PATH: "/bin", DOCKER_HOST: "unix:///run/custom.sock", SECRET_TOKEN: "x" }), { PATH: "/bin", LANG: "C", DOCKER_HOST: "unix:///run/custom.sock" });
  const unset = dockerClientEnv({ PATH: "/bin", HOME: "/home/operator" });
  assert.equal(unset.DOCKER_HOST, undefined, "without DOCKER_HOST the docker CLI resolves its own context or the platform default");
  assert.equal(unset.HOME, "/home/operator", "HOME lets the docker CLI find the current context");
});

test("Docker executor passes the resolved client environment and keeps the container isolation flags", async () => {
  const { seen, docker } = executor({ exit_code: 0 }, { PATH: "/bin", DOCKER_HOST: "tcp://127.0.0.1:2375" });
  const out = await docker.execute(run);
  assert.equal(seen[0].command, "docker");
  assert.equal(seen[0].env?.DOCKER_HOST, "tcp://127.0.0.1:2375");
  for (const flag of ["--network", "none", "--read-only", "/tmp/worktree:/work:rw"]) assert.ok(seen[0].args.includes(flag), flag);
  assert.deepEqual([out.executor, out.isolation_backend, out.network], ["container", "docker", "none"]);
});

test("an unavailable Docker daemon or CLI is a named executor failure, never an owned test result", async () => {
  const daemon = executor({ exit_code: 125, stderr: "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n" }, { PATH: "/bin" });
  await assert.rejects(daemon.docker.execute(run), /^Error: ISOLATED_EXECUTOR_UNAVAILABLE: docker run exited 125: docker: Cannot connect to the Docker daemon .* \(DOCKER_HOST not set; using the docker CLI context or platform default\)$/);
  const missing = executor(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }), { PATH: "/bin" });
  await assert.rejects(missing.docker.execute(run), /^Error: ISOLATED_EXECUTOR_UNAVAILABLE: spawn docker ENOENT$/);
  const failingTest = executor({ exit_code: 1, stderr: "not ok 1" }, { PATH: "/bin" });
  assert.equal((await failingTest.docker.execute(run)).exit_code, 1, "a failing owned test stays a test result");
  await assert.rejects(executor({}, {}).docker.execute({ ...run, mode: "HOST_READ_ONLY" }), /HOST_EXECUTOR_FORBIDDEN/);
});
