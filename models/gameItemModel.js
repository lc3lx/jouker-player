const mongoose = require("mongoose");
const slugify = require("slugify");

const gameItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, lowercase: true },
    description: { type: String },
    price: { type: Number, required: true, min: [0, "Price cannot be negative"] },
    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary"],
      default: "common",
    },
    stock: { type: Number, default: 0, min: [0, "Stock cannot be negative"] },
    image: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

gameItemSchema.pre("save", function (next) {
  if (this.isModified("name") && this.name) {
    this.slug = slugify(this.name);
  }
  next();
});

module.exports = mongoose.model("GameItem", gameItemSchema);
