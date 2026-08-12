import { createHash } from "node:crypto";
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
    if (key === "backfill" || key === "check") {
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
  const date = new Date(`${dateString}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() === 0;
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

export function isReviewed(status) {
  return ["reviewed", "verified", "human_verified", "official_verified"].includes(status);
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
