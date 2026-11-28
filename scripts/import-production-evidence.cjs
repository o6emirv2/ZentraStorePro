"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { requirements, validate } = require("../server/core/productionChecks"),
  { sourceDigest } = require("../server/core/securityAssessment");
async function main() {
  const dir = fs.realpathSync(process.argv[2]),
    key = process.argv[3];
  if (!Object.hasOwn(requirements, key)) throw Error("UNKNOWN_CONTROL");
  const report = JSON.parse(
      fs.readFileSync(path.join(dir, key + ".signed.json"), "utf8"),
    ),
    target = {
      publicKey: process.env.SECURITY_AUDIT_PUBLIC_KEY,
      project: process.env.RECOVERY_SOURCE_PROJECT,
      service: process.env.RENDER_SERVICE_ID,
      digest: sourceDigest(),
    };
  const evidence = validate(report, key, target);
  if (!evidence) throw Error("UNVERIFIED_PRODUCTION_REPORT");
  for (const check of evidence.checks) {
    if (!check.artifactHash) continue;
    const data = fs.readFileSync(
      path.join(dir, check.artifactHash + ".evidence"),
    );
    if (
      crypto.createHash("sha256").update(data).digest("hex") !==
      check.artifactHash
    )
      throw Error("ARTIFACT_MISMATCH");
  }
  const a = require("firebase-admin"),
    app = a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: target.project,
    });
  try {
    const db = a.firestore(app),
      ref = db.collection("storeSecurityEvidence").doc("production-" + key);
    await db.runTransaction(async (tx) => {
      const run = ref.collection("runs").doc(evidence.reference);
      const [current, earlier] = await Promise.all([tx.get(ref), tx.get(run)]);
      const old = current.data();
      if (earlier.exists && earlier.data()?.signature !== report.signature)
        throw Error("IMMUTABLE_PROOF_CONFLICT");
      if (old?.report?.at > report.report.at) throw Error("NEWER_PROOF_EXISTS");
      tx.set(ref, report);
      if (!earlier.exists) tx.create(run, report);
    });
    console.log(
      JSON.stringify({
        reference: evidence.reference,
        status: evidence.status,
        control: key,
      }),
    );
  } finally {
    await app.delete();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error("PRODUCTION_EVIDENCE_IMPORT_FAILED");
    process.exitCode = 1;
  });
