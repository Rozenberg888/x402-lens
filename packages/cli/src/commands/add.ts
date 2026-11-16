/**
 * `x402-lens add` — put x402 protection on an existing Express route.
 *
 * Scaffolders create new projects; this edits the file you already have. The
 * approach is deliberately conservative: it only recognises the two route forms
 * it can rewrite safely, refuses anything else with a clear explanation, and
 * never writes without `--write`. A bad regex edit on someone's server file is
 * far worse than a refusal.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

export class AddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddError";
  }
}

export interface AddOptions {
  file: string;
  /** Route as written by the user, e.g. `"GET /weather"`. */
  route: string;
  price: string;
  /** Apply the change. When false, only the diff is produced. */
  write?: boolean;
}

export interface AddResult {
  changed: boolean;
  diff: string;
  text: string;
  exitCode: number;
}

const IMPORT_LINE = 'import { paymentLens } from "@x402-lens/express";';
const LENS_DECLARATION = "const lens = paymentLens();";
const MOUNT_LINE = "app.use(lens.middleware);";

/**
 * Insert payment protection into an existing Express server file.
 *
 * Idempotent: running it twice leaves the file unchanged the second time.
 *
 * @param options - Target file, route, and price
 * @returns Diff, report, and exit code
 * @throws {AddError} When the file is not a supported Express setup
 */
export async function addProtection(options: AddOptions): Promise<AddResult> {
  const { file, route, price } = options;

  if (basename(file).match(/\.(ts|js|mjs|cjs)$/) === null) {
    throw new AddError(
      `${file} is not a JavaScript or TypeScript file. This command edits source files, not compiled output.`,
    );
  }

  const original = await readFile(file, "utf8");
  const parsed = parseRoute(route);

  const hasLens = original.includes("paymentLens(");
  const hasRouteEntry = hasRouteEntryFor(original, parsed);

  if (hasLens && hasRouteEntry) {
    return {
      changed: false,
      diff: "",
      text: `${file} already charges for ${parsed.method} ${parsed.path}. Nothing to do.`,
      exitCode: 0,
    };
  }

  const framework = detectFramework(original);
  if (framework !== "express") {
    throw new AddError(
      `${file} does not look like an Express app (${framework}). The add command only supports Express; use paymentLens() from @x402-lens/express manually for anything else.`,
    );
  }

  const routePattern = findRouteDeclaration(original, parsed);
  if (!routePattern) {
    throw new AddError(
      `Could not find a route declaration for "${parsed.method} ${parsed.path}" in ${file}. The add command recognises app.get("/path", ...) and router.post("/path", ...) forms written on one line. Add the middleware manually:\n\n  const lens = paymentLens({ routes: { "${parsed.method} ${parsed.path}": "${price}" } });\n  app.use(lens.middleware);\n`,
    );
  }

  const updated = hasLens
    ? withRouteEntry(original, file, parsed, price)
    : applyEdits(original, parsed, price, routePattern);
  const diff = unifiedDiff(file, original, updated);

  if (!options.write) {
    return {
      changed: true,
      diff,
      text: [
        `Dry run — ${file} would change as follows.`,
        "",
        diff,
        "",
        "Re-run with --write to apply. Set X402_FACILITATOR_URL, X402_NETWORK, and X402_PAY_TO first; paymentLens() refuses to guess them.",
      ].join("\n"),
      exitCode: 0,
    };
  }

  await writeFile(file, updated, "utf8");
  return {
    changed: true,
    diff,
    text: `Updated ${file}.\n\n${diff}\n\nNext: set X402_FACILITATOR_URL, X402_NETWORK, and X402_PAY_TO, then restart. Run \`x402-lens doctor\` to verify the configuration.`,
    exitCode: 0,
  };
}

interface ParsedRoute {
  method: string;
  path: string;
}

function parseRoute(route: string): ParsedRoute {
  const trimmed = route.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { method: "GET", path: trimmed };
  }
  return {
    method: trimmed.slice(0, spaceIndex).toUpperCase(),
    path: trimmed.slice(spaceIndex + 1).trim(),
  };
}

/** `"GET /weather"`, the key format the lens route map uses. */
function routeKey(route: ParsedRoute): string {
  return `${route.method} ${route.path}`;
}

/**
 * Index of the `}` that closes the `{` at `open`, skipping strings and comments.
 *
 * A brace counter alone would trip over a route path containing `}` or a
 * comment mentioning `{`, so the scan respects quoting and both comment styles.
 *
 * @returns Index of the closing brace, or -1 when the source is unbalanced
 */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) return -1;
      index = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return -1;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
      if (index === -1) return -1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index just past the closing quote, or -1 when the literal never closes. */
function skipString(source: string, open: number): number {
  const quote = source[open];
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/** The span of the `paymentLens(...)` argument list, when the file has one. */
function findLensCall(source: string): { open: number; close: number } | undefined {
  const pattern = /\bpaymentLens(?:Async)?\s*\(/;
  const match = pattern.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("(", match.index);
  const close = matchParen(source, open);
  if (close === -1) return undefined;
  return { open, close };
}

/** Index of the `)` closing the `(` at `open`, skipping strings and comments. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) return -1;
      index = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return -1;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
      if (index === -1) return -1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Locate the `routes: { ... }` object literal inside a `paymentLens` call. */
function findRoutesObject(source: string): { open: number; close: number } | undefined {
  const call = findLensCall(source);
  const scope = call ?? { open: 0, close: source.length - 1 };
  const inner = source.slice(scope.open, scope.close + 1);
  const pattern = /\broutes\s*:\s*\{/;
  const match = pattern.exec(inner);
  if (!match) return undefined;
  const open = scope.open + match.index + match[0].length - 1;
  const close = matchBrace(source, open);
  if (close === -1) return undefined;
  return { open, close };
}

/** True when the lens route map already charges for this route. */
function hasRouteEntryFor(source: string, route: ParsedRoute): boolean {
  const key = escapeRegExp(routeKey(route));
  const quotedKey = new RegExp(`["'\`]${key}["'\`]\\s*:`);
  const routes = findRoutesObject(source);
  if (routes) return quotedKey.test(source.slice(routes.open, routes.close + 1));
  // No routes map in code: the prices come from env or x402.config.json, so a
  // mention of the path elsewhere says nothing about whether it is priced.
  return false;
}

/**
 * Add one entry to the lens route map, preserving the file's own formatting.
 *
 * Refuses the forms it cannot rewrite safely — an array-form `routes`, or a
 * `paymentLens()` call carrying options the command does not understand — with
 * instructions instead of a guess.
 */
function withRouteEntry(
  source: string,
  file: string,
  route: ParsedRoute,
  price: string,
): string {
  if (/\broutes\s*:\s*\[/.test(source)) {
    throw new AddError(
      `${file} passes routes as an array, which x402-lens add does not rewrite. Add the entry by hand:\n\n  { route: "${routeKey(route)}", price: "${price}" }\n`,
    );
  }

  const routes = findRoutesObject(source);
  if (!routes) {
    throw new AddError(
      `paymentLens is already called, but its routes map could not be found, so x402-lens add will not guess where to put ${routeKey(route)}. Add it by hand:\n\n  routes: { "${routeKey(route)}": "${price}" }\n`,
    );
  }

  const entry = `"${routeKey(route)}": "${price}"`;
  const inner = source.slice(routes.open + 1, routes.close);

  // Insert after the last entry, keeping the closing brace on its own line when
  // the object already spans several.
  const trailing = inner.match(/\s*$/)?.[0] ?? "";
  const insertAt = routes.close - trailing.length;
  const lastEntry = source.slice(routes.open + 1, insertAt);

  if (lastEntry.trim().length === 0) {
    return `${source.slice(0, routes.open + 1)} ${entry} ${source.slice(routes.close)}`;
  }

  // Indentation comes from the line the last entry starts on, never from the
  // insertion point — which sits just before the closing brace's newline.
  const entryEnd = routes.open + 1 + lastEntry.length;
  const lineStart = source.lastIndexOf("\n", entryEnd - 1) + 1;
  const indent = source.slice(lineStart, entryEnd).match(/^[ \t]*/)?.[0] ?? "";
  const spacer = trailing.includes("\n") ? "\n" : " ";
  // Follow whatever comma style the file already uses: a trailing comma on the
  // last entry means the author wants one on every entry.
  const trailingComma = lastEntry.trimEnd().endsWith(",");
  const inserted = trailingComma ? `${entry},` : entry;
  const separator = trailingComma ? "" : ",";

  return `${source.slice(0, insertAt)}${separator}${spacer}${indent}${inserted}${source.slice(insertAt)}`;
}

type Framework = "express" | "fastify" | "hono" | "fastapi" | "unknown";

function detectFramework(source: string): Framework {
  if (/from\s+["']express["']|require\(\s*["']express["']\s*\)/.test(source)) return "express";
  if (/from\s+["']fastify["']|require\(\s*["']fastify["']\s*\)/.test(source)) return "fastify";
  if (/from\s+["']hono["']/.test(source)) return "hono";
  if (/from\s+fastapi\s+import|import\s+fastapi/.test(source)) return "fastapi";
  return "unknown";
}

interface RouteMatch {
  /** Index of the route declaration's start. */
  routeStart: number;
  /** The matched declaration text, for reporting. */
  matched: string;
}

/**
 * Find the route and where to insert the guard.
 *
 * Matches `app.get("/path",` and `router.get("/path",` — including single- or
 * double-quoted paths. Refuses multi-line and computed-path variants by simply
 * not matching them.
 */
function findRouteDeclaration(source: string, route: ParsedRoute): RouteMatch | undefined {
  const method = route.method.toLowerCase();
  const escapedPath = escapeRegExp(route.path);
  const pattern = new RegExp(
    `\\b(?:app|router|server)\\.${method}\\(\\s*(["'\`])${escapedPath}\\1\\s*,`,
  );
  const match = pattern.exec(source);
  if (!match) return undefined;
  return {
    routeStart: match.index,
    matched: match[0],
  };
}

function applyEdits(
  source: string,
  route: ParsedRoute,
  price: string,
  routeMatch: RouteMatch,
): string {
  let updated = source;

  // The lens is mounted globally and its route map decides what is protected,
  // so no per-route guard is needed. Adding one as well would duplicate the
  // check on the same request.
  if (!updated.includes("paymentLens(")) {
    // Normalise spacing rather than guess at it: exactly one blank line before
    // the declaration and one after the mount, whatever the file had. `\r?` so
    // a CRLF file is treated the same as an LF one.
    const before = `${updated
      .slice(0, routeMatch.routeStart)
      .replace(/(?:[ \t]*\r?\n)+$/, "")}\n\n`;
    const body = `${LENS_DECLARATION.replace(
      "paymentLens()",
      `paymentLens({ routes: { "${route.method} ${route.path}": "${price}" } })`,
    )}\n${MOUNT_LINE}\n\n`;
    updated = `${before}${body}${updated.slice(routeMatch.routeStart)}`;
  }

  // Add the import after the last top-level import.
  if (!updated.includes("@x402-lens/express")) {
    const lastImport = findLastImportEnd(updated);
    if (lastImport === -1) {
      updated = `${IMPORT_LINE}\n${updated}`;
    } else {
      updated = `${updated.slice(0, lastImport)}\n${IMPORT_LINE}${updated.slice(lastImport)}`;
    }
  }

  return updated;
}

function findLastImportEnd(source: string): number {
  const lines = source.split("\n");
  let offset = 0;
  let lastEnd = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    const isImportStart = trimmed.startsWith("import ");
    const isImportContinuation = lastEnd !== -1 && trimmed.length > 0 && !trimmed.startsWith("//");

    if (isImportStart) {
      // A one-liner import ends on its own line.
      if (/from\s+["'][^"']+["'];?$/.test(trimmed) || /^import\s+["'][^"']+["'];?$/.test(trimmed)) {
        lastEnd = offset + line.length;
      } else {
        // Multi-line import: remember the start and wait for the close.
        lastEnd = -2;
      }
    } else if (lastEnd === -2 && isImportContinuation && trimmed.endsWith(";")) {
      lastEnd = offset + line.length;
    }
    offset += line.length + 1;
  }

  return lastEnd > 0 ? lastEnd : -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Produce a unified diff with three lines of context.
 *
 * Only used for display, so it favours readability over exactness: it diffs by
 * line and emits a single hunk per changed region.
 *
 * @param file - Path shown in the diff header
 * @param before - Original contents
 * @param after - Updated contents
 * @returns Unified diff text
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const operations = diffLines(beforeLines, afterLines);

  const changedIndices = operations
    .map((op, index) => (op.type === "equal" ? -1 : index))
    .filter(index => index !== -1);

  if (changedIndices.length === 0) return "";

  const firstChanged = Math.max(0, (changedIndices[0] ?? 0) - 3);
  const lastChanged = Math.min(operations.length - 1, (changedIndices.at(-1) ?? 0) + 3);

  const header = [`--- a/${file}`, `+++ b/${file}`];
  let beforeCount = 0;
  let afterCount = 0;
  for (let index = firstChanged; index <= lastChanged; index += 1) {
    const op = operations[index];
    if (!op) continue;
    if (op.type !== "insert") beforeCount += 1;
    if (op.type !== "delete") afterCount += 1;
  }

  const body: string[] = [`@@ -${firstChanged + 1},${beforeCount} +${firstChanged + 1},${afterCount} @@`];
  for (let index = firstChanged; index <= lastChanged; index += 1) {
    const op = operations[index];
    if (!op) continue;
    if (op.type === "equal") body.push(` ${op.line}`);
    else if (op.type === "delete") body.push(`-${op.line}`);
    else body.push(`+${op.line}`);
  }

  return [...header, ...body].join("\n");
}

type LineOp =
  | { type: "equal"; line: string }
  | { type: "delete"; line: string }
  | { type: "insert"; line: string };

/**
 * Line diff via longest-common-subsequence. Quadratic, which is fine for source
 * files of a few thousand lines and keeps the command dependency-free.
 */
function diffLines(before: string[], after: string[]): LineOp[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      const nextRow = table[i + 1];
      if (!row || !nextRow) continue;
      row[j] =
        before[i] === after[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const operations: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      operations.push({ type: "equal", line: before[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    const nextRow = table[i + 1];
    const row = table[i];
    if (!nextRow || !row) break;
    if ((nextRow[j] ?? 0) >= (row[j + 1] ?? 0)) {
      operations.push({ type: "delete", line: before[i] as string });
      i += 1;
    } else {
      operations.push({ type: "insert", line: after[j] as string });
      j += 1;
    }
  }
  while (i < before.length) {
    operations.push({ type: "delete", line: before[i] as string });
    i += 1;
  }
  while (j < after.length) {
    operations.push({ type: "insert", line: after[j] as string });
    j += 1;
  }

  return operations;
}
