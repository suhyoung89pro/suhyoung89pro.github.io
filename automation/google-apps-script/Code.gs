/**
 * YOLO 산업 적용 사례 승인 피드
 *
 * 이 파일은 "YOLO 산업 적용 사례 검토" Google Sheet에 바인딩해서 사용합니다.
 * 자동 조사는 후보만 추가하며, 공개 여부는 시트의 검증 체크박스로만 결정됩니다.
 */

var YOLO_CONFIG = {
  spreadsheetIdProperty: "SPREADSHEET_ID",
  reviewSheet: "검토 대기",
  settingsSheet: "검색 설정",
  timeZone: "Asia/Seoul",
  crossrefEndpoint: "https://api.crossref.org/works",
  pdfCandidatesUrl: "https://raw.githubusercontent.com/suhyoung89pro/suhyoung89pro.github.io/main/automation/pdf-figure-worker/output/candidates.json",
  maxCandidatesPerRun: 100,
  maxImageCandidatesPerRun: 10,
  maxPdfQueueItems: 50,
  maxPdfCandidatesBytes: 1000000,
  weeklyHandler: "collectYoloCandidates",
  pdfDailyHandler: "syncPdfFigureCandidates"
};

var REVIEW_HEADERS = [
  "게시 승인",
  "출처 확인",
  "성능 조건 확인",
  "이미지 권리 확인",
  "사례 ID",
  "산업 분야",
  "적용 사례",
  "논문 제목",
  "한글 요약",
  "YOLO 버전",
  "작업 유형",
  "데이터셋",
  "성능 지표",
  "성능 값",
  "측정 조건",
  "결과 이미지 URL",
  "이미지 출처 URL",
  "이미지 라이선스",
  "저자",
  "학술지/학회",
  "발행연도",
  "DOI",
  "논문 URL",
  "코드 URL",
  "인용 수",
  "인용 출처",
  "인용 확인일",
  "발견일",
  "상태",
  "검토 메모"
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("YOLO 사례 조사")
    .addItem("지금 조사 실행", "collectYoloCandidates")
    .addItem("빈 결과 이미지 후보 찾기", "fillMissingImageCandidates")
    .addItem("PDF 결과 이미지 후보 동기화", "syncPdfFigureCandidates")
    .addItem("주간 자동 조사 설치", "installWeeklyTrigger")
    .addItem("PDF 후보 일일 동기화 설치", "installPdfSyncDailyTrigger")
    .addItem("게시 가능 행 점검", "showPublishSummary")
    .addToUi();
}

function installWeeklyTrigger() {
  rememberBoundSpreadsheet_();

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === YOLO_CONFIG.weeklyHandler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(YOLO_CONFIG.weeklyHandler)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .inTimezone(YOLO_CONFIG.timeZone)
    .create();

  openSpreadsheet_().toast(
    "매주 월요일 오전 8시에 후보를 조사합니다.",
    "YOLO 사례 조사",
    6
  );
}

function installPdfSyncDailyTrigger() {
  rememberBoundSpreadsheet_();

  var existingTriggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === YOLO_CONFIG.pdfDailyHandler;
  });
  ScriptApp.newTrigger(YOLO_CONFIG.pdfDailyHandler)
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .inTimezone(YOLO_CONFIG.timeZone)
    .create();
  existingTriggers.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  openSpreadsheet_().toast(
    "매일 오전 9시에 GitHub의 PDF 이미지 후보를 동기화합니다.",
    "YOLO PDF 이미지 조사",
    6
  );
}

function collectYoloCandidates() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error("다른 조사 작업이 실행 중입니다. 잠시 후 다시 시도해 주세요.");
  }

  try {
    var spreadsheet = openSpreadsheet_();
    var reviewSheet = getRequiredSheet_(spreadsheet, YOLO_CONFIG.reviewSheet);
    var settingsSheet = getRequiredSheet_(spreadsheet, YOLO_CONFIG.settingsSheet);
    validateReviewHeaders_(reviewSheet);

    var settings = readSearchSettings_(settingsSheet);
    if (!settings.length) {
      spreadsheet.toast("활성화된 검색어가 없습니다.", "YOLO 사례 조사", 6);
      return;
    }

    var knownKeys = readKnownKeys_(reviewSheet);
    var candidates = [];
    var failures = [];

    settings.some(function (setting) {
      try {
        var works = fetchCrossrefWorks_(setting);
        var acceptedForSetting = 0;

        works.some(function (work) {
          if (candidates.length >= YOLO_CONFIG.maxCandidatesPerRun) return true;
          if (acceptedForSetting >= setting.limit) return true;

          var candidate = crossrefWorkToCandidate_(work, setting);
          if (!candidate) return false;

          var key = candidateKey_(candidate.doi, candidate.paperUrl, candidate.title, candidate.year);
          if (!key || knownKeys[key]) return false;

          knownKeys[key] = true;
          candidates.push(candidate);
          acceptedForSetting += 1;
          return false;
        });
      } catch (error) {
        failures.push(setting.query + ": " + error.message);
      }

      return candidates.length >= YOLO_CONFIG.maxCandidatesPerRun;
    });

    if (candidates.length) {
      var startRow = appendCandidates_(reviewSheet, candidates);
      fillImageCandidatesInRows_(reviewSheet, startRow, candidates.length);
    }

    var message = candidates.length + "건의 새 후보를 추가했습니다.";
    if (failures.length) message += " 검색 오류 " + failures.length + "건은 실행 로그를 확인하세요.";
    spreadsheet.toast(message, "YOLO 사례 조사", 8);

    if (failures.length) console.warn(failures.join("\n"));
  } finally {
    lock.releaseLock();
  }
}

function doGet(event) {
  var mode = event && event.parameter
    ? stringValue_(event.parameter.mode)
    : "";
  var response = mode === "pdf-queue"
    ? readPdfQueue_()
    : {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        items: readPublishedItems_()
      };
  var json = JSON.stringify(response);
  var callback = event && event.parameter
    ? stringValue_(event.parameter.callback)
    : "";

  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function showPublishSummary() {
  var count = readPublishedItems_().length;
  openSpreadsheet_().toast(
    "현재 공개 조건을 모두 충족한 행은 " + count + "건입니다.",
    "게시 가능 행 점검",
    6
  );
}

function readPdfQueue_() {
  var sheet = getRequiredSheet_(openSpreadsheet_(), YOLO_CONFIG.reviewSheet);
  validateReviewHeaders_(sheet);

  var lastRow = lastCandidateRow_(sheet);
  if (lastRow < 2) {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), items: [] };
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, REVIEW_HEADERS.length).getValues();
  var items = [];
  rows.some(function (row) {
    if (items.length >= YOLO_CONFIG.maxPdfQueueItems) return true;
    if (row[3] === true || hasAnyImageField_(row)) return false;

    var paperId = stringValue_(row[4]);
    var title = stringValue_(row[7]);
    var doi = normalizeDoi_(row[21]);
    var paperUrl = httpsUrl_(row[22]) || (doi ? "https://doi.org/" + doi : "");
    if (!paperId || !title || !paperUrl || !isSupportedPdfQueuePaper_(doi, paperUrl)) return false;

    items.push({
      paperId: paperId,
      title: title,
      doi: doi,
      paperUrl: paperUrl
    });
    return false;
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    items: items
  };
}

function isSupportedPdfQueuePaper_(doi, paperUrl) {
  var normalizedDoi = normalizeDoi_(doi);
  var url = httpsUrl_(paperUrl);
  return /^10\.31224\//i.test(normalizedDoi) ||
    /^10\.21203\/rs\.3\.rs-/i.test(normalizedDoi) ||
    /^https:\/\/(?:www\.)?engrxiv\.org\//i.test(url) ||
    /^https:\/\/(?:www\.)?researchsquare\.com\//i.test(url);
}

function readPublishedItems_() {
  var sheet = getRequiredSheet_(openSpreadsheet_(), YOLO_CONFIG.reviewSheet);
  validateReviewHeaders_(sheet);

  var lastRow = lastCandidateRow_(sheet);
  if (lastRow < 2) return [];

  var rows = sheet.getRange(2, 1, lastRow - 1, REVIEW_HEADERS.length).getValues();
  return rows
    .filter(isPublishableRow_)
    .map(rowToPublicItem_)
    .sort(function (left, right) {
      return Number(right.year || 0) - Number(left.year || 0);
    });
}

function isPublishableRow_(row) {
  var publishApproved = row[0] === true;
  var sourceVerified = row[1] === true;
  var metricContextVerified = row[2] === true;
  var title = stringValue_(row[7]);
  var doi = normalizeDoi_(row[21]);
  var paperUrl = httpsUrl_(row[22]) || (doi ? "https://doi.org/" + doi : "");

  if (!publishApproved || !sourceVerified || !metricContextVerified) return false;
  if (!title || !paperUrl) return false;

  return true;
}

function rowToPublicItem_(row) {
  var doi = normalizeDoi_(row[21]);
  var paperUrl = httpsUrl_(row[22]) || (doi ? "https://doi.org/" + doi : "");
  var approvedImage = approvedImageFromRow_(row);
  var imageUrl = approvedImage ? approvedImage.url : "";
  var imageSourceUrl = approvedImage ? approvedImage.sourceUrl : "";
  var codeUrl = httpsUrl_(row[23]);
  var evidenceUrls = [paperUrl, doi ? "https://doi.org/" + doi : ""]
    .filter(function (url, index, urls) {
      return url && urls.indexOf(url) === index;
    });

  return {
    id: stringValue_(row[4]),
    published: true,
    industry: stringValue_(row[5]),
    application: stringValue_(row[6]),
    title: stringValue_(row[7]),
    summary: stringValue_(row[8]),
    model: stringValue_(row[9]),
    task: stringValue_(row[10]),
    dataset: stringValue_(row[11]),
    metrics: [
      {
        label: stringValue_(row[12]),
        value: stringValue_(row[13])
      }
    ],
    metricContext: stringValue_(row[14]),
    imageUrl: imageUrl,
    imageSourceUrl: imageSourceUrl,
    imageCaption: "",
    authors: stringValue_(row[18]),
    venue: stringValue_(row[19]),
    year: stringValue_(row[20]),
    doi: doi,
    paperUrl: paperUrl,
    codeUrl: codeUrl,
    citation: {
      text: formatCitation_(row),
      count: numberOrBlank_(row[24]),
      source: stringValue_(row[25]),
      checkedAt: dateToIso_(row[26])
    },
    evidenceUrls: evidenceUrls
  };
}

function approvedImageFromRow_(row) {
  if (row[3] !== true) return null;

  var imageUrl = httpsUrl_(row[15]);
  var imageSourceUrl = httpsUrl_(row[16]);
  var imageLicense = stringValue_(row[17]);
  if (!imageUrl || !imageSourceUrl || !isReusableImageLicense_(imageLicense)) return null;

  return {
    url: imageUrl,
    sourceUrl: imageSourceUrl,
    license: imageLicense
  };
}

function isReusableImageLicense_(value) {
  return /^(?:CC BY 4\.0)(?:\s*[·|-].*)?$/i.test(stringValue_(value));
}

function readSearchSettings_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  return sheet
    .getRange(2, 1, lastRow - 1, 6)
    .getValues()
    .filter(function (row) {
      return row[0] === true && stringValue_(row[2]);
    })
    .map(function (row) {
      return {
        industry: stringValue_(row[1]),
        query: stringValue_(row[2]),
        startYear: Math.max(2000, Number(row[3]) || 2020),
        limit: Math.min(25, Math.max(1, Number(row[4]) || 8)),
        application: stringValue_(row[5])
      };
    });
}

function fetchCrossrefWorks_(setting) {
  var rows = Math.min(100, Math.max(setting.limit * 4, 20));
  var query = [
    "query.bibliographic=" + encodeURIComponent(setting.query),
    "filter=" + encodeURIComponent("from-pub-date:" + setting.startYear + "-01-01"),
    "rows=" + rows,
    "sort=score",
    "order=desc"
  ].join("&");

  var response = UrlFetchApp.fetch(YOLO_CONFIG.crossrefEndpoint + "?" + query, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      Accept: "application/json",
      "User-Agent": "YOLOIndustrialCaseReview/1.0 (https://github.com/suhyoung89pro/suhyoung89pro.github.io)"
    }
  });

  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error("Crossref HTTP " + status);
  }

  var payload = JSON.parse(response.getContentText());
  return payload && payload.message && Array.isArray(payload.message.items)
    ? payload.message.items
    : [];
}

function crossrefWorkToCandidate_(work, setting) {
  var title = cleanText_(firstArrayValue_(work.title));
  var abstractText = cleanText_(work.abstract);
  var searchable = title + " " + abstractText;
  if (!title || !/(?:\bYOLO(?:v?\d+|X|NAS|World)?\b|You Only Look Once)/i.test(searchable)) {
    return null;
  }

  var year = publicationYear_(work);
  if (year && year < setting.startYear) return null;

  var doi = normalizeDoi_(work.DOI);
  var paperUrl = doi ? "https://doi.org/" + doi : httpsUrl_(work.URL);
  if (!paperUrl) return null;

  var authors = formatAuthors_(work.author);
  var venue = cleanText_(firstArrayValue_(work["container-title"]));
  var reviewNote = "자동 발견: Crossref / 검색어: " + setting.query;
  if (abstractText) reviewNote += " / 초록: " + truncate_(abstractText, 1200);

  return {
    id: "CR-" + stableHash_(doi || paperUrl || title + "|" + year).slice(0, 16),
    industry: setting.industry,
    application: setting.application,
    title: title,
    model: detectYoloVersion_(searchable),
    authors: authors,
    venue: venue,
    year: year,
    doi: doi,
    paperUrl: paperUrl,
    citationCount: numberOrBlank_(work["is-referenced-by-count"]),
    reviewNote: reviewNote
  };
}

function fillMissingImageCandidates() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error("다른 조사 작업이 실행 중입니다. 잠시 후 다시 시도해 주세요.");
  }

  try {
    var spreadsheet = openSpreadsheet_();
    var sheet = getRequiredSheet_(spreadsheet, YOLO_CONFIG.reviewSheet);
    validateReviewHeaders_(sheet);

    var result = fillImageCandidatesInRows_(sheet, 2, Math.max(0, lastCandidateRow_(sheet) - 1));
    spreadsheet.toast(
      result.filled + "건의 이미지 후보를 찾았습니다. " +
        "이미지를 확인한 뒤 '이미지 권리 확인'을 다시 체크해 주세요.",
      "YOLO 이미지 조사",
      8
    );
  } finally {
    lock.releaseLock();
  }
}

function syncPdfFigureCandidates(event) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.warn("다른 조사 작업이 실행 중이어서 PDF 이미지 후보 동기화를 건너뜁니다.");
    return { synced: 0, skipped: 0, invalid: 0, locked: true };
  }

  try {
    var spreadsheet = openSpreadsheet_();
    var sheet = getRequiredSheet_(spreadsheet, YOLO_CONFIG.reviewSheet);
    validateReviewHeaders_(sheet);
    var result = syncPdfFigureCandidates_(sheet, fetchPdfCandidateManifest_());

    if (!event || !event.triggerUid) {
      spreadsheet.toast(
        result.synced + "건의 PDF 이미지 후보를 가져왔습니다. " +
          "건너뜀 " + result.skipped + "건, 무효 " + result.invalid + "건",
        "YOLO PDF 이미지 조사",
        8
      );
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function fetchPdfCandidateManifest_() {
  var response = UrlFetchApp.fetch(YOLO_CONFIG.pdfCandidatesUrl, {
    muteHttpExceptions: true,
    followRedirects: false,
    headers: {
      Accept: "application/json",
      "User-Agent": "YOLOIndustrialCaseReview/1.2 (https://github.com/suhyoung89pro/suhyoung89pro.github.io)"
    }
  });
  var status = response.getResponseCode();
  if (status !== 200) throw new Error("PDF 후보 목록 HTTP " + status);
  if (response.getContent().length > YOLO_CONFIG.maxPdfCandidatesBytes) {
    throw new Error("PDF 후보 목록이 허용 크기를 초과했습니다.");
  }

  var manifest;
  try {
    manifest = JSON.parse(response.getContentText("UTF-8"));
  } catch (error) {
    throw new Error("PDF 후보 목록이 올바른 JSON이 아닙니다.");
  }

  if (!manifest || Array.isArray(manifest) || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.candidates) ||
      manifest.candidates.length > YOLO_CONFIG.maxPdfQueueItems ||
      typeof manifest.generatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.generatedAt) ||
      isNaN(new Date(manifest.generatedAt).getTime())) {
    throw new Error("PDF 후보 목록 스키마가 올바르지 않습니다.");
  }
  return manifest;
}

function syncPdfFigureCandidates_(sheet, manifest) {
  var lastRow = lastCandidateRow_(sheet);
  if (lastRow < 2) return { synced: 0, skipped: 0, invalid: 0 };

  var rows = sheet.getRange(2, 1, lastRow - 1, REVIEW_HEADERS.length).getValues();
  var rowsById = {};
  rows.forEach(function (row, index) {
    var paperId = stringValue_(row[4]);
    var key = "id:" + paperId;
    if (!paperId) return;
    if (!Object.prototype.hasOwnProperty.call(rowsById, key)) {
      rowsById[key] = { row: row, rowNumber: index + 2 };
    } else {
      rowsById[key] = null;
    }
  });

  var synced = 0;
  var skipped = 0;
  var invalid = 0;
  var seenIds = {};
  var warnings = [];

  manifest.candidates.forEach(function (value, index) {
    var candidate;
    try {
      candidate = validatePdfCandidate_(value);
    } catch (error) {
      invalid += 1;
      warnings.push("후보 " + (index + 1) + ": " + error.message);
      return;
    }

    var candidateKey = "id:" + candidate.paperId;
    if (seenIds[candidateKey]) {
      invalid += 1;
      warnings.push("중복 사례 ID: " + candidate.paperId);
      return;
    }
    seenIds[candidateKey] = true;

    var target = rowsById[candidateKey];
    if (!target || !pdfCandidateMatchesRow_(candidate, target.row)) {
      skipped += 1;
      return;
    }
    if (!writePdfCandidateIfEmpty_(sheet, target.rowNumber, candidate)) {
      skipped += 1;
      return;
    }
    synced += 1;
  });

  if (warnings.length) console.warn(warnings.join("\n"));
  return { synced: synced, skipped: skipped, invalid: invalid };
}

function validatePdfCandidate_(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("객체가 아닙니다.");
  }

  var paperId = requiredBoundedString_(value.paperId, 128, "paperId");
  var paperUrl = requiredBoundedString_(value.paperUrl, 2000, "paperUrl");
  var imageUrl = requiredBoundedString_(value.imageUrl, 2000, "imageUrl");
  var sourceUrl = requiredBoundedString_(value.sourceUrl, 2000, "sourceUrl");
  var license = requiredBoundedString_(value.license, 80, "license");
  var figureLabel = requiredBoundedString_(value.figureLabel, 100, "figureLabel");
  var note = requiredBoundedString_(value.note, 1000, "note");
  if (/^[=+@-]/.test(figureLabel) || /^[=+@-]/.test(note)) {
    throw new Error("시트 수식으로 해석될 수 있는 텍스트는 허용되지 않습니다.");
  }
  if (typeof value.doi !== "string" || value.doi.length > 300) {
    throw new Error("doi 형식이 올바르지 않습니다.");
  }
  var doi = stringValue_(value.doi);
  if (doi && !normalizeDoi_(doi)) throw new Error("doi 형식이 올바르지 않습니다.");
  doi = normalizeDoi_(doi);

  if (!isSafePublicHttpsUrl_(paperUrl)) throw new Error("paperUrl 호스트가 올바르지 않습니다.");
  if (!isAllowedPdfImageUrl_(imageUrl)) throw new Error("imageUrl 저장소 경로가 허용되지 않습니다.");
  if (!isSafePublicHttpsUrl_(sourceUrl)) throw new Error("sourceUrl 호스트가 올바르지 않습니다.");
  if (license !== "CC BY 4.0") throw new Error("CC BY 4.0 후보만 허용됩니다.");

  return {
    paperId: paperId,
    doi: doi,
    paperUrl: paperUrl,
    imageUrl: imageUrl,
    sourceUrl: sourceUrl,
    license: license,
    figureLabel: cleanText_(figureLabel),
    note: cleanText_(note)
  };
}

function requiredBoundedString_(value, maxLength, name) {
  if (typeof value !== "string" || !stringValue_(value) || value.length > maxLength) {
    throw new Error(name + " 형식이 올바르지 않습니다.");
  }
  return stringValue_(value);
}

function isAllowedPdfImageUrl_(url) {
  var prefix = "https://raw.githubusercontent.com/suhyoung89pro/suhyoung89pro.github.io/main/assets/yolo-research/auto/";
  var value = httpsUrl_(url);
  if (!value || value.indexOf(prefix) !== 0) return false;

  var path = value.slice(prefix.length);
  if (!path || path.length > 500 || /[?#\\%]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:png|jpe?g|webp)$/i.test(path);
}

function isSafePublicHttpsUrl_(url) {
  var value = httpsUrl_(url);
  if (!value) return false;
  var match = value.match(/^https:\/\/([^/?#]+)/i);
  if (!match || match[1].indexOf(":") !== -1) return false;

  var host = match[1].toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    return false;
  }
  return host !== "localhost" && !/^\d+(?:\.\d+){3}$/.test(host);
}

function pdfCandidateMatchesRow_(candidate, row) {
  var rowDoi = normalizeDoi_(row[21]);
  var rowPaperUrl = httpsUrl_(row[22]) || (rowDoi ? "https://doi.org/" + rowDoi : "");
  return candidate.paperId === stringValue_(row[4]) &&
    candidate.doi.toLowerCase() === rowDoi.toLowerCase() &&
    comparableUrl_(candidate.paperUrl) === comparableUrl_(rowPaperUrl);
}

function comparableUrl_(value) {
  return httpsUrl_(value).replace(/#.*$/, "").replace(/\/$/, "");
}

function writePdfCandidateIfEmpty_(sheet, rowNumber, candidate) {
  var current = sheet.getRange(rowNumber, 4, 1, 15).getValues()[0];
  var hasManualImageFields = [current[12], current[13], current[14]].some(function (value) {
    return stringValue_(value);
  });
  if (current[0] === true || hasManualImageFields) return false;

  var detail = [candidate.figureLabel, candidate.note].filter(Boolean).join(" · ");
  writeImageCandidate_(sheet, rowNumber, {
    imageUrl: candidate.imageUrl,
    sourceUrl: candidate.sourceUrl,
    license: candidate.license,
    note: "자동 이미지 후보: PDF · " + truncate_(detail, 900)
  });
  return true;
}

function hasAnyImageField_(row) {
  return [row[15], row[16], row[17]].some(function (value) {
    return stringValue_(value);
  });
}

function fillImageCandidatesInRows_(sheet, startRow, rowCount) {
  if (rowCount < 1) return { filled: 0, reviewed: 0 };

  var rows = sheet.getRange(startRow, 1, rowCount, REVIEW_HEADERS.length).getValues();
  var filled = 0;
  var reviewed = 0;

  for (var index = 0; index < rows.length; index += 1) {
    if (reviewed >= YOLO_CONFIG.maxImageCandidatesPerRun) break;

    var row = rows[index];
    var sheetRow = startRow + index;
    if (!stringValue_(row[4])) continue;
    var hasImageFields = [row[15], row[16], row[17]].some(function (value) {
      return stringValue_(value);
    });
    var legacyAutoCandidate = row[3] !== true && hasImageFields &&
      /자동 후보(?! v2)/.test(stringValue_(row[17]));
    if (row[3] === true || (hasImageFields && !legacyAutoCandidate)) continue;
    var auditNote = stringValue_(row[29]);
    if (!legacyAutoCandidate && /자동 이미지 후보:|자동 이미지 조사:/.test(auditNote)) continue;

    reviewed += 1;
    var result;
    try {
      result = findImageCandidate_(normalizeDoi_(row[21]), httpsUrl_(row[22]));
    } catch (error) {
      updateImageAuditNote_(sheet, sheetRow, "자동 이미지 조사 오류: " + error.message);
      continue;
    }

    if (!result || !result.imageUrl) {
      if (legacyAutoCandidate) clearImageCandidate_(sheet, sheetRow);
      updateImageAuditNote_(sheet, sheetRow, result && result.note
        ? result.note
        : "자동 이미지 조사: 지원하는 웹 Figure를 찾지 못했습니다.");
      continue;
    }

    writeImageCandidate_(sheet, sheetRow, result);
    filled += 1;
  }

  return { filled: filled, reviewed: reviewed };
}

function findImageCandidate_(doi, paperUrl) {
  var mdpi = mdpiAssetFromDoi_(doi);
  if (mdpi) return extractMdpiImageCandidate_(mdpi, paperUrl || "https://doi.org/" + doi);

  if (/^https:\/\/(?:www\.)?researchsquare\.com\//i.test(paperUrl)) {
    return extractResearchSquareImageCandidate_(paperUrl);
  }

  if (/^10\.21203\/rs\.3\.rs-/i.test(doi)) {
    var match = doi.match(/(rs-\d+)\/v(\d+)$/i);
    if (match) {
      return extractResearchSquareImageCandidate_(
        "https://www.researchsquare.com/article/" + match[1].toLowerCase() + "/v" + match[2]
      );
    }
  }

  if (/^https:\/\/(?:www\.)?engrxiv\.org\//i.test(paperUrl) || /^10\.31224\//i.test(doi)) {
    return { note: "자동 이미지 조사: 웹 Figure 없음 · PDF 추출 필요" };
  }

  return { note: "자동 이미지 조사: 현재 지원하지 않는 출판사입니다." };
}

function mdpiAssetFromDoi_(doi) {
  var match = stringValue_(doi).match(/^10\.3390\/([a-z]+)(\d{4})(\d{4,5})$/i);
  if (!match) return null;

  var doiJournal = match[1].toLowerCase();
  var journal = {
    app: "applsci",
    math: "mathematics",
    s: "sensors"
  }[doiJournal] || doiJournal;
  var volume = String(Number(match[2].slice(0, 2)));
  var article = ("00000" + Number(match[3])).slice(-5);
  return {
    journal: journal,
    asset: journal + "-" + ("00" + volume).slice(-2) + "-" + article
  };
}

function extractMdpiImageCandidate_(asset, articleUrl) {
  var base = "https://mdpi-res.com/d_attachment/" + asset.journal + "/" + asset.asset +
    "/article_deploy/";
  var response = fetchPublicResource_(base + asset.asset + ".xml", "application/xml,text/xml");
  var xml = response.getContentText();

  if (!/creativecommons\.org\/licenses\/by\/4\.0\/?/i.test(xml)) {
    return { note: "자동 이미지 조사: 재사용 가능한 CC BY 4.0 라이선스를 확인하지 못했습니다." };
  }

  var figures = parseMdpiFigures_(xml);
  var selected = chooseResultFigure_(figures);
  if (!selected) return { note: "자동 이미지 조사: 결과형 Figure 후보가 없습니다." };
  if (hasThirdPartyRightsWarning_(selected.caption)) {
    return { note: "자동 이미지 조사: 제3자 Figure 가능성이 있어 수동 확인이 필요합니다." };
  }

  var imageName = selected.graphic.replace(/\.(?:tiff?|png|jpe?g)$/i, ".png");
  var imageUrl = base + "html/images/" + imageName;
  if (!verifyImageUrl_(imageUrl)) {
    return { note: "자동 이미지 조사: Figure 이미지 주소를 확인하지 못했습니다." };
  }

  return {
    imageUrl: imageUrl,
    sourceUrl: articleUrl,
    license: "CC BY 4.0 · " + selected.label + " · 자동 후보 v2",
    note: "자동 이미지 후보: " + selected.label + " · " + selected.caption
  };
}

function parseMdpiFigures_(xml) {
  return stringValue_(xml).match(/<fig\b[\s\S]*?<\/fig>/gi) || [];
}

function parseMdpiFigure_(block) {
  return {
    label: cleanXmlText_(firstMatch_(block, /<label\b[^>]*>([\s\S]*?)<\/label>/i)),
    caption: cleanXmlText_(firstMatch_(block, /<caption\b[^>]*>([\s\S]*?)<\/caption>/i)),
    graphic: firstMatch_(block, /<graphic\b[^>]*(?:xlink:href|href)=["']([^"']+)["']/i)
  };
}

function extractResearchSquareImageCandidate_(articleUrl) {
  var response = fetchPublicResource_(articleUrl, "text/html");
  var html = response.getContentText();
  var jsonText = firstMatch_(html, /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!jsonText) return { note: "자동 이미지 조사: Research Square 웹 데이터를 찾지 못했습니다." };

  var payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (error) {
    payload = JSON.parse(decodeHtmlEntities_(jsonText));
  }
  var initialData = payload.props.pageProps.initialData;
  if (!initialData) return { note: "자동 이미지 조사: Research Square 논문 데이터를 읽지 못했습니다." };

  var licenseName = cleanText_(initialData.license && initialData.license.name);
  if (!/^CC BY 4\.0$/i.test(licenseName)) {
    return { note: "자동 이미지 조사: 재사용 가능한 CC BY 4.0 라이선스를 확인하지 못했습니다." };
  }

  var files = Array.isArray(initialData.files) ? initialData.files : [];
  var figures = files.filter(function (file) {
    return stringValue_(file.role).toLowerCase() === "figure" && httpsUrl_(file.url);
  }).map(function (file, index) {
    return {
      label: "Figure " + (index + 1),
      caption: cleanText_(file.legend),
      graphic: httpsUrl_(file.url)
    };
  });

  if (!figures.length) {
    return {
      note: initialData.isAuthorSuppliedPdf
        ? "자동 이미지 조사: 웹 Figure 없음 · PDF 추출 필요"
        : "자동 이미지 조사: Research Square에 별도 Figure 파일이 없습니다."
    };
  }

  var selected = chooseResultFigure_(figures);
  if (!selected || !verifyImageUrl_(selected.graphic)) {
    return { note: "자동 이미지 조사: 유효한 결과형 Figure 후보가 없습니다." };
  }
  if (hasThirdPartyRightsWarning_(selected.caption)) {
    return { note: "자동 이미지 조사: 제3자 Figure 가능성이 있어 수동 확인이 필요합니다." };
  }

  return {
    imageUrl: selected.graphic,
    sourceUrl: articleUrl,
    license: "CC BY 4.0 · " + selected.label + " · 자동 후보 v2",
    note: "자동 이미지 후보: " + selected.label + " · " + selected.caption
  };
}

function chooseResultFigure_(figures) {
  var ranked = figures.map(function (figure) {
    var parsed = typeof figure === "string" ? parseMdpiFigure_(figure) : figure;
    return { figure: parsed, score: scoreResultFigure_(parsed.caption) };
  }).filter(function (entry) {
    return entry.figure.graphic && entry.score >= 6 && !hasThirdPartyRightsWarning_(entry.figure.caption);
  }).sort(function (left, right) {
    return right.score - left.score;
  });

  return ranked.length ? ranked[0].figure : null;
}

function scoreResultFigure_(caption) {
  var text = stringValue_(caption).toLowerCase();
  var score = 0;
  [
    [/visual comparison|qualitative (?:comparison|results?)/, 12],
    [/(?:detection|inference|prediction|recognition) (?:results?|examples?)|results? (?:of|for|from)[^.]{0,80}(?:detect|infer|predict|recogn)/, 10],
    [/bounding box|locali[sz]ation|identified|identification/, 3],
    [/test (?:set|dataset)|defect/, 2],
    [/comparison/, 1],
    [/architecture|framework|module|workflow|flowchart|schematic/, -12],
    [/map|precision|recall|metric|flops|parameters?|training speed|radar chart|p[–-]?r curves?|loss curves?|confusion matrix/, -12],
    [/dataset annotation|dataset statistics|distribution|histograms?|feature maps?|heatmaps?|grad-cam|classes/, -8]
  ].forEach(function (rule) {
    if (rule[0].test(text)) score += rule[1];
  });
  return score;
}

function hasThirdPartyRightsWarning_(caption) {
  var text = stringValue_(caption);
  return /reproduced|adapted|permission|copyright|©|\[\s*\d+(?:\s*,\s*\d+)*\s*\]/i.test(text);
}

function verifyImageUrl_(url) {
  try {
    var response = fetchPublicResource_(url, "image/avif,image/webp,image/png,image/jpeg");
    var contentType = stringValue_(response.getHeaders()["Content-Type"] || response.getHeaders()["content-type"]);
    var bytes = response.getBlob().getBytes().length;
    return /^image\/(?:png|jpeg|webp|avif)$/i.test(contentType.split(";")[0]) &&
      bytes >= 5000 && bytes <= 15000000;
  } catch (error) {
    return false;
  }
}

function fetchPublicResource_(url, accept) {
  var safeUrl = httpsUrl_(url);
  if (!safeUrl || !isAllowedResearchHost_(safeUrl)) throw new Error("허용되지 않은 원격 주소입니다.");

  var response = UrlFetchApp.fetch(safeUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      Accept: accept,
      "User-Agent": "YOLOIndustrialCaseReview/1.1 (https://github.com/suhyoung89pro/suhyoung89pro.github.io)"
    }
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error("원격 자료 HTTP " + status);
  return response;
}

function isAllowedResearchHost_(url) {
  return /^https:\/\/(?:mdpi-res\.com|www\.researchsquare\.com|researchsquare\.com|assets(?:-eu)?\.researchsquare\.com)\//i.test(url);
}

function writeImageCandidate_(sheet, rowNumber, result) {
  sheet.getRange(rowNumber, 4).setValue(false);
  SpreadsheetApp.flush();
  sheet.getRange(rowNumber, 16, 1, 3).setValues([[
    result.imageUrl,
    result.sourceUrl,
    result.license
  ]]);
  sheet.getRange(rowNumber, 29).setValue("이미지 검토 필요");
  updateImageAuditNote_(sheet, rowNumber, result.note);
}

function clearImageCandidate_(sheet, rowNumber) {
  sheet.getRange(rowNumber, 4).setValue(false);
  sheet.getRange(rowNumber, 16, 1, 3).clearContent();
  sheet.getRange(rowNumber, 29).setValue("검토 대기");
}

function updateImageAuditNote_(sheet, rowNumber, message) {
  var cell = sheet.getRange(rowNumber, 30);
  var existing = stringValue_(cell.getValue())
    .replace(/(?:^|\n)자동 이미지 (?:후보|조사)[^\n]*/g, "")
    .trim();
  cell.setValue([existing, stringValue_(message)].filter(Boolean).join("\n"));
}

function firstMatch_(value, pattern) {
  var match = stringValue_(value).match(pattern);
  return match ? match[1] : "";
}

function cleanXmlText_(value) {
  return cleanText_(decodeHtmlEntities_(value));
}

function decodeHtmlEntities_(value) {
  return stringValue_(value)
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function appendCandidates_(sheet, candidates) {
  var now = new Date();
  var values = candidates.map(function (candidate) {
    return [
      false,
      false,
      false,
      false,
      candidate.id,
      candidate.industry,
      candidate.application,
      candidate.title,
      "",
      candidate.model,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      candidate.authors,
      candidate.venue,
      candidate.year,
      candidate.doi,
      candidate.paperUrl,
      "",
      candidate.citationCount,
      "Crossref",
      now,
      now,
      "검토 대기",
      candidate.reviewNote
    ];
  });

  var startRow = nextWriteRow_(sheet);
  sheet.getRange(startRow, 1, values.length, REVIEW_HEADERS.length).setValues(values);
  sheet
    .getRange(startRow, 1, values.length, 4)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sheet.getRange(startRow, 27, values.length, 2).setNumberFormat("yyyy-mm-dd");
  return startRow;
}

function nextWriteRow_(sheet) {
  return Math.max(2, lastCandidateRow_(sheet) + 1);
}

function readKnownKeys_(sheet) {
  var known = {};
  var lastRow = lastCandidateRow_(sheet);
  if (lastRow < 2) return known;

  sheet
    .getRange(2, 1, lastRow - 1, REVIEW_HEADERS.length)
    .getValues()
    .forEach(function (row) {
      var key = candidateKey_(row[21], row[22], row[7], row[20]);
      if (key) known[key] = true;
    });
  return known;
}

function lastCandidateRow_(sheet) {
  var lastPhysicalRow = Math.max(sheet.getLastRow(), 2);
  var ids = sheet.getRange(2, 5, lastPhysicalRow - 1, 1).getDisplayValues();

  for (var index = ids.length - 1; index >= 0; index -= 1) {
    if (stringValue_(ids[index][0])) return index + 2;
  }

  return 1;
}

function candidateKey_(doi, paperUrl, title, year) {
  var normalizedDoi = normalizeDoi_(doi);
  if (normalizedDoi) return "doi:" + normalizedDoi.toLowerCase();

  var normalizedUrl = httpsUrl_(paperUrl);
  if (normalizedUrl) return "url:" + normalizedUrl.toLowerCase();

  var normalizedTitle = stringValue_(title)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "");
  return normalizedTitle ? "title:" + normalizedTitle + ":" + stringValue_(year) : "";
}

function validateReviewHeaders_(sheet) {
  var headers = sheet.getRange(1, 1, 1, REVIEW_HEADERS.length).getValues()[0];
  REVIEW_HEADERS.forEach(function (expected, index) {
    if (stringValue_(headers[index]) !== expected) {
      throw new Error(
        "검토 대기 시트의 " + (index + 1) + "번째 열은 '" + expected + "'이어야 합니다."
      );
    }
  });
}

function formatCitation_(row) {
  var parts = [];
  if (stringValue_(row[18])) parts.push(stringValue_(row[18]));
  parts.push('"' + stringValue_(row[7]) + '"');
  if (stringValue_(row[19])) parts.push(stringValue_(row[19]));
  if (stringValue_(row[20])) parts.push(stringValue_(row[20]));
  if (normalizeDoi_(row[21])) parts.push("https://doi.org/" + normalizeDoi_(row[21]));
  return parts.join(", ");
}

function publicationYear_(work) {
  var fields = ["published-print", "published-online", "published", "issued", "created"];
  for (var i = 0; i < fields.length; i += 1) {
    var value = work[fields[i]];
    if (value && value["date-parts"] && value["date-parts"][0]) {
      var year = Number(value["date-parts"][0][0]);
      if (year) return year;
    }
  }
  return "";
}

function formatAuthors_(authors) {
  if (!Array.isArray(authors)) return "";
  var names = authors.slice(0, 8).map(function (author) {
    return [cleanText_(author.given), cleanText_(author.family)].filter(Boolean).join(" ");
  }).filter(Boolean);
  if (authors.length > 8) names.push("et al.");
  return names.join(", ");
}

function detectYoloVersion_(text) {
  var match = stringValue_(text).match(/\bYOLO(?:v?\d+(?:\.\d+)?|X|NAS|World)(?:-[A-Za-z0-9]+)?\b/i);
  return match ? match[0] : "YOLO";
}

function cleanText_(value) {
  return stringValue_(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function httpsUrl_(value) {
  var text = stringValue_(value);
  if (!text || !/^https:\/\/[^\s]+$/i.test(text) || /^https:\/\/[^/]*@/i.test(text)) return "";
  return text;
}

function normalizeDoi_(value) {
  var doi = stringValue_(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "";
}

function stableHash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    stringValue_(value),
    Utilities.Charset.UTF_8
  ).map(function (byte) {
    var normalized = byte < 0 ? byte + 256 : byte;
    return ("0" + normalized.toString(16)).slice(-2);
  }).join("");
}

function truncate_(value, maxLength) {
  var text = stringValue_(value);
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

function dateToIso_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
  var text = stringValue_(value);
  return text || "";
}

function numberOrBlank_(value) {
  if (value === "" || value === null || value === undefined) return "";
  var number = Number(value);
  return isNaN(number) ? "" : number;
}

function firstArrayValue_(value) {
  return Array.isArray(value) ? value[0] : value;
}

function stringValue_(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function openSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty(YOLO_CONFIG.spreadsheetIdProperty);

  if (!spreadsheetId) {
    var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (activeSpreadsheet) {
      spreadsheetId = activeSpreadsheet.getId();
      properties.setProperty(YOLO_CONFIG.spreadsheetIdProperty, spreadsheetId);
    }
  }

  if (!spreadsheetId) {
    throw new Error("승인 시트 연결 정보가 없습니다. installWeeklyTrigger를 다시 실행해 주세요.");
  }

  return SpreadsheetApp.openById(spreadsheetId);
}

function rememberBoundSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Google Sheet에 연결된 Apps Script에서 실행해 주세요.");
  }

  PropertiesService.getScriptProperties().setProperty(
    YOLO_CONFIG.spreadsheetIdProperty,
    spreadsheet.getId()
  );
}

function getRequiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error("필수 시트가 없습니다: " + name);
  return sheet;
}
