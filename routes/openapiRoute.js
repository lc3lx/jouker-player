const express = require("express");
const path = require("path");
const fs = require("fs");

const router = express.Router();

const specPath = path.join(__dirname, "..", "docs", "openapi.json");

router.get("/openapi.json", (req, res) => {
  if (!fs.existsSync(specPath)) {
    return res.status(404).json({ message: "OpenAPI spec not generated" });
  }
  res.sendFile(specPath);
});

router.get("/docs", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html><head><title>API Docs</title></head>
<body>
  <h1>Play Platform API</h1>
  <p>OpenAPI spec: <a href="/api-docs/openapi.json">/api-docs/openapi.json</a></p>
  <p>Use Swagger UI or Postman to import the JSON spec.</p>
</body></html>`);
});

module.exports = router;
