"use strict";
const crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  readline = require("node:readline");
const { Readable, Transform, PassThrough, Writable } = require("node:stream"),
  { pipeline } = require("node:stream/promises");
const { canonical } = require("./restoreVerification");
function ensure(condition, code) {
  if (!condition) throw Object.assign(Error(code), { code });
}
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function countStream(digest) {
  return new Transform({
    transform(chunk, enc, cb) {
      digest.update(chunk);
      cb(null, chunk);
    },
  });
}
async function seal(records, destination, key, header) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv),
    digest = crypto.createHash("sha256");
  const counts = {};
  cipher.setAAD(Buffer.from(JSON.stringify(canonical(header))));
  async function* lines() {
    for await (const row of records) {
      counts[row.type] = (counts[row.type] || 0) + 1;
      yield JSON.stringify(row) + "\n";
    }
  }
  await pipeline(
    Readable.from(lines()),
    zlib.createGzip(),
    cipher,
    countStream(digest),
    destination,
  );
  return {
    header,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    sha256: digest.digest("hex"),
    counts,
  };
}
function openStream(key, manifest) {
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(manifest.iv, "base64"),
  );
  d.setAAD(Buffer.from(JSON.stringify(canonical(manifest.header))));
  d.setAuthTag(Buffer.from(manifest.tag, "base64"));
  return d;
}
async function inspect(source, key, m) {
  const digest = crypto.createHash("sha256");
  await pipeline(
    source(),
    countStream(digest),
    openStream(key, m),
    zlib.createGunzip(),
    new Writable({
      write(c, e, cb) {
        cb();
      },
    }),
  );
  ensure(digest.digest("hex") === m.sha256, "RECOVERY_DIGEST_MISMATCH");
}
async function consume(source, key, m, consumer) {
  await inspect(source, key, m);
  const stream = new PassThrough(),
    done = pipeline(source(), openStream(key, m), zlib.createGunzip(), stream);
  done.catch(() => {});
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const counts = {};
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      counts[row.type] = (counts[row.type] || 0) + 1;
      await consumer(row);
    }
    await done;
    ensure(
      JSON.stringify(canonical(counts)) === JSON.stringify(canonical(m.counts)),
      "RECOVERY_COUNT_MISMATCH",
    );
  } finally {
    lines.close();
    stream.destroy();
    await done.catch(() => {});
  }
}
function quarantined(collection) {
  return /^(?:adminUsers|storeRegistrationBlocks|storeRegistrationPolicy|storeAccountRemovalJobs|storeAdmin|store.*(?:Session|Revocation|Transient|Nonce|Otp|Token|Challenge|Verification|Recovery|Confirmation|Outbox|Campaign|Job|Reservation|Pending|Dispatch|Lease|Intent|Preview)|storeSecurityEvidence)/i.test(
    collection,
  );
}
function rewriteReferences(fields, source, target) {
  function visit(v) {
    if (!v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(visit);
    const prefix = "projects/" + source + "/databases/(default)/documents/";
    if (typeof v.referenceValue === "string") {
      ensure(
        v.referenceValue.startsWith(prefix),
        "RECOVERY_FOREIGN_DOCUMENT_REFERENCE",
      );
      return {
        referenceValue:
          "projects/" +
          target +
          "/databases/(default)/documents/" +
          v.referenceValue.slice(prefix.length),
      };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
  }
  return visit(fields);
}
module.exports = {
  ensure,
  hash,
  seal,
  inspect,
  consume,
  quarantined,
  rewriteReferences,
};
