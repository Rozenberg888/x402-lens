/**
 * Per-request context carried through the async call chain.
 *
 * The official middleware builds its own `HTTPTransportContext`, so hooks only
 * receive a path and method — not the request id or the start time. An
 * AsyncLocalStorage store gives hooks the full picture without reaching into
 * private fields of the SDK's adapter, and without keying state on a route that
 * may have many concurrent requests.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** What we know at the moment a request enters our middleware. */
export interface RequestContext {
  requestId: string;
  startedAt: number;
  method: string;
  path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` bound to the current async chain. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context for the request currently being handled, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
