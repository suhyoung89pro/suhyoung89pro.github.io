import path from "node:path";
import {
  DATA_DIR,
  GENERATED_DIR,
  REVIEW_FILE,
  SNAPSHOT_DIR,
  SOURCE_URL,
  isApprovedAccountUrl,
  findBestMatch,
  isReviewed,
  isSunday,
  itemKey,
  listFiles,
  normalizeFeedText,
  parseArgs,
  parseAuthorizedFeedUrl,
  readJson,
  sha256,
  stableStringify,
} from "./lib.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const args = parseArgs(process.argv.slice(2));
const snapshotFiles = await listFiles(SNAPSHOT_DIR);
const categoryConfig = await readJson(path.join(DATA_DIR, "config/category-map.json"), { mappings: [] });
const aliasConfig = await readJson(path.join(DATA_DIR, "config/program-aliases.json"), { aliases: [] });
const feedSourceConfig = await readJson(path.join(DATA_DIR, "config/feed-sources.json"), { sources: [] });
const programConfig = await readJson(path.join(DATA_DIR, "entities/programs.json"), { programs: [] });
const peopleConfig = await readJson(path.join(DATA_DIR, "entities/people.json"), { people: [] });
const catalog = await readJson(path.join(DATA_DIR, "../catalog.json"), { categories: [] });

assert(Array.isArray(categoryConfig.mappings), "config/category-map.json: mappings must be an array");
assert(Array.isArray(aliasConfig.aliases), "config/program-aliases.json: aliases must be an array");
assert(Array.isArray(feedSourceConfig.sources), "config/feed-sources.json: sources must be an array");
assert(Array.isArray(programConfig.programs), "entities/programs.json: programs must be an array");
assert(Array.isArray(peopleConfig.people), "entities/people.json: people must be an array");

const categoryIds = new Set((catalog.categories || []).map((category) => category.id));
const mappingKeys = new Set();
const aliasKeys = new Set();
const feedSourceIds = new Set();
const programIds = new Set();
for (const program of programConfig.programs) {
  assert(program.id && !programIds.has(program.id), `entities/programs.json: duplicate or empty id ${program.id}`);
  programIds.add(program.id);
  if (program.title) {
    assert(
      normalizeFeedText(program.title, `entities/programs.json: ${program.id} title`) === program.title,
      `entities/programs.json: title is not normalized for ${program.id}`,
    );
  }
  for (const categoryId of program.categoryIds || []) {
    assert(categoryIds.has(categoryId), `entities/programs.json: unknown category ${categoryId}`);
  }
}

for (const source of feedSourceConfig.sources) {
  assert(
    typeof source.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id),
    "config/feed-sources.json: source id must use lowercase letters, numbers, and hyphens",
  );
  assert(!feedSourceIds.has(source.id), `config/feed-sources.json: duplicate source id ${source.id}`);
  feedSourceIds.add(source.id);
  if (isReviewed(source.status)) parseAuthorizedFeedUrl(source.url);
}

const personIds = new Set();
const accountOwners = new Map();
for (const person of peopleConfig.people) {
  assert(person.id && !personIds.has(person.id), `entities/people.json: duplicate or empty id ${person.id}`);
  personIds.add(person.id);
  assert(
    normalizeFeedText(person.name, `entities/people.json: ${person.id} name`) === person.name,
    `entities/people.json: name is not normalized for ${person.id}`,
  );
  if (person.role) {
    assert(
      normalizeFeedText(person.role, `entities/people.json: ${person.id} role`) === person.role,
      `entities/people.json: role is not normalized for ${person.id}`,
    );
  }
  for (const account of person.accounts || []) {
    if (!account.url) continue;
    assert(isApprovedAccountUrl(account), `entities/people.json: invalid ${account.service || "social"} URL`);
    assert(!accountOwners.has(account.url), `entities/people.json: ${account.url} belongs to multiple people`);
    accountOwners.set(account.url, person.id);
  }
}

for (const program of programConfig.programs) {
  for (const season of program.seasons || []) {
    for (const personId of season.peopleIds || []) {
      assert(personIds.has(personId), `entities/programs.json: unknown person ${personId}`);
    }
  }
}

for (const mapping of categoryConfig.mappings) {
  assert(mapping.platform === "netflix" && mapping.market === "KR", "config/category-map.json: invalid platform or market");
  assert(mapping.title, "config/category-map.json: title is required");
  assert(
    normalizeFeedText(mapping.title, "config/category-map.json title") === mapping.title,
    `config/category-map.json: title is not normalized for ${mapping.title}`,
  );
  if (mapping.seasonTitle) {
    assert(
      normalizeFeedText(mapping.seasonTitle, "config/category-map.json seasonTitle") === mapping.seasonTitle,
      `config/category-map.json: seasonTitle is not normalized for ${mapping.title}`,
    );
  }
  const key = `${mapping.platform}\u0000${mapping.market}\u0000${mapping.title}\u0000${mapping.seasonTitle || ""}`;
  assert(!mappingKeys.has(key), `config/category-map.json: duplicate mapping for ${mapping.title}`);
  mappingKeys.add(key);
  assert(Array.isArray(mapping.categoryIds), `config/category-map.json: categoryIds must be an array for ${mapping.title}`);
  if (isReviewed(mapping.status)) {
    assert(mapping.categoryIds.length > 0, `config/category-map.json: reviewed mapping ${mapping.title} needs a category`);
  }
  for (const categoryId of mapping.categoryIds || []) {
    assert(categoryIds.has(categoryId), `config/category-map.json: unknown category ${categoryId}`);
  }
  if (mapping.programId) assert(programIds.has(mapping.programId), `config/category-map.json: unknown program ${mapping.programId}`);
}

for (const alias of aliasConfig.aliases) {
  assert(alias.platform === "netflix" && alias.market === "KR", "config/program-aliases.json: invalid platform or market");
  assert(alias.title, "config/program-aliases.json: title is required");
  assert(
    normalizeFeedText(alias.title, "config/program-aliases.json title") === alias.title,
    `config/program-aliases.json: title is not normalized for ${alias.title}`,
  );
  if (alias.seasonTitle) {
    assert(
      normalizeFeedText(alias.seasonTitle, "config/program-aliases.json seasonTitle") === alias.seasonTitle,
      `config/program-aliases.json: seasonTitle is not normalized for ${alias.title}`,
    );
  }
  const key = `${alias.platform}\u0000${alias.market}\u0000${alias.title}\u0000${alias.seasonTitle || ""}`;
  assert(!aliasKeys.has(key), `config/program-aliases.json: duplicate alias for ${alias.title}`);
  aliasKeys.add(key);
  assert(programIds.has(alias.programId), `config/program-aliases.json: unknown program ${alias.programId}`);
}

const generatedFiles = await listFiles(GENERATED_DIR);
if (!snapshotFiles.length) {
  assert(!args["require-data"], "No licensed OTT snapshots are available");
  assert(generatedFiles.length === 0, "Generated OTT files exist without licensed snapshots");
  console.log("Validated OTT configuration. No licensed snapshots are currently published.");
  process.exit(0);
}

const weeks = new Set();
const snapshotsByWeek = new Map();

for (const file of snapshotFiles) {
  const snapshot = await readJson(file);
  assert(snapshot.schemaVersion === 1, `${file}: unsupported schemaVersion`);
  assert(snapshot.platform === "netflix" && snapshot.market === "KR", `${file}: invalid platform or market`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.week) && isSunday(snapshot.week), `${file}: week must be a Sunday`);
  assert(snapshot.week <= new Date().toISOString().slice(0, 10), `${file}: week is in the future`);
  assert(!weeks.has(snapshot.week), `${file}: duplicate week ${snapshot.week}`);
  weeks.add(snapshot.week);
  snapshotsByWeek.set(snapshot.week, snapshot);
  assert(snapshot.source?.url === SOURCE_URL, `${file}: unapproved source URL`);
  for (const category of ["Films", "TV"]) {
    const items = snapshot.categories?.[category];
    assert(Array.isArray(items) && items.length === 10, `${file}: ${category} must contain 10 items`);
    const itemKeys = new Set();
    items.forEach((item, index) => {
      assert(item.officialRank === index + 1, `${file}: ${category} ranks must be 1 through 10`);
      assert(typeof item.title === "string" && item.title.trim(), `${file}: empty title`);
      assert(normalizeFeedText(item.title, `${file}: title`) === item.title, `${file}: title is not normalized`);
      assert(item.seasonTitle === null || typeof item.seasonTitle === "string", `${file}: invalid seasonTitle`);
      if (item.seasonTitle) {
        assert(
          normalizeFeedText(item.seasonTitle, `${file}: seasonTitle`) === item.seasonTitle,
          `${file}: seasonTitle is not normalized`,
        );
      }
      assert(Number.isInteger(item.weeksInTop10) && item.weeksInTop10 > 0, `${file}: invalid weeksInTop10`);
      assert(!itemKeys.has(itemKey(item)), `${file}: duplicate ${category} title/season`);
      itemKeys.add(itemKey(item));
    });
  }
  const expectedHash = sha256(stableStringify({ week: snapshot.week, categories: snapshot.categories }));
  assert(snapshot.sourceHash === expectedHash, `${file}: sourceHash does not match normalized contents`);
}

const latest = await readJson(path.join(GENERATED_DIR, "latest.json"));
assert(latest.schemaVersion === 1, "generated/latest.json: unsupported schemaVersion");
assert(latest.platform === "netflix" && latest.market === "KR", "generated/latest.json: invalid platform or market");
assert(latest.week === [...weeks].sort().at(-1), "generated/latest.json is not based on the newest snapshot");
assert(latest.source?.url === SOURCE_URL, "generated/latest.json: unapproved source URL");
assert(latest.rankings && typeof latest.rankings === "object", "generated/latest.json: rankings must be an object");

const expectedGeneratedFiles = new Set([
  "latest.json",
  ...new Set([...weeks].map((week) => `monthly/${week.slice(0, 7)}.json`)),
]);
const actualGeneratedFiles = new Set(
  generatedFiles.map((file) => path.relative(GENERATED_DIR, file).replaceAll(path.sep, "/")),
);
assert(
  expectedGeneratedFiles.size === actualGeneratedFiles.size &&
    [...expectedGeneratedFiles].every((file) => actualGeneratedFiles.has(file)),
  "generated/: file set does not match the licensed snapshot months",
);

const reviewedMappings = categoryConfig.mappings.filter((mapping) => isReviewed(mapping.status));
const reviewedPeople = new Map(
  peopleConfig.people.filter((person) => isReviewed(person.verificationStatus)).map((person) => [person.id, person]),
);

function findReviewedMapping(item) {
  return findBestMatch(reviewedMappings, item);
}

function validatePublishedItem(item, categoryId, label) {
  const mapping = findReviewedMapping(item);
  assert(mapping, `${label}: ${item.title} has no reviewed mapping`);
  if (categoryId !== "all") {
    assert(mapping.categoryIds.includes(categoryId), `${label}: ${item.title} is not mapped to ${categoryId}`);
  }
  for (const person of item.people || []) {
    const sourcePerson = reviewedPeople.get(person.id);
    assert(sourcePerson, `${label}: unreviewed or unknown person ${person.id}`);
    assert(person.name === sourcePerson.name, `${label}: person name mismatch for ${person.id}`);
    for (const account of person.accounts || []) {
      const sourceAccount = (sourcePerson.accounts || []).find((candidate) => candidate.url === account.url);
      assert(sourceAccount, `${label}: unknown account ${account.url}`);
      assert(
        isReviewed(sourceAccount.verificationStatus || sourceAccount.status) && isApprovedAccountUrl(sourceAccount),
        `${label}: unreviewed or invalid account ${account.url}`,
      );
    }
  }
}

for (const [categoryId, record] of Object.entries(latest.rankings || {})) {
  assert(record.categoryId === categoryId, `generated/latest.json: categoryId mismatch for ${categoryId}`);
  assert(record.items.length <= 3, `generated/latest.json: ${categoryId} weekly list exceeds TOP 3`);
  assert(record.monthly?.items?.length <= 3, `generated/latest.json: ${categoryId} monthly list exceeds TOP 3`);
  record.items.forEach((item, index) => {
    assert(item.rank === index + 1, `generated/latest.json: ${categoryId} weekly ranks are not sequential`);
    assert(Number.isInteger(item.officialRank) && item.officialRank >= 1 && item.officialRank <= 10, `generated/latest.json: invalid official rank`);
    const sourceItem = snapshotsByWeek.get(latest.week)?.categories?.TV?.find(
      (candidate) => itemKey(candidate) === itemKey(item),
    );
    assert(sourceItem?.officialRank === item.officialRank, `generated/latest.json: ${item.title} does not match the source snapshot`);
    validatePublishedItem(item, categoryId, "generated/latest.json");
  });
  record.monthly.items.forEach((item, index) => {
    assert(item.rank === index + 1, `generated/latest.json: ${categoryId} monthly ranks are not sequential`);
    assert(Number.isInteger(item.score) && item.score > 0, `generated/latest.json: invalid monthly score`);
    validatePublishedItem(item, categoryId, "generated/latest.json monthly");
  });
}

const review = await readJson(REVIEW_FILE);
const reviewKeys = new Set();
for (const item of review.items || []) {
  const key = itemKey(item);
  assert(!reviewKeys.has(key), `review/unmapped.json: duplicate ${item.title}`);
  reviewKeys.add(key);
  assert(item.status === "pending_review" || item.status === "resolved", `review/unmapped.json: invalid status`);
  assert(!findReviewedMapping(item), `review/unmapped.json: reviewed mapping still queued for ${item.title}`);
}

console.log(`Validated ${snapshotFiles.length} Netflix snapshot(s), generated rankings, and review data.`);
