"use strict";
const { Writable } = require("node:stream"),
  readline = require("node:readline/promises");
async function main() {
  const mode = process.argv[2],
    uid = process.argv[3];
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !["rotate", "recover", "finish"].includes(mode) ||
    !uid ||
    uid.includes("/")
  )
    throw Error("PRIVATE_INTERACTIVE_TERMINAL_AND_UID_REQUIRED");
  const vault = require("../server/core/adminFactorVault");
  if (mode === "finish") {
    await vault.finalize(uid);
    console.log("Bekleyen oturum iptalleri kontrol edildi.");
    return;
  }
  let muted = false;
  const output = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    }),
    cli = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
  async function secret(prompt) {
    process.stdout.write(prompt + " ");
    muted = true;
    try {
      return (await cli.question("")).trim();
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  }
  try {
    const password = await secret("Yönetici parolası"),
      proof = await secret(
        mode === "recover"
          ? "Tek kullanımlık çevrimdışı kurtarma kodu"
          : "Mevcut doğrulama uygulamasındaki kod",
      ),
      credentials = vault.createCredentials();
    process.stdout.write(
      "Yeni kimlik doğrulayıcı için kurulum anahtarı\n" +
        credentials.seed +
        "\nTek kullanımlık kurtarma kodunu çevrimdışı saklayın\n" +
        credentials.recovery +
        "\n",
    );
    const newCode = await secret("Yeni doğrulama uygulamasındaki kod");
    const result = await vault.replace({
      uid,
      password,
      ...(mode === "recover" ? { recovery: proof } : { oldCode: proof }),
      newCredentials: credentials,
      newCode,
    });
    console.log(
      "Doğrulayıcı güncellendi. Mevcut oturumlar iptal edildi. Sürüm " +
        result.revision,
    );
  } finally {
    cli.close();
  }
}
main().catch((e) => {
  console.error(
    e.code && /^[A-Z0-9_]+$/.test(e.code)
      ? e.code
      : "ADMIN_FACTOR_OPERATION_NOT_VERIFIED",
  );
  process.exitCode = 1;
});
