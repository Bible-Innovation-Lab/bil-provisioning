// Minimal in-memory KvClient fake honoring SET NX EX + PERSIST semantics
// for unit tests. Not for production use — single-process only, no
// concurrency safety beyond JS's single-threaded event loop.

import type { KvClient } from "../lib/kv.js";

interface Entry {
  value: unknown;
  expiresAt: number | null; // ms epoch; null = no TTL
}

export class FakeKv implements KvClient {
  private store = new Map<string, Entry>();
  private now: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.now = nowFn;
  }

  private expired(entry: Entry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.now();
  }

  private read(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.expired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: true }
  ): Promise<"OK" | null> {
    if (opts?.nx === true && this.read(key)) return null;
    const expiresAt = opts?.ex !== undefined ? this.now() + opts.ex * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.read(key);
    return entry ? (entry.value as T) : null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.read(key)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async persist(key: string): Promise<0 | 1> {
    const entry = this.read(key);
    if (!entry || entry.expiresAt === null) return 0;
    entry.expiresAt = null;
    return 1;
  }

  // Test-only introspection.
  _ttlMs(key: string): number | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return null;
    return entry.expiresAt - this.now();
  }
}
