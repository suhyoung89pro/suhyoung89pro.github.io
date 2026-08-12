const CONFIG_URL = "./yolo-research-config.json";
const FEED_TIMEOUT_MS = 30000;

const statusElement = document.querySelector("#research-status");
const gridElement = document.querySelector("#research-grid");
const listSection = document.querySelector("#approved-papers");

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

function normalizeMetrics(value, record) {
  const metrics = [];

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (item && typeof item === "object") {
        const label = textValue(firstValue(item, ["label", "name", "metric"]));
        const metricValue = textValue(firstValue(item, ["value", "result", "score"]));
        if (label && metricValue) metrics.push({ label, value: metricValue });
      } else if (textValue(item)) {
        metrics.push({ label: "보고 성능", value: textValue(item) });
      }
    });
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([label, metricValue]) => {
      const normalizedValue = textValue(metricValue);
      if (!label.toLowerCase().endsWith("url") && normalizedValue) {
        const displayLabels = {
          map: "mAP",
          map50: "mAP@0.5",
          precision: "Precision",
          recall: "Recall",
          fps: "FPS",
        };
        metrics.push({ label: displayLabels[label.toLowerCase()] || label, value: normalizedValue });
      }
    });
  } else if (textValue(value)) {
    metrics.push({ label: "보고 성능", value: textValue(value) });
  }

  const commonMetrics = [
    ["mAP", ["mAP", "map"]],
    ["mAP@0.5", ["mAP50", "map50", "mAP@0.5"]],
    ["Precision", ["precision", "Precision"]],
    ["Recall", ["recall", "Recall"]],
    ["FPS", ["fps", "FPS"]],
  ];

  commonMetrics.forEach(([label, keys]) => {
    const metricValue = textValue(firstValue(record, keys));
    const alreadyIncluded = metrics.some((metric) => metric.label.toLowerCase() === label.toLowerCase());
    if (metricValue && !alreadyIncluded) metrics.push({ label, value: metricValue });
  });

  return metrics;
}

function normalizeLinks(record) {
  const links = [];
  const feedLinks = firstValue(record, ["links", "resources"]);
  const evidenceLinks = firstValue(record, ["evidenceUrls", "evidence_urls"]);

  if (Array.isArray(feedLinks)) {
    feedLinks.forEach((link) => {
      if (!link || typeof link !== "object") return;
      const url = safeUrl(firstValue(link, ["url", "href"]));
      if (url) links.push({ label: textValue(firstValue(link, ["label", "name"])) || "관련 자료", url });
    });
  }

  if (Array.isArray(evidenceLinks)) {
    evidenceLinks.forEach((evidence, index) => {
      const url = safeUrl(
        evidence && typeof evidence === "object" ? firstValue(evidence, ["url", "href"]) : evidence,
      );
      if (url) links.push({ label: `근거 자료 ${index + 1}`, url });
    });
  }

  [
    ["논문 원문", ["paperUrl", "paper_url", "publicationUrl", "url"]],
    ["DOI", ["doiUrl", "doi_url"]],
    ["코드", ["codeUrl", "code_url", "githubUrl"]],
    ["출처", ["sourceUrl", "source_url"]],
    ["이미지 출처", ["imageSourceUrl", "image_source_url"]],
    ["데이터셋", ["datasetUrl", "dataset_url"]],
  ].forEach(([label, keys]) => {
    let url = safeUrl(firstValue(record, keys));
    if (!url && label === "DOI") {
      const doi = textValue(record.doi)
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .replace(/^doi:\s*/i, "")
        .trim();
      if (/^10\.\d{4,9}\/\S+$/i.test(doi)) url = safeUrl(`https://doi.org/${doi}`);
    }
    if (url) links.push({ label, url });
  });

  const metricEvidenceUrl = safeUrl(
    record.metrics && typeof record.metrics === "object"
      ? firstValue(record.metrics, ["evidenceUrl", "evidence_url"])
      : "",
  );
  if (metricEvidenceUrl) links.push({ label: "성능 근거", url: metricEvidenceUrl });

  return links.filter((link, index) => links.findIndex((candidate) => candidate.url === link.url) === index);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;

  const title = textValue(firstValue(record, ["title", "paperTitle", "paper_title", "논문명", "논문 제목"]));
  if (!title) return null;

  const performance = firstValue(record, ["metrics", "performance", "results", "reportedPerformance"]);
  const citationValue = firstValue(record, ["citation", "ieeeCitation", "formattedCitation", "인용"]);
  const citation =
    citationValue && typeof citationValue === "object"
      ? textValue(firstValue(citationValue, ["text", "formatted", "value"]))
      : textValue(citationValue);
  const citationCount =
    citationValue && typeof citationValue === "object"
      ? textValue(firstValue(citationValue, ["count", "citationCount"]))
      : textValue(firstValue(record, ["citationCount", "citedByCount"]));

  return {
    title,
    industry: textValue(firstValue(record, ["industry", "sector", "domain", "산업"])),
    year: textValue(firstValue(record, ["year", "publicationYear", "publication_year", "발행연도"])),
    authors: textValue(firstValue(record, ["authors", "author", "저자"])),
    venue: textValue(firstValue(record, ["venue", "journal", "conference", "publisher", "학술지"])),
    summary: textValue(firstValue(record, ["summary", "applicationSummary", "description", "abstract", "요약"])),
    model: textValue(firstValue(record, ["model", "yoloModel", "yoloVersion", "modelVersion", "모델"])),
    task: textValue(firstValue(record, ["task", "application", "useCase", "use_case", "적용분야"])),
    dataset: textValue(firstValue(record, ["dataset", "data", "evaluationDataset", "데이터셋"])),
    metrics: normalizeMetrics(performance, record),
    metricContext: textValue(
      firstValue(record, ["metricContext", "measurementConditions", "conditions", "측정 조건"]),
    ),
    citation,
    citationCount,
    imageUrl: safeUrl(firstValue(record, ["resultImageUrl", "result_image_url", "imageUrl", "image_url", "resultImage"])),
    imageAlt: textValue(firstValue(record, ["imageAlt", "image_alt", "resultImageAlt"])),
    imageCaption: textValue(firstValue(record, ["imageCaption", "image_caption", "resultImageCaption"])),
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

function createDefinitionList(className, rows) {
  const list = document.createElement("dl");
  list.className = className;

  rows.forEach(({ label, value }) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    list.append(row);
  });

  return list;
}

function createPaperCard(paper) {
  const card = document.createElement("article");
  card.className = "paper-card";

  const header = document.createElement("header");
  header.className = "paper-card-header";

  const meta = document.createElement("div");
  meta.className = "paper-card-meta";
  const industry = document.createElement("span");
  const year = document.createElement("span");
  industry.textContent = paper.industry;
  year.textContent = paper.year;
  meta.append(industry, year);

  const title = document.createElement("h3");
  title.textContent = paper.title;
  header.append(meta, title);

  const bylineParts = [paper.authors, paper.venue].filter(Boolean);
  if (bylineParts.length) {
    const byline = document.createElement("p");
    byline.className = "paper-byline";
    byline.textContent = bylineParts.join(" · ");
    header.append(byline);
  }
  card.append(header);

  if (paper.imageUrl) {
    const figure = document.createElement("figure");
    figure.className = "paper-result";
    const image = document.createElement("img");
    image.src = paper.imageUrl;
    image.alt = paper.imageAlt || `${paper.title} 결과 이미지`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => figure.remove(), { once: true });
    figure.append(image);

    if (paper.imageCaption) {
      const caption = document.createElement("figcaption");
      caption.textContent = paper.imageCaption;
      figure.append(caption);
    }
    card.append(figure);
  }

  const body = document.createElement("div");
  body.className = "paper-card-body";

  if (paper.summary) {
    const summary = document.createElement("p");
    summary.className = "paper-summary";
    summary.textContent = paper.summary;
    body.append(summary);
  }

  const detailRows = [
    { label: "YOLO 모델", value: paper.model },
    { label: "적용 과제", value: paper.task },
    { label: "데이터셋", value: paper.dataset },
    { label: "측정 조건", value: paper.metricContext },
    { label: "인용 수", value: paper.citationCount },
  ].filter((row) => row.value);
  if (detailRows.length) body.append(createDefinitionList("paper-details", detailRows));

  if (paper.metrics.length) {
    const metricsSection = document.createElement("section");
    metricsSection.className = "paper-section";
    const metricsTitle = document.createElement("h4");
    metricsTitle.textContent = "논문 보고 성능";
    metricsSection.append(metricsTitle, createDefinitionList("paper-metrics", paper.metrics));
    body.append(metricsSection);
  }

  if (paper.citation) {
    const citationSection = document.createElement("section");
    citationSection.className = "paper-section";
    const citationTitle = document.createElement("h4");
    citationTitle.textContent = "인용 정보";
    const citation = document.createElement("blockquote");
    citation.className = "paper-citation";
    citation.textContent = paper.citation;
    citationSection.append(citationTitle, citation);
    body.append(citationSection);
  }

  if (paper.links.length) {
    const links = document.createElement("nav");
    links.className = "paper-links";
    links.setAttribute("aria-label", `${paper.title} 관련 링크`);
    paper.links.forEach(({ label, url }) => {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `${label} ↗`;
      links.append(link);
    });
    body.append(links);
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

function renderPapers(papers) {
  gridElement.replaceChildren(...papers.map(createPaperCard));
  gridElement.hidden = false;
  showStatus("ready", `${papers.length}건의 승인된 논문`, "각 수치는 원문의 평가 조건과 함께 확인해 주세요.");
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
        "아직 공개 승인된 논문이 없습니다.",
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
