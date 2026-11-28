"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const M = require("@imagemagick/magick-wasm");

const vector = require("@resvg/resvg-wasm");
const heic = require("heic-decode");
let initialized;
const checkDimensions = (width, height) => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 10000 ||
    height > 10000 ||
    width * height > 25000000
  )
    throw Error("Geçersiz görsel boyutu");
};
async function decodeSource(buffer, ext) {
  const header = buffer.subarray(0, 65536).toString("utf8");
  if (
    ext === ".svg" ||
    (/<svg(?:\s|>)/i.test(header) && /^\s*(?:<|\uFEFF)/.test(header))
  ) {
    let svg, resized, rendered;
    try {
      svg = new vector.Resvg(buffer);
      checkDimensions(svg.width, svg.height);
      if (Math.max(svg.width, svg.height) > 2400)
        resized = new vector.Resvg(buffer, {
          fitTo: {
            mode: svg.width >= svg.height ? "width" : "height",
            value: 2400,
          },
        });
      rendered = (resized || svg).render();
      return { bytes: Buffer.from(rendered.asPng()), converted: true };
    } finally {
      rendered?.free();
      resized?.free();
      svg?.free();
    }
  }
  if (
    buffer.subarray(4, 8).toString() === "ftyp" &&
    /^(?:mif1|msf1|heic|heix|hevc|hevx)$/.test(
      buffer.subarray(8, 12).toString(),
    )
  ) {
    const frames = await heic.all({ buffer });
    try {
      checkDimensions(frames[0].width, frames[0].height);
      const { data, width, height } = await frames[0].decode();
      const pam = [
        "P7",
        "WIDTH " + width,
        "HEIGHT " + height,
        "DEPTH 4",
        "MAXVAL 255",
        "TUPLTYPE RGB_ALPHA",
        "ENDHDR",
        "",
      ].join("\n");
      return {
        bytes: Buffer.concat([Buffer.from(pam), Buffer.from(data)]),
        converted: true,
      };
    } finally {
      frames.dispose();
    }
  }
  return { bytes: buffer, converted: false };
}
const native = new Map(
  Object.entries({
    JPEG: [".jpg", ".jpeg", ".jfif"],
    PNG: [".png"],
    APNG: [".apng", ".png"],
    WEBP: [".webp"],
    GIF: [".gif"],
    ICO: [".ico"],
  }),
);
const skipped = new Set([
  ".woff",
  ".woff2",
  ".css",
  ".js",
  ".mjs",
  ".webmanifest",
  ".wasm",
  ".txt",
  ".json",
  ".html",
  ".md",
  ".map",
  ".xml",
]);
const documents = new Set([
  "PDF",
  "PS",
  "EPS",
  "XPS",
  "MSL",
  "MVG",
  "TXT",
  "LABEL",
  "HTML",
  "TEXT",
  "URL",
  "HTTPS",
  "HTTP",
]);
async function build(root = path.resolve(__dirname, "..")) {
  const assets = path.join(root, "public"),
    previews = path.join(root, "public/gallery-previews");
  const renditions = new Map();
  const entries = new Map(),
    generated = new Set(),
    rejected = [];
  initialized ??= Promise.all([
    M.initializeImageMagick(
      fs.readFileSync(require.resolve("@imagemagick/magick-wasm/magick.wasm")),
    ),
    vector.initWasm(
      fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")),
    ),
  ]);
  await initialized;
  Object.assign(M.ResourceLimits, {
    width: 10000n,
    height: 10000n,
    area: 25000000n,
    memory: 192000000n,
    maxMemoryRequest: 128000000n,
    disk: 0n,
    time: 12n,
    listLength: 100n,
  });
  async function visit(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (file === previews) continue;
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || skipped.has(ext)) continue;
      const original =
          "/" + path.relative(root, file).split(path.sep).join("/"),
        key = original.normalize("NFC");
      if (entries.has(key))
        throw new Error(
          "Aynı Unicode yoluna karşılık gelen iki dosya var: " + original,
        );
      if (fs.statSync(file).size > 20000000) {
        rejected.push(original);
        continue;
      }
      let output;
      try {
        const buffer = fs.readFileSync(file);
        if (
          !buffer.length ||
          /^(?:\s*<!(?:DOCTYPE\s+html)|\s*<html\b)/i.test(
            buffer.subarray(0, 512).toString(),
          )
        )
          throw Error();
        const ico = buffer.length >= 6 && buffer.readUInt32LE(0) === 65536;
        const source = await decodeSource(buffer, ext);
        M.ImageMagick.read(
          source.bytes,
          new M.MagickReadSettings({
            frameIndex: 0,
            frameCount: 1,
            ...(ico ? { format: M.MagickFormat.Ico } : {}),
            ...(!source.converted && ext === ".tga"
              ? { format: M.MagickFormat.Tga }
              : {}),
          }),
          (image) => {
            const format = String(image.format).toUpperCase();
            if (
              documents.has(format) ||
              !image.width ||
              !image.height ||
              image.width * image.height > 25000000
            )
              throw Error();
            if (key.startsWith("/public/assets/products/") && ["JPEG", "PNG", "WEBP"].includes(format)) {
              const width = image.width;
              const variants = { width };
              const digest = crypto.createHash("sha256").update(buffer).digest("hex");
              const sizes = [[192, "thumbnail"]];
              if (width > 1000 && buffer.length > 120000) sizes.push([720, "medium"]);
              for (const [size, field] of sizes) {
                if (width <= size) continue;
                const name = digest + "-" + size + "-v1.webp";
                const destination = path.join(previews, name);
                if (!fs.existsSync(destination)) {
                  image.clone(copy => {
                    copy.autoOrient();
                    copy.thumbnail(new M.MagickGeometry(String(size) + "x>"));
                    copy.strip();
                    copy.quality = size === 192 ? 78 : 86;
                    copy.write(M.MagickFormat.WebP, bytes => {
                      fs.mkdirSync(previews, { recursive: true });
                      fs.writeFileSync(destination, bytes);
                    });
                  });
                }
                generated.add(name);
                variants[field] = "/public/gallery-previews/" + name;
              }
              if (variants.thumbnail) renditions.set(original, variants);
            }
            if (
              !source.converted &&
              ((ico && ext === ".ico") || native.get(format)?.includes(ext))
            ) {
              output = original;
              return;
            }
            image.autoOrient();
            if (image.width > 2400 || image.height > 2400)
              image.resize(new M.MagickGeometry("2400x2400>"));
            image.strip();
            image.write(M.MagickFormat.Png, (bytes) => {
              const name =
                crypto.createHash("sha256").update(bytes).digest("hex") +
                ".png";
              fs.mkdirSync(previews, { recursive: true });
              fs.writeFileSync(path.join(previews, name), bytes);
              generated.add(name);
              output = "/public/gallery-previews/" + name;
            });
          },
        );
      } catch {
        rejected.push(original);
      }
      if (output) entries.set(key, output);
    }
  }
  await visit(assets);
  if (fs.existsSync(previews))
    for (const file of fs.readdirSync(previews))
      if (/^[a-f0-9]{64}(?:\.png|-(?:192|720)-v1\.webp)$/.test(file) && !generated.has(file))
        fs.unlinkSync(path.join(previews, file));
  const dataDir = path.join(root, "public/data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "repository-images.mjs"),
    "// Generated by scripts/build-repository-images.cjs from deployed assets.\nexport const repositoryImages = Object.freeze(" +
      JSON.stringify(Object.fromEntries(entries), null, 2) +
      ");\n",
  );
  fs.writeFileSync(path.join(dataDir, "image-renditions.mjs"),
    "// Generated by scripts/build-repository-images.cjs.\nexport const renditions = " +
    JSON.stringify(Object.fromEntries(renditions), null, 2) + ";\n");
  for (const file of rejected)
    process.stderr.write("Görsel olarak okunamadı: " + file + "\n");
  return {
    images: entries.size,
    previews: generated.size,
    rejected: rejected.length,
  };
}
module.exports = { build };
if (require.main === module)
  build()
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
