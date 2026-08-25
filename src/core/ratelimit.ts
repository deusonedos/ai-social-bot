import { env } from '../config/env.js';

/**
 * Скользящее окно в памяти. Для одного инстанса этого достаточно;
 * при горизонтальном масштабировании заменяется на Redis — интерфейс тот же.
 */
class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

const perUser = new SlidingWindow(env.MAX_REQUESTS_PER_USER_PER_MIN, 60_000);
const perChat = new SlidingWindow(env.MAX_REQUESTS_PER_CHAT_PER_MIN, 60_000);

setInterval(() => {
  perUser.sweep();
  perChat.sweep();
}, 60_000).unref();

export type RateLimitResult = { ok: true } | { ok: false; reason: 'user' | 'chat' };

export function checkRateLimit(userId: string, conversationKey: string): RateLimitResult {
  if (!perUser.check(userId)) return { ok: false, reason: 'user' };
  if (!perChat.check(conversationKey)) return { ok: false, reason: 'chat' };
  return { ok: true };
}
