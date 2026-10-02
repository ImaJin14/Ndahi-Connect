import { AsyncLocalStorage } from "node:async_hooks";

// Request and operation IDs for the current async call chain (OBS-002). `requestId`
// identifies one HTTP request; `correlationId` identifies the customer operation it
// belongs to, and is stored on payments and queued jobs so later work can resume it.
const storage = new AsyncLocalStorage();

export const correlation = () => storage.getStore() || {};

// Runs fn with the given IDs; IDs that are omitted or empty are inherited.
export function withCorrelation(ids, fn) {
  const next = { ...correlation() };
  for (const [key, value] of Object.entries(ids)) if (value) next[key] = value;
  return storage.run(next, fn);
}

export const validCorrelationId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : undefined;

// Sent only to NDAHI's own network bridge, which logs the same ID on its side.
export const correlationHeaders = () => {
  const { correlationId } = correlation();
  return correlationId ? { "x-correlation-id": correlationId } : {};
};
