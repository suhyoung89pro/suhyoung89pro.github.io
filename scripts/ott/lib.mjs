import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
export const DATA_DIR = process.env.CONTENT_RADAR_DATA_DIR
  ? path.resolve(process.env.CONTENT_RADAR_DATA_DIR)
  : path.join(ROOT_DIR, "content-radar/data/ott");
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots/netflix/kr");
export const GENERATED_DIR = path.join(DATA_DIR, "generated");
export const REVIEW_FILE = path.join(DATA_DIR, "review/unmapped.json");
export const SOURCE_URL = "authorized-local-import";
export const SOURCE_NAME = "Authorized ranking data";
export const MAX_FEED_BYTES = 50 * 1024 * 1024;
export const MAX_FEED_ROWS = 500_000;
export const MAX_TEXT_LENGTH = 300;
export const EXPECTED_HEADERS = [
  "country_name",
  "country_iso2",
  "week",
  "category",
  "weekly_rank",
  "show_title",
  "season_title",
  "cumulative_weeks_in_top_10",
];

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Unknown argument: ${value}`);
    const key = value.slice(2);
    if (["backfill", "check", "require-data"].includes(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

export function parseDelimited(text, delimiter = "\t") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("Unterminated quoted field in TSV");
  if (field || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

export function parseNetflixTsv(text) {
  const rows = parseDelimited(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("Netflix TSV is empty");
  const headers = rows.shift();
  if (headers.length !== EXPECTED_HEADERS.length || headers.some((value, i) => value !== EXPECTED_HEADERS[i])) {
    throw new Error(`Unexpected Netflix TSV headers: ${headers.join(", ")}`);
  }
  if (rows.length > MAX_FEED_ROWS) {
    throw new Error(`Netflix TSV exceeds the ${MAX_FEED_ROWS.toLocaleString("en-US")} row limit`);
  }

  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`Netflix TSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonIfChanged(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await readFile(filePath, "utf8")) === content) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return true;
}

export async function listFiles(directory, suffix = ".json") {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await listFiles(fullPath, suffix)));
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(fullPath);
    }
    return files.sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function isSunday(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCDay() === 0
  );
}

export function normalizeFeedText(value, label) {
  const normalized = String(value ?? "").normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} is empty`);
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_TEXT_LENGTH} characters`);
  }
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(normalized)) {
    throw new Error(`${label} contains unsafe control characters`);
  }
  return normalized;
}

export function parseAuthorizedFeedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Authorized feed URL is not valid");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:") throw new Error("Authorized feed URL must use HTTPS");
  if (url.username || url.password) throw new Error("Authorized feed URL must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("Authorized feed URL must use the default HTTPS port");
  if (url.search || url.hash) throw new Error("Authorized feed URL must not contain a query string or fragment");
  if (
    isIP(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !hostname.includes(".")
  ) {
    throw new Error("Authorized feed URL must use a public DNS hostname");
  }
  return url;
}

export function snapshotPath(week) {
  return path.join(SNAPSHOT_DIR, week.slice(0, 4), `${week}.json`);
}

export function itemKey(item) {
  return `${item.title}\u0000${item.seasonTitle || ""}`;
}

export function mappingMatches(mapping, item) {
  return (
    mapping.platform === "netflix" &&
    mapping.market === "KR" &&
    mapping.title === item.title &&
    (!mapping.seasonTitle || mapping.seasonTitle === item.seasonTitle)
  );
}

export function findBestMatch(candidates, item) {
  return candidates
    .filter((candidate) => mappingMatches(candidate, item))
    .sort((a, b) => Number(Boolean(b.seasonTitle)) - Number(Boolean(a.seasonTitle)))[0];
}

export function isReviewed(status) {
  return ["reviewed", "verified", "human_verified", "official_verified"].includes(status);
}

const ACCOUNT_RULES = {
  youtube: {
    hosts: new Set(["youtube.com", "www.youtube.com"]),
    path: /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/,
  },
  instagram: {
    hosts: new Set(["instagram.com", "www.instagram.com"]),
    path: /^\/[A-Za-z0-9._]+\/?$/,
  },
  tiktok: {
    hosts: new Set(["tiktok.com", "www.tiktok.com"]),
    path: /^\/@[^/]+\/?$/,
  },
  x: {
    hosts: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
    path: /^\/[A-Za-z0-9_]{1,15}\/?$/,
  },
  threads: {
    hosts: new Set(["threads.net", "www.threads.net"]),
    path: /^\/@[^/]+\/?$/,
  },
  facebook: {
    hosts: new Set(["facebook.com", "www.facebook.com"]),
    path: /^\/[A-Za-z0-9.]+\/?$/,
  },
  linkedin: {
    hosts: new Set(["linkedin.com", "www.linkedin.com"]),
    path: /^\/(?:in|company)\/[^/]+\/?$/,
  },
};

export function isApprovedAccountUrl(account) {
  if (!account?.url || !account?.service) return false;
  try {
    const url = new URL(account.url);
    const service = String(account.service).trim().toLowerCase();
    const rule = ACCOUNT_RULES[service];
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      rule?.hosts.has(url.hostname.toLowerCase()) === true &&
      rule.path.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
