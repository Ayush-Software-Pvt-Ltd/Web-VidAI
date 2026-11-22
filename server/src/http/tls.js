// The server's certificate (docs/SPEC.md section 2, HTTPS): self-signed by VidAI unless the admin
// put their own into `tls/`.
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generate } from "selfsigned";
import { AppError } from "../errors.js";
import { restrictToOwner } from "../platform/paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER_NAME = "VidAI Server";
/** Apple's browsers refuse longer validity (notBefore to notAfter). */
const VALID_DAYS = 825;
const RENEW_BEFORE_DAYS = 30;

/**
 * @typedef {object} CertificateInfo
 * @property {string[]} names DNS names and IP addresses the certificate is valid for.
 * @property {string} notBefore ISO time.
 * @property {string} notAfter ISO time.
 * @property {string} fingerprint SHA-256, colon separated hex.
 * @property {boolean} vidaiMade True when VidAI made it (subject `O=VidAI Server`, `CN=VidAI Server`).
 */

/**
 * Whether the subject is the one VidAI gives its own certificates.
 * @param {X509Certificate} cert
 */
function madeByVidai(cert) {
  const lines = cert.subject.split("\n").map((line) => line.trim());
  return lines.includes(`CN=${ISSUER_NAME}`) && lines.includes(`O=${ISSUER_NAME}`);
}

/**
 * The names of a certificate's subjectAltName, lower-cased (`DNS:` and `IP Address:` entries).
 * @param {X509Certificate} cert
 * @returns {string[]}
 */
function namesOf(cert) {
  return (cert.subjectAltName ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^(DNS|IP Address):/, "").toLowerCase());
}

/**
 * What the System page shows about a certificate.
 * @param {string} pem
 * @returns {CertificateInfo}
 */
export function certificateInfo(pem) {
  const cert = new X509Certificate(pem);
  return {
    names: namesOf(cert),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: new Date(cert.validTo).toISOString(),
    fingerprint: cert.fingerprint256,
    vidaiMade: madeByVidai(cert),
  };
}

/** @param {string} file */
function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Why a certificate of ours must be replaced, or null when it can stay.
 * @param {X509Certificate} cert
 * @param {string} keyPem
 * @param {string[]} wanted Lower-cased names and addresses it must cover.
 * @param {number} now
 * @returns {string | null}
 */
function replacementReason(cert, keyPem, wanted, now) {
  /** @type {boolean} */
  let matches;
  try {
    matches = cert.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    matches = false;
  }
  if (!matches) return "key-mismatch";
  const end = new Date(cert.validTo).getTime();
  if (end - now < RENEW_BEFORE_DAYS * DAY_MS) return "expiring";
  if (new Date(cert.validFrom).getTime() > now) return "not-yet-valid";
  const have = new Set(namesOf(cert));
  return wanted.every((name) => have.has(name)) ? null : "names-changed";
}

/**
 * Make the certificate files usable: create them when missing, keep them when fine, replace ours
 * when they are near their end or lack a current name or address. A certificate VidAI did not make
 * (recognised by its subject) is used as it is and never touched.
 * @param {object} options
 * @param {string} options.dir The `tls/` directory (created when missing).
 * @param {string[]} options.hostnames Host names to cover (`localhost` is always added).
 * @param {string[]} options.addresses IPv4 addresses to cover (`127.0.0.1` is always added).
 * @param {number} [options.now] Milliseconds since the epoch (tests inject it).
 * @returns {Promise<{ key: string, cert: string, action: "created" | "reused" | "replaced" | "foreign", reason: string | null }>}
 */
export async function ensureCertificate({ dir, hostnames, addresses, now = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  restrictToOwner(dir);
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  const dnsNames = [...new Set(["localhost", ...hostnames].map((name) => name.toLowerCase()))];
  const ips = [...new Set(["127.0.0.1", ...addresses])];

  const certPem = readIfExists(certFile);
  const keyPem = readIfExists(keyFile);
  /** @type {string | null} */
  let reason = null;

  if (certPem !== null) {
    /** @type {X509Certificate} */
    let cert;
    try {
      cert = new X509Certificate(certPem);
    } catch (error) {
      // We cannot tell whose it is, so we do not overwrite it.
      throw new AppError(
        "io",
        `The certificate ${certFile} cannot be read. Delete it to let VidAI make a new one.`,
        { cause: error },
      );
    }
    if (!madeByVidai(cert)) {
      if (keyPem === null) {
        throw new AppError(
          "io",
          `The certificate ${certFile} has no key file ${keyFile} next to it.`,
        );
      }
      return { key: keyPem, cert: certPem, action: "foreign", reason: null };
    }
    if (keyPem !== null) {
      reason = replacementReason(
        cert,
        keyPem,
        [...dnsNames, ...ips].map((n) => n.toLowerCase()),
        now,
      );
      if (reason === null) return { key: keyPem, cert: certPem, action: "reused", reason: null };
    } else {
      reason = "key-missing";
    }
  }

  const notBeforeDate = new Date(now - DAY_MS);
  const notAfterDate = new Date(notBeforeDate.getTime() + VALID_DAYS * DAY_MS);
  const made = await generate(
    [
      { name: "commonName", value: ISSUER_NAME },
      { name: "organizationName", value: ISSUER_NAME },
    ],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            ...dnsNames.map((value) => /** @type {const} */ ({ type: 2, value })),
            ...ips.map((ip) => /** @type {const} */ ({ type: 7, ip })),
          ],
        },
      ],
    },
  );
  // Key first: a crash in between leaves a mismatch, which the next start replaces.
  fs.writeFileSync(keyFile, made.private, { mode: 0o600 });
  restrictToOwner(keyFile);
  fs.writeFileSync(certFile, made.cert);
  return {
    key: made.private,
    cert: made.cert,
    action: certPem === null ? "created" : "replaced",
    reason,
  };
}
