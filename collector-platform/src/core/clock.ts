/**
 * 时钟抽象：生产用系统时钟；测试用虚拟时钟，让接管超时可确定性离线复现。
 */

export interface Clock {
  nowMs(): number;
  /** 周期定时器（调度器 tick / 心跳） */
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    return setInterval(fn, ms);
  }
  clearInterval(handle: ReturnType<typeof setInterval>): void {
    clearInterval(handle);
  }
}

/** 测试时钟：时间只在 advance 时前进，定时器随推进同步触发，无需真实等待 */
export class VirtualClock implements Clock {
  private current = 0;
  private seq = 0;
  private readonly timers = new Map<
    number,
    { fn: () => void; period: number; nextAt: number }
  >();

  nowMs(): number {
    return this.current;
  }

  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = (this.seq += 1);
    this.timers.set(id, { fn, period: ms, nextAt: this.current + ms });
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.timers.delete(handle as unknown as number);
  }

  /** 前进到目标时刻，按到期顺序触发期间的定时器（可重复触发） */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    // 最多触发轮次保护，避免周期为 0 之类的死循环
    let guard = 0;
    while (guard < 10000) {
      guard += 1;
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.timers) {
        if (t.nextAt <= target && t.nextAt < nextAt) {
          nextAt = t.nextAt;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.current = timer.nextAt;
      timer.nextAt += timer.period;
      // 回调可能是异步的，让出微任务队列让其落盘后再推进
      await Promise.resolve();
      timer.fn();
      await Promise.resolve();
    }
    this.current = target;
  }

  /** 直接设置绝对时间（不触发定时器，用于构造心跳过期场景） */
  setNow(ms: number): void {
    this.current = ms;
  }

  /** 清空全部定时器（测试间隔离） */
  reset(): void {
    this.timers.clear();
    this.current = 0;
  }
}
