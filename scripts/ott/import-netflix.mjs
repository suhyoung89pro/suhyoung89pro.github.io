import { readFile, stat } from "node:fs/promises";
import {
  MAX_FEED_BYTES,
  SOURCE_NAME,
  SOURCE_URL,
  isSunday,
  listFiles,
  parseArgs,
  parseNetflixTsv,
  normalizeFeedText,
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
  if (!/^(?:[1-9]|10)$/.test(row.weekly_rank)) {
    throw new Error(`Invalid weekly rank for ${row.show_title || "untitled row"}: ${row.weekly_rank}`);
  }
  if (!/^[1-9]\d*$/.test(row.cumulative_weeks_in_top_10)) {
    throw new Error(`Invalid cumulative weeks for ${row.show_title || "untitled row"}`);
  }
  const officialRank = Number(row.weekly_rank);
  const weeksInTop10 = Number(row.cumulative_weeks_in_top_10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.week) || !isSunday(row.week)) {
    throw new Error(`Invalid ranking week: ${row.week}`);
  }
  if (!["Films", "TV"].includes(row.category)) throw new Error(`Unexpected category: ${row.category}`);
  if (!Number.isSafeInteger(weeksInTop10) || weeksInTop10 > 10_000) {
    throw new Error(`Invalid cumulative weeks for ${row.show_title || "untitled row"}`);
  }
  const title = normalizeFeedText(row.show_title, "show title");
  const rawSeason = String(row.season_title ?? "").trim();
  const seasonTitle = !rawSeason || /^N\/?A$/i.test(rawSeason)
    ? null
    : normalizeFeedText(rawSeason, `season title for ${title}`);
  return {
    officialRank,
    title,
    seasonTitle,
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
    const keys = new Set(items.map((item) => `${item.title}\u0000${item.seasonTitle || ""}`));
    if (keys.size !== items.length) throw new Error(`${week} ${category} contains duplicate titles/seasons`);
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

const inputStat = await stat(args.input);
if (!inputStat.isFile() || inputStat.size === 0) throw new Error("Input TSV is empty");
if (inputStat.size > MAX_FEED_BYTES) {
  throw new Error(`Input TSV exceeds the ${MAX_FEED_BYTES} byte limit`);
}
const input = await readFile(args.input, "utf8");
const parsedRows = parseNetflixTsv(input);
const koreaRows = parsedRows.filter((row) => row.country_iso2 === "KR");
if (!koreaRows.length) throw new Error("Input TSV contains no KR rows");
const unexpectedCategory = koreaRows.find((row) => !["Films", "TV"].includes(row.category));
if (unexpectedCategory) throw new Error(`Unexpected KR category: ${unexpectedCategory.category}`);

const rowsByWeek = Map.groupBy(koreaRows, (row) => row.week);
const sourceWeeks = [...rowsByWeek.keys()].sort();
if (sourceWeeks.length > 600) throw new Error("Input TSV contains more than 600 KR ranking weeks");
const today = new Date().toISOString().slice(0, 10);
const futureWeek = sourceWeeks.find((week) => week > today);
if (futureWeek) throw new Error(`Input TSV contains future week ${futureWeek}`);

const maxAgeDays = args["max-age-days"] == null ? null : Number(args["max-age-days"]);
if (maxAgeDays != null && (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 90)) {
  throw new Error("--max-age-days must be an integer from 1 through 90");
}
if (maxAgeDays != null) {
  const latestTimestamp = new Date(`${sourceWeeks.at(-1)}T00:00:00Z`).getTime();
  const ageDays = Math.floor((Date.now() - latestTimestamp) / 86_400_000);
  if (ageDays > maxAgeDays) {
    throw new Error(`Newest source week ${sourceWeeks.at(-1)} is ${ageDays} days old`);
  }
}

const incomingByWeek = new Map(
  sourceWeeks.map((week) => [week, makeSnapshot(week, rowsByWeek.get(week))]),
);
const existingFiles = await listFiles(SNAPSHOT_DIR);
const existingWeeks = existingFiles.map((file) => file.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean);
const newestExisting = existingWeeks.sort().at(-1);
const existingWeekSet = new Set(existingWeeks);
if (newestExisting && sourceWeeks.at(-1) < newestExisting) {
  throw new Error(`Source rolls back from stored week ${newestExisting} to ${sourceWeeks.at(-1)}`);
}
if (newestExisting && sourceWeeks.at(-1) > newestExisting) {
  const sourceWeekSet = new Set(sourceWeeks);
  for (
    let timestamp = new Date(`${newestExisting}T00:00:00Z`).getTime() + 7 * 86_400_000;
    timestamp <= new Date(`${sourceWeeks.at(-1)}T00:00:00Z`).getTime();
    timestamp += 7 * 86_400_000
  ) {
    const expectedWeek = new Date(timestamp).toISOString().slice(0, 10);
    if (!sourceWeekSet.has(expectedWeek)) {
      throw new Error(`Source is missing required week ${expectedWeek}`);
    }
  }
}

for (const week of existingWeeks) {
  if (!rowsByWeek.has(week)) continue;
  const existing = await readJson(snapshotPath(week));
  const incoming = incomingByWeek.get(week);
  if (existing.sourceHash !== incoming.sourceHash) {
    throw new Error(
      `Source corrected existing week ${week}; stored ${existing.sourceHash}, incoming ${incoming.sourceHash}. Review before replacing the snapshot.`,
    );
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
    const incoming = incomingByWeek.get(week);
    const changed = await writeJsonIfChanged(snapshotPath(week), incoming);
    console.log(`${changed ? "Saved" : "Verified"} authorized KR snapshot ${week}.`);
  }
}
