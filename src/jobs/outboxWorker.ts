import { eventDispatcher } from "../services/eventDispatcher.service";

const POLL_INTERVAL_MS = 10_000;

let intervalHandle: NodeJS.Timeout | null = null;
let isProcessing = false;

async function tick(): Promise<void> {
  // Skip overlapping ticks: a batch could take longer than the poll
  // interval, and running two at once risks fetching the same pending
  // rows twice before either has updated their status.
  if (isProcessing) {
    return;
  }

  isProcessing = true;
  try {
    await eventDispatcher.processPendingEvents();
  } catch (err) {
    console.error("[OutboxWorker] Unexpected error while processing events:", err);
  } finally {
    isProcessing = false;
  }
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[OutboxWorker] Received ${signal}, shutting down`);
  stopOutboxWorker();
  process.exit(0);
}

export function startOutboxWorker(): void {
  if (intervalHandle) {
    return;
  }

  console.log(`[OutboxWorker] Starting, polling every ${POLL_INTERVAL_MS / 1000}s`);
  intervalHandle = setInterval(() => void tick(), POLL_INTERVAL_MS);

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  void tick();
}

export function stopOutboxWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[OutboxWorker] Stopped");
  }
}
