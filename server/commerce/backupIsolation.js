"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  C = require("./common");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
async function read(url, body) {
  const cred = initFirebaseAdmin().app?.options?.credential;
  if (!cred?.getAccessToken) C.fail("COMMERCE_BACKUP_AUTH_UNAVAILABLE", 503);
  const token = await cred.getAccessToken();
  const result = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) C.fail("COMMERCE_BACKUP_POLICY_UNVERIFIED", 503);
  return result.json();
}
function verifyVault(meta, sourceNumber) {
  const days = Number(process.env.RECOVERY_RETENTION_DAYS || 30);
  return (
    Number.isSafeInteger(days) &&
    days >= 1 &&
    days <= 3650 &&
    /^\d+$/.test(String(sourceNumber)) &&
    /^\d+$/.test(String(meta?.projectNumber)) &&
    String(sourceNumber) !== String(meta.projectNumber) &&
    meta.iamConfiguration?.publicAccessPrevention === "enforced" &&
    meta.iamConfiguration?.uniformBucketLevelAccess?.enabled === true &&
    Number(meta.retentionPolicy?.retentionPeriod) >= days * 86400 &&
    /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(
      meta.encryption?.defaultKmsKeyName || "",
    )
  );
}
async function checkVault(config) {
  const [project, bucket] = await Promise.all([
    read(
      "https://cloudresourcemanager.googleapis.com/v3/projects/" +
        encodeURIComponent(config.sourceProject),
    ),
    read(
      "https://storage.googleapis.com/storage/v1/b/" +
        encodeURIComponent(config.bucket),
    ),
  ]);
  if (!verifyVault(bucket, project.name?.split("/").at(-1)))
    C.fail("COMMERCE_BACKUP_VAULT_UNVERIFIED", 503);
}
async function checkTarget(config) {
  const id = config.restoreDatabase,
    target = config.targetProject;
  if (
    !/^zentra-drill-[a-z0-9][a-z0-9-]{0,37}$/.test(id) ||
    target === config.sourceProject
  )
    C.fail("COMMERCE_RESTORE_TEST_PROJECT_REQUIRED", 409);
  const base = "projects/" + target + "/databases/" + id,
    rules = "https://firebaserules.googleapis.com/v1/";
  const [project, release, contents] = await Promise.all([
    read("https://cloudresourcemanager.googleapis.com/v3/projects/" + target),
    read(rules + "projects/" + target + "/releases/cloud.firestore/" + id),
    read(
      "https://firestore.googleapis.com/v1/" +
        base +
        "/documents:listCollectionIds",
      { pageSize: 1 },
    ),
  ]);
  if (
    project.labels?.["zentra-drill"] !== "isolated" ||
    contents.nextPageToken ||
    contents.collectionIds?.length ||
    !release.rulesetName?.startsWith("projects/" + target + "/rulesets/")
  )
    C.fail("COMMERCE_RESTORE_TARGET_UNSAFE", 409);
  const deployed = await read(rules + release.rulesetName),
    expected = fs
      .readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8")
      .trim();
  if (
    deployed.source?.files?.length !== 1 ||
    deployed.source.files[0].content.trim() !== expected
  )
    C.fail("COMMERCE_RESTORE_TARGET_UNSAFE", 409);
}
module.exports = { checkTarget, checkVault, verifyVault };
