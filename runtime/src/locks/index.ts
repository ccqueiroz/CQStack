import type {
  ApiContract,
  ArtifactReference,
  ContractChange,
  LockDescriptor,
  ReviewResult,
} from "../contracts.js";
import { Storage, hash, id } from "../storage.js";
import { validate } from "../validation/index.js";
export class LockService {
  constructor(
    readonly storage: Storage,
    readonly authorizeMutation: () => void = () => {},
    readonly validateReview: (
      review: ReviewResult,
      subjectTask: string,
      subjectHash: string
    ) => void = (review) => {
      validate("review-result", review);
    }
  ) {}
  private key(ref: { id: string; version: string }): string {
    return id(ref.id) + "-" + hash(ref.version);
  }
  put(contract: ApiContract): ArtifactReference {
    this.authorizeMutation();
    validate("api-contract", contract);
    const ref = {
      id: contract.contract_id,
      version: contract.version,
      content_hash: hash(contract),
    };
    this.storage.create(["contracts", this.key(ref) + ".json"], contract);
    return ref;
  }
  get(ref: { id: string; version: string }): {
    contract: ApiContract;
    lock: LockDescriptor | null;
  } {
    const contract = this.storage.read<ApiContract>(
      "contracts",
      this.key(ref) + ".json"
    );
    validate("api-contract", contract);
    const lock = this.storage.exists("contracts", this.key(ref) + ".lock.json")
      ? this.storage.read<LockDescriptor>(
          "contracts",
          this.key(ref) + ".lock.json"
        )
      : null;
    if (lock) {
      validate("lock-descriptor", lock);
      if (hash(contract) !== lock.content_hash)
        throw new Error("CONTRACT_HASH_MISMATCH");
      const source = "contracts/" + this.key(ref) + ".json";
      if (
        lock.contract_id !== contract.contract_id ||
        lock.task_id !== contract.task_id ||
        lock.version !== contract.version ||
        lock.source_artifact !== source ||
        lock.backend_reviewer === lock.frontend_reviewer
      )
        throw new Error("CONTRACT_LOCK_MISMATCH");
    }
    return { contract, lock };
  }
  lock(
    ref: ArtifactReference,
    backend: ReviewResult,
    frontend: ReviewResult,
    actor: string
  ): LockDescriptor {
    this.authorizeMutation();
    return this.storage.exclusive("contract-" + this.key(ref), () => {
      const { contract, lock } = this.get(ref);
      if (lock) throw new Error("CONTRACT_ALREADY_LOCKED");
      if (hash(contract) !== ref.content_hash)
        throw new Error("CONTRACT_HASH_MISMATCH");
      for (const [review, role] of [
        [backend, "api-contract-backend-reviewer"],
        [frontend, "api-contract-frontend-reviewer"],
      ] as const) {
        validate("review-result", review);
        if (
          review.role !== role ||
          review.verdict !== "approved" ||
          review.task_id !== contract.task_id ||
          review.subject_hash !== ref.content_hash ||
          review.reviewer === actor ||
          !review.evidence.length
        )
          throw new Error("INVALID_CONTRACT_REVIEW");
        this.validateReview(review, contract.task_id, ref.content_hash);
      }
      if (backend.reviewer === frontend.reviewer)
        throw new Error("INDEPENDENT_REVIEW_REQUIRED");
      const descriptor: LockDescriptor = {
        contract_id: contract.contract_id,
        task_id: contract.task_id,
        version: contract.version,
        status: "locked",
        content_hash: ref.content_hash,
        approved_timestamp: new Date().toISOString(),
        backend_reviewer: backend.reviewer,
        frontend_reviewer: frontend.reviewer,
        source_artifact: "contracts/" + this.key(ref) + ".json",
      };
      validate("lock-descriptor", descriptor);
      this.storage.create(
        ["contracts", this.key(ref) + ".lock.json"],
        descriptor
      );
      return descriptor;
    });
  }
  require(ref: ArtifactReference): void {
    const { lock } = this.get(ref);
    if (!lock || lock.content_hash !== ref.content_hash)
      throw new Error("API_CONTRACT_LOCK_REQUIRED");
  }
  request(change: ContractChange): ContractChange {
    this.authorizeMutation();
    validate("contract-change", change);
    this.require(change.current_contract);
    this.storage.create(
      ["contract-changes", id(change.request_id) + ".json"],
      change
    );
    return change;
  }
  // Phase 1 only consumes explicitly user-approved immutable visual artifacts; no approval UI.
  putVisual(
    value: unknown,
    userApproval: { actor: string; approved: boolean }
  ): unknown {
    this.authorizeMutation();
    const visual = validate<Record<string, any>>("visual-lock", value);
    if (!userApproval.approved || visual.approval.actor !== userApproval.actor)
      throw new Error("VISUAL_USER_APPROVAL_REQUIRED");
    const { content_hash, ...content } = visual;
    if (hash(content) !== content_hash) throw new Error("VISUAL_HASH_MISMATCH");
    this.storage.create(
      [
        "visual",
        this.key({ id: visual.lock_id, version: visual.version }) + ".json",
      ],
      visual
    );
    return visual;
  }
  visual(ref: ArtifactReference): unknown {
    const visual = this.storage.read<Record<string, any>>(
      "visual",
      this.key(ref) + ".json"
    );
    validate("visual-lock", visual);
    const { content_hash, ...content } = visual;
    if (hash(content) !== content_hash || content_hash !== ref.content_hash)
      throw new Error("VISUAL_HASH_MISMATCH");
    return visual;
  }
}
