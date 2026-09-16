const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.ObjectId, required: true, index: true },
  tableId: { type: String, required: true },
  handId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
}, { timestamps: true });
schema.index({ userId: 1, handId: 1 }, { unique: true });
module.exports = mongoose.model('IslandTicket', schema);
