import { readFile } from "node:fs/promises";
import { evaluateHomePilot, homePilotTemplate } from "../lib/home-pilot.mjs";

try {
  const path = process.argv[2];
  if (path === "--template") {
    console.log(JSON.stringify(homePilotTemplate(), null, 2));
    process.exit(0);
  }
  if (!path) throw Error("A report file is required");
  const raw = await readFile(path);
  if (raw.length > 1_000_000) throw Error("Report exceeds the size limit");
  const result = evaluateHomePilot(JSON.parse(raw));
  console.log(JSON.stringify(result));
  if (result.status !== "reported_pass") process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ status: "unavailable", code: "HOME_PILOT_REPORT_REQUIRED_OR_INVALID" }));
  process.exitCode = 1;
}
