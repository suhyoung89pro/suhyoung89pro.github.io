const mediaOrder = ["tv", "ott", "youtube"];
const GENERATED_DATA_URL = "./data/ott/generated/latest.json";
const FALLBACK_DATA_URL = "./data/catalog.json";

const state = {
  catalog: null,
  generated: null,
  selectedCategoryId: "cooking",
  ottPeriod: "weekly",
  dataSource: "sample",
};

const elements = {
  categoryList: document.querySelector("#category-list"),
  rankingGrid: document.querySelector("#ranking-grid"),
  rankingStatus: document.querySelector("#ranking-status"),
  selectedCategory: document.querySelector("#selected-category"),
  dataUpdated: document.querySelector("#data-updated"),
  dataMode: document.querySelector("#data-mode"),
  rankingNote: document.querySelector("#ranking-note"),
};

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return "확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function findCategory(categoryId) {
  return state.catalog.categories.find((category) => category.id === categoryId);
}

function createCategoryButton(category) {
  const button = makeElement("button", "radar-category-button", category.name);
  button.type = "button";
  button.dataset.categoryId = category.id;
  button.setAttribute("aria-pressed", String(category.id === state.selectedCategoryId));
  button.addEventListener("click", () => selectCategory(category.id));
  return button;
}

function renderCategories() {
  const fragment = document.createDocumentFragment();
  state.catalog.categories.forEach((category) => {
    fragment.append(createCategoryButton(category));
  });
  elements.categoryList.replaceChildren(fragment);
}

function isSafeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function createPersonRow(person) {
  const row = makeElement("li", "radar-person");
  const role = person.role || person.character || "출연";
  row.append(makeElement("span", "", `${person.name || "출연자 확인 중"} · ${role}`));

  const account = person.account || person.accounts?.find((entry) => entry?.url);
  if (account?.url && isSafeUrl(account.url)) {
    const link = makeElement("a", "radar-account-link", account.service || "SNS");
    link.href = account.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${person.name} ${account.service || "SNS"} 계정 열기`);
    row.append(link);
  } else {
    const status = account?.status || person.verificationStatus || "검수 필요";
    row.append(makeElement("span", "radar-account-status", status));
  }

  return row;
}

function formatMovement(item) {
  const previousRank = Number(item.previousRank);
  const currentRank = Number(item.officialRank || item.rank);
  if (!Number.isFinite(previousRank) || !Number.isFinite(currentRank)) return "";
  if (previousRank === currentRank) return "전주와 동일";
  return previousRank > currentRank
    ? `전주 대비 ${previousRank - currentRank}계단 상승`
    : `전주 대비 ${currentRank - previousRank}계단 하락`;
}

function createRankingItem(item, isGeneratedOtt = false) {
  const listItem = makeElement("li", "radar-ranking-item");
  listItem.append(makeElement("span", "radar-rank"));

  const body = makeElement("div", "radar-item-body");
  body.append(makeElement("h4", "radar-item-title", item.title));
  const metaParts = [item.platform, item.seasonTitle || item.typeLabel].filter(Boolean);
  body.append(makeElement("p", "radar-item-meta", metaParts.join(" · ")));

  if (isGeneratedOtt) {
    const facts = [];
    if (state.ottPeriod === "monthly") {
      if (item.score) facts.push(`${item.score}점`);
      if (item.bestOfficialRank) facts.push(`주간 최고 ${item.bestOfficialRank}위`);
      if (item.appearances) facts.push(`${item.appearances}주 반영`);
    } else {
      if (item.officialRank) facts.push(`전체 ${item.officialRank}위`);
      const movement = formatMovement(item);
      if (movement) facts.push(movement);
      if (item.weeksInTop10) facts.push(`차트 ${item.weeksInTop10}주`);
    }
    if (facts.length) body.append(makeElement("p", "radar-rank-facts", facts.join(" · ")));
  }

  if (Array.isArray(item.people) && item.people.length) {
    const details = makeElement("details", "radar-item-details");
    details.append(makeElement("summary", "", "출연자·계정 보기"));
    const peopleList = makeElement("ul", "radar-people-list");
    item.people.forEach((person) => peopleList.append(createPersonRow(person)));
    details.append(peopleList);
    body.append(details);
  }

  listItem.append(body);
  return listItem;
}

function createPeriodTabs(ranking) {
  const tabs = makeElement("div", "radar-period-tabs");
  tabs.setAttribute("aria-label", "OTT 순위 기간");

  [
    ["weekly", "주간"],
    ["monthly", "월간"],
  ].forEach(([period, label]) => {
    const button = makeElement("button", "radar-period-button", label);
    button.type = "button";
    button.dataset.period = period;
    button.setAttribute("aria-pressed", String(state.ottPeriod === period));
    button.disabled = !ranking.periods?.[period]?.items?.length;
    button.addEventListener("click", () => {
      state.ottPeriod = period;
      renderRankings(state.selectedCategoryId);
    });
    tabs.append(button);
  });

  return tabs;
}

function createRankingPanel(ranking) {
  const panel = makeElement("section", "radar-ranking-panel");
  panel.setAttribute("aria-labelledby", `ranking-${ranking.medium}`);

  const header = makeElement("div", "radar-ranking-header");
  const headingGroup = makeElement("div");
  headingGroup.append(makeElement("span", "", ranking.eyebrow));
  const heading = makeElement("h3", "", ranking.label.replace(/TOP\s*5/i, "TOP 3"));
  heading.id = `ranking-${ranking.medium}`;
  headingGroup.append(heading);
  header.append(headingGroup);
  const basis = makeElement("p", "", ranking.basis);
  if (ranking.sourceUrl && isSafeUrl(ranking.sourceUrl)) {
    basis.append(document.createTextNode(" · "));
    const sourceLink = makeElement("a", "radar-source-link", "원문");
    sourceLink.href = ranking.sourceUrl;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    basis.append(sourceLink);
  }
  header.append(basis);
  panel.append(header);

  let items = ranking.items;
  if (ranking.periods) {
    if (!ranking.periods[state.ottPeriod]?.items?.length) state.ottPeriod = "weekly";
    panel.append(createPeriodTabs(ranking));
    items = ranking.periods[state.ottPeriod]?.items || [];
    const periodMeta = ranking.periods[state.ottPeriod];
    if (periodMeta?.label) {
      const label = periodMeta.provisional
        ? `${periodMeta.label} · 잠정 순위${periodMeta.weeksIncluded ? ` · ${periodMeta.weeksIncluded}주 반영` : ""}`
        : periodMeta.label;
      panel.append(makeElement("p", "radar-period-label", label));
    }
  }

  const list = makeElement("ol", "radar-ranking-list");
  items.slice(0, ranking.limit || 3).forEach((item) => {
    list.append(createRankingItem(item, Boolean(ranking.periods)));
  });
  panel.append(list);
  return panel;
}

function renderRankings(categoryId) {
  const category = findCategory(categoryId);
  const rankings = state.catalog.rankings[categoryId];

  elements.selectedCategory.textContent = category.name;
  elements.rankingGrid.setAttribute("aria-busy", "false");
  elements.rankingGrid.classList.toggle(
    "radar-ranking-grid--generated",
    state.dataSource === "generated",
  );
  if (!rankings) {
    elements.rankingGrid.replaceChildren(
      makeElement(
        "p",
        "radar-empty-state",
        `${category.name} 카테고리는 데이터를 준비하고 있습니다. 다른 카테고리를 선택해 주세요.`,
      ),
    );
    elements.rankingStatus.textContent = `${category.name} 카테고리 데이터 준비 중`;
    return;
  }

  const fragment = document.createDocumentFragment();
  mediaOrder.forEach((medium) => {
    if (rankings[medium]) fragment.append(createRankingPanel(rankings[medium]));
  });
  elements.rankingGrid.replaceChildren(fragment);
  elements.rankingStatus.textContent = `${category.name} 카테고리의 매체별 TOP 3를 표시했습니다.`;
}

function selectCategory(categoryId) {
  if (!findCategory(categoryId)) return;
  state.selectedCategoryId = categoryId;
  elements.categoryList.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.categoryId === categoryId));
  });
  renderRankings(categoryId);
}

function validateCatalog(catalog) {
  return (
    catalog &&
    typeof catalog.updatedAt === "string" &&
    Array.isArray(catalog.categories) &&
    catalog.rankings &&
    typeof catalog.rankings === "object"
  );
}

function getGeneratedCategoryEntries(payload) {
  if (payload?.rankings && !Array.isArray(payload.rankings)) {
    return Object.entries(payload.rankings);
  }
  if (Array.isArray(payload?.categories)) {
    return payload.categories
      .map((category) => [category.id || category.categoryId, category])
      .filter(([id]) => id);
  }
  return [];
}

function normalizeGeneratedItems(items, platform) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 3).map((item, index) => ({
    rank: Number(item.rank) || index + 1,
    officialRank: Number(item.officialRank) || undefined,
    previousRank: Number(item.previousRank) || undefined,
    weeksInTop10: Number(item.weeksInTop10 || item.weeksOnList) || undefined,
    bestOfficialRank: Number(item.bestOfficialRank) || undefined,
    score: Number(item.score) || undefined,
    appearances: Number(item.appearances) || undefined,
    title: item.title || item.programTitle || "제목 확인 중",
    seasonTitle: item.seasonTitle || item.seasonLabel || item.typeLabel || "시즌 정보 확인 중",
    typeLabel: item.typeLabel || item.seasonTitle || item.seasonLabel || "OTT 콘텐츠",
    platform: item.platform || platform || "Netflix",
    summary: item.summary || "공식 순위에 진입한 작품입니다.",
    people: Array.isArray(item.people) ? item.people : [],
    programId: item.programId || null,
  }));
}

function getPeriodItems(record, period) {
  if (!record) return [];
  if (period === "weekly") {
    return record.items || record.weekly?.items || record.weekly || [];
  }
  return record.monthly?.items || record.monthly || record.monthlyItems || [];
}

function buildGeneratedCatalog(payload, fallbackCatalog) {
  const entries = getGeneratedCategoryEntries(payload);
  if (!entries.length) return null;

  const fallbackCategories = new Map(
    (fallbackCatalog?.categories || []).map((category) => [category.id, category]),
  );
  const categories = [];
  const rankings = {};
  const platform = payload.platform === "netflix" ? "Netflix" : payload.platform || "Netflix";
  const market = payload.market || "KR";
  const weekLabel = payload.week ? `${payload.week} 주간` : "최신 주간";
  const sourceLabel = payload.source?.name || payload.sourceName || "공식 순위";

  entries.forEach(([categoryId, record]) => {
    const weeklyItems = normalizeGeneratedItems(getPeriodItems(record, "weekly"), platform);
    const monthlyItems = normalizeGeneratedItems(getPeriodItems(record, "monthly"), platform);
    if (!weeklyItems.length && !monthlyItems.length) return;

    const fallback = fallbackCategories.get(categoryId);
    const name = record.name || record.categoryName || fallback?.name || (categoryId === "all" ? "전체" : categoryId);
    const description =
      record.description ||
      fallback?.description ||
      (categoryId === "all"
        ? `${platform} ${market} TV 공식 순위 전체`
        : `${platform} 공식 순위 중 ${name}으로 검수된 작품`);

    categories.push({ id: categoryId, name, description });
    rankings[categoryId] = {
      ott: {
        medium: "ott",
        eyebrow: "Streaming",
        label: `${platform} TV TOP 3`,
        basis: `${sourceLabel} · ${market} · 카테고리는 자체 분류`,
        sourceUrl: payload.source?.url,
        limit: 3,
        periods: {
          weekly: { items: weeklyItems, label: weekLabel },
          monthly: {
            items: monthlyItems,
            label: record.monthly?.month || payload.month || "월간 누적",
            provisional: Boolean(record.monthly?.provisional),
            weeksIncluded: record.monthly?.weeksIncluded,
          },
        },
        items: weeklyItems,
      },
    };
  });

  if (!categories.length) return null;
  categories.sort((a, b) => (a.id === "all" ? -1 : b.id === "all" ? 1 : 0));

  const trends = Array.isArray(payload.trends)
    ? payload.trends
    : categories.map((category) => ({
        categoryId: category.id,
        label: category.id === "all" ? `${platform} 한국 TV` : `${category.name} TOP 3`,
        status: payload.week || "최신",
      }));

  return {
    updatedAt: payload.updatedAt || payload.generatedAt || payload.week || new Date().toISOString(),
    categories,
    trends,
    rankings,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function setDataMode(mode) {
  const isGenerated = mode === "generated";
  elements.dataMode.textContent = isGenerated ? "최신 데이터" : "샘플";
  elements.rankingNote.textContent = isGenerated
    ? "공식 순위 기반 · 카테고리는 자체 분류"
    : "샘플 데이터 · 실제 순위 연동 전";
}

async function loadCatalog() {
  try {
    const fallbackCatalog = await fetchJson(FALLBACK_DATA_URL);
    if (!validateCatalog(fallbackCatalog)) throw new Error("Invalid fallback catalog");

    let catalog = fallbackCatalog;
    try {
      const generatedPayload = await fetchJson(GENERATED_DATA_URL);
      const generatedCatalog = buildGeneratedCatalog(generatedPayload, fallbackCatalog);
      if (!generatedCatalog || !validateCatalog(generatedCatalog)) {
        throw new Error("Invalid generated catalog");
      }
      catalog = generatedCatalog;
      state.generated = generatedPayload;
      state.dataSource = "generated";
    } catch (generatedError) {
      console.info("자동 생성 데이터가 없어 샘플 카탈로그를 사용합니다.", generatedError);
      state.dataSource = "sample";
    }

    state.catalog = catalog;
    state.selectedCategoryId = catalog.categories.some((category) => category.id === "all")
      ? "all"
      : catalog.categories.some((category) => category.id === state.selectedCategoryId)
        ? state.selectedCategoryId
        : catalog.categories[0].id;
    elements.dataUpdated.textContent = formatDate(catalog.updatedAt);
    setDataMode(state.dataSource);
    renderCategories();
    selectCategory(state.selectedCategoryId);
  } catch (error) {
    console.error("콘텐츠 데이터를 불러오지 못했습니다.", error);
    elements.dataUpdated.textContent = "확인 필요";
    elements.categoryList.replaceChildren(
      makeElement("span", "radar-loading", "카테고리를 불러오지 못했습니다."),
    );
    elements.rankingGrid.setAttribute("aria-busy", "false");
    elements.rankingGrid.replaceChildren(
      makeElement("p", "radar-empty-state", "데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."),
    );
    elements.rankingStatus.textContent = "콘텐츠 데이터를 불러오지 못했습니다.";
  }
}

loadCatalog();
