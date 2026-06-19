const mongoose = require("mongoose");

const checkpointPointSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true, min: 0 },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
    radius: { type: Number, required: true, min: 0.5, default: 3 },
  },
  { _id: false }
);

const parkourCheckpointSchema = new mongoose.Schema(
  {
    trackId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    nameEn: { type: String },
    description: { type: String },
    checkpoints: [checkpointPointSchema],
    finishLine: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      z: { type: Number, required: true },
      radius: { type: Number, required: true, min: 0.5, default: 4 },
    },
    spawnPoint: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      z: { type: Number, default: 0 },
    },
    maxPlayers: { type: Number, default: 20, min: 2, max: 20 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ParkourCheckpoint", parkourCheckpointSchema);
