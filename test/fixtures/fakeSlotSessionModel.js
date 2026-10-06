"use strict";

// Minimal stand-in for a bonus-session mongoose model, so slotOperation's
// Mongo path can run without a database (no session doc, no requestId).
module.exports = {
  findOne: () => ({ session: () => ({ lean: async () => null }) }),
  updateOne: async () => ({ matchedCount: 1 }),
  deleteOne: async () => ({ deletedCount: 1 }),
};
