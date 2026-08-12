import { readFile } from "node:fs/promises";
import {
  SOURCE_NAME,
  SOURCE_URL,
  isSunday,
  listFiles,
  parseArgs,
  parseNetflixTsv,
  readJson,
  sha256,
  snapshotPath,
  stableStringify,
  writeJsonIfChanged,
  SNAPSHOT_DIR,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  throw new Error(
    "--input is required. This tool intentionally does not download Tudum data; only import data you are authorized to use.",
  );
}

function normalizeRow(row) {
  const officialRank = Number(row.weekly_rank);
  const weeksInTop10 = Number(row.cumulative_weeks_in_top_10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.week) || !isSunday(row.week)) {
    throw new Error(`Invalid ranking week: ${row.week}`);
  }
  if (!["Films", "TV"].includes(row.category)) throw new Error(`Unexpected category: ${row.category}`);
  if (!Number.isInteger(officialRank) || officialRank < 1 || officialRank > 10) {
    throw new Error(`Invalid weekly rank for ${row.show_title}: ${row.weekly_rank}`);
  }
  if (!Number.isInteger(weeksInTop10) || weeksInTop10 < 1) {
    throw new Error(`Invalid cumulative weeks for ${row.show_title}`);
  }
  if (!row.show_title.trim()) throw new Error("Ranking row has an empty title");
  return {
    officialRank,
    title: row.show_title.trim(),
    seasonTitle: row.season_title.trim() || null,
    weeksInTop10,
  };
}

function makeSnapshot(week, rows) {
  const categories = {};
  for (const category of ["Films", "TV"]) {
    const items = rows
      .filter((row) => row.category === category)
      .map(normalizeRow)
      .sort((a, b) => a.officialRank - b.officialRank);
    const ranks = items.map((item) => item.officialRank);
    if (items.length !== 10 || ranks.some((rank, index) => rank !== index + 1)) {
      throw new Error(`${week} ${category} must contain unique ranks 1 through 10`);
    }
    categories[category] = items;
  }

  const sourceHash = sha256(stableStringify({ week, categories }));
  return {
    schemaVersion: 1,
    platform: "netflix",
    market: "KR",
    week,
    source: { name: SOURCE_NAME, url: SOURCE_URL },
    sourceHash,
    categories,
  };
}

const input = await readFile(args.input, "utf8");
const koreaRows = parseNetflixTsv(input).filter((row) => row.country_iso2 === "KR");
if (!koreaRows.length) throw new Error("Input TSV contains no KR rows");

const rowsByWeek = Map.groupBy(koreaRows, (row) => row.week);
const sourceWeeks = [...rowsByWeek.keys()].sort();
const existingFiles = await listFiles(SNAPSHOT_DIR);
const existingWeeks = existingFiles.map((file) => file.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean);
const newestExisting = existingWeeks.sort().at(-1);
const existingWeekSet = new Set(existingWeeks);

for (const week of existingWeeks) {
  if (!rowsByWeek.has(week)) continue;
  const existing = await readJson(snapshotPath(week));
  const incoming = makeSnapshot(week, rowsByWeek.get(week));
  if (existing.sourceHash !== incoming.sourceHash) {
    throw new Error(`Source corrected existing week ${week}; review before replacing the snapshot`);
  }
}

const latestSourceMonth = sourceWeeks.at(-1).slice(0, 7);
const missingCurrentMonthWeeks = sourceWeeks.filter(
  (week) => week.startsWith(latestSourceMonth) && !existingWeekSet.has(week),
);
const weeksToWrite = args.backfill
  ? sourceWeeks.filter((week) => !existingWeekSet.has(week))
  : [...new Set([
      ...missingCurrentMonthWeeks,
      ...sourceWeeks.filter((week) => newestExisting && week > newestExisting),
    ])].sort();

if (!weeksToWrite.length) {
  console.log(`Imported rankings are already up to date through ${sourceWeeks.at(-1)}.`);
} else {
  for (const week of weeksToWrite) {
    const incoming = makeSnapshot(week, rowsByWeek.get(week));
    const changed = await writeJsonIfChanged(snapshotPath(week), incoming);
    console.log(`${changed ? "Saved" : "Verified"} authorized KR snapshot ${week}.`);
  }
}
