"use strict";

const fs = require("fs/promises");
const path = require("path");
const { normalizeTableArtwork } = require("../utils/normalizeTableArtwork");

/** Opt-in processed view of legacy artwork. Originals are never overwritten. */
function tableArtworkMiddleware(root, kind) {
  const cache = new Map();
  const base = path.resolve(root);
  return async (req, res, next) => {
    if (req.query.tableArt !== "3" || !["GET", "HEAD"].includes(req.method)) return next();
    let relative;
    try { relative = decodeURIComponent(req.path).replace(/^\/+/, ""); }
    catch { return res.status(400).end(); }
    const allowed = kind === "uploads"
      ? /^cosmetics\/[^/]+\.(png|jpe?g|webp)$/i
      : /^(tables\/[^/]+|vip\/[^/]+\/taple_[^/]+)\.(png|jpe?g|webp)$/i;
    if (!allowed.test(relative) || relative.includes("\\") || relative.split("/").some(p => p.startsWith("."))) return res.status(404).end();
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep)) return res.status(404).end();
    try {
      const real = await fs.realpath(file);
      if (!real.startsWith(base + path.sep)) return res.status(404).end();
      const stat = await fs.stat(real);
      const key = `${real}:${stat.mtimeMs}:${stat.size}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = fs.readFile(real).then(normalizeTableArtwork);
        cache.set(key, pending);
        while (cache.size > 24) cache.delete(cache.keys().next().value);
        pending.catch(() => cache.delete(key));
      }
      const png = await pending;
      res.set("Cache-Control", "public, max-age=3600");
      return res.type("png").send(png);
    } catch (error) {
      if (error.code === "ENOENT") return res.status(404).end();
      return next(error);
    }
  };
}

module.exports = { tableArtworkMiddleware };
