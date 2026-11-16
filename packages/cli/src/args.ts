/**
 * Minimal argv parsing.
 *
 * The CLI has five commands and a handful of flags; a dependency would be more
 * code to audit than the parser itself.
 */

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

/**
 * Split argv into a command, positionals, and flags.
 *
 * Supports `--key value`, `--key=value`, and boolean `--flag`. A `--flag` that
 * is followed by another flag or by nothing is treated as boolean.
 *
 * @param argv - Arguments after the executable and script path
 * @returns Parsed structure
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token.startsWith("--")) {
      const withoutDashes = token.slice(2);
      if (withoutDashes.length === 0) continue;

      const equalsIndex = withoutDashes.indexOf("=");
      if (equalsIndex !== -1) {
        flags[withoutDashes.slice(0, equalsIndex)] = withoutDashes.slice(equalsIndex + 1);
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[withoutDashes] = next;
        index += 1;
      } else {
        flags[withoutDashes] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // Short aliases: -h, -v.
      flags[token.slice(1)] = true;
      continue;
    }

    if (command === undefined) {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags };
}

/** Read a flag as a string, or `undefined` when absent or boolean. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Read a flag as a boolean. Any presence counts, including `--flag=false`. */
export function flagEnabled(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}
