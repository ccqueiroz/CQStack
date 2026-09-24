import { spawn } from "node:child_process";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../contracts.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

class ProcessExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProcessExecutionError";
    this.code = code;
  }
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }
  // Keep the host alive until escalation has reached the process group, even
  // when its leader exits and descendants have closed all inherited stdio.
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }, 250);
}

export const runProcess: ProcessRunner = (
  request: ProcessRequest
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new ProcessExecutionError("ABORTED", "process execution aborted"));
      return;
    }
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, request.timeout_ms);
    timer.unref();
    const abort = () => terminate(child);
    request.signal?.addEventListener("abort", abort, { once: true });
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
      return current + chunk.subarray(0, remaining).toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      reject(
        new ProcessExecutionError(
          error.code ?? "SPAWN_FAILED",
          `failed to start ${request.command}`
        )
      );
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (timedOut) {
        reject(
          new ProcessExecutionError("TIMEOUT", "process execution timed out")
        );
        return;
      }
      if (request.signal?.aborted) {
        reject(
          new ProcessExecutionError("ABORTED", "process execution aborted")
        );
        return;
      }
      resolve({ exit_code: exitCode, stdout, stderr, signal });
    });
    child.stdin?.on("error", () => {
      /* close races are reported by the process */
    });
    child.stdin?.end(request.stdin);
  });
