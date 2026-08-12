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
  maxCandidatesPerRun: 100,
  weeklyHandler: "collectYoloCandidates"
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
    .addItem("주간 자동 조사 설치", "installWeeklyTrigger")
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

    if (candidates.length) appendCandidates_(reviewSheet, candidates);

    var message = candidates.length + "건의 새 후보를 추가했습니다.";
    if (failures.length) message += " 검색 오류 " + failures.length + "건은 실행 로그를 확인하세요.";
    spreadsheet.toast(message, "YOLO 사례 조사", 8);

    if (failures.length) console.warn(failures.join("\n"));
  } finally {
    lock.releaseLock();
  }
}

function doGet(event) {
  var items = readPublishedItems_();
  var response = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    items: items
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
  var imageRightsVerified = row[3] === true;
  var title = stringValue_(row[7]);
  var imageUrl = httpsUrl_(row[15]);
  var imageSourceUrl = httpsUrl_(row[16]);
  var imageLicense = stringValue_(row[17]);
  var doi = normalizeDoi_(row[21]);
  var paperUrl = httpsUrl_(row[22]) || (doi ? "https://doi.org/" + doi : "");

  if (!publishApproved || !sourceVerified || !metricContextVerified) return false;
  if (!title || !paperUrl) return false;

  if (stringValue_(row[15])) {
    if (!imageUrl || !imageRightsVerified || !imageSourceUrl || !imageLicense) return false;
  }

  return true;
}

function rowToPublicItem_(row) {
  var doi = normalizeDoi_(row[21]);
  var paperUrl = httpsUrl_(row[22]) || (doi ? "https://doi.org/" + doi : "");
  var imageUrl = httpsUrl_(row[15]);
  var imageSourceUrl = imageUrl ? httpsUrl_(row[16]) : "";
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
    imageCaption: imageUrl ? "이미지 라이선스: " + stringValue_(row[17]) : "",
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
