/**
 * Single-producer / single-consumer async queue backing the runner event
 * streams. Buffers when the producer outruns the consumer, which matters
 * because a tool-heavy turn can emit faster than Postgres writes land.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this.iterator();
  }

  iterator(): AsyncIterableIterator<T> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<T>> {
        const buffered = self.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (self.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => self.waiters.push(resolve));
      },
      return(): Promise<IteratorResult<T>> {
        self.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
