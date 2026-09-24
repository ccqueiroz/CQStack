import { validate } from "../validation/index.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  TaskEvent,
  TaskRecord,
  TaskCapsule,
  TaskState,
} from "../contracts.js";
import { Storage, id } from "../storage.js";
import { assertTransition } from "../state/index.js";
export class EventStore {
  constructor(
    readonly storage: Storage,
    readonly authorizeMutation: () => void = () => {}
  ) {}
  list(task: string): TaskEvent[] {
    id(task);
    if (!this.storage.exists("events", task + ".jsonl")) return [];
    const text = readFileSync(
      this.storage.path("events", task + ".jsonl"),
      "utf8"
    );
    if (!text.endsWith("\n")) throw new Error("CORRUPT_EVENT_LOG");
    return text
      .trim()
      .split("\n")
      .map((line) => {
        const event = validate<TaskEvent>("task-event", JSON.parse(line));
        if (event.task_id !== task) throw new Error("EVENT_TASK_MISMATCH");
        return event;
      });
  }
  append(
    task: string,
    type: string,
    payload: Record<string, unknown>,
    actor = "cockpit",
    role = "master-orchestrator"
  ): TaskEvent {
    this.authorizeMutation();
    return this.storage.exclusive("events-" + id(task), () =>
      this.appendUnlocked(task, type, payload, actor, role)
    );
  }
  private appendUnlocked(
    task: string,
    type: string,
    payload: Record<string, unknown>,
    actor = "cockpit",
    role = "master-orchestrator"
  ): TaskEvent {
    const event: TaskEvent = {
      event_id: randomUUID(),
      task_id: task,
      timestamp: new Date().toISOString(),
      actor,
      role,
      event_type: type,
      payload,
    };
    validate("task-event", event);
    this.storage.append(["events", id(task) + ".jsonl"], event);
    return event;
  }
  create(capsule: TaskCapsule): TaskRecord {
    this.authorizeMutation();
    validate("task-capsule", capsule);
    return this.storage.exclusive("events-" + id(capsule.task_id), () => {
      if (this.list(capsule.task_id).length) throw new Error("TASK_EXISTS");
      this.appendUnlocked(capsule.task_id, "task.created", { capsule });
      return this.get(capsule.task_id);
    });
  }
  get(task: string): TaskRecord {
    const events = this.list(task);
    if (events[0]?.event_type !== "task.created")
      throw new Error("TASK_NOT_FOUND");
    let state: TaskState = "TASK_RECEIVED",
      revision = 0;
    for (const e of events) {
      if (e.event_type === "task.transitioned") {
        const next = e.payload.to as TaskState;
        assertTransition(state, next);
        state = next;
        revision++;
      }
    }
    return {
      capsule: events[0].payload.capsule as TaskCapsule,
      state,
      revision,
      updated_at: events.at(-1)!.timestamp,
    };
  }
  transition(
    task: string,
    to: TaskState,
    expectedRevision: number
  ): TaskRecord {
    this.authorizeMutation();
    return this.storage.exclusive("events-" + id(task), () => {
      const before = this.get(task);
      if (before.revision !== expectedRevision)
        throw new Error("STALE_TASK_REVISION");
      assertTransition(before.state, to);
      this.appendUnlocked(task, "task.transitioned", {
        from: before.state,
        to,
        revision: before.revision + 1,
      });
      return this.get(task);
    });
  }
}
