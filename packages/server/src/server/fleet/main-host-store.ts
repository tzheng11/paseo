import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAIN_HOST_MAX_GENERATION,
  MainHostApplyInputSchema,
  MainHostChoiceSchema,
  MainHostSetInputSchema,
  MainHostStateSchema,
  serializeMainHostAllocation,
  type MainHostAllocation,
  type MainHostApplyInput,
  type MainHostChoice,
  type MainHostProvenance,
  type MainHostSetInput,
  type MainHostState,
} from "@getpaseo/protocol/fleet/main-host";

const FleetFileSchema = z.strictObject({
  version: z.literal(1),
  state: MainHostStateSchema,
  requests: z.record(z.string(), MainHostStateSchema),
  allocations: z.array(MainHostChoiceSchema),
  allocatorPins: z.record(z.string(), z.string()),
});
type FleetFile = z.infer<typeof FleetFileSchema>;

export type MainHostRefusalCode =
  | "stale_generation"
  | "generation_exhausted"
  | "allocation_conflict"
  | "allocator_unverified"
  | "invalid_receipt"
  | "confirmation_required"
  | "move_required"
  | "fleet_busy";

export class MainHostRefusal extends Error {
  constructor(
    public readonly code: MainHostRefusalCode,
    public readonly current: MainHostState,
  ) {
    super(`Main host change refused: ${code}. The previous setting is unchanged.`);
    this.name = "MainHostRefusal";
  }
}

export interface MainHostStoreOptions {
  paseoHome: string;
  serverId: string;
  hasDotsDatabase?: () => boolean;
}

export class MainHostStore {
  private readonly filePath: string;
  private readonly keyPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private file: FleetFile = {
    version: 1,
    state: { choice: null, held: false, delivery: null },
    requests: {},
    allocations: [],
    allocatorPins: {},
  };
  private privateKey = "";
  private publicKey = "";

  constructor(private readonly options: MainHostStoreOptions) {
    this.filePath = path.join(options.paseoHome, "fleet.json");
    this.keyPath = path.join(options.paseoHome, "fleet-allocator-key.pem");
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.paseoHome, { recursive: true });
    // Initialization runs once at boot, under this home's supervisor lock. The previous
    // worker has ended, so its transaction lock is abandoned even if its PID was reused
    // (including a container restart) or now belongs to an inaccessible process.
    await rm(`${this.filePath}.lock`, { force: true });
    await this.exclusive(async () => {
      this.file = await this.read();
      try {
        this.privateKey = await readFile(this.keyPath, "utf8");
        await chmod(this.keyPath, 0o600);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (
          this.file.allocations.some((choice) => choice.allocatorServerId === this.options.serverId)
        ) {
          throw new Error(
            "The Main-host allocator key is missing. Restore it before allocating again.",
            { cause: error },
          );
        }
        const key = generateKeyPairSync("ed25519");
        this.privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        await replaceDurably(this.keyPath, this.privateKey);
      }
      const privateKey = createPrivateKey(this.privateKey);
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid allocator key");
      this.publicKey = createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString();
    });
  }

  snapshot(): MainHostState {
    return structuredClone(this.file.state);
  }

  allocator(): { serverId: string; publicKey: string } {
    return { serverId: this.options.serverId, publicKey: this.publicKey };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async set(input: MainHostSetInput, provenance: MainHostProvenance): Promise<MainHostState> {
    const request = MainHostSetInputSchema.parse(input);
    return this.transaction(async (file) => {
      const priorResult = Object.hasOwn(file.requests, request.requestId)
        ? file.requests[request.requestId]
        : undefined;
      if (priorResult) return { file, state: priorResult };
      this.refuseWhenDatabaseExists(file.state);
      const generation = file.state.choice?.generation ?? 0;
      if (request.expectedGeneration !== generation) this.refuse("stale_generation", file.state);
      if (generation === MAIN_HOST_MAX_GENERATION) this.refuse("generation_exhausted", file.state);
      const previous = file.state.choice;
      const allocation: MainHostAllocation = {
        allocationId: randomUUID(),
        allocatorServerId: this.options.serverId,
        requestId: request.requestId,
        mainHost: request.mainHost,
        generation: generation + 1,
        previousMainHost: previous?.mainHost ?? null,
        undoOf:
          previous && request.mainHost === previous.previousMainHost ? previous.allocationId : null,
        setAt: new Date().toISOString(),
        setBy: provenance,
      };
      const receipt = sign(
        null,
        Buffer.from(serializeMainHostAllocation(allocation)),
        this.privateKey,
      ).toString("base64");
      const choice: MainHostChoice = { ...allocation, receipt };
      const state: MainHostState = { choice, held: true, delivery: null };
      return {
        file: {
          ...file,
          state,
          requests: { ...file.requests, [request.requestId]: state },
          allocations: [...file.allocations, choice],
        },
        state,
      };
    });
  }

  async apply(input: MainHostApplyInput, provenance: MainHostProvenance): Promise<MainHostState> {
    const request = MainHostApplyInputSchema.parse(input);
    const choice = request.choice;
    return this.transaction(async (file) => {
      const priorResult = Object.hasOwn(file.requests, request.requestId)
        ? file.requests[request.requestId]
        : undefined;
      if (priorResult) return { file, state: priorResult };
      const key = this.verifyChoice({ file, request, provenance });
      this.refuseWhenDatabaseExists(file.state);
      const current = file.state.choice;
      const generation = current?.generation ?? 0;
      const same = current?.allocationId === choice.allocationId;
      if (same && JSON.stringify(current) !== JSON.stringify(choice))
        this.refuse("invalid_receipt", file.state);
      if (!same && choice.generation <= generation) this.refuse("allocation_conflict", file.state);
      if (request.expectedLocalGeneration !== generation)
        this.refuse("stale_generation", file.state);
      const confirmation = request.confirmation;
      if (
        confirmation &&
        (confirmation.allocationId !== choice.allocationId || !isOwnerApp(provenance))
      ) {
        this.refuse("confirmation_required", file.state);
      }
      let delivery = same ? file.state.delivery : null;
      if (confirmation)
        delivery = {
          allocationId: choice.allocationId,
          confirmedAt: new Date().toISOString(),
          confirmedBy: provenance,
        };
      const state: MainHostState = {
        choice,
        held: !confirmation && (!same || file.state.held),
        delivery,
      };
      return {
        file: {
          ...file,
          state,
          requests: { ...file.requests, [request.requestId]: state },
          allocations: same ? file.allocations : [...file.allocations, choice],
          allocatorPins: { ...file.allocatorPins, [choice.allocatorServerId]: key },
        },
        state,
      };
    });
  }

  private verifyChoice(input: {
    file: FleetFile;
    request: MainHostApplyInput;
    provenance: MainHostProvenance;
  }): string {
    const { file, request, provenance } = input;
    const { choice, allocatorPublicKey } = request;
    let pinned: string | undefined = file.allocatorPins[choice.allocatorServerId];
    if (!Object.hasOwn(file.allocatorPins, choice.allocatorServerId)) pinned = undefined;
    if (choice.allocatorServerId === this.options.serverId) pinned = this.publicKey;
    if (allocatorPublicKey && !isOwnerApp(provenance))
      this.refuse("allocator_unverified", file.state);
    if (pinned && allocatorPublicKey && pinned !== allocatorPublicKey)
      this.refuse("allocator_unverified", file.state);
    const key = pinned ?? (isOwnerApp(provenance) ? allocatorPublicKey : undefined);
    if (!key) this.refuse("allocator_unverified", file.state);
    let valid = false;
    try {
      const publicKey = createPublicKey(key);
      valid =
        publicKey.asymmetricKeyType === "ed25519" &&
        verify(
          null,
          Buffer.from(serializeMainHostAllocation(choice)),
          publicKey,
          Buffer.from(choice.receipt, "base64"),
        );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.refuse("invalid_receipt", file.state);
    }
    if (!valid) this.refuse("invalid_receipt", file.state);
    return key;
  }

  private refuseWhenDatabaseExists(state: MainHostState): void {
    if (this.options.hasDotsDatabase?.()) this.refuse("move_required", state);
  }

  private refuse(code: MainHostRefusalCode, state: MainHostState): never {
    throw new MainHostRefusal(code, structuredClone(state));
  }

  private async read(): Promise<FleetFile> {
    try {
      return FleetFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        version: 1,
        state: { choice: null, held: false, delivery: null },
        requests: {},
        allocations: [],
        allocatorPins: {},
      };
    }
  }

  private transaction(
    update: (file: FleetFile) => Promise<{ file: FleetFile; state: MainHostState }>,
  ): Promise<MainHostState> {
    return this.exclusive(async () => {
      const before = await this.read();
      const result = await update(before);
      if (result.file !== before) await replaceDurably(this.filePath, JSON.stringify(result.file));
      this.file = result.file;
      if (result.file !== before) for (const listener of this.listeners) listener();
      return structuredClone(result.state);
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const lockPath = `${this.filePath}.lock`;
      const candidate = `${lockPath}.${process.pid}.${randomUUID()}`;
      await replaceDurably(candidate, String(process.pid));
      try {
        await link(candidate, lockPath);
      } catch (error) {
        if (isFileExists(error)) this.refuse("fleet_busy", this.snapshot());
        throw error;
      } finally {
        await rm(candidate, { force: true });
      }
      try {
        return await operation();
      } finally {
        await rm(lockPath);
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isOwnerApp(provenance: MainHostProvenance): boolean {
  return (
    provenance.principalId === "owner" &&
    (provenance.clientType === "browser" || provenance.clientType === "mobile")
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function replaceDurably(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, filePath);
    // Windows cannot flush a directory opened for reading; file data is already synced.
    if (process.platform === "win32") return;
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
