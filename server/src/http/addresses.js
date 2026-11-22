// The names and addresses this computer can be reached at (docs/SPEC.md section 2).
import os from "node:os";

/**
 * Host names and non-internal IPv4 addresses of this computer.
 * @param {{ hostname?: string, interfaces?: ReturnType<typeof os.networkInterfaces> }} [source]
 * @returns {{ hostname: string, hostnames: string[], addresses: string[] }}
 */
export function localIdentity({
  hostname = os.hostname(),
  interfaces = os.networkInterfaces(),
} = {}) {
  const name = hostname.toLowerCase();
  const bare = name.replace(/\.local$/, "");
  const addresses = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return { hostname: name, hostnames: [...new Set([name, `${bare}.local`])], addresses };
}

const WILDCARDS = new Set(["0.0.0.0", "::", "[::]", ""]);
const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The URLs to print once the server listens. A wildcard host lists the host name, every network
 * address and localhost; a specific host lists only itself (plus localhost when it is loopback).
 * @param {{ port: number, host: string, identity?: ReturnType<typeof localIdentity> }} options
 * @returns {string[]}
 */
export function listAddresses({ port, host, identity = localIdentity() }) {
  const url = (/** @type {string} */ name) =>
    `https://${name.includes(":") ? `[${name}]` : name}:${port}`;
  if (WILDCARDS.has(host)) {
    return [identity.hostname, ...identity.addresses, "localhost"].map(url);
  }
  return [...new Set([host, ...(LOOPBACKS.has(host) ? ["localhost"] : [])])].map(url);
}
