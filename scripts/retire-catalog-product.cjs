"use strict";
const { initFirebaseAdmin } = require("../server/config/firebaseAdmin");
const { retirementIds, retiredProduct } = require("../server/core/retiredProducts");

async function main() {
  const { db, app } = initFirebaseAdmin();
  if (!db || !app) throw Error("Firebase yönetim bağlantısı kurulamadı.");
  const project = app.options.projectId;
  const apply = process.argv.includes("--apply");
  if (apply && (!project || !process.argv.includes("--project") ||
      process.argv[process.argv.indexOf("--project") + 1] !== project))
    throw Error("Hedef Firebase projesini --project ile doğrulayın.");

  const [settings, legacy, pending] = await Promise.all([
    db.collection("storefrontSettings").doc("main").get(),
    db.collection("storeProductSettings").select().get(),
    db.collection("storeProductDeletionJobs").where("preserveHistory", "==", true).select("step").get(),
  ]);
  const catalog = settings.data()?.catalog || {};
  const targets = retirementIds(catalog);
  for (const doc of legacy.docs) if (retiredProduct(doc.id)) targets.add(doc.id);
  for (const doc of pending.docs) targets.add(doc.id);

  for (const id of targets) {
    const job = (await db.collection("storeProductDeletionJobs").doc(id).get()).data();
    console.log(JSON.stringify({ project, productId: id,
      catalogRecord: Boolean(catalog.products?.[id] || catalog.customProducts?.[id]),
      legacyRecord: legacy.docs.some(doc => doc.id === id),
      tombstone: catalog.deletedProductIds?.[id] === true, jobStep: job?.step ?? null }));
    if (apply) {
      const result = await require("../server/core/productDeletion").request(id, id, { uid: "catalog-migration" });
      console.log(JSON.stringify(result));
    }
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
