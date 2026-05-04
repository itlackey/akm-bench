export interface EventEnvelope {
  schemaVersion: 1;
  id: number;
  ts: string;
  eventType: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}
