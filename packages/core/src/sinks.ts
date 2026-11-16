/**
 * Event sinks: where observability data actually goes.
 *
 * Three sinks, because there are three real deployment shapes: a developer
 * reading a terminal, an operator grepping a file, and a production service
 * shipping to an APM. The `onEvent` callback covers the third without forcing
 * an OpenTelemetry dependency on anyone who does not want one.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LensEvent } from "./events.js";
import { formatEventLine } from "./format.js";

/** Anything that can receive events. */
export interface LensSink {
  /** Sink name, used in error messages. */
  readonly name: string;
  /** Called for every event. Must not throw — errors are caught by the bus. */
  write(event: LensEvent): void | Promise<void>;
  /** Flush and release resources. */
  close?(): void | Promise<void>;
}

/** Prints a compact line per event to `console.log` / `console.error`. */
export function consoleSink(
  logger: Pick<Console, "log" | "error"> = console,
): LensSink {
  return {
    name: "console",
    write(event) {
      const line = formatEventLine(event);
      if (event.type === "payment.failed" || event.type === "payment.settle_failed") {
        logger.error(line);
        return;
      }
      logger.log(line);
    },
  };
}

/**
 * Appends newline-delimited JSON to a file.
 *
 * Writes are serialised through an internal promise chain so concurrent
 * requests cannot interleave partial lines.
 */
export function jsonlFileSink(path: string): LensSink {
  let chain: Promise<void> = Promise.resolve();
  let directoryReady: Promise<void> | undefined;

  const ensureDirectory = (): Promise<void> => {
    directoryReady ??= mkdir(dirname(path), { recursive: true }).then(() => undefined);
    return directoryReady;
  };

  return {
    name: `jsonl:${path}`,
    write(event) {
      const line = `${JSON.stringify(event)}\n`;
      chain = chain
        .then(ensureDirectory)
        .then(() => appendFile(path, line, "utf8"))
        .catch(() => undefined);
      return chain;
    },
    async close() {
      await chain;
    },
  };
}

/**
 * Forwards events to a user callback, e.g. an OpenTelemetry span or a Sentry
 * breadcrumb. Exceptions from the callback are swallowed so a broken exporter
 * cannot break a payment.
 */
export function callbackSink(callback: (event: LensEvent) => void): LensSink {
  return {
    name: "callback",
    write(event) {
      callback(event);
    },
  };
}

/**
 * Fan-out. A failing sink never prevents the others from receiving the event,
 * and never propagates into the payment path.
 */
export class EventBus {
  private readonly sinks: LensSink[];
  private readonly onSinkError: ((error: unknown, sink: LensSink) => void) | undefined;
  private closed = false;

  constructor(
    sinks: LensSink[],
    onSinkError?: (error: unknown, sink: LensSink) => void,
  ) {
    this.sinks = [...sinks];
    this.onSinkError = onSinkError;
  }

  /** Register an additional sink at runtime. */
  add(sink: LensSink): void {
    this.sinks.push(sink);
  }

  /** Remove a previously added sink. No-op when it is not registered. */
  remove(sink: LensSink): void {
    const index = this.sinks.indexOf(sink);
    if (index !== -1) this.sinks.splice(index, 1);
  }

  /** Emit to every sink. Never throws. */
  emit(event: LensEvent): void {
    if (this.closed) return;
    for (const sink of this.sinks) {
      try {
        const result = sink.write(event);
        if (result instanceof Promise) {
          result.catch(error => this.reportSinkError(error, sink));
        }
      } catch (error) {
        this.reportSinkError(error, sink);
      }
    }
  }

  /** Flush every sink, then stop accepting events. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      this.sinks.map(async sink => {
        try {
          await sink.close?.();
        } catch (error) {
          this.reportSinkError(error, sink);
        }
      }),
    );
  }

  private reportSinkError(error: unknown, sink: LensSink): void {
    if (this.onSinkError) {
      this.onSinkError(error, sink);
      return;
    }
    console.error(`[x402-lens] sink "${sink.name}" failed:`, error);
  }
}
