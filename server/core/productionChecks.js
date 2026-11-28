"use strict";
const crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const env = require("../config/env");
const { canonical } = require("./restoreVerification");
const requirements = {
  sessions: [
    "tls",
    "secure-cookie",
    "revoked-session",
    "role-revocation",
    "admin-mfa",
    "single-use-action",
    "issuer-audience",
    "expired-session",
    "customer-boundary",
    "rotation",
  ],
  database: [
    "published-rules",
    "indexes",
    "effective-iam",
    "private-read",
    "private-write",
    "financial-transaction",
    "account-isolation",
  ],
  backup: [
    "firestore",
    "auth",
    "storage",
    "rules-indexes",
    "sealed-config",
    "anti-resurrection",
    "relations",
    "financial-totals",
    "functional-smoke",
    "recovery-time",
    "recovery-point",
    "independent-encrypted-storage",
  ],
  "app-check": [
    "supported-services",
    "production-domain",
    "debug-registry",
    "missing-token",
    "invalid-token",
    "expired-token",
    "approved-app",
    "denied-role",
    "webhook-identity",
    "device",
  ],
};
const titles = {
  passed: "Üretim kanıtı doğrulandı.",
  partial: "Üretim doğrulamasının bir bölümü tamamlandı.",
  failed: "Üretim kontrolü başarısız.",
  running: "Üretim denetimi sürüyor.",
  unverified: "Üretim kanıtı bulunamadı veya güncel değil.",
};
function validate(envelope, key, target, now = Date.now()) {
  try {
    if (
      !envelope ||
      !requirements[key] ||
      !target.project ||
      !target.service ||
      !target.digest ||
      !target.publicKey
    )
      return null;
    const { report, signature } = envelope,
      publicKey = crypto.createPublicKey(
        target.publicKey.replace(/\\n/g, "\n"),
      );
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !crypto.verify(
        null,
        Buffer.from(JSON.stringify(canonical(report))),
        publicKey,
        Buffer.from(signature, "base64"),
      )
    )
      return null;
    if (
      report.version !== 1 ||
      report.kind !== key ||
      report.project !== target.project ||
      report.service !== target.service ||
      report.sourceDigest !== target.digest ||
      !Number.isSafeInteger(report.at) ||
      report.at > now ||
      now - report.at > (key === "backup" ? 30 : 7) * 86400000 ||
      !/^[a-zA-Z0-9_-]{8,120}$/.test(report.runId)
    )
      return null;
    if (
      !Array.isArray(report.tests) ||
      report.tests.some(
        (t) =>
          !t ||
          !requirements[key].includes(t.id) ||
          !["passed", "failed", "running", "unverified"].includes(t.status),
      )
    )
      return null;
    const byId = new Map(report.tests.map((t) => [t.id, t]));
    if (byId.size !== report.tests.length) return null;
    const checks = requirements[key].map((id) => {
      const t = byId.get(id);
      return t &&
        ["passed", "failed", "running"].includes(t.status) &&
        /^[a-f0-9]{64}$/.test(t.artifactHash || "")
        ? { id, status: t.status, artifactHash: t.artifactHash }
        : { id, status: "unverified" };
    });
    const passed = checks.filter((x) => x.status === "passed").length,
      status = checks.some((x) => x.status === "failed")
        ? "failed"
        : passed === checks.length
          ? "passed"
          : checks.some((x) => x.status === "running")
            ? "running"
            : passed
              ? "partial"
              : "unverified";
    return {
      status,
      detail: titles[status] + " " + passed + " / " + checks.length + " kanıt.",
      at: report.at,
      reference: report.runId,
      checks,
    };
  } catch {
    return null;
  }
}
let memo;
async function load() {
  const { app, db } = initFirebaseAdmin();
  if (
    env.nodeEnv !== "production" ||
    !app?.options?.projectId ||
    !db ||
    !process.env.RENDER_SERVICE_ID ||
    !process.env.SECURITY_AUDIT_PUBLIC_KEY
  )
    return {};
  const target = {
    project: app.options.projectId,
    service: process.env.RENDER_SERVICE_ID,
    publicKey: process.env.SECURITY_AUDIT_PUBLIC_KEY,
    digest: require("./securityAssessment").runningSourceDigest(),
  };
  const now = Date.now();
  if (memo?.until > now && memo.key === target.digest) return memo.result;
  const keys = Object.keys(requirements);
  try {
    const docs = await db.getAll(
      ...keys.map((k) =>
        db.collection("storeSecurityEvidence").doc("production-" + k),
      ),
    );
    const result = Object.fromEntries(
      keys.map((k, i) => [k, validate(docs[i].data(), k, target)]),
    );
    memo = { until: now + 30000, key: target.digest, result };
    return result;
  } catch {
    return {};
  }
}
async function configurationChecks(kind) {
  const { app } = initFirebaseAdmin(),
    project = app?.options?.projectId;
  const messages = [];
  if (!app?.options?.credential || !project)
    return {
      complete: false,
      messages: ["Google Cloud yönetim bağlantısı doğrulanamadı."],
    };
  let access_token;
  try {
    ({ access_token } = await app.options.credential.getAccessToken());
  } catch {
    return {
      complete: false,
      messages: ["Google Cloud yönetim kimliği doğrulanamadı."],
    };
  }
  async function get(url) {
    const res = await fetch(url, {
      headers: { authorization: "Bearer " + access_token },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw Object.assign(Error("provider"), { status: res.status });
    return res.json();
  }
  try {
    if (kind === "database") {
      const rulesBase = "https://firebaserules.googleapis.com/v1/",
        release = await get(
          rulesBase + "projects/" + project + "/releases/cloud.firestore",
        );
      if (
        !String(release.rulesetName).startsWith(
          "projects/" + project + "/rulesets/",
        )
      )
        throw Error("ruleset target");
      const rules = await get(rulesBase + release.rulesetName),
        expected = fs
          .readFileSync(
            path.resolve(__dirname, "../../firestore.rules"),
            "utf8",
          )
          .trim(),
        matches =
          rules.source?.files?.length === 1 &&
          rules.source.files[0].content.trim() === expected;
      messages.push(
        matches
          ? "Yayımlanan Firestore kuralları paketle birebir eşleşiyor."
          : "Yayımlanan Firestore kuralları paketle eşleşmiyor.",
      );
      const base =
          "https://firestore.googleapis.com/v1/projects/" +
          project +
          "/databases/(default)/collectionGroups/-/indexes",
        actual = [];
      let token = "";
      do {
        const page = await get(
          base +
            "?pageSize=100" +
            (token ? "&pageToken=" + encodeURIComponent(token) : ""),
        );
        actual.push(...(page.indexes || []));
        token = page.nextPageToken || "";
      } while (token);
      const normalize = (v) =>
        JSON.stringify(
          v
            .filter((f) => f.fieldPath !== "__name__")
            .map((f) => [f.fieldPath, f.order || f.arrayConfig]),
        );
      const required = require("../../firestore.indexes.json").indexes || [];
      const ready = required.filter((v) =>
        actual.some(
          (i) =>
            i.name?.includes(
              "/collectionGroups/" + v.collectionGroup + "/indexes/",
            ) &&
            i.queryScope === v.queryScope &&
            i.state === "READY" &&
            normalize(i.fields) === normalize(v.fields),
        ),
      );
      messages.push(
        "Sağlayıcıda hazır indeks · " + ready.length + " / " + required.length,
      );
      return {
        complete: matches && ready.length === required.length,
        messages,
      };
    }
    const projectName = "projects/" + project,
      api = "https://firebaseappcheck.googleapis.com/v1/";
    const services = await get(api + projectName + "/services?pageSize=100");
    const required = [
      "firestore.googleapis.com",
      "firebasestorage.googleapis.com",
      "identitytoolkit.googleapis.com",
    ];
    const missing = required.filter(
      (id) =>
        !(services.services || []).some(
          (s) =>
            s.name.endsWith("/services/" + id) &&
            s.enforcementMode === "ENFORCED",
        ),
    );
    messages.push(
      missing.length
        ? "Zorunlu doğrulaması teyit edilmeyen servisler · " +
            missing.join(", ")
        : "Korunan servislerde zorunlu doğrulama etkin.",
    );
    const debugs = await get(
        api +
          projectName +
          "/apps/" +
          encodeURIComponent(env.firebase.publicConfig.appId) +
          "/debugTokens?pageSize=1",
      ),
      clean = !(debugs.debugTokens || []).length;
    messages.push(
      clean
        ? "Üretim uygulamasında kayıtlı debug tokenı yok."
        : "Üretim uygulamasında debug tokenı kayıtlı.",
    );
    return { complete: !missing.length && clean, messages };
  } catch (e) {
    return {
      complete: false,
      messages: [
        ...messages,
        "Sağlayıcı denetimi tamamlanamadı" +
          (e.status ? " (HTTP " + e.status + ")" : "."),
      ],
    };
  }
}
module.exports = { requirements, validate, load, configurationChecks };
