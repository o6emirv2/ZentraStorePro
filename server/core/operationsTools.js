"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { staffHasPermission } = require("./adminStoreService");
const { audit } = require("./memberControl");
const crypto = require("node:crypto");
const catalog = {
  users: [
    "Kullanıcı yönetim araçları",
    "Firebase Authentication ile kullanıcı dizinine erişimi denetler.",
    "store.users.read",
  ],
  database: [
    "Veritabanı araçları",
    "Firestore bağlantısını ve beklenen indekslerin sağlayıcı durumunu sorgular.",
    "store.security.read",
  ],
  security: [
    "Güvenlik araçları",
    "Oturum ayarları ve son üretim doğrulama kayıtlarını denetler.",
    "store.security.read",
  ],
  backups: [
    "Yedekleme araçları",
    "Son yedeğin ve izole geri yükleme tatbikatının kanıtlarını okur.",
    "store.backups.write",
  ],
  email: [
    "E-posta araçları",
    "Kalıcı e-posta kuyruğundaki bekleyen, yeniden denenen ve reddedilen kayıtları sayar.",
    "store.operations.write",
  ],
  integrations: [
    "Entegrasyon araçları",
    "Firebase bağlantısı ile Render, Shopier ve Telegram yapılandırma durumlarını gösterir.",
    "store.security.read",
  ],
  finance: [
    "Finansal araçlar",
    "Son 100 bakiye kaydında önceki bakiye, hareket tutarı ve sonuç bakiyesini karşılaştırır.",
    "store.wallet.read",
  ],
  system: [
    "Sistem bakım araçları",
    "Sunucu çalışma süresini, bellek kullanımını ve depo bağlantısını ölçer.",
    "store.security.read",
  ],
  blocks: [
    "Kara liste yönetimi",
    "Kayıt engellerini ve tamamlanmayı bekleyen hesap silme işlemlerini sayar.",
    "store.registration.unblock",
  ],
};
async function count(q) {
  if (typeof q.count === "function")
    return (await q.count().get()).data().count;
  return (await q.get()).size;
}
async function inspect(id) {
  const { auth, db } = initFirebaseAdmin();
  if (id === "users") {
    const result = await auth.listUsers(1);
    return {
      state: "passed",
      details: [
        "Firebase Authentication dizini okunabildi.",
        result.users.length
          ? "Örnek hesap kaydı doğrulandı."
          : "Dizinde kayıt yok.",
      ],
    };
  }
  if (id === "database") {
    const c = await require("./runtimeHealth").connectionReadiness();
    const results =
      await require("./productionChecks").configurationChecks("database");
    return {
      state: !c.storageReady
        ? "failed"
        : results.complete
          ? "passed"
          : "partial",
      details: [
        c.storageReady
          ? "Firestore sunucu okuması başarılı."
          : "Veritabanı okunamadı.",
        ...results.messages,
      ],
    };
  }
  if (id === "security") {
    const x = await require("./productionChecks").load();
    const session = x.sessions;
    return {
      state: session?.status || "unverified",
      details: [session?.detail || "Üretim oturum doğrulama kaydı bulunamadı."],
    };
  }
  if (id === "backups") {
    const verified =
        await require("./restoreVerification").loadRestoreEvidence(),
      p = await require("./productionChecks").load();
    const snap = await db
      .collection("storeBackups")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    return {
      state: p.backup?.status || "unverified",
      details: [
        snap.empty
          ? "Yedekleme işi bulunamadı."
          : "Son Firestore işi " + snap.docs[0].data().state,
        verified.verified
          ? "Firestore belge karşılaştırması doğrulandı."
          : "Firestore karşılaştırma kanıtı yok.",
        p.backup?.detail || "Tam kapsamlı tatbikat henüz doğrulanmadı.",
      ],
    };
  }
  if (id === "email") {
    const states = [
      "queued",
      "sending",
      "retry",
      "accepted",
      "delivered",
      "failed",
      "bounced",
      "needs_review",
    ];
    const amounts = await Promise.all(
      states.map((s) =>
        count(db.collection("storeEmailOutbox").where("state", "==", s)),
      ),
    );
    const names = [
      "Kuyrukta",
      "Gönderiliyor",
      "Tekrar denenecek",
      "Sağlayıcı kabul etti",
      "Teslim edildi",
      "Başarısız",
      "Reddedildi",
      "İnceleme gerekli",
    ];
    return {
      state: amounts.slice(5).some(Boolean) ? "partial" : "passed",
      details: names.map((n, i) => n + " · " + amounts[i]),
    };
  }
  if (id === "integrations") {
    const { storageReady } =
      await require("./runtimeHealth").connectionReadiness();
    const providers = await require("./providerDiagnostics").diagnose();
    const failed = !storageReady || providers.some((v) => v.state === "failed");
    return {
      state: failed
        ? "failed"
        : providers.every((v) => v.state === "passed")
          ? "passed"
          : "partial",
      details: [
        storageReady
          ? "Firebase sunucu okuması doğrulandı."
          : "Firebase okuması başarısız.",
        ...providers.map((v) => v.detail),
      ],
    };
  }
  if (id === "finance") {
    const page = await db
      .collection("storeWalletLedger")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    let missing = 0,
      invalid = 0;
    for (const d of page.docs) {
      const v = d.data(),
        n = [v.balanceBeforeKurus, v.amountKurus, v.balanceAfterKurus];
      if (!n.every(Number.isSafeInteger)) missing++;
      else if (n[0] + n[1] !== n[2]) invalid++;
    }
    return {
      state: invalid
        ? "failed"
        : missing
          ? "partial"
          : page.size
            ? "passed"
            : "unverified",
      details: [
        "İncelenen hareket · " + page.size,
        "Eksik tutar · " + missing,
        "Uyuşmayan bakiye · " + invalid,
      ],
    };
  }
  if (id === "system") {
    const c = await require("./runtimeHealth").connectionReadiness();
    return {
      state: c.storageReady ? "passed" : "failed",
      details: [
        "Çalışma süresi · " + Math.floor(process.uptime()) + " sn",
        "İşlem belleği · " +
          Math.ceil(process.memoryUsage().rss / 1048576) +
          " MiB",
        c.storageReady
          ? "Firestore ulaşılabilir."
          : "Firestore bağlantısı başarısız.",
      ],
    };
  }
  const [blocks, pending, paused] = await Promise.all([
    count(db.collection("storeRegistrationBlocks")),
    count(
      db.collection("storeAccountRemovalJobs").where("state", "==", "pending"),
    ),
    count(
      db
        .collection("storeAccountRemovalJobs")
        .where("state", "==", "needs_review"),
    ),
  ]);
  return {
    state: paused ? "partial" : "passed",
    details: [
      "Etkin engel · " + blocks,
      "Devam eden silme · " + pending,
      "İnceleme bekleyen silme · " + paused,
    ],
  };
}
async function list(policy) {
  const { db } = initFirebaseAdmin();
  return Promise.all(
    Object.entries(catalog)
      .filter(([, v]) => staffHasPermission(policy, v[2]))
      .map(async ([id, [title, description, permission]]) => ({
        id,
        title,
        description,
        permission,
        last:
          (await db.collection("storeAdminToolRuns").doc(id).get()).data() ||
          null,
      })),
  );
}
async function run(id, actor) {
  const { db } = initFirebaseAdmin(),
    reference = crypto.randomUUID();
  let result;
  try {
    result = await inspect(id);
  } catch (error) {
    result = {
      state: "failed",
      details: [
        "Kontrol tamamlanamadı. Hata kodu " +
          String(error.code || "SERVICE_UNAVAILABLE").slice(0, 70),
      ],
    };
  }
  const record = { ...result, reference, at: Date.now(), actor: actor.uid };
  await db.runTransaction(async (tx) => {
    const ref = db.collection("storeAdminToolRuns").doc(id);
    const last = (await tx.get(ref)).data();
    if (!last || last.at <= record.at) tx.set(ref, record);
    audit(tx, db, "store.tool." + id, actor, "", {
      reference,
      result: result.state,
    });
  });
  return record;
}
module.exports = { catalog, list, run };
