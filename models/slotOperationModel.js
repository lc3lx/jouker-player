const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: String, required: true },
  game: { type: String, required: true },
  requestId: { type: String, required: true },
  fingerprint: { type: String, required: true },
  response: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, collection: "slot_operations" });
schema.index({ userId: 1, game: 1, requestId: 1 }, { unique: true });
module.exports = mongoose.model("SlotOperation", schema);
