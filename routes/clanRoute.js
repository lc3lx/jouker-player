const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const clanService = require("../services/clanService");
const clanMembershipService = require("../services/clanMembershipService");
const clanInvitationService = require("../services/clanInvitationService");
const clanRequestService = require("../services/clanRequestService");
const clanTreasuryService = require("../services/clanTreasuryService");
const clanTournamentEngine = require("../services/clanTournamentEngineService");
const clanEventService = require("../services/clanEventService");
const clanAchievementService = require("../services/clanAchievementService");
const clanLeaderboardService = require("../services/clanLeaderboardService");
const clanBadgeService = require("../services/clanBadgeService");
const chatService = require("../services/chatService");
const ClanMember = require("../models/clanMemberModel");
const ApiError = require("../utils/apiError");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("user"));

/** Guard: the caller must be a member of :id. Returns the membership doc. */
async function requireMemberOf(req) {
  const member = await ClanMember.findOne({ clan: req.params.id, user: req.user._id }).lean();
  if (!member) throw new ApiError("You are not a member of this clan", 403);
  return member;
}

// ─── my clan ──────────────────────────────────────────────────────────────────
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const membership = await clanMembershipService.getMembership(req.user._id);
    res.json({ data: membership });
  })
);

// ─── invitations I received (recipient side) ──────────────────────────────────
router.get(
  "/invitations/mine",
  asyncHandler(async (req, res) => {
    const data = await clanInvitationService.listMyInvitations(req.user._id);
    res.json({ results: data.length, data });
  })
);

router.post(
  "/invitations/:invitationId/accept",
  asyncHandler(async (req, res) => {
    const data = await clanInvitationService.acceptInvitation(req.user._id, req.params.invitationId);
    res.json({ data });
  })
);

router.post(
  "/invitations/:invitationId/decline",
  asyncHandler(async (req, res) => {
    const data = await clanInvitationService.declineInvitation(req.user._id, req.params.invitationId);
    res.json({ data });
  })
);

router.delete(
  "/invitations/:invitationId",
  asyncHandler(async (req, res) => {
    const data = await clanInvitationService.cancelInvitation(req.user._id, req.params.invitationId);
    res.json({ data });
  })
);

// ─── join requests I sent + moderation of incoming requests ───────────────────
router.get(
  "/requests/mine",
  asyncHandler(async (req, res) => {
    const data = await clanRequestService.listMyRequests(req.user._id);
    res.json({ results: data.length, data });
  })
);

router.post(
  "/requests/:requestId/cancel",
  asyncHandler(async (req, res) => {
    const data = await clanRequestService.cancelMyRequest(req.user._id, req.params.requestId);
    res.json({ data });
  })
);

router.post(
  "/requests/:requestId/accept",
  asyncHandler(async (req, res) => {
    const data = await clanRequestService.acceptRequest(req.user._id, req.params.requestId);
    res.json({ data });
  })
);

router.post(
  "/requests/:requestId/reject",
  asyncHandler(async (req, res) => {
    const data = await clanRequestService.rejectRequest(req.user._id, req.params.requestId);
    res.json({ data });
  })
);

// ─── badge lookup: resolve clan badges for a set of users (any surface) ───────
router.post(
  "/badges",
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.slice(0, 100) : [];
    const data = await clanBadgeService.attachBadges(ids);
    res.json({ data });
  })
);

// ─── leaderboards (public to authed users) ────────────────────────────────────
router.get(
  "/leaderboards",
  asyncHandler(async (req, res) => {
    const data = await clanLeaderboardService.getLeaderboard({
      scope: req.query.scope,
      country: req.query.country,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ results: data.data.length, ...data });
  })
);

// ─── browse / search ────────────────────────────────────────────────────────
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await clanService.browseClans({
      q: req.query.q,
      country: req.query.country,
      language: req.query.language,
      joinType: req.query.joinType,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ results: result.data.length, ...result });
  })
);

// ─── create ───────────────────────────────────────────────────────────────────
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const clan = await clanService.createClan(req.user._id, req.body || {});
    res.status(201).json({ data: clan });
  })
);

// ─── single clan profile ──────────────────────────────────────────────────────
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const clan = await clanService.getClanProfile(req.params.id, req.user._id);
    res.json({ data: clan });
  })
);

// ─── edit ───────────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const clan = await clanService.editClan(req.user._id, req.params.id, req.body || {});
    res.json({ data: clan });
  })
);

// ─── disband (owner) ──────────────────────────────────────────────────────────
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.disbandClan(req.user._id, req.params.id);
    res.json({ data });
  })
);

// ─── membership ───────────────────────────────────────────────────────────────
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const members = await clanMembershipService.listMembers(req.params.id);
    res.json({ results: members.length, data: members });
  })
);

router.post(
  "/:id/join",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.joinClan(req.user._id, req.params.id, {
      message: req.body?.message,
    });
    res.json({ data });
  })
);

// send an invitation to a user (permission: invite)
router.post(
  "/:id/invitations",
  asyncHandler(async (req, res) => {
    const data = await clanInvitationService.sendInvitation(
      req.user._id,
      req.params.id,
      req.body?.userId,
      req.body?.message
    );
    res.status(201).json({ data });
  })
);

// list this clan's outgoing pending invitations (members)
router.get(
  "/:id/invitations",
  asyncHandler(async (req, res) => {
    await requireMemberOf(req);
    const data = await clanInvitationService.listClanInvitations(req.params.id);
    res.json({ results: data.length, data });
  })
);

// list pending join requests (permission: acceptRequests, enforced in service)
router.get(
  "/:id/requests",
  asyncHandler(async (req, res) => {
    const data = await clanRequestService.listRequests(req.user._id, req.params.id);
    res.json({ results: data.length, data });
  })
);

router.post(
  "/leave",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.leaveClan(req.user._id);
    res.json({ data });
  })
);

router.post(
  "/:id/members/:userId/kick",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.kickMember(req.user._id, req.params.id, req.params.userId);
    res.json({ data });
  })
);

router.post(
  "/:id/members/:userId/role",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.setMemberRole(
      req.user._id,
      req.params.id,
      req.params.userId,
      req.body?.role
    );
    res.json({ data });
  })
);

router.post(
  "/:id/members/:userId/transfer",
  asyncHandler(async (req, res) => {
    const data = await clanMembershipService.transferOwnership(
      req.user._id,
      req.params.id,
      req.params.userId
    );
    res.json({ data });
  })
);

// ─── tournaments ──────────────────────────────────────────────────────────────
router.get(
  "/:id/tournaments",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.listTournaments(req.params.id, {
      lifecycle: req.query.lifecycle,
    });
    res.json({ results: data.length, data });
  })
);

router.post(
  "/:id/tournaments",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.createTournament(req.user._id, req.params.id, req.body || {});
    res.status(201).json({ data });
  })
);

router.get(
  "/:id/tournaments/:tid",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.getTournamentDetail(req.params.tid);
    res.json({ data });
  })
);

router.post(
  "/:id/tournaments/:tid/register",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.register(req.user._id, req.params.tid);
    res.json({ data });
  })
);

router.post(
  "/:id/tournaments/:tid/unregister",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.unregister(req.user._id, req.params.tid);
    res.json({ data });
  })
);

router.post(
  "/:id/tournaments/:tid/cancel",
  asyncHandler(async (req, res) => {
    const data = await clanTournamentEngine.cancelTournament(req.user._id, req.params.tid);
    res.json({ data });
  })
);

// ─── events ─────────────────────────────────────────────────────────────────
router.get(
  "/:id/events",
  asyncHandler(async (req, res) => {
    const data = await clanEventService.listEvents(req.params.id, {
      upcoming: req.query.upcoming === "true" || req.query.upcoming === "1",
    });
    res.json({ results: data.length, data });
  })
);

router.post(
  "/:id/events",
  asyncHandler(async (req, res) => {
    const data = await clanEventService.createEvent(req.user._id, req.params.id, req.body || {});
    res.status(201).json({ data });
  })
);

router.post(
  "/:id/events/:eventId/rsvp",
  asyncHandler(async (req, res) => {
    const attending = req.body?.attending !== false;
    const data = await clanEventService.rsvp(req.user._id, req.params.eventId, attending);
    res.json({ data });
  })
);

router.delete(
  "/:id/events/:eventId",
  asyncHandler(async (req, res) => {
    const data = await clanEventService.cancelEvent(req.user._id, req.params.eventId);
    res.json({ data });
  })
);

// ─── achievements ─────────────────────────────────────────────────────────────
router.get(
  "/:id/achievements",
  asyncHandler(async (req, res) => {
    const data = await clanAchievementService.listAchievements(req.params.id);
    res.json({ data });
  })
);

// ─── treasury (members only) ──────────────────────────────────────────────────
router.get(
  "/:id/treasury",
  asyncHandler(async (req, res) => {
    await requireMemberOf(req);
    const data = await clanTreasuryService.getTreasury(req.params.id);
    res.json({ data });
  })
);

router.get(
  "/:id/treasury/transactions",
  asyncHandler(async (req, res) => {
    await requireMemberOf(req);
    const data = await clanTreasuryService.listTransactions(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ results: data.data.length, ...data });
  })
);

router.post(
  "/:id/treasury/donate",
  asyncHandler(async (req, res) => {
    const data = await clanTreasuryService.donate(req.user._id, req.params.id, req.body?.amount);
    res.json({ data });
  })
);

// ─── clan chat history (members only; live send/typing over /clan socket) ─────
router.get(
  "/:id/chat",
  asyncHandler(async (req, res) => {
    await requireMemberOf(req);
    const rows = await chatService.getHistory({
      channel: "clan",
      channelId: req.params.id,
      before: req.query.before || null,
      limit: parseInt(req.query.limit || "50", 10),
    });
    res.json({
      results: rows.length,
      data: rows.map((m) => ({
        id: String(m._id),
        senderId: m.sender ? String(m.sender._id || m.sender) : null,
        senderName: m.sender?.name || null,
        senderAvatar: m.sender?.profileImg || null,
        body: m.body || "",
        emoji: m.emoji || null,
        system: !!(m.meta && m.meta.system),
        meta: m.meta || null,
        createdAt: m.createdAt,
      })),
    });
  })
);

router.post(
  "/:id/chat",
  asyncHandler(async (req, res) => {
    const msg = await chatService.sendMessage({
      senderId: req.user._id,
      channel: "clan",
      channelId: req.params.id,
      body: req.body?.body,
      emoji: req.body?.emoji,
    });
    res.status(201).json({ data: { id: String(msg._id) } });
  })
);

module.exports = router;
