const express = require("express");
const authService = require("../services/authService");
const { getTasks, claimTask, claimAllTasks } = require("../services/taskService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("user"));

router.get("/", getTasks);
router.post("/claim-all", claimAllTasks);
router.post("/:taskId/claim", claimTask);

module.exports = router;
