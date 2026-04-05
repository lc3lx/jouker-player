const express = require("express");
const authService = require("../services/authService");

const router = express.Router();

router.get("/ice-servers", authService.protect, (req, res) => {
  const stun = process.env.STUN_URL || "stun:stun.l.google.com:19302";
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  const iceServers = [{ urls: stun }];
  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  }

  res.status(200).json({ iceServers });
});

module.exports = router;
