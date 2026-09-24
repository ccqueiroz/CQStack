import { runProcess } from "../processes/run.js";
import type { ProcessResult, ProcessRunner } from "../contracts.js";

export type ExecutionMode = "HOST_READ_ONLY" | "ISOLATED_WRITE_TEST";
export interface ExecutionRequest { task_id:string; implementation_unit:string; worktree:string; command:string; args:string[]; cwd:string; timeout_ms:number; env:Record<string,string>; mode:ExecutionMode; }
export interface ExecutionResult extends ProcessResult { executor:string; isolation_backend:string; network:"none"|"host"; worktree_mount:string; child_processes:"contained"|"host"; }
export interface ExecutionSandbox { execute(request:ExecutionRequest):Promise<ExecutionResult>; }

export class HostExecutor implements ExecutionSandbox {
  async execute(r:ExecutionRequest):Promise<ExecutionResult> {
    const out=await runProcess({command:r.command,args:r.args,cwd:r.cwd,stdin:"",timeout_ms:r.timeout_ms,env:r.env});
    return {...out,executor:"host",isolation_backend:"none",network:"host",worktree_mount:r.worktree,child_processes:"host"};
  }
}

// Only what the docker CLI needs to resolve the operator's daemon: an explicit DOCKER_HOST,
// or its own context/config under HOME, falling back to the platform default socket.
const DOCKER_CLIENT_ENV=["DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG","DOCKER_CERT_PATH","DOCKER_TLS_VERIFY","HOME"];
export function dockerClientEnv(environment:NodeJS.ProcessEnv=process.env):Record<string,string> {
  return {PATH:environment.PATH??"",LANG:"C",...Object.fromEntries(DOCKER_CLIENT_ENV.flatMap(name=>environment[name]?[[name,environment[name]!]]:[]))};
}
export class DockerExecutor implements ExecutionSandbox {
  constructor(private readonly runner:ProcessRunner=runProcess,private readonly environment:NodeJS.ProcessEnv=process.env) {}
  async execute(r:ExecutionRequest):Promise<ExecutionResult> {
    if(r.mode!=="ISOLATED_WRITE_TEST") throw new Error("HOST_EXECUTOR_FORBIDDEN");
    const dockerEnv=dockerClientEnv(this.environment);
    const envArgs=Object.entries(r.env).flatMap(([k,v])=>["-e",`${k}=${v}`]);
    const out=await this.runner({command:"docker",args:["run","--rm","--network","none","--read-only","--tmpfs","/tmp:rw,noexec,nosuid,size=64m","--pids-limit","128","--memory","512m","--cpus","1","--user","1000:1000","-v",`${r.worktree}:/work:rw`,"-w","/work",...envArgs,"node:22-bookworm","node","--experimental-permission","--allow-child-process","--allow-fs-read=/work","--allow-fs-write=/work",...r.args],cwd:r.cwd,stdin:"",timeout_ms:r.timeout_ms,env:dockerEnv}).catch((error)=>{throw new Error(`ISOLATED_EXECUTOR_UNAVAILABLE: ${error instanceof Error?error.message:"docker failed"}`)});
    // docker run reserves 125 for its own failures (daemon unreachable, image, flags): never a test result.
    if(out.exit_code===125) throw new Error(`ISOLATED_EXECUTOR_UNAVAILABLE: docker run exited 125: ${out.stderr.trim().split("\n")[0]??""}${dockerEnv.DOCKER_HOST?"":" (DOCKER_HOST not set; using the docker CLI context or platform default)"}`);
    return {...out,executor:"container",isolation_backend:"docker",network:"none",worktree_mount:"/work",child_processes:"contained"};
  }
}

export function configuredExecutor():ExecutionSandbox { return new DockerExecutor(); }
