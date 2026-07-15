"use strict";

const mongoose = require("mongoose");
const { VIP_LEVELS } = require("../config/vipConfig");

const STATUSES = ["pending", "approved", "rejected", "cancelled"];

const vipPurchaseRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    level: { type: String, enum: VIP_LEVELS, required: true },
    status: { type: String, enum: STATUSES, default: "pending", index: true },
    /** Snapshot of store price when the user submitted the request. */
    priceUsd: { type: Number, default: 0, min: 0 },
    userNote: { type: String, default: null, trim: true, maxlength: 500 },
    adminNote: { type: String, default: null, trim: true, maxlength: 500 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

vipPurchaseRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });
vipPurchaseRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("VIPPurchaseRequest", vipPurchaseRequestSchema);
module.exports.STATUSES = STATUSES;
