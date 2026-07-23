const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const friendService = require("../services/friendService");
const invitationService = require("../services/invitationService");
const presenceService = require("../services/presenceService");
const clanBadgeService = require("../services/clanBadgeService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("user"));

router.get("/friends", asyncHandler(async (req, res) => {
  const friends = await friendService.listFriends(req.user._id);
  const ids = friends.map((f) => f.userId);
  const [presence, clanBadges] = await Promise.all([
    presenceService.getPresenceBatch(ids),
    clanBadgeService.attachBadges(ids),
  ]);
  res.json({
    results: friends.length,
    data: friends.map((f) => ({
      ...f,
      presence: presence[f.userId] || null,
      clan: clanBadges[f.userId] || null,
    })),
  });
}));

router.get("/requests", asyncHandler(async (req, res) => {
  const data = await friendService.listPendingRequests(req.user._id);
  res.json({ data });
}));

router.get("/users/search", asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ results: 0, data: [] });
  }
  const User = require("../models/userModel");
  const rows = await User.find({
    _id: { $ne: req.user._id },
    active: { $ne: false },
    name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" },
  })
    .select("name profileImg")
    .limit(12)
    .lean();
  res.json({
    results: rows.length,
    data: rows.map((u) => ({
      id: String(u._id),
      name: u.name,
      avatar: u.profileImg || null,
    })),
  });
}));

router.post("/friends/request", asyncHandler(async (req, res) => {
  const reqDoc = await friendService.sendFriendRequest(
    req.user._id,
    req.body.toUserId,
    req.body.message
  );
  res.status(201).json({ data: reqDoc });
}));

router.post("/friends/accept/:requestId", asyncHandler(async (req, res) => {
  const friendship = await friendService.acceptFriendRequest(req.user._id, req.params.requestId);
  res.json({ data: friendship });
}));

router.post("/friends/reject/:requestId", asyncHandler(async (req, res) => {
  const data = await friendService.rejectFriendRequest(req.user._id, req.params.requestId);
  res.json({ data });
}));

router.post("/friends/cancel/:requestId", asyncHandler(async (req, res) => {
  const data = await friendService.cancelFriendRequest(req.user._id, req.params.requestId);
  res.json({ data });
}));

router.delete("/friends/:friendUserId", asyncHandler(async (req, res) => {
  const data = await friendService.removeFriend(req.user._id, req.params.friendUserId);
  res.json({ data });
}));

router.post("/block/:userId", asyncHandler(async (req, res) => {
  const data = await friendService.blockUser(req.user._id, req.params.userId);
  res.json({ data });
}));

router.delete("/block/:userId", asyncHandler(async (req, res) => {
  const data = await friendService.unblockUser(req.user._id, req.params.userId);
  res.json({ data });
}));

router.post("/invitations", asyncHandler(async (req, res) => {
  const invite = await invitationService.sendInvitation(req.user._id, {
    toUserId: req.body.toUserId,
    gameType: req.body.gameType,
    tableId: req.body.tableId,
    tournamentId: req.body.tournamentId,
    tableNumber: req.body.tableNumber,
    displayName: req.body.displayName,
    joinPayload: req.body.joinPayload,
  });
  res.status(201).json({ data: invite });
}));

router.get("/invitations/pending", asyncHandler(async (req, res) => {
  const data = await invitationService.listPendingInvitations(req.user._id);
  res.json({ results: data.length, data });
}));

router.post("/invitations/:id/accept", asyncHandler(async (req, res) => {
  const data = await invitationService.respondInvitation(req.user._id, req.params.id, true);
  res.json({ data });
}));

router.post("/invitations/:id/decline", asyncHandler(async (req, res) => {
  const data = await invitationService.respondInvitation(req.user._id, req.params.id, false);
  res.json({ data });
}));

router.delete("/invitations/:id", asyncHandler(async (req, res) => {
  const data = await invitationService.cancelInvitation(req.user._id, req.params.id);
  res.json({ data });
}));

router.get("/presence/:userId", asyncHandler(async (req, res) => {
  const data = await presenceService.getPresence(req.params.userId);
  res.json({ data });
}));

module.exports = router;
