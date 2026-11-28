"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

function loopback(name) {
  const host = process.env[name];
  if (!host || !/^(?:127\.0\.0\.1|localhost):[0-9]+$/.test(host))
    throw Error(name + " must identify a local emulator");
  return "http://" + host;
}
async function main() {
  const project = "demo-zentra-rules",
    bucket = project + ".appspot.com";
  const docHost = loopback("FIRESTORE_EMULATOR_HOST");
  const fileHost = loopback("FIREBASE_STORAGE_EMULATOR_HOST");
  const authHost = loopback("FIREBASE_AUTH_EMULATOR_HOST");
  assert.equal(
    process.env.GCLOUD_PROJECT,
    project,
    "Choose the isolated demo project",
  );
  const app = initializeApp({ projectId: project, storageBucket: bucket });
  const id = randomUUID(),
    path = "users/" + id;
  const publicFile = "store-product-images/" + id + ".png",
    privateFile = "support/" + id + "/ticket/item";
  const cases = [];
  async function check(name, url, status, options = {}) {
    const result = await fetch(url, options);
    assert.equal(result.status, status, name + " HTTP " + result.status);
    cases.push(name);
    return result;
  }
  try {
    await getFirestore(app).doc(path).set({ marker: id });
    for (const file of [publicFile, privateFile])
      await getStorage(app)
        .bucket()
        .file(file)
        .save(Buffer.from([1, 2, 3]), {
          resumable: false,
          contentType: "application/octet-stream",
        });
    const response = await fetch(
      authHost +
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    assert.equal(response.status, 200);
    const { idToken } = await response.json();
    assert(idToken);
    const doc =
      docHost +
      "/v1/projects/" +
      project +
      "/databases/(default)/documents/" +
      path;
    const files = fileHost + "/v0/b/" + bucket + "/o";
    for (const [role, headers] of [
      ["guest", {}],
      ["member", { Authorization: "Bearer " + idToken }],
    ]) {
      await check(role + "-private-document-read-denied", doc, 403, {
        headers,
      });
      await check(role + "-direct-balance-write-denied", doc, 403, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: { storeBalanceKurus: { integerValue: "20" } },
        }),
      });
      const allowed = await check(
        role + "-public-product-media-readable",
        files + "/" + encodeURIComponent(publicFile) + "?alt=media",
        200,
        { headers },
      );
      assert.deepEqual(
        [...new Uint8Array(await allowed.arrayBuffer())],
        [1, 2, 3],
      );
      const privateResult = await fetch(
        files + "/" + encodeURIComponent(privateFile) + "?alt=media",
        { headers },
      );
      assert(
        [401, 403].includes(privateResult.status),
        role + " private attachment " + privateResult.status,
      );
      cases.push(role + "-support-file-read-denied");
      const write = await fetch(
        files + "?uploadType=media&name=" + encodeURIComponent(publicFile),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          body: Buffer.from([4]),
        },
      );
      assert(
        [401, 403].includes(write.status),
        role + " media mutation " + write.status,
      );
      cases.push(role + "-public-media-write-denied");
    }
    console.log(
      JSON.stringify({
        project,
        emulators: ["auth", "firestore", "storage"],
        passed: cases.length,
        failed: 0,
        cases,
      }),
    );
  } finally {
    await deleteApp(app);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
