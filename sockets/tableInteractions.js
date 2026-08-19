"use strict";

/**
 * Shared socket layer for the table-interactions economy. Attach to ANY game
 * namespace — Poker (/table-game, rooms `tg:<id>`), Trix and Tarneeb41
 * (/game, rooms `trix:<id>` / `tarneeb41:<id>`). One implementation, three games.
 *
 * Client contract:
 *  emit "interaction_catalog" (ack) → { ok, items[], inventory[] }
 *  emit "send_interaction" { tableId, gameType, itemKey, targetUserId?, actionId } (ack)
 *      → ack { ok } | { ok:false, reason }
 *  on   "table_interaction" → animation event broadcast to the whole table room
 */

const svc = require("../services/tableInteractionsService");
const logger = require("../utils/logger");
const Table = require("../models/tableModel");

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {(gameType: string, tableId: string) => string|null} roomForGame
 */
function registerTableInteractionHandlers(nsp, roomForGame, fixedGameType = null) {
  nsp.on("connection", (socket) => {
    socket.on("interaction_catalog", async (_payload, ack) => {
      if (typeof ack !== "function") return;
      try {
        const [items, inventory, chatPresets] = await Promise.all([
          svc.listCatalog(),
          svc.getInventory(socket.userId),
          require("../services/tableChatPresetService")
            .listPublished()
            .catch(() => ({ emojis: [], phrases: [] })),
        ]);
        ack({
          ok: true,
          items: items.map((i) => ({
            key: i.key,
            name: i.name,
            nameAr: i.nameAr || null,
            displayName: i.displayName || null,
            icon: i.icon,
            thumbnail: i.thumbnail,
            animation: i.animation,
            rarity: i.rarity,
            category: i.category,
            subCategory: i.subCategory || null,
            price: i.price,
            effectivePrice: i.effectivePrice != null ? i.effectivePrice : i.price,
            discount: i.discount || null,
            unlimitedPrice: i.unlimitedPrice,
            perUseCost: i.perUseCost,
            currency: i.currency,
            currencyId: i.currencyId || "coins",
            vipOnly: i.vipOnly,
            seasonal: i.seasonal,
            featured: !!i.featured,
            popular: !!i.popular,
            recommended: !!i.recommended,
            limitedEdition: i.limitedEdition,
            cooldownMs: i.cooldownMs,
          })),
          inventory,
          chatPresets,
        });
      } catch (e) {
        logger.warn("interaction_catalog_failed", { reason: e?.message || "unknown" });
        ack({ ok: false, reason: "CATALOG_FAILED" });
      }
    });

    socket.on("send_interaction", async (payload, ack) => {
      const done = typeof ack === "function" ? ack : () => {};
      try {
        const { tableId, gameType, itemKey, targetUserId, actionId } = payload || {};
        if (!tableId || !itemKey) return done({ ok: false, reason: "BAD_REQUEST" });

        const resolvedGameType = fixedGameType || String(gameType || "").trim();
        if (!["poker", "trix", "tarneeb41"].includes(resolvedGameType)) {
          return done({ ok: false, reason: "BAD_REQUEST" });
        }

        // A room can contain spectators, but paid interactions are a seated
        // player privilege. Check the durable seat to prevent a spectator (or
        // a stale socket room) from spending/sending table effects.
        const room = roomForGame(resolvedGameType, String(tableId));
        if (!room || !socket.rooms.has(room)) {
          return done({ ok: false, reason: "NOT_IN_ROOM" });
        }

        const table = await Table.findOne({
          _id: String(tableId),
          gameType: resolvedGameType,
          "seats.user": socket.userId,
        })
          .select("_id seats.user")
          .lean();
        if (!table) return done({ ok: false, reason: "NOT_SEATED" });

        const targetId = targetUserId ? String(targetUserId) : null;
        if (
          targetId &&
          !(table.seats || []).some((seat) => String(seat?.user) === targetId)
        ) {
          return done({ ok: false, reason: "TARGET_NOT_IN_TABLE" });
        }

        const res = await svc.sendInteraction({
          userId: socket.userId,
          itemKey: String(itemKey),
          targetUserId: targetId,
          actionId: typeof actionId === "string" ? actionId.slice(0, 128) : null,
        });
        if (!res.ok) return done(res);

        nsp.to(room).emit("table_interaction", { ...res.event, tableId: String(tableId) });
        done({ ok: true, charge: res.charge });
      } catch (e) {
        logger.warn("send_interaction_failed", {
          userId: socket.userId,
          reason: e?.message || "unknown",
        });
        done({ ok: false, reason: "SEND_FAILED" });
      }
    });
  });
}

module.exports = { registerTableInteractionHandlers };
