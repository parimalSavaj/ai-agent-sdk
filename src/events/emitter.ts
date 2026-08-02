/**
 * events/emitter.ts
 *
 * A typed EventEmitter class for subscribing to SDK lifecycle events.
 *
 * Convention:
 *   - `EventEmitter` is a class — it holds subscriber state and exposes
 *     on() / off() / emit() behavior.
 *   - `EventMap` is a type — a plain mapping of event name → payload shape.
 *
 * Two ways to observe a run:
 *
 *   1. Inline callback (simple, one-off):
 *      run(agent, input, { onEvent: (e) => console.log(e) })
 *
 *   2. EventEmitter (reusable, multi-subscriber):
 *      const emitter = new AgentEventEmitter();
 *      emitter.on("llm-call-start", (e) => logger.debug(e));
 *      emitter.on("tool-call-end",  (e) => metrics.record(e));
 *      run(agent, input, { emitter });
 */

import type { RunEvent } from "../core/runner.js";

// ── EventMap — maps each RunEvent type string to its full payload ─────────────

export type EventMap = {
  [K in RunEvent["type"]]: Extract<RunEvent, { type: K }>;
};

// ── EventEmitter class ────────────────────────────────────────────────────────

export class AgentEventEmitter {
  // Subscriber lists keyed by event type
  private readonly listeners = new Map<
    string,
    Set<(event: RunEvent) => void>
  >();

  /**
   * Subscribe to a specific event type.
   *
   * @example
   * ```ts
   * emitter.on("tool-call-end", (e) => {
   *   console.log(`${e.toolName} took ${e.durationMs}ms`);
   * });
   * ```
   */
  on<K extends RunEvent["type"]>(
    type: K,
    listener: (event: EventMap[K]) => void,
  ): this {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as (event: RunEvent) => void);
    return this;
  }

  /**
   * Unsubscribe a previously registered listener.
   */
  off<K extends RunEvent["type"]>(
    type: K,
    listener: (event: EventMap[K]) => void,
  ): this {
    this.listeners.get(type)?.delete(listener as (event: RunEvent) => void);
    return this;
  }

  /**
   * Subscribe to ALL event types with a single catch-all listener.
   * Useful for logging or debugging.
   *
   * @example
   * ```ts
   * emitter.onAny((e) => console.log("[agent]", e.type, e));
   * ```
   */
  onAny(listener: (event: RunEvent) => void): this {
    return this.on("*" as RunEvent["type"], listener);
  }

  /**
   * Remove a catch-all listener registered with onAny().
   */
  offAny(listener: (event: RunEvent) => void): this {
    return this.off("*" as RunEvent["type"], listener);
  }

  /**
   * Remove all listeners (optionally for a specific event type only).
   */
  clear(type?: RunEvent["type"]): this {
    if (type) {
      this.listeners.delete(type);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  /**
   * Emit an event to all matching listeners.
   * Called internally by the runner — not usually called by user code.
   */
  emit(event: RunEvent): void {
    // Fire type-specific listeners
    const specific = this.listeners.get(event.type);
    if (specific) {
      for (const fn of specific) fn(event);
    }
    // Fire catch-all listeners
    const catchAll = this.listeners.get("*");
    if (catchAll) {
      for (const fn of catchAll) fn(event);
    }
  }

  /**
   * Returns the number of listeners registered for a given type.
   * Useful for testing.
   */
  listenerCount(type: RunEvent["type"]): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
