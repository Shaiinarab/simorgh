// ── Ports — the only way phoenix-core touches the outside world ────────────────
//
// phoenix-core owns its decisions and *borrows* its capabilities. Every ambient
// runtime facility it needs — HTTP, hashing, time, ids, SQL, storage, the ledger —
// arrives through one of the interfaces below.
//
// That is the whole reason this module runs unchanged on Cloudflare Workers, on
// Node, and on Deno: nothing here imports `cloudflare:workers`, reads a global
// binding, or names a Workers-only type. Adding a capability means adding a port,
// never reaching for a global.
//
// The types are deliberately *structural* rather than nominal. `Response` satisfies
// `HttpLike`, `globalThis.fetch` satisfies `FetchLike`, and Cloudflare's
// `SqlStorage` satisfies `SqlPort` — so a host wires itself up without adapters.

/** What `SqlPort.exec` accepts as a binding and hands back as a column. */
export type SqlValue = string | number | null | ArrayBuffer;

/** One row, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

export interface SqlCursor<T extends SqlRow> {
  toArray(): T[];
  /** Rows changed by a write; `0` for a read. */
  readonly rowsWritten: number;
}

/**
 * The slice of a SQL database the engine uses.
 *
 * Narrower than Cloudflare's `SqlStorage` and than `node:sqlite` on purpose: three
 * members is the whole contract, and both satisfy it. That is what lets a unit test
 * pass a stub, the Workers host pass its Durable Object storage, and the Node host
 * pass `node:sqlite` without a single adapter.
 */
export interface SqlPort {
  exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** Anything with `get(name)`. A real `Headers` satisfies it. */
export interface HeaderAccessor {
  get(name: string): string | null;
}

/** The response shape the engine reads. A real `Response` satisfies it. */
export interface HttpLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  /**
   * Optional so a provider that ignores headers can use a minimal stub — but MCP
   * is session-oriented (`Mcp-Session-Id` arrives on the response), so the port has
   * to be able to see them. A real `Response.headers` satisfies this.
   */
  readonly headers?: HeaderAccessor;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Outbound HTTP. `globalThis.fetch` satisfies it everywhere the engine runs. */
export type FetchLike = (url: string, init?: HttpInit) => Promise<HttpLike>;

/**
 * Resolves a secret by name, e.g. `GROQ_API_KEY`.
 *
 * A function rather than a record so a host can hand over its own configuration
 * object without an index signature — no host is forced into a cast, and no host
 * can be handed one accidentally (the engine never *enumerates* secrets).
 */
export type SecretReader = (name: string) => string | undefined;

/** SHA-256 of the UTF-8 bytes of `value`. */
export type Sha256 = (value: string) => Promise<Uint8Array>;

/**
 * Every ambient capability the engine needs, injected once per process.
 *
 * `sha256` and `randomUUID` are ports rather than calls to a `crypto` global
 * because that global's *type* is declared by whichever runtime's type library
 * happens to be loaded — exactly the coupling this module exists to avoid.
 */
export interface PhoenixPorts {
  fetch: FetchLike;
  sha256: Sha256;
  randomUUID(): string;
  /** Epoch milliseconds. A port so cooldown and rate-limit behaviour is testable. */
  now(): number;
}

/**
 * An inference binding shaped like Cloudflare Workers AI.
 *
 * Optional everywhere it appears: it is the one capability with no portable
 * equivalent, so a non-Workers host simply leaves it out and the providers that
 * need it report themselves unavailable.
 */
export interface WorkersAiPort {
  /**
   * The third argument is **additive and optional**: Cloudflare's Auto Router
   * (`cloudflare/auto`, ADR-0006) needs an AI Gateway id threaded through, and
   * widening the port this way means every existing host binding — Cloudflare's
   * `env.AI` and every test stub — still satisfies the port with no change.
   * Extending additively rather than replacing the signature is why this was the
   * right call: the port has three known implementors, and a breaking change to
   * serve one new provider would have taxed all of them for one bird's need.
   */
  run(
    model: string,
    input: { messages: { role: string; content: string }[] },
    options?: WorkersAiRunOptions
  ): Promise<unknown>;
}

/** Additive options for `WorkersAiPort.run`. See ADR-0006. */
export interface WorkersAiRunOptions {
  /** AI Gateway fronting the model pool; only `cloudflare/auto` consumes it today. */
  gateway?: { id: string };
}

// ── Storage ports ─────────────────────────────────────────────────────────────

/**
 * Offloaded request payloads, keyed by reference. Backed by KV on Cloudflare and
 * by anything the host likes elsewhere.
 */
export interface ContextStorePort {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

// ── Ledger ────────────────────────────────────────────────────────────────────

/** One transparency-ledger row, as it is written. */
export interface LedgerEntry {
  userId: string;
  tier: string;
  refId: string;
  timestamp: number;
  action?: string;
  details?: string;
}

/**
 * A ledger row as it is read back.
 *
 * A `type` alias rather than an `interface` so it keeps an implicit index
 * signature: `SqlPort.exec<T>` restricts T to `SqlRow`, and interfaces do not get
 * one. The same rule applies to every row type in this package.
 */
export type LedgerRow = {
  id: number;
  user_id: string;
  tier: string;
  ref_id: string | null;
  timestamp: number;
  action: string | null;
  details: string | null;
};

export interface UserLogs {
  userId: string;
  entries: LedgerRow[];
  count: number;
}

/** The Data Trust transparency ledger. Append-only by contract. */
export interface LedgerPort {
  logEntry(entry: LedgerEntry): Promise<{ logged: boolean }>;
  getUserLogs(userId: string): Promise<UserLogs>;
  /**
   * The row that owns `refId`, or `null` if no row carries it.
   *
   * `ref_id` is the only durable link between an offloaded context and the principal
   * that created it, so this is what lets a host answer "may this caller read this
   * context?" without trusting the caller's claim to the reference. It is a read on an
   * append-only table: the answer can never change for a given `refId`, because no row
   * is ever updated and a `refId` is a fresh UUID per request.
   *
   * More than one row may share a `refId` — the request record and a later
   * `shield_block` row are written for the same request — and every one of them carries
   * the same `user_id`, so the caller of this method does not have to care which row
   * comes back.
   */
  findByRef(refId: string): Promise<LedgerRow | null>;
}
