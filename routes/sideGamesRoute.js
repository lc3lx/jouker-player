const express = require("express");
const authService = require("../services/authService");
const { listTypes, play } = require("../services/sideGamesService");
const { listValidator, playValidator } = require("../utils/validators/sideGamesValidator");

const router = express.Router();

router.get("/", listValidator, listTypes);
router.post("/play", authService.protect, playValidator, play);

module.exports = router;
