/**
 * thread.ts
 *
 * Conversation memory — Thread, ThreadStore, and createThread().
 *
 * Convention:
 *   - `ThreadStore` is an interface — the contract for any storage backend.
 *     The in-memory implementation ships here; Redis/Postgres etc. can be
 *     added later without touching any agent or runner code.
 *   - `Thread` is a class — it holds the message history for one conversation
 *     and exposes methods to append and read messages.
 *   - `InMemoryThreadStore` is a class — implements ThreadStore using a Map.
 *
 * Design:
 *   Each Thread has a unique id. The runner reads existing messages from the
 *   thread before calling the model, then appends new messages after each
 *   turn. The system message (agent instructions) is NOT stored in the thread
 *   — it is prepended fresh on every run so changing an agent's instructions
 *   takes effect immediately without migrating stored history.
 *
 * Usage:
 *   ```ts
 *   const thread = createThread();
 *   await run(agent, "My name is Alex", { thread });
 *   const result = await run(agent, "What is my name?", { thread });
 *   // result.finalOutput → "Your name is Alex."
 *   ```
 */

import type { Message } from "./message.js";

// ── Thread class ──────────────────────────────────────────────────────────────

export class Thread {
  /** Unique identifier for this conversation */
  readonly id: string;
  /** ISO-8601 timestamp of when this thread was created */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the last message appended */
  updatedAt: string;

  private messages: Message[] = [];

  constructor(id?: string) {
    this.id = id ?? Thread.generateId();
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }

  // ── Message access ──────────────────────────────────────────────────────────

  /** Return a shallow copy of the message history (excludes system messages) */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Append one or more messages to the thread history.
   * System messages are intentionally excluded — the agent's instructions
   * are prepended by the runner on every call, not stored here.
   */
  addMessages(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === "system") continue; // never persist system messages
      this.messages.push(msg);
    }
    this.updatedAt = new Date().toISOString();
  }

  /** Clear all messages from this thread */
  clear(): void {
    this.messages = [];
    this.updatedAt = new Date().toISOString();
  }

  /** Total number of messages in the thread */
  get length(): number {
    return this.messages.length;
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  private static generateId(): string {
    // Simple random id — no external dependency needed
    return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ── ThreadStore interface ─────────────────────────────────────────────────────
// `interface` because this is a contract — different storage backends
// (in-memory, Redis, Postgres) implement it the same way.

export interface ThreadStore {
  /** Load a thread by id. Returns undefined if not found. */
  get(threadId: string): Promise<Thread | undefined>;
  /** Persist a thread (create or update). */
  save(thread: Thread): Promise<void>;
  /** Delete a thread by id. */
  delete(threadId: string): Promise<void>;
  /** List all thread ids in this store. */
  list(): Promise<string[]>;
}

// ── InMemoryThreadStore class ─────────────────────────────────────────────────

export class InMemoryThreadStore implements ThreadStore {
  private readonly store = new Map<string, Thread>();

  async get(threadId: string): Promise<Thread | undefined> {
    return this.store.get(threadId);
  }

  async save(thread: Thread): Promise<void> {
    this.store.set(thread.id, thread);
  }

  async delete(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()];
  }

  /** Number of threads currently stored */
  get size(): number {
    return this.store.size;
  }
}

// ── Default global store ──────────────────────────────────────────────────────
// Threads created with createThread() are registered here automatically,
// so they can be looked up by id from anywhere in the same process without
// the user needing to manage a store instance.

const defaultStore = new InMemoryThreadStore();

// ── createThread() ────────────────────────────────────────────────────────────

/**
 * Create a new Thread and register it in the default in-memory store.
 *
 * @example
 * ```ts
 * const thread = createThread();
 * await run(agent, "My name is Alex", { thread });
 * const result = await run(agent, "What is my name?", { thread });
 * console.log(result.finalOutput); // "Your name is Alex."
 * ```
 */
export function createThread(id?: string): Thread {
  const thread = new Thread(id);
  defaultStore.save(thread);
  return thread;
}

/**
 * Retrieve the default in-memory store.
 * Useful for listing or deleting threads in tests or management scripts.
 */
export function getDefaultStore(): InMemoryThreadStore {
  return defaultStore;
}
