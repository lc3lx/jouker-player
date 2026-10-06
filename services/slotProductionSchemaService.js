"use strict";

// Collections/indexes must exist before the first financial transaction.
async function ensureSlotProductionIndexes() {
  for (const name of ["poseidonBonusSessionModel", "zenobiaBonusSessionModel",
    "goldenTreeBonusSessionModel", "kingArthBonusSessionModel", "slotOperationModel",
    "poseidonJackpotRoundModel", "miniGamePlayModel"]) {
    const Model = require(`../models/${name}`);
    await Model.createCollection();
    if (name === "poseidonJackpotRoundModel") await dropJackpotDeletionTtl(Model);
    await Model.createIndexes();
  }
}

/**
 * Jackpot rounds used to carry a TTL index on `expiresAt`, so MongoDB deleted
 * every round 10 minutes after it was created — paid or not. Mongoose never
 * drops an index it no longer declares, so remove it here explicitly.
 */
async function dropJackpotDeletionTtl(Model) {
  const indexes = await Model.collection.indexes();
  for (const index of indexes) {
    const keys = Object.keys(index.key || {});
    if (keys.length === 1 && keys[0] === "expiresAt" && index.expireAfterSeconds != null) {
      await Model.collection.dropIndex(index.name);
    }
  }
}

module.exports = { ensureSlotProductionIndexes, dropJackpotDeletionTtl };
