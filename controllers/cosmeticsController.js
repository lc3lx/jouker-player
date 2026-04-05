const {
  listCatalog,
  listFeatured,
  listRecommended,
  getMe,
  buyCosmetic,
  equipCosmetic,
  autoEquipAfterBuy,
} = require("../services/cosmeticsService");
const { refreshCosmeticsForUserOnTables } = require("../sockets/tableGame");

exports.getCatalog = async (req, res, next) => {
  try {
    const data = await listCatalog();
    res.status(200).json({ status: "success", results: data.length, data });
  } catch (e) {
    next(e);
  }
};

exports.getFeatured = async (req, res, next) => {
  try {
    const data = await listFeatured();
    res.status(200).json({ status: "success", results: data.length, data });
  } catch (e) {
    next(e);
  }
};

exports.getRecommended = async (req, res, next) => {
  try {
    const data = await listRecommended(req.user._id);
    res.status(200).json({ status: "success", results: data.length, data });
  } catch (e) {
    next(e);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const data = await getMe(req.user._id);
    res.status(200).json({ status: "success", data });
  } catch (e) {
    next(e);
  }
};

exports.postBuy = async (req, res, next) => {
  try {
    const cosmeticId = req.body?.cosmeticId;
    const autoEquip = !!req.body?.autoEquip;
    await buyCosmetic(req.user._id, cosmeticId);
    if (autoEquip) {
      await autoEquipAfterBuy(req.user._id, cosmeticId);
      await refreshCosmeticsForUserOnTables(req.user._id);
    }
    const data = await getMe(req.user._id);
    res.status(200).json({ status: "success", data });
  } catch (e) {
    next(e);
  }
};

exports.postEquip = async (req, res, next) => {
  try {
    const cosmeticId = req.body?.cosmeticId;
    await equipCosmetic(req.user._id, cosmeticId);
    await refreshCosmeticsForUserOnTables(req.user._id);
    const data = await getMe(req.user._id);
    res.status(200).json({ status: "success", data });
  } catch (e) {
    next(e);
  }
};
