"use strict";

// Collections/indexes must exist before the first financial transaction.
async function ensureSlotProductionIndexes() {
  for (const name of ["poseidonBonusSessionModel", "zenobiaBonusSessionModel",
    "goldenTreeBonusSessionModel", "kingArthBonusSessionModel", "slotOperationModel",
    "poseidonJackpotRoundModel", "miniGamePlayModel"]) {
    const Model = require(`../models/${name}`);
    await Model.createCollection();
    await Model.createIndexes();
  }
}

module.exports = { ensureSlotProductionIndexes };
