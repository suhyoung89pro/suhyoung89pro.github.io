const CONFIG_URL = "./yolo-research-config.json";
const FEED_TIMEOUT_MS = 30000;
const ALL_INDUSTRIES = "__all__";
const CC_BY_4_URL = "https://creativecommons.org/licenses/by/4.0/";

const statusElement = document.querySelector("#research-status");
const gridElement = document.querySelector("#research-grid");
const filtersElement = document.querySelector("#industry-filters");
const listSection = document.querySelector("#approved-papers");

let approvedPapers = [];
let activeIndustry = ALL_INDUSTRIES;

function firstValue(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function textValue(value) {
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(", ");
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim();
  return "";
}

function isPublishable(record) {
  return Boolean(record && typeof record === "object" && record.published === true);
}

function safeUrl(value) {
  const candidate = textValue(value);
  if (!candidate) return "";

  try {
    const url = new URL(candidate, window.location.href);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeLinks(record) {
  const links = [];
  let sourceUrl = safeUrl(
    firstValue(record, ["paperUrl", "paper_url", "publicationUrl", "url"]),
  );

  if (!sourceUrl) {
    const doi = textValue(record.doi)
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .trim();
    if (/^10\.\d{4,9}\/\S+$/i.test(doi)) {
      sourceUrl = safeUrl(`https://doi.org/${doi}`);
    }
  }

  if (!sourceUrl) {
    sourceUrl = safeUrl(firstValue(record, ["imageSourceUrl", "image_source_url"]));
  }

  if (sourceUrl) links.push({ label: "논문·출처 보기", url: sourceUrl, kind: "primary" });

  const codeUrl = safeUrl(firstValue(record, ["codeUrl", "code_url", "githubUrl"]));
  if (codeUrl && codeUrl !== sourceUrl) links.push({ label: "코드", url: codeUrl, kind: "secondary" });

  return links;
}

function normalizeImageCredit(record) {
  const caption = textValue(
    firstValue(record, ["imageCaption", "image_caption", "resultImageCaption"]),
  );
  if (!/\bCC BY 4\.0\b/i.test(caption)) return null;

  const figure = caption.match(/\b(?:figure|fig\.?)\s*(\d+)\b/i);
  const label = [figure ? `Fig. ${figure[1]}` : "Image", "CC BY 4.0"];
  if (/(?:크롭|cropped|일부\s*발췌)/i.test(caption)) label.push("일부 발췌");

  return {
    label: label.join(" · "),
    title: caption,
    url: CC_BY_4_URL,
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;

  const title = textValue(
    firstValue(record, ["title", "paperTitle", "paper_title", "논문명", "논문 제목"]),
  );
  if (!title) return null;

  return {
    title,
    industry:
      textValue(firstValue(record, ["industry", "sector", "domain", "산업"])) || "기타",
    application:
      textValue(
        firstValue(record, ["application", "useCase", "use_case", "task", "적용 사례", "적용분야"]),
      ) || "산업 적용 사례",
    summary: textValue(
      firstValue(record, ["summary", "applicationSummary", "description", "abstract", "요약"]),
    ),
    model: textValue(
      firstValue(record, ["model", "yoloModel", "yoloVersion", "modelVersion", "모델"]),
    ),
    authors: textValue(firstValue(record, ["authors", "author", "저자"])),
    venue: textValue(firstValue(record, ["venue", "journal", "conference", "publisher", "학술지"])),
    year: textValue(firstValue(record, ["year", "publicationYear", "publication_year", "발행연도"])),
    imageUrl: safeUrl(
      firstValue(record, ["resultImageUrl", "result_image_url", "imageUrl", "image_url", "resultImage"]),
    ),
    imageAlt: textValue(firstValue(record, ["imageAlt", "image_alt", "resultImageAlt"])),
    imageCredit: normalizeImageCredit(record),
    links: normalizeLinks(record),
  };
}

function extractRecords(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.items)
  ) {
    throw new Error("INVALID_FEED");
  }
  return payload.items;
}

function createResultVisual(paper) {
  if (!paper.imageUrl) {
    const placeholder = document.createElement("div");
    placeholder.className = "paper-result-placeholder";
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = "결과 이미지 검토 중";
    detail.textContent = "출처와 재사용 권한이 확인되면 공개됩니다.";
    placeholder.append(title, detail);
    return placeholder;
  }

  const figure = document.createElement("figure");
  figure.className = "paper-result";
  const image = document.createElement("img");
  image.src = paper.imageUrl;
  image.alt = paper.imageAlt || `${paper.application} 결과 이미지`;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => figure.replaceWith(createResultVisual({ ...paper, imageUrl: "" })), {
    once: true,
  });
  figure.append(image);

  if (paper.imageCredit) {
    const credit = document.createElement("a");
    credit.className = "paper-image-credit";
    credit.href = paper.imageCredit.url;
    credit.target = "_blank";
    credit.rel = "noopener noreferrer";
    credit.textContent = paper.imageCredit.label;
    credit.title = paper.imageCredit.title;
    credit.setAttribute("aria-label", `${paper.imageCredit.title} 라이선스 보기`);
    figure.append(credit);
  }

  return figure;
}

function createPaperCard(paper) {
  const card = document.createElement("article");
  card.className = "paper-card";
  card.append(createResultVisual(paper));

  const body = document.createElement("div");
  body.className = "paper-card-body";

  const meta = document.createElement("div");
  meta.className = "paper-card-meta";
  [paper.industry, paper.model].filter(Boolean).forEach((value) => {
    const item = document.createElement("span");
    item.textContent = value;
    meta.append(item);
  });
  body.append(meta);

  const application = document.createElement("p");
  application.className = "paper-application";
  application.textContent = paper.application;
  body.append(application);

  const title = document.createElement("h3");
  title.textContent = paper.title;
  body.append(title);

  if (paper.summary) {
    const summary = document.createElement("p");
    summary.className = "paper-summary";
    summary.textContent = paper.summary;
    body.append(summary);
  }

  const sourceParts = [paper.authors, paper.venue, paper.year].filter(Boolean);
  if (sourceParts.length || paper.links.length) {
    const footer = document.createElement("div");
    footer.className = "paper-card-footer";

    if (sourceParts.length) {
      const sourceLine = document.createElement("p");
      sourceLine.className = "paper-source-line";
      sourceLine.textContent = sourceParts.join(" · ");
      footer.append(sourceLine);
    }

    if (paper.links.length) {
      const links = document.createElement("nav");
      links.className = "paper-links";
      links.setAttribute("aria-label", `${paper.title} 관련 링크`);
      paper.links.forEach(({ label, url, kind }) => {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `${label} ↗`;
        if (kind === "primary") link.className = "paper-link-primary";
        links.append(link);
      });
      footer.append(links);
    }

    body.append(footer);
  }

  card.append(body);
  return card;
}

function showStatus(state, title, detail) {
  statusElement.className = `research-status research-status-${state}`;
  statusElement.replaceChildren();

  const heading = document.createElement("strong");
  const description = document.createElement("span");
  heading.textContent = title;
  description.textContent = detail;
  statusElement.append(heading, description);
}

function renderFilteredPapers() {
  const visiblePapers =
    activeIndustry === ALL_INDUSTRIES
      ? approvedPapers
      : approvedPapers.filter((paper) => paper.industry === activeIndustry);

  gridElement.replaceChildren(...visiblePapers.map(createPaperCard));
  gridElement.hidden = false;

  const scope = activeIndustry === ALL_INDUSTRIES ? "전체" : activeIndustry;
  showStatus(
    "ready",
    `${visiblePapers.length}건의 승인된 사례`,
    `${scope} 분야의 적용 장면과 논문 설명을 보여드립니다.`,
  );
}

function renderFilters() {
  const industries = [...new Set(approvedPapers.map((paper) => paper.industry))].sort((left, right) =>
    left.localeCompare(right, "ko"),
  );
  const options = [ALL_INDUSTRIES, ...industries];

  filtersElement.replaceChildren(
    ...options.map((industry) => {
      const button = document.createElement("button");
      const count =
        industry === ALL_INDUSTRIES
          ? approvedPapers.length
          : approvedPapers.filter((paper) => paper.industry === industry).length;
      button.type = "button";
      button.className = "research-filter";
      button.dataset.industry = industry;
      button.setAttribute("aria-pressed", String(industry === activeIndustry));
      button.textContent = `${industry === ALL_INDUSTRIES ? "전체" : industry} ${count}`;
      button.addEventListener("click", () => {
        activeIndustry = industry;
        filtersElement.querySelectorAll("button").forEach((filterButton) => {
          filterButton.setAttribute(
            "aria-pressed",
            String(filterButton.dataset.industry === activeIndustry),
          );
        });
        renderFilteredPapers();
      });
      return button;
    }),
  );
  filtersElement.hidden = false;
}

function renderPapers(papers) {
  approvedPapers = papers;
  activeIndustry = ALL_INDUSTRIES;
  renderFilters();
  renderFilteredPapers();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

function fetchJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `__yoloResearchFeed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("FEED_TIMEOUT"));
    }, FEED_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
    }

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.src = `${url}${separator}callback=${encodeURIComponent(callbackName)}`;
    script.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("FEED_SCRIPT_ERROR"));
      },
      { once: true },
    );
    document.head.append(script);
  });
}

async function loadResearch() {
  try {
    const config = await fetchJson(CONFIG_URL, { cache: "no-store" });
    const feedUrl = safeUrl(config.feedUrl || config.feed_url);

    if (!feedUrl) {
      showStatus(
        "setup",
        "논문 피드 연결을 준비하고 있습니다.",
        "승인 데이터 피드가 설정되면 검토를 마친 사례가 이곳에 표시됩니다.",
      );
      return;
    }

    const payload = await fetchJsonp(feedUrl);
    const papers = extractRecords(payload)
      .filter(isPublishable)
      .map(normalizeRecord)
      .filter(Boolean);

    if (!papers.length) {
      showStatus(
        "empty",
        "아직 공개 승인된 사례가 없습니다.",
        "검토와 게시 승인을 마친 사례가 생기면 자동으로 업데이트됩니다.",
      );
      return;
    }

    renderPapers(papers);
  } catch (error) {
    console.error("YOLO research feed could not be loaded.", error);
    showStatus(
      "error",
      "논문 자료를 불러오지 못했습니다.",
      "잠시 후 다시 시도하거나 각 논문의 원문 링크를 직접 확인해 주세요.",
    );
  } finally {
    listSection.setAttribute("aria-busy", "false");
  }
}

loadResearch();
