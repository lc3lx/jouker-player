const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const arena = require("../services/arenaTournamentEngineService");
const catalog = require("../services/arenaTournamentCatalog");

const router = express.Router();

router.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    res.json({ status: "success", data: catalog.serializeCatalog() });
  })
);

router.get(
  "/lobby",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.listLobby(req.user._id, { game: req.query.game });
    res.json({ status: "success", results: data.length, data });
  })
);

router.get(
  "/:id",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.getDetail(req.params.id, req.user._id);
    res.json({ status: "success", data });
  })
);

router.post(
  "/",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const data = await arena.createTournament(req.user._id, req.body || {});
    res.status(201).json({ status: "success", data });
  })
);

router.post(
  "/join-code",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.registerByCode(req.user._id, req.body?.inviteCode || req.body?.code);
    res.json({ status: "success", data });
  })
);

router.post(
  "/:id/register",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.register(req.user._id, req.params.id, {
      inviteCode: req.body?.inviteCode || req.body?.code,
    });
    res.json({ status: "success", data });
  })
);

router.post(
  "/:id/unregister",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.unregister(req.user._id, req.params.id);
    res.json({ status: "success", data });
  })
);

router.post(
  "/:id/enter",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.enter(req.user._id, req.params.id);
    res.json({ status: "success", data });
  })
);

router.post(
  "/:id/cancel",
  authService.protect,
  asyncHandler(async (req, res) => {
    const data = await arena.cancelTournament(req.params.id, "Cancelled by creator", {
      actorId: req.user._id,
    });
    res.json({ status: "success", data });
  })
);

module.exports = router;
