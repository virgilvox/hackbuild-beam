/**
 * A typed event emitter, zero dependencies.
 *
 * The SDK has to be usable from a plain page with no build step, so it cannot lean
 * on a framework's reactivity to publish what the link is doing. This is the whole
 * of what it needs: subscribe, unsubscribe, emit, with the payload type keyed off
 * the event name so a listener for "position" can never be handed a log line.
 *
 * One behavior is deliberate rather than incidental. Emit walks a snapshot of the
 * listener set and contains what a listener throws, because these listeners are not
 * peers: a UI listener that throws while re-rendering must not stop the safety
 * listener behind it from seeing the same event. A swallowed throw is a silent
 * failure, which is worse than the crash it replaced, so it goes to an optional sink
 * rather than nowhere.
 */

export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

/** A listener whose payload type has been erased so unrelated events can share a map. */
type StoredListener = (value: never) => void;

export class Emitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<StoredListener>>();
  private readonly onListenerError: ((err: unknown, key: keyof E) => void) | null;

  constructor(onListenerError?: (err: unknown, key: keyof E) => void) {
    this.onListenerError = onListenerError ?? null;
  }

  on<K extends keyof E>(key: K, fn: Listener<E[K]>): Unsubscribe {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set<StoredListener>();
      this.listeners.set(key, set);
    }
    set.add(fn as StoredListener);
    return () => {
      this.off(key, fn);
    };
  }

  /** Subscribe for exactly one event. The listener is removed before it runs. */
  once<K extends keyof E>(key: K, fn: Listener<E[K]>): Unsubscribe {
    let off: Unsubscribe | null = null;
    const wrapped: Listener<E[K]> = (value) => {
      off?.();
      fn(value);
    };
    off = this.on(key, wrapped);
    return off;
  }

  off<K extends keyof E>(key: K, fn: Listener<E[K]>): void {
    const set = this.listeners.get(key);
    if (!set) return;
    set.delete(fn as StoredListener);
    if (set.size === 0) this.listeners.delete(key);
  }

  emit<K extends keyof E>(key: K, value: E[K]): void {
    const set = this.listeners.get(key);
    if (!set || set.size === 0) return;
    /* A snapshot, so a listener may unsubscribe itself or another without the
     * iteration skipping whoever moved into the freed slot. */
    for (const fn of [...set]) {
      try {
        (fn as unknown as Listener<E[K]>)(value);
      } catch (err) {
        this.onListenerError?.(err, key);
      }
    }
  }

  listenerCount(key: keyof E): number {
    return this.listeners.get(key)?.size ?? 0;
  }

  /** Drop every listener, or every listener for one event. */
  clear(key?: keyof E): void {
    if (key === undefined) this.listeners.clear();
    else this.listeners.delete(key);
  }
}
