/** Detected thinking levels one model should expose. */
export type ReasoningEfforts = Record<string, string> | false

/** One capability record read from an endpoint's model listing. */
export interface Capability {
  /** Level names the endpoint publishes, in endpoint order. */
  efforts: string[]
  /** Whether the endpoint says thinking can be turned off. */
  canDisable: boolean
  /** The endpoint's explicit reasoning flag, when it states one. */
  supports?: boolean
  /** One pinned effort, present when the endpoint publishes no selectable set. */
  fixedEffort?: string
}

/** Resolved plugin options. */
export interface Options {
  entryId: string
  routes: string[]
  intervalMs: number
  startDelayMs: number
  timeoutMs: number
  includeOff: boolean
  /** Expose a pinned effort as the single level when no set is published. */
  fixedEffortAsLevel: boolean
  log: boolean
  /** Path of the status document; `''` uses the harness home, `false` disables it. */
  statusFile: string | false
}

/** One model correction a sweep would make. */
export interface Change {
  id: string
  from: unknown
  to: ReasoningEfforts | null
}

/** A writer that merges one patch into the status document. */
export type StatusWriter = (patch: Record<string, unknown>) => void

/** Every thinking level the pi-ai adapter can name, in escalation order. */
export declare const LEVELS: readonly string[]
export declare const name: 'api-thinking'
export declare const inject: readonly ['configEditor']

export declare function normalizeConfig(config?: unknown): Options
export declare function createStatus(rawConfig: unknown): StatusWriter
export declare function defaultStatusFile(): string
export declare function readCapability(entry: unknown): Capability | undefined
export declare function decideEfforts(
  capability: Capability | undefined,
  options?: { includeOff?: boolean; fixedEffortAsLevel?: boolean },
): ReasoningEfforts | null | undefined
export declare function sameEfforts(declared: unknown, decided: unknown): boolean
export declare function readListing(body: unknown): Array<{ id: string; raw: Record<string, unknown> }>
export declare function unusableLevels(capability: Capability | undefined): string[]
export declare function planModels(
  models: unknown[],
  listing: Array<{ id: string; raw: Record<string, unknown> }>,
  options?: { includeOff?: boolean },
): { models: unknown[]; changes: Change[]; dropped: string[] }
export declare function planPatchEdits(
  lines: string[],
  desired: Map<string, ReasoningEfforts | null>,
  options?: { entryId?: string },
): { lines: string[]; changed: boolean }
export declare function writePatchFile(
  path: string,
  desired: Map<string, ReasoningEfforts | null>,
  options?: { entryId?: string },
): { changed: boolean }
export declare function apply(ctx: unknown, config?: unknown): void
