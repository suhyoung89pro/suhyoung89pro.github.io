import path from "node:path";
import {
  DATA_DIR,
  GENERATED_DIR,
  REVIEW_FILE,
  SNAPSHOT_DIR,
  SOURCE_URL,
  isSunday,
  itemKey,
  listFiles,
  readJson,
  sha256,
  stableStringify,
} from "./lib.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const snapshotFiles = await listFiles(SNAPSHOT_DIR);
const categoryConfig = await readJson(path.join(DATA_DIR, "config/category-map.json"), { mappings: [] });
const aliasConfig = await readJson(path.join(DATA_DIR, "config/program-aliases.json"), { aliases: [] });
const programConfig = await readJson(path.join(DATA_DIR, "entities/programs.json"), { programs: [] });
const peopleConfig = await readJson(path.join(DATA_DIR, "entities/people.json"), { people: [] });
const catalog = await readJson(path.join(DATA_DIR, "../catalog.json"), { categories: [] });

assert(Array.isArray(categoryConfig.mappings), "config/category-map.json: mappings must be an array");
assert(Array.isArray(aliasConfig.aliases), "config/program-aliases.json: aliases must be an array");
assert(Array.isArray(programConfig.programs), "entities/programs.json: programs must be an array");
assert(Array.isArray(peopleConfig.people), "entities/people.json: people must be an array");

const categoryIds = new Set((catalog.categories || []).map((category) => category.id));
const programIds = new Set();
for (const program of programConfig.programs) {
  assert(program.id && !programIds.has(program.id), `entities/programs.json: duplicate or empty id ${program.id}`);
  programIds.add(program.id);
  for (const categoryId of program.categoryIds || []) {
    assert(categoryIds.has(categoryId), `entities/programs.json: unknown category ${categoryId}`);
  }
}

const personIds = new Set();
const accountOwners = new Map();
for (const person of peopleConfig.people) {
  assert(person.id && !personIds.has(person.id), `entities/people.json: duplicate or empty id ${person.id}`);
  personIds.add(person.id);
  for (const account of person.accounts || []) {
    if (!account.url) continue;
    const accountUrl = new URL(account.url);
    assert(accountUrl.protocol === "https:", "entities/people.json: account URLs must use HTTPS");
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
  for (const categoryId of mapping.categoryIds || []) {
    assert(categoryIds.has(categoryId), `config/category-map.json: unknown category ${categoryId}`);
  }
  if (mapping.programId) assert(programIds.has(mapping.programId), `config/category-map.json: unknown program ${mapping.programId}`);
}

for (const alias of aliasConfig.aliases) {
  assert(alias.platform === "netflix" && alias.market === "KR", "config/program-aliases.json: invalid platform or market");
  assert(alias.title, "config/program-aliases.json: title is required");
  assert(programIds.has(alias.programId), `config/program-aliases.json: unknown program ${alias.programId}`);
}

if (!snapshotFiles.length) {
  console.log("Validated OTT configuration. No licensed snapshots are currently published.");
  process.exit(0);
}

const weeks = new Set();

for (const file of snapshotFiles) {
  const snapshot = await readJson(file);
  assert(snapshot.schemaVersion === 1, `${file}: unsupported schemaVersion`);
  assert(snapshot.platform === "netflix" && snapshot.market === "KR", `${file}: invalid platform or market`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.week) && isSunday(snapshot.week), `${file}: week must be a Sunday`);
  assert(!weeks.has(snapshot.week), `${file}: duplicate week ${snapshot.week}`);
  weeks.add(snapshot.week);
  assert(snapshot.source?.url === SOURCE_URL, `${file}: unapproved source URL`);
  for (const category of ["Films", "TV"]) {
    const items = snapshot.categories?.[category];
    assert(Array.isArray(items) && items.length === 10, `${file}: ${category} must contain 10 items`);
    const itemKeys = new Set();
    items.forEach((item, index) => {
      assert(item.officialRank === index + 1, `${file}: ${category} ranks must be 1 through 10`);
      assert(typeof item.title === "string" && item.title.trim(), `${file}: empty title`);
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
assert(latest.rankings?.all?.items?.length > 0, "generated/latest.json must include the all category");

for (const [categoryId, record] of Object.entries(latest.rankings || {})) {
  assert(record.categoryId === categoryId, `generated/latest.json: categoryId mismatch for ${categoryId}`);
  assert(record.items.length <= 3, `generated/latest.json: ${categoryId} weekly list exceeds TOP 3`);
  assert(record.monthly?.items?.length <= 3, `generated/latest.json: ${categoryId} monthly list exceeds TOP 3`);
  record.items.forEach((item, index) => {
    assert(item.rank === index + 1, `generated/latest.json: ${categoryId} weekly ranks are not sequential`);
    assert(Number.isInteger(item.officialRank) && item.officialRank >= 1 && item.officialRank <= 10, `generated/latest.json: invalid official rank`);
  });
  record.monthly.items.forEach((item, index) => {
    assert(item.rank === index + 1, `generated/latest.json: ${categoryId} monthly ranks are not sequential`);
    assert(Number.isInteger(item.score) && item.score > 0, `generated/latest.json: invalid monthly score`);
  });
}

const review = await readJson(REVIEW_FILE);
const reviewKeys = new Set();
for (const item of review.items || []) {
  const key = itemKey(item);
  assert(!reviewKeys.has(key), `review/unmapped.json: duplicate ${item.title}`);
  reviewKeys.add(key);
  assert(item.status === "pending_review" || item.status === "resolved", `review/unmapped.json: invalid status`);
}

console.log(`Validated ${snapshotFiles.length} Netflix snapshot(s), generated rankings, and review data.`);
