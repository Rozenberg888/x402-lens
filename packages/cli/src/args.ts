/**
 * Minimal argv parsing with an explicit flag schema.
 *
 * The CLI has six commands and a handful of flags; a dependency would be more
 * code to audit than the parser itself. But a parser cannot guess which flags
 * take a value, and the first version tried: it paired any `--flag` with the
 * next non-`--` token. That made `inspect --json https://api.example/x` parse as
 * `{ json: "https://api.example/x" }` with no positional at all — the documented
 * boolean silently ate the URL, and the command failed with "inspect requires a
 * URL". It also made `--write false` true, because presence was the test and
 * `"false"` is present.
 *
 * So the schema is declared. A flag absent from it is a usage error rather than
 * being ignored: `--timeoutt 5` should not silently fall back to the default.
 */

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "h",
  "once",
  "write",
  "alert-on-success",
  "v",
]);

/** Flags that require a value. */
const VALUE_FLAGS = new Set([
  "method",
  "header",
  "timeout",
  "state",
  "interval",
  "slack",
  "price",
  "file",
  "facilitator",
  "network",
  "networks",
  "tx",
  "rpc",
  "challenge",
  "payment",
  "verify",
  "settle",
]);

/**
 * Every flag this CLI understands.
 *
 * Exported so a test can assert that the usage text and the parser agree — the
 * previous version documented `--once` and then never read it, because nothing
 * connected the two.
 */
export const ALL_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
  /**
   * Arguments that cannot be interpreted.
   *
   * A command must refuse to run when this is non-empty. Collecting them instead
   * of throwing keeps `parseArgs` usable in a test without a try/catch, and lets
   * the caller print usage alongside the message.
   */
  errors: string[];
}

/**
 * Split argv into a command, positionals, and flags.
 *
 * Supports `--key value` for flags in {@link VALUE_FLAGS}, `--key=value` for the
 * same, and `--flag` for those in {@link BOOLEAN_FLAGS}.
 *
 * @param argv - Arguments after the executable and script path
 * @returns Parsed structure, plus any arguments that could not be interpreted
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    // `--` ends flag parsing: everything after is positional. Without this a
    // positional beginning with `-` is unrepresentable.
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const withoutDashes = token.slice(2);
      if (withoutDashes.length === 0) continue;

      const equalsIndex = withoutDashes.indexOf("=");
      const name = equalsIndex === -1 ? withoutDashes : withoutDashes.slice(0, equalsIndex);
      const inline = equalsIndex === -1 ? undefined : withoutDashes.slice(equalsIndex + 1);

      if (!ALL_FLAGS.has(name)) {
        errors.push(`Unknown flag "--${name}".`);
        continue;
      }

      if (BOOLEAN_FLAGS.has(name)) {
        if (inline !== undefined) {
          // `--json=false` is not supported: a boolean flag is on or off, and
          // accepting "false" is what made `--write false` write a file.
          errors.push(`--${name} takes no value (got "${inline}").`);
          continue;
        }
        // `--write false` is the same mistake in the space-separated spelling,
        // and it is the one people actually type. A bare `true`/`false` after a
        // boolean flag is almost certainly an attempt to set it, so it is
        // refused instead of being silently consumed as a positional.
        const following = argv[index + 1];
        if (following === "true" || following === "false") {
          errors.push(
            `--${name} takes no value; write --${name} to enable it and omit it to disable it (got "${following}").`,
          );
          index += 1;
          continue;
        }
        flags[name] = true;
        continue;
      }

      if (inline !== undefined) {
        flags[name] = inline;
        continue;
      }

      const next = argv[index + 1];
      if (next === undefined || next === "--" || next.startsWith("--")) {
        errors.push(`--${name} requires a value.`);
        continue;
      }
      flags[name] = next;
      index += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // Short aliases: -h, -v.
      const alias = token.slice(1);
      if (!BOOLEAN_FLAGS.has(alias)) {
        errors.push(`Unknown flag "-${alias}".`);
        continue;
      }
      flags[alias] = true;
      continue;
    }

    if (command === undefined) {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags, errors };
}

/** Read a flag as a string, or `undefined` when absent or boolean. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a flag as a boolean.
 *
 * A boolean flag is either present (true) or absent (false). `--flag=false` is
 * rejected by the parser rather than silently counting as enabled, which is the
 * behaviour that let `--write false` overwrite a file.
 */
export function flagEnabled(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}
