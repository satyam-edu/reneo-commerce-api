import { supabaseAdmin } from "../lib/supabase";

const BATCH_SIZE = 10;
const MAX_RETRIES = 5;

interface OutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  retry_count: number;
}

export class EventDispatcherService {
  async processPendingEvents(): Promise<void> {
    const { data: events, error } = await supabaseAdmin
      .from("events")
      .select("id, type, payload, retry_count")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error("[EventDispatcher] Failed to fetch pending events:", error.message);
      return;
    }

    await Promise.all((events ?? []).map((event) => this.dispatch(event as OutboxEvent)));
  }

  private async dispatch(event: OutboxEvent): Promise<void> {
    try {
      await this.deliver(event);

      const { error } = await supabaseAdmin
        .from("events")
        .update({ status: "sent", processed_at: new Date().toISOString() })
        .eq("id", event.id);

      if (error) {
        console.error(`[EventDispatcher] Failed to mark event ${event.id} as sent:`, error.message);
      }
    } catch (deliveryError) {
      await this.handleFailure(event, deliveryError);
    }
  }

  // Stand-in for a real channel (webhook POST, or a Supabase Realtime
  // `channel(...).send({ type: "broadcast", ... })` call). Whatever
  // replaces this body, the failure handling below is what matters: the
  // order this event describes was already committed independently of
  // delivery, so a delivery failure here can never lose or mutate it —
  // only delay the seller's notification.
  private async deliver(event: OutboxEvent): Promise<void> {
    if (event.type === "ORDER_CREATED") {
      console.log(`[EventDispatcher] Notifying seller(s) of order ${event.payload.order_id}`);
      return;
    }

    throw new Error(`Unknown event type: ${event.type}`);
  }

  private async handleFailure(event: OutboxEvent, deliveryError: unknown): Promise<void> {
    const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
    const nextRetryCount = event.retry_count + 1;
    const exhausted = nextRetryCount >= MAX_RETRIES;

    const { error } = await supabaseAdmin
      .from("events")
      // Stays 'pending' until retries are exhausted, so the next poll
      // picks it back up; only 'failed' once MAX_RETRIES is hit.
      .update({
        status: exhausted ? "failed" : "pending",
        retry_count: nextRetryCount,
        last_error: message,
      })
      .eq("id", event.id);

    if (error) {
      console.error(`[EventDispatcher] Failed to record failure for event ${event.id}:`, error.message);
    }
  }
}

export const eventDispatcher = new EventDispatcherService();
