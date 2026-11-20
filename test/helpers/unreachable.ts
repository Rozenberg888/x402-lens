/**
 * A port that is provably closed right now.
 *
 * Several tests need a facilitator URL that refuses connections, to exercise the
 * "facilitator is unreachable" path. They used a hardcoded port, which is not a
 * guarantee: the OS hands out ephemeral ports from a wide range, and nothing
 * stops a parallel test file — or another process on the machine — from binding
 * it between two runs. When that happened the connect succeeded, the lens took a
 * completely different branch, and the test failed for a reason unrelated to
 * what it was checking.
 *
 * Asking the OS for a free port and immediately releasing it is not a perfect
 * guarantee either — there is a window between release and use — but it shrinks
 * the collision to something that will not happen in practice, and it is far
 * better than naming a constant and hoping.
 */

import { createServer } from "node:net";

/**
 * Reserve a port, note it, and release it.
 *
 * @returns A port number that was free a moment ago
 */
export async function closedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not obtain a port")));
        return;
      }
      const { port } = address;
      probe.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * A URL on a port that refuses connections.
 *
 * @returns `http://127.0.0.1:<closed port>`
 */
export async function unreachableUrl(): Promise<string> {
  return `http://127.0.0.1:${await closedPort()}`;
}
