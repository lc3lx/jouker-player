const mongoose = require("mongoose");

const achievementSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String },
    points: { type: Number, default: 0 },
    icon: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

achievementSchema.pre("save", function (next) {
  if (this.code) this.code = this.code.toUpperCase();
  next();
});

module.exports = mongoose.model("Achievement", achievementSchema);
