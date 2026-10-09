import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../core/src/server.js";

await startServer({ projectRoot: process.env.CLAUDE_PROJECT_DIR, cloneRoot: fileURLToPath(new URL("../..", import.meta.url)), homeDir: homedir() });
