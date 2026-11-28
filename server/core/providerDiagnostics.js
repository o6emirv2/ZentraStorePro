"use strict";
async function probe(label, url, token, accept, fetcher) {
  if (!url)
    return {
      state: "unverified",
      detail: label + " için tanılama bağlantısı yapılandırılmadı.",
    };
  try {
    const res = await fetcher(url, {
      method: "GET",
      headers: token
        ? { Authorization: "Bearer " + token, Accept: "application/json" }
        : { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok)
      return {
        state: "failed",
        detail:
          label + " okuma isteği başarısız (HTTP " + Number(res.status) + ").",
      };
    if (!accept(await res.json()))
      return {
        state: "failed",
        detail: label + " beklenen hizmet kimliğini doğrulamadı.",
      };
    return {
      state: "passed",
      detail: label + " sağlayıcısından yetkili okuma yanıtı alındı.",
    };
  } catch {
    return { state: "failed", detail: label + " okuma isteği tamamlanamadı." };
  }
}
function diagnose(env = process.env, fetcher = fetch) {
  const service = env.RENDER_SERVICE_ID,
    render = env.RENDER_DIAGNOSTICS_TOKEN,
    bot = env.TELEGRAM_BOT_TOKEN,
    shop = env.SHOPIER_READ_TOKEN;
  return Promise.all([
    probe(
      "Render",
      render && /^srv-[a-z0-9]+$/.test(service || "")
        ? "https://api.render.com/v1/services/" + service
        : "",
      render,
      (x) => x?.id === service,
      fetcher,
    ),
    probe(
      "Shopier",
      shop ? "https://api.shopier.com/v1/shop/settings" : "",
      shop,
      (x) =>
        typeof x?.name === "string" &&
        !!x.name &&
        typeof x.access === "boolean" &&
        (!env.SHOPIER_SHOP_NAME || x.name === env.SHOPIER_SHOP_NAME),
      fetcher,
    ),
    probe(
      "Telegram",
      bot && /^\d{4,}:[\w-]+$/.test(bot)
        ? "https://api.telegram.org/bot" + bot + "/getMe"
        : "",
      "",
      (x) =>
        x?.ok === true &&
        x.result?.is_bot === true &&
        String(x.result.id) === bot.split(":")[0],
      fetcher,
    ),
  ]);
}
module.exports = { diagnose };
