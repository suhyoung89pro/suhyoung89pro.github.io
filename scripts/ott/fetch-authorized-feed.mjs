import { BlockList } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import {
  DATA_DIR,
  MAX_FEED_BYTES,
  isReviewed,
  parseArgs,
  parseAuthorizedFeedUrl,
  readJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const sourceId = process.env.OTT_FEED_SOURCE_ID?.trim();

if (!sourceId) throw new Error("OTT_FEED_SOURCE_ID is required");

const sourceConfig = await readJson(
  args.config || path.join(DATA_DIR, "config/feed-sources.json"),
  { sources: [] },
);
const source = (sourceConfig.sources || []).find(
  (candidate) => candidate.id === sourceId && isReviewed(candidate.status),
);
if (!source) throw new Error(`No reviewed authorized feed source is configured for ${sourceId}`);
const endpoint = parseAuthorizedFeedUrl(source.url);

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) blockedAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["::ffff:0:0", 96],
]) blockedAddresses.addSubnet(address, prefix, "ipv6");

if (args.check) {
  console.log("Authorized feed endpoint policy passed.");
  process.exit(0);
}
if (!args.output) throw new Error("--output is required");

function safeLookup(hostname, options, callback) {
  const family = typeof options === "number" ? options : options?.family || 0;
  const wantsAll = typeof options === "object" && options?.all === true;

  dnsLookup(hostname, { all: true, family, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }

    try {
      if (!addresses.length) throw new Error("Authorized feed hostname did not resolve");
      for (const address of addresses) {
        const addressFamily = address.family === 6 ? "ipv6" : "ipv4";
        if (blockedAddresses.check(address.address, addressFamily)) {
          throw new Error("Authorized feed hostname resolves to a non-public address");
        }
      }

      if (wantsAll) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    } catch (validationError) {
      callback(validationError);
    }
  });
}

function downloadAuthorizedFeed() {
  return new Promise((resolve, reject) => {
    const token = process.env.OTT_FEED_TOKEN?.trim();
    const request = httpsRequest(
      endpoint,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        lookup: safeLookup,
        method: "GET",
        timeout: 120_000,
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`Authorized feed returned HTTP ${status}`));
          return;
        }

        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("text/html")) {
          response.resume();
          reject(new Error("Authorized feed returned HTML instead of TSV data"));
          return;
        }

        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
          response.resume();
          reject(new Error(`Authorized feed exceeds the ${MAX_FEED_BYTES} byte limit`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_FEED_BYTES) {
            response.destroy(
              new Error(`Authorized feed exceeds the ${MAX_FEED_BYTES} byte limit`),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!totalBytes) {
            reject(new Error("Authorized feed returned an empty body"));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        response.on("error", reject);
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Authorized feed request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

let feed;
try {
  feed = await downloadAuthorizedFeed();
} catch (error) {
  if (error?.message?.startsWith("Authorized feed")) throw error;
  throw new Error(`Authorized feed request failed (${error?.code || error?.name || "network error"})`);
}

await writeFile(args.output, feed, { flag: "wx" });
console.log(`Downloaded ${feed.byteLength} bytes from the authorized feed.`);
