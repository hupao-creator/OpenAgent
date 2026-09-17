export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.catch(() => undefined).then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  drain(): Promise<void> {
    return this.tail
  }
}
