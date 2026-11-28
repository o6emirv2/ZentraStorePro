"use strict";
const admin = require("firebase-admin"),
  crypto = require("node:crypto"),
  { once } = require("node:events"),
  { finished } = require("node:stream/promises");
const {
  ensure,
  hash,
  seal,
  consume,
  quarantined,
  rewriteReferences,
} = require("../server/core/recoveryBundle");
const { canonical } = require("../server/core/restoreVerification");
const env = process.env,
  project = env.RECOVERY_SOURCE_PROJECT,
  target = env.RECOVERY_DRILL_PROJECT;
const idOk = (v) => /^[a-z][a-z0-9-]{4,29}$/.test(v || "");
const cred = admin.credential.applicationDefault();
const root = (p) => "projects/" + p + "/databases/(default)/documents",
  fire = "https://firestore.googleapis.com/v1/",
  rules = "https://firebaserules.googleapis.com/v1/",
  gcp = "https://cloudresourcemanager.googleapis.com/v3/projects/";
const escapePath = (p) => p.split("/").map(encodeURIComponent).join("/");
async function api(url, body) {
  const { access_token } = await cred.getAccessToken();
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + access_token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  ensure(r.ok, "RECOVERY_PROVIDER_HTTP_" + r.status);
  return r.json();
}
async function* pages(url, list, body) {
  let token = "",
    seen = new Set();
  do {
    ensure(!seen.has(token), "RECOVERY_CURSOR_CYCLE");
    seen.add(token);
    const page = await api(
      body !== undefined
        ? url
        : url +
            (url.includes("?") ? "&" : "?") +
            "pageSize=100" +
            (token ? "&pageToken=" + encodeURIComponent(token) : ""),
      body === undefined
        ? undefined
        : { ...body, pageSize: 100, ...(token ? { pageToken: token } : {}) },
    );
    yield* page[list] || [];
    token = page.nextPageToken;
  } while (token);
}
async function* documents(p, time, parent = root(p)) {
  const base = fire + escapePath(parent);
  for await (const collection of pages(
    base + ":listCollectionIds",
    "collectionIds",
    { readTime: time },
  )) {
    for await (const d of pages(
      base +
        "/" +
        encodeURIComponent(collection) +
        "?showMissing=true&readTime=" +
        encodeURIComponent(time),
      "documents",
    )) {
      const relative = d.name.slice(root(p).length + 1);
      if (d.createTime)
        yield { type: "document", path: relative, fields: d.fields || {} };
      yield* documents(p, time, d.name);
    }
  }
}
async function* records(app, bucket, header) {
  const source = app.options.projectId;
  const resources = {};
  for (const svc of ["cloud.firestore", "firebase.storage/" + bucket.name]) {
    const release = await api(
      rules + "projects/" + source + "/releases/" + svc,
    );
    ensure(
      release.rulesetName?.startsWith("projects/" + source + "/rulesets/"),
      "RECOVERY_RULESET_INVALID",
    );
    resources[svc] = (await api(rules + release.rulesetName)).source;
  }
  const indexes = [];
  for await (const i of pages(
    fire +
      "projects/" +
      source +
      "/databases/(default)/collectionGroups/-/indexes",
    "indexes",
  ))
    indexes.push(i);
  resources.indexes = indexes;
  const secret = env.RECOVERY_CONFIGURATION_SECRET_VERSION;
  ensure(
    /^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9]\d*$/.test(
      secret || "",
    ),
    "RECOVERY_CONFIG_VERSION_REQUIRED",
  );
  const content = await api(
      "https://secretmanager.googleapis.com/v1/" + secret + ":access",
    ),
    config = JSON.parse(Buffer.from(content.payload.data, "base64"));
  ensure(
    config.ACCOUNT_BLOCKLIST_KEY &&
      config.STORE_KEY_ENCRYPTION_SECRET &&
      config.firebaseScrypt?.key &&
      Number.isInteger(config.firebaseScrypt.rounds) &&
      Number.isInteger(config.firebaseScrypt.memoryCost),
    "RECOVERY_CONFIGURATION_INCOMPLETE",
  );
  yield { type: "configuration", resources, config };
  yield* documents(source, header.readTime);
  const auth = admin.auth(app);
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const user of page.users) {
      const row = user.toJSON();
      if (user.providerData.some((p) => p.providerId === "password"))
        ensure(row.passwordHash, "RECOVERY_AUTH_HASH_PERMISSION_REQUIRED");
      yield { type: "auth", row };
    }
    token = page.pageToken;
  } while (token);
  let query = { autoPaginate: false, maxResults: 100 };
  do {
    const [files, next] = await bucket.getFiles(query);
    for (const file of files) {
      const [meta] = await file.getMetadata();
      yield {
        type: "asset",
        name: file.name,
        contentType: meta.contentType || "application/octet-stream",
        size: meta.size,
        metadata: meta.metadata || {},
      };
      const digest = crypto.createHash("sha256");
      let size = 0;
      for await (const chunk of bucket
        .file(file.name, { generation: meta.generation })
        .createReadStream()) {
        digest.update(chunk);
        size += chunk.length;
        yield { type: "data", value: chunk.toString("base64") };
      }
      ensure(String(size) === String(meta.size), "RECOVERY_ASSET_SIZE");
      yield { type: "assetEnd", sha256: digest.digest("hex") };
    }
    query = next;
  } while (query);
}
async function storagePolicy(bucket, sourceMeta) {
  const [m] = await bucket.getMetadata();
  ensure(
    require("../server/commerce/backupIsolation").verifyVault(
      m,
      sourceMeta.name.split("/").at(-1),
    ),
    "RECOVERY_INDEPENDENT_STORAGE_REQUIRED",
  );
  return m;
}
async function kms(key, mode, bytes, context) {
  ensure(
    /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(
      key || "",
    ),
    "RECOVERY_KMS_KEY_REQUIRED",
  );
  const field = mode === "encrypt" ? "plaintext" : "ciphertext";
  const res = await api(
    "https://cloudkms.googleapis.com/v1/" + key + ":" + mode,
    {
      [field]: bytes.toString("base64"),
      additionalAuthenticatedData: Buffer.from(context).toString("base64"),
    },
  );
  return Buffer.from(
    res[mode === "encrypt" ? "ciphertext" : "plaintext"],
    "base64",
  );
}
async function backup(app, vault, sourceBucket, meta) {
  await storagePolicy(vault, meta);
  const id = crypto.randomUUID(),
    header = {
      id,
      version: 1,
      source: project,
      readTime: new Date(Date.now() - 2000).toISOString(),
      sourceDigest:
        require("../server/core/securityAssessment").runningSourceDigest(),
    };
  const archive = vault.file("recovery/" + id + "/bundle"),
    key = crypto.randomBytes(32),
    wrapping = env.RECOVERY_KMS_KEY;
  const wrapped = await kms(wrapping, "encrypt", key, id);
  try {
    const m = await seal(
      records(app, sourceBucket, header),
      archive.createWriteStream({
        resumable: true,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
      key,
      header,
    );
    const [meta] = await archive.getMetadata();
    m.generation = meta.generation;
    m.wrapped = wrapped.toString("base64");
    m.wrapping = wrapping;
    await require("../server/core/recoveryBundle").inspect(
      () =>
        vault
          .file(archive.name, { generation: m.generation })
          .createReadStream(),
      key,
      m,
    );
    await vault
      .file("recovery/" + id + "/manifest.json")
      .save(JSON.stringify(m), {
        preconditionOpts: { ifGenerationMatch: 0 },
        contentType: "application/json",
      });
    await admin
      .firestore(app)
      .collection("storeRecoveryRuns")
      .doc(id)
      .create({
        kind: "encrypted-backup",
        state: "verified",
        createdAt: Date.now(),
        source: project,
        reference: id,
        sha256: m.sha256,
        counts: m.counts,
        snapshot: header.readTime,
      });
    return { id, counts: m.counts, sha256: m.sha256 };
  } finally {
    key.fill(0);
  }
}
async function verifyBusinessRelations(db) {
  const counts = {
    ledgerOrders: 0,
    deliveries: 0,
    walletProfiles: 0,
    orderViews: 0,
  };
  const { facts } = require("../server/core/memberFinance"),
    { readAvailableBalance } = require("../server/core/storeMoney");
  async function order(id) {
    ensure(
      typeof id === "string" && id && !id.includes("/"),
      "RECOVERY_ORDER_REFERENCE_INVALID",
    );
    const active = await db.collection("storeOrders").doc(id).get();
    if (active.exists) return active.data();
    return (await db.collection("storeOrderArchives").doc(id).get()).data()
      ?.order;
  }
  for await (const d of db.collection("storeWalletLedger").stream()) {
    const row = d.data();
    if (!row.orderId) continue;
    const parent = await order(row.orderId);
    ensure(
      parent && parent.uid === row.uid,
      "RECOVERY_LEDGER_ORDER_OWNER_MISMATCH",
    );
    counts.ledgerOrders++;
  }
  for await (const d of db.collection("storeDeliveries").stream()) {
    const row = d.data(),
      parent = await order(row.orderId || d.id);
    ensure(
      parent && (!row.uid || parent.uid === row.uid),
      "RECOVERY_DELIVERY_ORDER_OWNER_MISMATCH",
    );
    counts.deliveries++;
  }
  for await (const d of db.collection("users").stream()) {
    const row = d.data();
    readAvailableBalance(row);
    ensure(
      row.storeAccountStatus === "security_locked",
      "RECOVERY_PROFILE_NOT_QUARANTINED",
    );
    counts.walletProfiles++;
  }
  for await (const d of db.collection("storeOrders").stream()) {
    const o = d.data(),
      view = facts(o);
    ensure(
      view.amount !== null && typeof o.uid === "string" && o.uid,
      "RECOVERY_ORDER_VIEW_UNAVAILABLE",
    );
    counts.orderViews++;
  }
  return counts;
}
async function snapshotChanges(name, sourceTime) {
  const read = (p, t) =>
    pages(
      fire +
        escapePath(root(p)) +
        "/" +
        name +
        "?orderBy=__name__" +
        (t ? "&readTime=" + encodeURIComponent(t) : ""),
      "documents",
    )[Symbol.asyncIterator]();
  const live = read(project, sourceTime),
    copy = read(target);
  let a = await live.next(),
    b = await copy.next();
  const changes = {
    addedSinceSnapshot: 0,
    updatedSinceSnapshot: 0,
    deletedSinceSnapshot: 0,
    unchanged: 0,
  };
  while (!a.done || !b.done) {
    const left = a.done ? "" : a.value.name.split("/").at(-1),
      right = b.done ? "" : b.value.name.split("/").at(-1);
    const order =
      left && right
        ? Buffer.compare(Buffer.from(left), Buffer.from(right))
        : left
          ? -1
          : 1;
    if (order < 0) {
      changes.addedSinceSnapshot++;
      a = await live.next();
      continue;
    }
    if (order > 0) {
      changes.deletedSinceSnapshot++;
      b = await copy.next();
      continue;
    }
    const expected = rewriteReferences(a.value.fields || {}, project, target);
    if (
      JSON.stringify(canonical(expected)) ===
      JSON.stringify(canonical(b.value.fields || {}))
    )
      changes.unchanged++;
    else changes.updatedSinceSnapshot++;
    a = await live.next();
    b = await copy.next();
  }
  return changes;
}
async function restore(app, vault, meta, id) {
  ensure(
    idOk(target) && target !== project && /^[0-9a-f-]{36}$/.test(id),
    "ISOLATED_RESTORE_PROJECT_REQUIRED",
  );
  await storagePolicy(vault, meta);
  const targetInfo = await api(gcp + target);
  ensure(
    targetInfo.labels?.["zentra-drill"] === "isolated",
    "RECOVERY_TARGET_QUARANTINE_REQUIRED",
  );
  const targetBucketName = env.RECOVERY_DRILL_BUCKET;
  ensure(
    targetBucketName &&
      targetBucketName !== vault.name &&
      targetBucketName !== env.RECOVERY_SOURCE_BUCKET,
    "RECOVERY_TARGET_BUCKET_INVALID",
  );
  const restored = admin.initializeApp(
    { credential: cred, projectId: target, storageBucket: targetBucketName },
    "zentra-isolated-drill",
  );
  try {
    const targetDb = admin.firestore(restored),
      ta = admin.auth(restored),
      assets = admin.storage(restored).bucket(),
      [targetBucketMeta] = await assets.getMetadata();
    ensure(
      String(targetBucketMeta.projectNumber) ===
        targetInfo.name.split("/").at(-1) &&
        targetBucketMeta.iamConfiguration?.publicAccessPrevention ===
          "enforced",
      "RECOVERY_TARGET_BUCKET_INVALID",
    );
    ensure(
      !(await targetDb.listCollections()).length &&
        !(await ta.listUsers(1)).users.length &&
        !(await assets.getFiles({ maxResults: 1 }))[0].length,
      "RECOVERY_TARGET_MUST_BE_EMPTY",
    );
    for (const service of [
      "cloud.firestore",
      "firebase.storage/" + targetBucketName,
    ]) {
      const release = await api(
        rules + "projects/" + target + "/releases/" + service,
      );
      const src = (await api(rules + release.rulesetName)).source;
      const local = require("node:fs")
        .readFileSync(
          require("node:path").resolve(
            __dirname,
            service === "cloud.firestore"
              ? "../firestore.rules"
              : "recovery-storage.rules",
          ),
          "utf8",
        )
        .trim();
      ensure(
        src?.files?.length === 1 && src.files[0].content.trim() === local,
        "RECOVERY_TARGET_RULES_UNVERIFIED",
      );
    }
    const [manifest] = await vault
        .file("recovery/" + id + "/manifest.json")
        .download(),
      m = JSON.parse(manifest);
    ensure(
      m.header?.source === project &&
        m.header.id === id &&
        m.wrapping === env.RECOVERY_KMS_KEY,
      "RECOVERY_SOURCE_MISMATCH",
    );
    const key = await kms(
        m.wrapping,
        "decrypt",
        Buffer.from(m.wrapped, "base64"),
        id,
      ),
      start = Date.now();
    const counts = {
      docs: 0,
      accounts: 0,
      assets: 0,
      quarantined: 0,
      ledger: 0,
      orders: 0,
    };
    const sourceAuth = admin.auth(app),
      sourceDb = admin.firestore(app),
      absent = new Set(),
      sourceAccounts = new Map();
    let scrypt,
      pending = [],
      asset,
      assetDone,
      assetName,
      assetHash,
      expectedConfig,
      skipAsset = false;
    async function current(uid) {
      if (!uid) return true;
      if (absent.has(uid)) return false;
      if (sourceAccounts.has(uid)) return true;
      try {
        const row = await sourceAuth.getUser(uid);
        const tomb = await sourceDb
          .collection("storeAccountRemovalJobs")
          .doc(uid)
          .get();
        if (tomb.exists) {
          absent.add(uid);
          return false;
        }
        sourceAccounts.set(uid, row);
        return true;
      } catch (e) {
        if (e.code !== "auth/user-not-found") throw e;
        absent.add(uid);
        return false;
      }
    }
    async function flush() {
      if (!pending.length) return;
      const writes = pending.map((r) => ({
        update: { name: root(target) + "/" + r.path, fields: r.fields },
        currentDocument: { exists: false },
      }));
      await api(fire + root(target) + ":commit", { writes });
      for (const r of pending) {
        const saved = await api(fire + escapePath(root(target) + "/" + r.path));
        ensure(
          hash(JSON.stringify(canonical(saved.fields || {}))) ===
            hash(JSON.stringify(canonical(r.fields))),
          "RECOVERY_DOCUMENT_MISMATCH",
        );
        counts.docs++;
      }
      pending = [];
    }
    try {
      await consume(
        () =>
          vault
            .file("recovery/" + id + "/bundle", { generation: m.generation })
            .createReadStream(),
        key,
        m,
        async (row) => {
          if (row.type === "configuration") {
            scrypt = row.config.firebaseScrypt;
            expectedConfig = hash(JSON.stringify(canonical(row.resources)));
            ensure(
              scrypt?.key &&
                row.resources.indexes &&
                row.resources["cloud.firestore"],
              "RECOVERY_CONFIGURATION_INCOMPLETE",
            );
            return;
          }
          if (row.type === "document") {
            const [col, doc] = row.path.split("/");
            if (quarantined(col) || col === "storeRecoveryRuns") {
              counts.quarantined++;
              return;
            }
            const owner =
                row.fields?.uid?.stringValue || (col === "users" ? doc : null),
              financial =
                /^store(?:Orders|OrderArchives|Deliveries|WalletLedger|WalletAdjustments|WalletRequests|Refunds|Payments)$/.test(
                  col,
                );
            if (owner && !financial && !(await current(owner))) {
              counts.quarantined++;
              return;
            }
            const fields = rewriteReferences(row.fields, project, target);
            if (col === "users") {
              fields.storeAccountStatus = { stringValue: "security_locked" };
              delete fields.role;
              delete fields.permissions;
              delete fields.admin;
            }
            if (col === "storeWalletLedger") {
              const n = [
                "balanceBeforeKurus",
                "amountKurus",
                "balanceAfterKurus",
              ].map((k) => fields[k]?.integerValue);
              ensure(
                n.every((v) => v !== undefined) &&
                  BigInt(n[0]) + BigInt(n[1]) === BigInt(n[2]),
                "RECOVERY_LEDGER_MISMATCH",
              );
              counts.ledger++;
            }
            if (col === "storeOrders") {
              ensure(
                owner &&
                  fields.totalKurus?.integerValue !== undefined &&
                  BigInt(fields.totalKurus.integerValue) >= 0n,
                "RECOVERY_ORDER_MISMATCH",
              );
              counts.orders++;
            }
            pending.push({ path: row.path, fields });
            if (pending.length >= 100) await flush();
            return;
          }
          if (row.type === "auth") {
            const u = row.row;
            if (!(await current(u.uid))) {
              counts.quarantined++;
              return;
            }
            const item = {
              uid: u.uid,
              disabled: true,
              emailVerified: u.emailVerified === true,
              ...Object.fromEntries(
                ["email", "displayName", "photoURL", "phoneNumber"]
                  .filter((k) => u[k])
                  .map((k) => [k, u[k]]),
              ),
              providerData: (u.providerData || [])
                .filter(
                  (v) =>
                    v.providerId !== "password" && v.providerId !== "phone",
                )
                .map((v) =>
                  Object.fromEntries(
                    Object.entries(v).filter(([k]) =>
                      [
                        "providerId",
                        "uid",
                        "email",
                        "displayName",
                        "photoURL",
                      ].includes(k),
                    ),
                  ),
                ),
            };
            if (u.passwordHash) {
              item.passwordHash = Buffer.from(u.passwordHash, "base64");
              item.passwordSalt = Buffer.from(u.passwordSalt || "", "base64");
            }
            const res = await ta.importUsers(
              [item],
              u.passwordHash
                ? {
                    hash: {
                      algorithm: "SCRYPT",
                      key: Buffer.from(scrypt.key, "base64"),
                      saltSeparator: Buffer.from(
                        scrypt.saltSeparator || "",
                        "base64",
                      ),
                      rounds: scrypt.rounds,
                      memoryCost: scrypt.memoryCost,
                    },
                  }
                : undefined,
            );
            ensure(res.successCount === 1, "RECOVERY_AUTH_IMPORT_FAILED");
            const check = await ta.getUser(u.uid);
            ensure(
              check.disabled &&
                !Object.keys(check.customClaims || {}).length &&
                check.email === u.email,
              "RECOVERY_ACCOUNT_QUARANTINE_FAILED",
            );
            counts.accounts++;
            return;
          }
          if (row.type === "asset") {
            ensure(!asset, "RECOVERY_ASSET_ORDER");
            assetName = row.name;
            const parts = assetName.split("/");
            skipAsset =
              parts[0] === "support" && parts[1] && !(await current(parts[1]));
            if (skipAsset) {
              counts.quarantined++;
              return;
            }
            assetHash = crypto.createHash("sha256");
            asset = assets
              .file(row.name)
              .createWriteStream({
                resumable: true,
                contentType: row.contentType,
                preconditionOpts: { ifGenerationMatch: 0 },
              });
            assetDone = finished(asset);
            assetDone.catch(() => {});
            return;
          }
          if (row.type === "data") {
            if (skipAsset) return;
            ensure(asset, "RECOVERY_ASSET_ORDER");
            const part = Buffer.from(row.value, "base64");
            assetHash.update(part);
            if (!asset.write(part)) await once(asset, "drain");
            return;
          }
          if (row.type === "assetEnd") {
            if (skipAsset) {
              skipAsset = false;
              return;
            }
            ensure(
              asset && assetHash.digest("hex") === row.sha256,
              "RECOVERY_ASSET_MISMATCH",
            );
            asset.end();
            await assetDone;
            asset = null;
            const actual = crypto.createHash("sha256");
            for await (const part of assets.file(assetName).createReadStream())
              actual.update(part);
            ensure(
              actual.digest("hex") === row.sha256,
              "RECOVERY_ASSET_MISMATCH",
            );
            counts.assets++;
            return;
          }
          ensure(false, "RECOVERY_RECORD_UNKNOWN");
        },
      );
      await flush();
      for (const col of [
        "storeRegistrationPolicy",
        "storeRegistrationBlocks",
      ]) {
        for await (const doc of sourceDb.collection(col).stream()) {
          await targetDb.collection(col).doc(doc.id).create(doc.data());
          ensure(
            (await targetDb.collection(col).doc(doc.id).get()).exists,
            "RECOVERY_BLOCKLIST_MISMATCH",
          );
        }
      }
      const business = await verifyBusinessRelations(targetDb),
        comparedAt = new Date(Date.now() - 1000).toISOString(),
        deltas = {};
      for (const name of [
        "storeOrders",
        "storeOrderArchives",
        "storeWalletLedger",
        "storeDeliveries",
      ])
        deltas[name] = await snapshotChanges(name, comparedAt);
      const result = {
        reference: id,
        targetProject: target,
        business,
        recoveryPoint: { comparedAt, deltas },
        state: "verified",
        kind: "isolated-drill",
        createdAt: Date.now(),
        snapshot: m.header.readTime,
        rtoMs: Date.now() - start,
        snapshotAgeAtStartMs: start - Date.parse(m.header.readTime),
        scope: counts,
        configDigest: expectedConfig,
        sha256: m.sha256,
      };
      await sourceDb
        .collection("storeRecoveryRuns")
        .doc(id)
        .collection("drills")
        .doc(crypto.randomUUID())
        .create(result);
      return result;
    } finally {
      key.fill(0);
      asset?.destroy();
    }
  } finally {
    await restored.delete();
  }
}
async function main() {
  ensure(
    idOk(project) &&
      env.RECOVERY_SOURCE_BUCKET &&
      env.RECOVERY_BACKUP_BUCKET &&
      env.RECOVERY_SOURCE_BUCKET !== env.RECOVERY_BACKUP_BUCKET,
    "RECOVERY_CONFIGURATION_REQUIRED",
  );
  const app = admin.initializeApp(
    {
      credential: cred,
      projectId: project,
      storageBucket: env.RECOVERY_SOURCE_BUCKET,
    },
    "zentra-archive",
  );
  try {
    const meta = await api(gcp + project),
      src = admin.storage(app).bucket(),
      vault = admin.storage(app).bucket(env.RECOVERY_BACKUP_BUCKET),
      [sm] = await src.getMetadata();
    ensure(
      String(sm.projectNumber) === meta.name.split("/").at(-1),
      "RECOVERY_SOURCE_BUCKET_MISMATCH",
    );
    const mode = process.argv[2];
    ensure(["backup", "drill"].includes(mode), "RECOVERY_MODE_REQUIRED");
    const r =
      mode === "backup"
        ? await backup(app, vault, src, meta)
        : await restore(app, vault, meta, process.argv[3] || "");
    process.stdout.write(JSON.stringify(r) + "\n");
  } finally {
    await app.delete();
  }
}
module.exports = { verifyBusinessRelations };
if (require.main === module)
  main().catch((e) => {
    console.error(
      typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code)
        ? e.code
        : "RECOVERY_OPERATION_FAILED",
    );
    process.exitCode = 1;
  });
