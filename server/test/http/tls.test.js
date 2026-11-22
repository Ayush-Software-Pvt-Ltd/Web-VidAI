import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { generate } from "selfsigned";
import { certificateInfo, ensureCertificate } from "../../src/http/tls.js";
import { tempDir } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

describe("ensureCertificate", () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = tempDir();
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** @param {string} name */
  function fresh(name) {
    const target = path.join(dir, name);
    return target;
  }

  test("creates the files, with names, addresses, a 825 day life and a private key", async () => {
    const tlsDir = fresh("create");
    const made = await ensureCertificate({
      dir: tlsDir,
      hostnames: ["Studio-Mac", "studio-mac.local"],
      addresses: ["192.168.1.20"],
      now: NOW,
    });
    assert.equal(made.action, "created");
    assert.equal(fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8"), made.cert);
    assert.equal(fs.readFileSync(path.join(tlsDir, "key.pem"), "utf8"), made.key);
    const info = certificateInfo(made.cert);
    assert.deepEqual(info.names.sort(), [
      "127.0.0.1",
      "192.168.1.20",
      "localhost",
      "studio-mac",
      "studio-mac.local",
    ]);
    assert.equal(info.vidaiMade, true);
    assert.match(info.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const days = (Date.parse(info.notAfter) - Date.parse(info.notBefore)) / DAY;
    assert.equal(days, 825);
    assert.ok(Date.parse(info.notBefore) <= NOW);
    assert.ok(Date.parse(info.notAfter) > NOW + 800 * DAY);
    const x509 = new X509Certificate(made.cert);
    assert.match(x509.subject, /O=VidAI Server/);
    assert.match(x509.subject, /CN=VidAI Server/);
    assert.equal(x509.ca, false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(tlsDir, "key.pem")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(tlsDir).mode & 0o777, 0o700);
    }
  });

  test("reuses a good certificate unchanged", async () => {
    const tlsDir = fresh("reuse");
    const args = { dir: tlsDir, hostnames: ["box"], addresses: ["10.0.0.5"], now: NOW };
    const first = await ensureCertificate(args);
    const second = await ensureCertificate({ ...args, now: NOW + 100 * DAY });
    assert.equal(second.action, "reused");
    assert.equal(second.cert, first.cert);
    assert.equal(second.key, first.key);
  });

  test("an address that is no longer in the certificate gets a replacement", async () => {
    const tlsDir = fresh("address");
    const first = await ensureCertificate({
      dir: tlsDir,
      hostnames: ["box"],
      addresses: ["10.0.0.5"],
      now: NOW,
    });
    const second = await ensureCertificate({
      dir: tlsDir,
      hostnames: ["box"],
      addresses: ["10.0.0.5", "10.0.0.9"],
      now: NOW,
    });
    assert.equal(second.action, "replaced");
    assert.equal(second.reason, "names-changed");
    assert.notEqual(second.cert, first.cert);
    assert.ok(certificateInfo(second.cert).names.includes("10.0.0.9"));
    assert.equal(fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8"), second.cert);
  });

  test("a new host name gets a replacement, a dropped address does not", async () => {
    const tlsDir = fresh("names");
    await ensureCertificate({ dir: tlsDir, hostnames: ["a"], addresses: ["10.0.0.5"], now: NOW });
    const fewer = await ensureCertificate({
      dir: tlsDir,
      hostnames: ["a"],
      addresses: [],
      now: NOW,
    });
    assert.equal(fewer.action, "reused");
    const more = await ensureCertificate({
      dir: tlsDir,
      hostnames: ["a", "b"],
      addresses: [],
      now: NOW,
    });
    assert.equal(more.action, "replaced");
  });

  test("a certificate within 30 days of its end is replaced, 31 days is not", async () => {
    const tlsDir = fresh("expiring");
    const args = { dir: tlsDir, hostnames: ["box"], addresses: [] };
    const first = await ensureCertificate({ ...args, now: NOW });
    const end = Date.parse(certificateInfo(first.cert).notAfter);
    const outside = await ensureCertificate({ ...args, now: end - 31 * DAY });
    assert.equal(outside.action, "reused");
    const inside = await ensureCertificate({ ...args, now: end - 29 * DAY });
    assert.equal(inside.action, "replaced");
    assert.equal(inside.reason, "expiring");
    assert.ok(Date.parse(certificateInfo(inside.cert).notAfter) > end);
  });

  test("an expired certificate is replaced", async () => {
    const tlsDir = fresh("expired");
    const args = { dir: tlsDir, hostnames: ["box"], addresses: [] };
    const first = await ensureCertificate({ ...args, now: NOW });
    const end = Date.parse(certificateInfo(first.cert).notAfter);
    const later = await ensureCertificate({ ...args, now: end + 10 * DAY });
    assert.equal(later.action, "replaced");
  });

  test("a key that does not belong to the certificate is replaced", async () => {
    const tlsDir = fresh("mismatch");
    const args = { dir: tlsDir, hostnames: ["box"], addresses: [] };
    await ensureCertificate({ ...args, now: NOW });
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(
      path.join(tlsDir, "key.pem"),
      stranger.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const again = await ensureCertificate({ ...args, now: NOW });
    assert.equal(again.action, "replaced");
    assert.equal(again.reason, "key-mismatch");
  });

  test("a missing key file of our certificate means a new pair", async () => {
    const tlsDir = fresh("nokey");
    const args = { dir: tlsDir, hostnames: ["box"], addresses: [] };
    await ensureCertificate({ ...args, now: NOW });
    fs.rmSync(path.join(tlsDir, "key.pem"));
    const again = await ensureCertificate({ ...args, now: NOW });
    assert.equal(again.action, "replaced");
    assert.ok(fs.existsSync(path.join(tlsDir, "key.pem")));
  });

  describe("a certificate VidAI did not make", () => {
    /** @type {{ cert: string, key: string }} */
    let foreign;
    before(async () => {
      const made = await generate([{ name: "commonName", value: "intranet.example.com" }], {
        keySize: 2048,
        algorithm: "sha256",
        notAfterDate: new Date(NOW + 5 * DAY),
        extensions: [
          { name: "subjectAltName", altNames: [{ type: 2, value: "intranet.example.com" }] },
        ],
      });
      foreign = { cert: made.cert, key: made.private };
    });

    test("is used as it is, even when expired soon and without our addresses", async () => {
      const tlsDir = fresh("foreign");
      fs.mkdirSync(tlsDir);
      fs.writeFileSync(path.join(tlsDir, "cert.pem"), foreign.cert);
      fs.writeFileSync(path.join(tlsDir, "key.pem"), foreign.key);
      const result = await ensureCertificate({
        dir: tlsDir,
        hostnames: ["box"],
        addresses: ["10.0.0.5"],
        now: NOW,
      });
      assert.equal(result.action, "foreign");
      assert.equal(result.cert, foreign.cert);
      assert.equal(fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8"), foreign.cert);
      assert.equal(fs.readFileSync(path.join(tlsDir, "key.pem"), "utf8"), foreign.key);
      assert.equal(certificateInfo(foreign.cert).vidaiMade, false);
    });

    test("with no key next to it is an error and nothing is overwritten", async () => {
      const tlsDir = fresh("foreign-nokey");
      fs.mkdirSync(tlsDir);
      fs.writeFileSync(path.join(tlsDir, "cert.pem"), foreign.cert);
      await assert.rejects(
        ensureCertificate({ dir: tlsDir, hostnames: [], addresses: [], now: NOW }),
        /no key file/,
      );
      assert.equal(fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8"), foreign.cert);
      assert.ok(!fs.existsSync(path.join(tlsDir, "key.pem")));
    });
  });

  test("a certificate file that cannot be read is an error, not an overwrite", async () => {
    const tlsDir = fresh("garbage");
    fs.mkdirSync(tlsDir);
    fs.writeFileSync(path.join(tlsDir, "cert.pem"), "garbage");
    await assert.rejects(
      ensureCertificate({ dir: tlsDir, hostnames: [], addresses: [], now: NOW }),
      /cannot be read/,
    );
    assert.equal(fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8"), "garbage");
  });
});
