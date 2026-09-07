import { AppError } from "./errors.js";
export class Singleflight {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key);
    if (prior) return prior as Promise<T>;
    const task = Promise.resolve()
      .then(work)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
export class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private limit: number,
    private queue: number,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queue)
        throw new AppError(503, "QUEUE_FULL");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
