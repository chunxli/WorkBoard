type Job = () => Promise<void>;
type QueueEntry = { key: string; job: Job; waitForPreviousRuns: boolean };

/**
 * Runs are keyed by repoId: at most one run per repo executes at a time (they share a single
 * git working directory, so concurrent runs on the same repo would corrupt each other's
 * checkout/branch state), but runs on different repos are free to execute in parallel, up to
 * an overall concurrency cap.
 */
export class JobQueue {
  private queue: QueueEntry[] = [];
  private activeKeys = new Set<string>();
  private globalRunning = 0;
  private exclusiveRunning = false;
  private readonly concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  enqueue(key: string, job: Job, waitForPreviousRuns = false) {
    this.queue.push({ key, job, waitForPreviousRuns });
    this.drain();
  }

  private drain() {
    if (this.exclusiveRunning || this.globalRunning >= this.concurrency) return;

    for (let index = 0; index < this.queue.length && this.globalRunning < this.concurrency; ) {
      const entry = this.queue[index];

      if (entry.waitForPreviousRuns) {
        // Do not let later jobs overtake this barrier or let it start before earlier blocked jobs.
        if (index > 0 || this.globalRunning > 0) return;
        this.queue.splice(index, 1);
        this.start(entry);
        return;
      }

      if (this.activeKeys.has(entry.key)) {
        index++;
        continue;
      }

      this.queue.splice(index, 1);
      this.start(entry);
    }
  }

  private start(entry: QueueEntry) {
    this.activeKeys.add(entry.key);
    this.globalRunning++;
    this.exclusiveRunning = entry.waitForPreviousRuns;
    entry
      .job()
      .catch((err) => console.error("[job-queue] job failed:", err))
      .finally(() => {
        this.globalRunning--;
        this.activeKeys.delete(entry.key);
        if (entry.waitForPreviousRuns) this.exclusiveRunning = false;
        this.drain();
      });
  }
}

// Singleton across Next.js dev-mode hot reloads.
const globalForQueue = globalThis as unknown as { copilotJobQueue?: JobQueue };

export const jobQueue =
  globalForQueue.copilotJobQueue ?? new JobQueue(Number(process.env.RUN_CONCURRENCY ?? 2));

globalForQueue.copilotJobQueue = jobQueue;

