const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

const LOCAL_ROOT = path.join(__dirname, "..", "..", "uploads");

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function uploadLocal({ key, buffer, contentType }) {
  const fullPath = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  const checksum = sha256Buffer(buffer);
  return {
    provider: "local",
    key,
    publicUrl: `/uploads/${key.replace(/\\/g, "/")}`,
    checksum,
    contentType: contentType || "application/octet-stream",
  };
}

async function uploadS3({ key, buffer, contentType }) {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || "us-east-1";
  if (!bucket) throw new Error("S3_BUCKET_NOT_CONFIGURED");
  const https = require("https");
  const checksum = sha256Buffer(buffer);
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const objectPath = `/${key}`;
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: objectPath,
        method: "PUT",
        headers: {
          "Content-Type": contentType || "image/png",
          "Content-Length": buffer.length,
          Authorization: process.env.S3_AUTH_HEADER || "",
        },
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`S3_UPLOAD_${res.statusCode}`));
      }
    );
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
  return {
    provider: "s3",
    key,
    publicUrl: `https://${host}${objectPath}`,
    checksum,
    contentType: contentType || "image/png",
  };
}

async function uploadGcs({ key, buffer, contentType }) {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) throw new Error("GCS_BUCKET_NOT_CONFIGURED");
  const token = process.env.GCS_UPLOAD_TOKEN;
  if (!token) throw new Error("GCS_UPLOAD_TOKEN_NOT_CONFIGURED");
  const https = require("https");
  const checksum = sha256Buffer(buffer);
  const objectPath = `/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(key)}`;
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "storage.googleapis.com",
        path: objectPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType || "image/png",
          "Content-Length": buffer.length,
        },
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`GCS_UPLOAD_${res.statusCode}`));
      }
    );
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
  return {
    provider: "gcs",
    key,
    publicUrl: `https://storage.googleapis.com/${bucket}/${key}`,
    checksum,
    contentType: contentType || "image/png",
  };
}

async function uploadMinio({ key, buffer, contentType }) {
  const endpoint = process.env.MINIO_ENDPOINT;
  const bucket = process.env.MINIO_BUCKET;
  if (!endpoint || !bucket) throw new Error("MINIO_NOT_CONFIGURED");
  const base = endpoint.replace(/\/$/, "");
  const url = `${base}/${bucket}/${key}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType || "image/png",
      Authorization: process.env.MINIO_AUTH || "",
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`MINIO_UPLOAD_${res.status}`);
  return {
    provider: "minio",
    key,
    publicUrl: url,
    checksum: sha256Buffer(buffer),
    contentType: contentType || "image/png",
  };
}

function resolveProvider() {
  const p = String(process.env.STORAGE_PROVIDER || "local").toLowerCase();
  if (["s3", "gcs", "minio", "local"].includes(p)) return p;
  return "local";
}

async function uploadWithRetry({ key, buffer, contentType }, maxAttempts = 3) {
  const provider = resolveProvider();
  const fn = {
    local: uploadLocal,
    s3: uploadS3,
    gcs: uploadGcs,
    minio: uploadMinio,
  }[provider];

  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn({ key, buffer, contentType });
    } catch (e) {
      lastErr = e;
      logger.warn("storage_upload_retry", { provider, key, attempt: i + 1, reason: e.message });
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  if (provider !== "local") {
    logger.warn("storage_fallback_local", { key, reason: lastErr?.message });
    return uploadLocal({ key, buffer, contentType });
  }
  throw lastErr;
}

module.exports = {
  uploadWithRetry,
  sha256Buffer,
  resolveProvider,
};
