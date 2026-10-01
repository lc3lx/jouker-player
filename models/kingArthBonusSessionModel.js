const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: String, required: true },
  tableId: { type: String, required: true },
  session: { type: mongoose.Schema.Types.Mixed, default: null },
  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "king_arth_bonus_sessions" });
schema.index({ userId: 1, tableId: 1 }, { unique: true });
module.exports = mongoose.model("KingArthBonusSession", schema);
