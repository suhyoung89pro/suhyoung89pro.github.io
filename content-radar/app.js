const mediaOrder = ["tv", "ott", "youtube"];
const state = {
  catalog: null,
  selectedCategoryId: "cooking",
};

const elements = {
  categoryList: document.querySelector("#category-list"),
  trendList: document.querySelector("#trend-list"),
  rankingGrid: document.querySelector("#ranking-grid"),
  rankingStatus: document.querySelector("#ranking-status"),
  selectedCategory: document.querySelector("#selected-category"),
  selectedDescription: document.querySelector("#selected-description"),
  dataUpdated: document.querySelector("#data-updated"),
};

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return "확인 필요";
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

function renderTrends(categoryId) {
  const trends = state.catalog.trends.filter((trend) => trend.categoryId === categoryId);
  if (!trends.length) {
    elements.trendList.replaceChildren(
      makeElement("span", "radar-loading", "이 카테고리의 트렌드 신호를 준비하고 있습니다."),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  trends.forEach((trend) => {
    const chip = makeElement("span", "radar-trend-chip");
    chip.append(makeElement("span", "", trend.label));
    chip.append(makeElement("small", "", `샘플 · ${trend.status}`));
    fragment.append(chip);
  });
  elements.trendList.replaceChildren(fragment);
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
  row.append(makeElement("span", "", `${person.name} · ${person.role}`));

  if (person.account?.url && isSafeUrl(person.account.url)) {
    const link = makeElement("a", "radar-account-link", person.account.service);
    link.href = person.account.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${person.name} ${person.account.service} 공식 계정 열기`);
    row.append(link);
  } else {
    row.append(makeElement("span", "radar-account-status", person.account?.status || "검수 필요"));
  }

  return row;
}

function createRankingItem(item) {
  const listItem = makeElement("li", "radar-ranking-item");
  listItem.append(makeElement("span", "radar-rank"));

  const body = makeElement("div", "radar-item-body");
  body.append(makeElement("h4", "radar-item-title", item.title));
  body.append(makeElement("p", "radar-item-meta", `${item.platform} · ${item.typeLabel}`));
  body.append(makeElement("p", "radar-item-summary", item.summary));

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

function createRankingPanel(ranking) {
  const panel = makeElement("section", "radar-ranking-panel");
  panel.setAttribute("aria-labelledby", `ranking-${ranking.medium}`);

  const header = makeElement("div", "radar-ranking-header");
  const headingGroup = makeElement("div");
  headingGroup.append(makeElement("span", "", ranking.eyebrow));
  const heading = makeElement("h3", "", ranking.label);
  heading.id = `ranking-${ranking.medium}`;
  headingGroup.append(heading);
  header.append(headingGroup);
  header.append(makeElement("p", "", ranking.basis));
  panel.append(header);

  const list = makeElement("ol", "radar-ranking-list");
  ranking.items.slice(0, 5).forEach((item) => list.append(createRankingItem(item)));
  panel.append(list);
  return panel;
}

function renderRankings(categoryId) {
  const category = findCategory(categoryId);
  const rankings = state.catalog.rankings[categoryId];

  elements.selectedCategory.textContent = category.name;
  elements.selectedDescription.textContent = category.description;
  elements.rankingGrid.setAttribute("aria-busy", "false");

  if (!rankings) {
    elements.rankingGrid.replaceChildren(
      makeElement(
        "p",
        "radar-empty-state",
        `${category.name} 카테고리는 데이터를 준비하고 있습니다. 요리 카테고리에서 MVP 예시를 확인해 주세요.`,
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
  elements.rankingStatus.textContent = `${category.name} 카테고리의 매체별 TOP 5를 표시했습니다.`;
}

function selectCategory(categoryId) {
  if (!findCategory(categoryId)) return;
  state.selectedCategoryId = categoryId;
  elements.categoryList.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.categoryId === categoryId));
  });
  renderTrends(categoryId);
  renderRankings(categoryId);
}

function validateCatalog(catalog) {
  return (
    catalog &&
    typeof catalog.updatedAt === "string" &&
    Array.isArray(catalog.categories) &&
    Array.isArray(catalog.trends) &&
    catalog.rankings &&
    typeof catalog.rankings === "object"
  );
}

async function loadCatalog() {
  try {
    const response = await fetch("./data/catalog.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    if (!validateCatalog(catalog)) throw new Error("Invalid catalog");

    state.catalog = catalog;
    elements.dataUpdated.textContent = formatDate(catalog.updatedAt);
    renderCategories();
    selectCategory(state.selectedCategoryId);
  } catch (error) {
    console.error("콘텐츠 데이터를 불러오지 못했습니다.", error);
    elements.dataUpdated.textContent = "확인 필요";
    elements.categoryList.replaceChildren(
      makeElement("span", "radar-loading", "카테고리를 불러오지 못했습니다."),
    );
    elements.trendList.replaceChildren(
      makeElement("span", "radar-loading", "트렌드를 불러오지 못했습니다."),
    );
    elements.rankingGrid.setAttribute("aria-busy", "false");
    elements.rankingGrid.replaceChildren(
      makeElement("p", "radar-empty-state", "데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."),
    );
    elements.rankingStatus.textContent = "콘텐츠 데이터를 불러오지 못했습니다.";
  }
}

loadCatalog();
