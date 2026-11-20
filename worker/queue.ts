export class Queue {
  private tail = Promise.resolve();

  run(task: () => Promise<void>) {
    this.tail = this.tail.then(task).catch(catchError('queue'));
  }
}

export function catchError(context: string) {
  return (error: unknown) => {
    console.error(`[${new Date().toISOString()}] Error in ${context}:`, error);
  };
}

export const queue = new Queue();
