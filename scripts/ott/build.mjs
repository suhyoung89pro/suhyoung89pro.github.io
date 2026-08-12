import path from "node:path";
import {
  DATA_DIR,
  GENERATED_DIR,
  REVIEW_FILE,
  SNAPSHOT_DIR,
  SOURCE_NAME,
  SOURCE_URL,
  findBestMatch,
  isApprovedAccountUrl,
  isReviewed,
  itemKey,
  listFiles,
  parseArgs,
  readJson,
  writeJsonIfChanged,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const snapshotFiles = await listFiles(SNAPSHOT_DIR);
if (!snapshotFiles.length) {
  console.log("No Netflix snapshots found; nothing to build.");
  process.exit(0);
}

const snapshots = (await Promise.all(snapshotFiles.map((file) => readJson(file)))).sort((a, b) => a.week.localeCompare(b.week));
const latest = snapshots.at(-1);
const previousCandidate = snapshots.at(-2);
const previous =
  previousCandidate &&
  new Date(`${latest.week}T00:00:00Z`).getTime() - new Date(`${previousCandidate.week}T00:00:00Z`).getTime() === 7 * 86_400_000
    ? previousCandidate
    : null;
const categoryConfig = await readJson(path.join(DATA_DIR, "config/category-map.json"), { mappings: [] });
const aliasConfig = await readJson(path.join(DATA_DIR, "config/program-aliases.json"), { aliases: [] });
const programConfig = await readJson(path.join(DATA_DIR, "entities/programs.json"), { programs: [] });
const peopleConfig = await readJson(path.join(DATA_DIR, "entities/people.json"), { people: [] });
const catalog = await readJson(path.join(DATA_DIR, "../catalog.json"), { categories: [] });

const mappings = (categoryConfig.mappings || []).filter((mapping) => isReviewed(mapping.status));
const aliases = (aliasConfig.aliases || []).filter((alias) => isReviewed(alias.status));
const programsById = new Map((programConfig.programs || []).map((program) => [program.id, program]));
const peopleById = new Map((peopleConfig.people || []).map((person) => [person.id, person]));
const catalogById = new Map((catalog.categories || []).map((category) => [category.id, category]));

function findMapping(item) {
  return findBestMatch(mappings, item);
}

function enrichPeople(item, mapping) {
  const alias = findBestMatch(aliases, item);
  const programId = mapping?.programId || alias?.programId || null;
  const program = programsById.get(programId);
  if (!program) return { programId, people: [] };
  const season = (program.seasons || []).find((candidate) =>
    alias?.seasonNumber != null
      ? candidate.number === alias.seasonNumber
      : candidate.title === item.seasonTitle,
  );
  const people = (season?.peopleIds || [])
    .map((id) => peopleById.get(id))
    .filter((person) => person && isReviewed(person.verificationStatus))
    .map((person) => ({
      id: person.id,
      name: person.name,
      role: person.role || "출연",
      accounts: (person.accounts || []).filter(
        (account) =>
          isReviewed(account.verificationStatus || account.status) && isApprovedAccountUrl(account),
      ),
      verificationStatus: person.verificationStatus || "pending",
    }));
  return { programId, people };
}

function makeWeeklyItems(items, categoryId) {
  const previousRanks = new Map((previous?.categories?.TV || []).map((item) => [itemKey(item), item.officialRank]));
  return items
    .filter((item) => {
      const mapping = findMapping(item);
      return mapping && (categoryId === "all" || mapping.categoryIds?.includes(categoryId));
    })
    .slice(0, 3)
    .map((item, index) => {
      const mapping = findMapping(item);
      const enriched = enrichPeople(item, mapping);
      return {
        rank: index + 1,
        officialRank: item.officialRank,
        previousRank: previousRanks.get(itemKey(item)) || null,
        title: item.title,
        seasonTitle: item.seasonTitle,
        weeksInTop10: item.weeksInTop10,
        programId: enriched.programId,
        people: enriched.people,
      };
    });
}

function monthRankings(monthSnapshots, categoryId) {
  const totals = new Map();
  for (const snapshot of monthSnapshots) {
    for (const item of snapshot.categories.TV) {
      const mapping = findMapping(item);
      if (!mapping || (categoryId !== "all" && !mapping.categoryIds?.includes(categoryId))) continue;
      const key = itemKey(item);
      const current = totals.get(key) || {
        title: item.title,
        seasonTitle: item.seasonTitle,
        score: 0,
        bestOfficialRank: 10,
        appearances: 0,
        latestOfficialRank: item.officialRank,
      };
      current.score += 11 - item.officialRank;
      current.bestOfficialRank = Math.min(current.bestOfficialRank, item.officialRank);
      current.appearances += 1;
      current.latestOfficialRank = item.officialRank;
      totals.set(key, current);
    }
  }

  return [...totals.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.bestOfficialRank - b.bestOfficialRank ||
        a.latestOfficialRank - b.latestOfficialRank ||
        a.title.localeCompare(b.title, "ko"),
    )
    .slice(0, 3)
    .map((item, index) => {
      const mapping = findMapping(item);
      const enriched = enrichPeople(item, mapping);
      return {
        rank: index + 1,
        title: item.title,
        seasonTitle: item.seasonTitle,
        score: item.score,
        bestOfficialRank: item.bestOfficialRank,
        appearances: item.appearances,
        programId: enriched.programId,
        people: enriched.people,
      };
    });
}

const categoryIds = new Set(["all"]);
for (const mapping of mappings) for (const categoryId of mapping.categoryIds || []) categoryIds.add(categoryId);

const snapshotsByMonth = Map.groupBy(snapshots, (snapshot) => snapshot.week.slice(0, 7));
const latestMonth = latest.week.slice(0, 7);
const monthlyDocuments = new Map();
for (const [month, monthSnapshots] of snapshotsByMonth) {
  const rankings = {};
  for (const categoryId of categoryIds) rankings[categoryId] = monthRankings(monthSnapshots, categoryId);
  monthlyDocuments.set(month, {
    schemaVersion: 1,
    platform: "netflix",
    market: "KR",
    month,
    formulaVersion: "rank-points-v1",
    formula: "주 종료일이 속한 달을 기준으로 각 주 순위에 11-순위 점수를 부여해 합산",
    provisional: month === latestMonth,
    weeksIncluded: monthSnapshots.length,
    source: { name: SOURCE_NAME, url: SOURCE_URL },
    rankings,
  });
}

const latestMonthly = monthlyDocuments.get(latestMonth);
const rankings = {};
for (const categoryId of categoryIds) {
  const category = catalogById.get(categoryId);
  const items = makeWeeklyItems(latest.categories.TV, categoryId);
  const monthlyItems = latestMonthly.weeksIncluded >= 2 ? latestMonthly.rankings[categoryId] || [] : [];
  if (!items.length && !monthlyItems.length) continue;
  rankings[categoryId] = {
    categoryId,
    name: categoryId === "all" ? "전체" : category?.name || categoryId,
    description:
      categoryId === "all"
        ? "Netflix 한국 TV 공식 TOP 10 중 상위 3개"
        : category?.description || `Netflix 공식 순위 중 ${categoryId} 검수 작품`,
    items,
    monthly: {
      month: latestMonth,
      provisional: latestMonthly.provisional,
      weeksIncluded: latestMonthly.weeksIncluded,
      basis: latestMonthly.formula,
      items: monthlyItems,
    },
  };
}

const generated = {
  schemaVersion: 1,
  platform: "netflix",
  market: "KR",
  updatedAt: latest.week,
  week: latest.week,
  month: latestMonth,
  source: { name: SOURCE_NAME, url: SOURCE_URL },
  rankings,
};

function makeReviewSearches(item) {
  const quotedTitle = `"${item.seasonTitle || item.title}"`;
  return [
    { label: "작품·출연진 검색", url: `https://www.google.com/search?q=${encodeURIComponent(`${quotedTitle} 공식 출연진`)}` },
    { label: "공식 YouTube 검색", url: `https://www.google.com/search?q=${encodeURIComponent(`${quotedTitle} 공식 유튜브`)}` },
  ];
}

const existingReview = await readJson(REVIEW_FILE, { schemaVersion: 1, items: [] });
const existingReviewByKey = new Map(
  (existingReview.items || [])
    .filter((item) => !findMapping(item))
    .map((item) => [itemKey(item), { ...item, searches: makeReviewSearches(item) }]),
);
for (const snapshot of snapshots) {
  for (const item of snapshot.categories.TV) {
    if (findMapping(item)) continue;
    const key = itemKey(item);
    const existing = existingReviewByKey.get(key);
    if (existing) {
      if (!existing.firstSeenWeek || snapshot.week < existing.firstSeenWeek) {
        existingReviewByKey.set(key, { ...existing, firstSeenWeek: snapshot.week });
      }
      continue;
    }
    existingReviewByKey.set(key, {
      platform: "netflix",
      market: "KR",
      title: item.title,
      seasonTitle: item.seasonTitle,
      firstSeenWeek: snapshot.week,
      status: "pending_review",
      searches: makeReviewSearches(item),
    });
  }
}
const review = {
  schemaVersion: 1,
  description: "카테고리·출연자 연결 전 운영자 검수가 필요한 Netflix TV 작품",
  items: [...existingReviewByKey.values()].sort(
    (a, b) => a.firstSeenWeek.localeCompare(b.firstSeenWeek) || a.title.localeCompare(b.title, "ko"),
  ),
};

let changes = 0;
for (const [month, document] of monthlyDocuments) {
  if (await writeJsonIfChanged(path.join(GENERATED_DIR, "monthly", `${month}.json`), document)) changes += 1;
}
if (await writeJsonIfChanged(path.join(GENERATED_DIR, "latest.json"), generated)) changes += 1;
if (await writeJsonIfChanged(REVIEW_FILE, review)) changes += 1;

if (args.check && changes) throw new Error(`${changes} generated OTT file(s) were out of date`);
console.log(changes ? `Updated ${changes} generated OTT file(s).` : "Generated OTT data is already up to date.");
