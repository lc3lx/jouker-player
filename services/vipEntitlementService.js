"use strict";

/**
 * What an active VIP subscription lets a player wear.
 *
 * VIP cosmetics used to be applied, never owned: `resolveEffectiveSeatCosmetics`
 * forced the subscriber's tier felt and card back over whatever they had
 * equipped, and nothing was ever written into their inventory. So a subscriber
 * saw VIP art they had not chosen, could not turn it off, could not swap it,
 * and found none of it in the store — "ماطلو السكنات تبع الVIP عندي".
 *
 * The fix is entitlement rather than a grant. A VIP-gated item is *owned while
 * the subscription is active*: it shows up as owned, equips like anything else,
 * and simply stops being owned when the subscription lapses. Nothing has to be
 * written on subscribe or cleaned up on expiry, and there is no state to get
 * out of step with the subscription.
 */

/** Lowest to highest. Ordering is for ranking seats, not for inheritance. */
const VIP_ORDER = ["bronze", "silver", "gold", "platinum"];

function normalizeLevel(level) {
  const s = String(level || "").toLowerCase().trim();
  return VIP_ORDER.includes(s) ? s : null;
}

/** 0 for "not a VIP", 1..4 upward. */
function vipRank(level) {
  const s = normalizeLevel(level);
  return s ? VIP_ORDER.indexOf(s) + 1 : 0;
}

/** Does this cosmetic come with a subscription rather than a purchase? */
function isVipGated(item) {
  return !!(item && normalizeLevel(item.vipLevelRequired));
}

/**
 * Does `userLevel` entitle the player to `requiredLevel`?
 *
 * **A tier gets its own set and nothing else.** This used to be cumulative
 * (`vipRank(user) >= vipRank(need)`), which handed a platinum member all
 * sixteen items at once — "لي دخلت الدنيا ببعضا". The set is the tier's
 * identity: a platinum table should say platinum on sight, and it cannot if
 * the platinum member is sitting on the bronze felt. Higher tiers are worth
 * more because their art is better, not because they hold more of it.
 *
 * An unknown or missing requirement is not a VIP gate at all.
 */
function entitles(userLevel, requiredLevel) {
  const need = normalizeLevel(requiredLevel);
  if (!need) return false;
  return normalizeLevel(userLevel) === need;
}

/**
 * May this player equip this item right now?
 *
 * Ownership is still the rule for everything bought. A VIP-gated item is not
 * bought — it is held for as long as the subscription is.
 */
function canEquip({ item, isOwned, vipLevel }) {
  if (!item) return false;
  if (isVipGated(item)) return entitles(vipLevel, item.vipLevelRequired);
  return !!isOwned;
}

/** VIP-gated items are never for sale; the subscription is the price. */
function isPurchasable(item) {
  return !!item && !isVipGated(item);
}

/**
 * The felt the whole table wears.
 *
 * Two rules the player asked for at once — "the priority of display is VIP's"
 * and "while I'm playing I can change the table" — which only fit together if
 * VIP priority means *whose choice wins*, not *which picture wins*. So the
 * highest seated VIP decides the felt: their equipped theme when they have one,
 * their tier felt when they do not. With no VIP seated it falls to the
 * lowest-seated player who has a theme equipped, which is stable — the same
 * players in the same seats always produce the same felt.
 *
 * @param {Array<{vipLevel?: string|null, equippedTableTheme?: string|null,
 *                seatIndex?: number}>} seats
 * @param {(level: string) => ({tableTheme?: string, tableAsset?: string}|null)} vipCosmeticsFor
 */
function resolveTableFelt(seats, vipCosmeticsFor) {
  let best = null;
  let bestRank = 0;
  let equippedTheme = null;
  let equippedSeat = Infinity;

  for (const row of seats || []) {
    const rank = vipRank(row?.vipLevel);
    if (rank > bestRank) {
      bestRank = rank;
      best = row;
    }
    const theme = row?.equippedTableTheme || null;
    if (theme) {
      const seat = Number.isFinite(row?.seatIndex) ? row.seatIndex : Infinity;
      if (seat < equippedSeat) {
        equippedSeat = seat;
        equippedTheme = theme;
      }
    }
  }

  if (best) {
    // Their own choice first: a VIP who swaps the felt mid-game is exercising
    // the priority, not losing it. Falling straight through to the tier felt
    // here is what made the table impossible to change.
    if (best.equippedTableTheme) {
      return { activeTableTheme: best.equippedTableTheme, activeTableAsset: null };
    }
    const vip = vipCosmeticsFor(best.vipLevel);
    if (vip?.tableTheme) {
      return {
        activeTableTheme: vip.tableTheme,
        activeTableAsset: vip.tableAsset || null,
      };
    }
  }

  if (equippedTheme) {
    return { activeTableTheme: equippedTheme, activeTableAsset: null };
  }
  return { activeTableTheme: null, activeTableAsset: null };
}

module.exports = {
  VIP_ORDER,
  normalizeLevel,
  vipRank,
  isVipGated,
  entitles,
  canEquip,
  isPurchasable,
  resolveTableFelt,
};
