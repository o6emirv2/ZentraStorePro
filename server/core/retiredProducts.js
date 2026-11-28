"use strict";

const retiredId = "ios-lion-pubg";
const knownIds = new Set(["ioslionpubg", "lionios", "ioslion"]);

function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replaceAll("ı", "i").replace(/[^a-z0-9]/g, "");
}

function retiredProduct(id, name, platform) {
  return knownIds.has(normalized(id)) ||
    (normalized(platform) === "ios" && ["lion", "lionios"].includes(normalized(name)));
}

function retirementIds(catalog) {
  catalog ||= {};
  const ids = new Set([retiredId]);
  for (const group of [catalog.products, catalog.customProducts]) {
    for (const [id, item] of Object.entries(group || {})) {
      if (retiredProduct(id) || (group === catalog.customProducts &&
          (!item?.game || item.game === "pubg") && retiredProduct(id, item?.name, item?.platform))) ids.add(id);
    }
  }
  return ids;
}

function retiredSlide(row, targets) {
  return targets?.has(row?.productId) || retiredProduct(row?.productId) ||
    String(row?.image || "").split(/[?#]/)[0].toLowerCase().endsWith("/lion-ios.webp");
}

module.exports = { retiredId, retiredProduct, retiredSlide, retirementIds };
