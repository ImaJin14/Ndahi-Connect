import { Storage } from "@google-cloud/storage";

const [command, ...args] = process.argv.slice(2);
const bucketName = process.env.GCS_BUCKET_NAME;
const encodedCredentials = process.env.GCS_SERVICE_ACCOUNT_JSON_BASE64;
if (!bucketName || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucketName)) {
  throw new Error("GCS_BUCKET_NAME is missing or invalid");
}
if (!encodedCredentials) throw new Error("GCS_SERVICE_ACCOUNT_JSON_BASE64 is required");
let credentials;
try {
  credentials = JSON.parse(Buffer.from(encodedCredentials, "base64").toString("utf8"));
} catch {
  throw new Error("GCS service account credentials are invalid");
}
if (credentials.type !== "service_account" || !credentials.client_email || !credentials.private_key) {
  throw new Error("GCS credentials must belong to a service account");
}
const storage = new Storage({ projectId: credentials.project_id, credentials });
const bucket = storage.bucket(bucketName);
const validObject = (name) => typeof name === "string" &&
  /^ndahi-postgres\/(daily|restore-reports)\/[A-Za-z0-9._:-]+$/.test(name);

if (command === "configure") {
  const days = Number.parseInt(args[0], 10);
  if (!Number.isSafeInteger(days) || days < 7) throw new Error("Retention must be at least 7 days");
  await bucket.getMetadata();
  await bucket.setMetadata({ lifecycle: { rule: [{
    action: { type: "Delete" }, condition: { age: days },
  }] } });
  console.log(JSON.stringify({ configured: true, retentionDays: days }));
} else if (command === "upload") {
  const [localPath, objectName] = args;
  if (!localPath || !validObject(objectName)) throw new Error("Upload path is invalid");
  await bucket.upload(localPath, {
    destination: objectName, resumable: false, validation: "crc32c",
    metadata: { cacheControl: "no-store" },
  });
  const [metadata] = await bucket.file(objectName).getMetadata();
  if (!Number(metadata.size)) throw new Error("Uploaded backup is empty");
  console.log(JSON.stringify({ uploaded: objectName, size: Number(metadata.size) }));
} else if (command === "download") {
  const [objectName, localPath] = args;
  if (!localPath || !validObject(objectName)) throw new Error("Download path is invalid");
  await bucket.file(objectName).download({ destination: localPath, validation: "crc32c" });
  console.log(JSON.stringify({ downloaded: objectName }));
} else {
  throw new Error("Expected configure, upload, or download command");
}
