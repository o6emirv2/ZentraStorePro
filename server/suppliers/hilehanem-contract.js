"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fromEnvironment, validBaseUrl } = require("./hilehanem-config");
const fail = (code) => {
  throw Object.assign(new Error(code), { code, statusCode: 503 });
};
const unknown = () => fail("HILEHANEM_RESULT_UNKNOWN");
const headerName = (value) =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) &&
  ![
    "host",
    "content-length",
    "connection",
    "content-type",
    "accept",
    "cookie",
  ].includes(value.toLowerCase());
const states = ["completed", "rejected", "pending", "notFound"];
const fields = [
  "balance",
  "currency",
  "productId",
  "packageId",
  "stock",
  "unitCostMinor",
  "state",
  "requestId",
  "quantity",
  "reference",
  "licenses",
  "purchaseCostMinor",
];
const variables = new Set([
  "productId",
  "packageId",
  "quantity",
  "currency",
  "requestId",
  "maximumCostMinor",
  "maximumCost",
]);

function validateContract(c) {
  const invalid = () => fail("HILEHANEM_CONTRACT_INVALID");
  if (
    c?.version !== 1 ||
    !validBaseUrl(c.documentationUrl) ||
    c.idempotency?.guaranteed !== true ||
    !headerName(c.idempotency.header) ||
    !headerName(c.authentication?.name) ||
    c.authentication.name.toLowerCase() ===
      c.idempotency.header.toLowerCase() ||
    !["header", "body"].includes(c.authentication.location) ||
    !["", "Bearer "].includes(c.authentication.prefix || "") ||
    !["minor", "major"].includes(c.amountUnit || "minor") ||
    !Number.isInteger(c.minorDigits ?? 2) ||
    (c.minorDigits ?? 2) < 0 ||
    (c.minorDigits ?? 2) > 4
  )
    invalid();
  if (
    fields.some(
      (key) =>
        typeof c.fields?.[key] !== "string" || !c.fields[key].startsWith("/"),
    )
  )
    invalid();
  const seen = new Set();
  for (const state of states) {
    if (!Array.isArray(c.states?.[state]) || !c.states[state].length) invalid();
    for (const value of c.states[state]) {
      if (typeof value !== "string" || !value || seen.has(value)) invalid();
      seen.add(value);
    }
  }
  for (const name of ["balance", "package", "purchase", "lookup"]) {
    const operation = c.operations?.[name];
    if (
      !operation ||
      !["GET", "POST"].includes(operation.method) ||
      typeof operation.path !== "string" ||
      !/^\/(?!\/)/.test(operation.path) ||
      /[\\\x00-\x20\x7f?#]/.test(operation.path) ||
      operation.path.split("/").some((x) => x === ".." || x === ".") ||
      (operation.method === "GET" &&
        (operation.body || c.authentication.location === "body"))
    )
      invalid();
    const definition = JSON.stringify(operation);
    for (const token of definition.matchAll(/\{([A-Za-z]+)\}/g))
      if (!variables.has(token[1])) invalid();
    if (name === "lookup" && !definition.includes("{requestId}")) invalid();
    if (
      name === "purchase" &&
      (operation.method !== "POST" ||
        ["productId", "packageId", "quantity"].some(
          (x) => !definition.includes("{" + x + "}"),
        ) ||
        (!definition.includes("{maximumCostMinor}") &&
          !definition.includes("{maximumCost}")))
    )
      invalid();
  }
  return c;
}
function readContract(source = process.env) {
  const file = String(source.HILEHANEM_CONTRACT_FILE || "").trim();
  if (!file) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    fail("HILEHANEM_CONTRACT_INVALID");
  }
  return validateContract(config);
}
function fieldAt(data, pointer) {
  return pointer
    .split("/")
    .slice(1)
    .reduce(
      (value, part) =>
        value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
      data,
    );
}
function render(template, values, asUrl = false) {
  if (Array.isArray(template)) return template.map((x) => render(x, values));
  if (template && typeof template === "object")
    return Object.fromEntries(
      Object.entries(template).map(([k, v]) => [k, render(v, values)]),
    );
  if (typeof template !== "string") return template;
  const match = /^\{([A-Za-z]+)\}$/.exec(template);
  if (match && !asUrl) return values[match[1]];
  return template.replace(/\{([A-Za-z]+)\}/g, (_, k) =>
    asUrl ? encodeURIComponent(values[k]) : String(values[k]),
  );
}
function amount(value, scale) {
  const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2] || "").length > scale)
    fail("HILEHANEM_RESPONSE_INVALID");
  const result = Number(match[1] + (match[2] || "").padEnd(scale, "0"));
  if (!Number.isSafeInteger(result) || result > 1000000000000)
    fail("HILEHANEM_RESPONSE_INVALID");
  return result;
}
async function responseJson(response) {
  if (Number(response.headers.get("content-length")) > 2000000) unknown();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2000000) unknown();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function adapter({
  config = fromEnvironment(),
  contract = readContract(),
  fetcher = global.fetch,
} = {}) {
  if (!config.configured) fail("HILEHANEM_CONFIGURATION_REQUIRED");
  if (!contract) fail("HILEHANEM_API_CONTRACT_REQUIRED");
  validateContract(contract);
  const read = (d, k, op) =>
    fieldAt(d, contract.operations[op]?.fields?.[k] || contract.fields[k]);
  const digits = contract.minorDigits ?? 2,
    scale = contract.amountUnit === "major" ? digits : 0;
  const price = (value) => amount(value, scale);
  async function request(name, values = {}) {
    const operation = contract.operations[name],
      url = new URL(
        config.baseUrl.replace(/\/$/, "") +
          render(operation.path, values, true),
      );
    if (
      !validBaseUrl(url.href) ||
      url.origin !== new URL(config.baseUrl).origin
    )
      fail("HILEHANEM_CONTRACT_INVALID");
    for (const [key, value] of Object.entries(operation.query || {}))
      url.searchParams.set(key, render(value, values));
    const headers = { Accept: "application/json" },
      body = render(operation.body || {}, values),
      auth = contract.authentication;
    if (auth.location === "header")
      headers[auth.name] = (auth.prefix || "") + config.apiKey;
    else body[auth.name] = config.apiKey;
    if (name === "purchase")
      headers[contract.idempotency.header] = values.requestId;
    if (operation.method === "POST")
      headers["Content-Type"] = "application/json";
    try {
      const res = await fetcher(url, {
        method: operation.method,
        headers,
        ...(operation.method === "POST" ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (
        !res.ok &&
        (!["purchase", "lookup"].includes(name) ||
          ![400, 404, 409, 422].includes(res.status))
      )
        unknown();
      return { ok: res.ok, data: await responseJson(res) };
    } catch {
      unknown();
    }
  }
  const currency = (value) => {
    if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
      fail("HILEHANEM_RESPONSE_INVALID");
    return value;
  };
  async function balance() {
    const { data } = await request("balance");
    return {
      balanceMinor: price(read(data, "balance", "balance")),
      currency: currency(read(data, "currency", "balance")),
      minorDigits: digits,
    };
  }
  async function quote(binding) {
    const { data } = await request("package", binding),
      field = (key) => read(data, key, "package");
    const stock = field("stock");
    if (
      String(field("productId")) !== binding.productId ||
      String(field("packageId")) !== binding.packageId ||
      !Number.isSafeInteger(stock) ||
      stock < 0
    )
      fail("HILEHANEM_RESPONSE_INVALID");
    return {
      productId: binding.productId,
      packageId: binding.packageId,
      stock,
      unitCostMinor: price(field("unitCostMinor")),
      currency: currency(field("currency")),
    };
  }
  async function order(name, input) {
    const maximumCost = digits
      ? (input.maximumCostMinor / 10 ** digits).toFixed(digits)
      : String(input.maximumCostMinor);
    const { ok, data } = await request(name, { ...input, maximumCost }),
      field = (key) => read(data, key, name);
    const state = states.find((x) =>
      contract.states[x].includes(field("state")),
    );
    if (!state || (state === "completed" && !ok)) unknown();
    if (state === "notFound" || state === "pending") return { state };
    if (field("requestId") !== input.requestId) unknown();
    if (state === "rejected") return { state };
    const reference = field("reference"),
      licenses = field("licenses"),
      costMinor = price(field("purchaseCostMinor"));
    if (
      String(field("productId")) !== input.productId ||
      String(field("packageId")) !== input.packageId ||
      field("quantity") !== input.quantity ||
      typeof reference !== "string" ||
      !reference.trim() ||
      reference.length > 160 ||
      !Array.isArray(licenses) ||
      licenses.length !== input.quantity ||
      new Set(licenses).size !== licenses.length ||
      licenses.some(
        (x) => typeof x !== "string" || x.length < 4 || x.length > 512,
      ) ||
      field("currency") !== input.currency ||
      costMinor > input.maximumCostMinor
    )
      unknown();
    return { state, reference, licenses, costMinor, currency: input.currency };
  }
  return {
    balance,
    quote,
    purchase: (input) => order("purchase", input),
    lookup: (input) => order("lookup", input),
  };
}
function mappings(source = process.env) {
  let rows;
  try {
    rows = JSON.parse(source.HILEHANEM_PRODUCT_MAPPINGS || "[]");
  } catch {
    fail("HILEHANEM_MAPPING_INVALID");
  }
  if (!Array.isArray(rows) || rows.length > 200)
    fail("HILEHANEM_MAPPING_INVALID");
  const seen = new Set();
  return rows.map((row) => {
    if (
      !row ||
      !/^[a-z0-9][a-z0-9-]{1,79}$/.test(row.zentraProductId || "") ||
      !/^[a-z0-9][a-z0-9-]{0,39}$/.test(row.zentraPlanKey || "") ||
      !["productId", "packageId"].every(
        (k) =>
          typeof row[k] === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(row[k]),
      ) ||
      !Number.isSafeInteger(row.maximumUnitCostMinor) ||
      row.maximumUnitCostMinor < 1 ||
      !/^[A-Z]{3}$/.test(row.currency || "")
    )
      fail("HILEHANEM_MAPPING_INVALID");
    const id = row.zentraProductId + "__" + row.zentraPlanKey;
    if (seen.has(id)) fail("HILEHANEM_MAPPING_INVALID");
    seen.add(id);
    return {
      id,
      zentraProductId: row.zentraProductId,
      zentraPlanKey: row.zentraPlanKey,
      productId: row.productId,
      packageId: row.packageId,
      currency: row.currency,
      maximumUnitCostMinor: row.maximumUnitCostMinor,
    };
  });
}
module.exports = { readContract, validateContract, adapter, mappings };
