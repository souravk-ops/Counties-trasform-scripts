// scripts/data_extractor.js
// Extraction script per instructions
// - Reads: input.html, unnormalized_address.json, property_seed.json
// - Owners from owners/owner_data.json
// - Utilities from owners/utilities_data.json
// - Layout from owners/layout_data.json
// - All others from input.html

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const DEFAULT_SOURCE_HTTP_REQUEST = {
  method: "GET",
  url: "https://qpublic.schneidercorp.com/application.aspx",
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Updated selectors based on the provided HTML
const PARCEL_SELECTOR = "#ctlBodyPane_ctl02_ctl01_dynamicSummary_rptrDynamicColumns_ctl00_pnlSingleValue span";
const OVERALL_DETAILS_TABLE_SELECTOR = "#ctlBodyPane_ctl02_ctl01_dynamicSummary_divSummary table.tabular-data-two-column tbody tr";
const BUILDING_SECTION_TITLE = "Residential Buildings"; // Corrected title from HTML
const SALES_TABLE_SELECTOR = "#ctlBodyPane_ctl15_ctl01_grdSales tbody tr"; // Corrected selector for sales table
const VALUATION_TABLE_SELECTOR = "#ctlBodyPane_ctl05_ctl01_grdValuation"; // Corrected selector for valuation table


function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function textTrim(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function cloneDeep(obj) {
  return obj == null ? null : JSON.parse(JSON.stringify(obj));
}

function normalizePointerPath(value) {
  if (typeof value !== "string") return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/\\/g, "/");
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  trimmed = trimmed.replace(/^\/+/, "");
  if (!trimmed) return null;
  return `./${trimmed}`;
}

function attachSourceHttpRequest(target, request) {
  if (!target || !request) return;
  target.source_http_request = cloneDeep(request);
}

function normalizePointerOutput(pointerString) {
  if (!pointerString) return null;
  if (typeof pointerString !== "string") return null;
  const trimmed = pointerString.trim();
  if (!trimmed) return null;
  if (/^cid:/i.test(trimmed)) {
    const cidOnly = trimmed.slice(4).trim();
    return cidOnly ? { cid: `cid:${cidOnly}` } : null;
  }
  if (/^(?:baf|bag)/i.test(trimmed)) {
    return { cid: trimmed };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { uri: trimmed };
  }
  const normalized = normalizePointerPath(trimmed);
  if (!normalized) return null;
  return { "/": normalized };
}

function sanitizePointerObject(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  const sanitized = {};
  if (typeof pointer.cid === "string") {
    const cid = pointer.cid.trim();
    if (cid) sanitized.cid = cid;
  }
  if (typeof pointer.uri === "string") {
    const uri = pointer.uri.trim();
    if (uri) sanitized.uri = uri;
  }
  if (typeof pointer["/"] === "string") {
    const normalizedPath = normalizePointerPath(pointer["/"]);
    if (normalizedPath) sanitized["/"] = normalizedPath;
  }
  return stripPointerToAllowedKeys(sanitized);
}

const POINTER_ALLOWED_KEYS = new Set(["cid", "uri", "/"]);
const RELATIONSHIP_ENDPOINT_BLOCKLIST = new Set([
  "document_type",
  "file_format",
  "ipfs_url",
  "name",
  "original_url",
  "deed_type",
]);

function stripRelationshipMetadata(pointer) {
  if (!pointer || typeof pointer !== "object") return pointer;
  const cleaned = {};
  Object.keys(pointer).forEach((key) => {
    if (RELATIONSHIP_ENDPOINT_BLOCKLIST.has(key)) {
      return;
    }
    cleaned[key] = pointer[key];
  });
  return cleaned;
}

function stripPointerToAllowedKeys(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  const candidate = stripRelationshipMetadata(pointer);
  const cleaned = {};
  for (const key of POINTER_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
    const raw = candidate[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) cleaned[key] = trimmed;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function finalizeRelationshipEndpoint(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  const sanitized = stripPointerToAllowedKeys(pointer);
  if (!sanitized || typeof sanitized !== "object") return null;

  if (typeof sanitized.cid === "string") {
    const cidValue = sanitized.cid.trim();
    if (cidValue) {
      const normalizedCid = cidValue.startsWith("cid:")
        ? cidValue
        : `cid:${cidValue}`;
      return { cid: normalizedCid };
    }
  }

  if (typeof sanitized.uri === "string") {
    const uriValue = sanitized.uri.trim();
    if (uriValue) {
      return { uri: uriValue };
    }
  }

  if (typeof sanitized["/"] === "string") {
    const normalizedPath = normalizePointerPath(sanitized["/"]);
    if (normalizedPath) {
      return { "/": normalizedPath };
    }
    const trimmedPath = sanitized["/"].trim();
    if (trimmedPath) {
      if (trimmedPath.startsWith("./") || trimmedPath.startsWith("../")) {
        return { "/": trimmedPath };
      }
      if (trimmedPath.startsWith("data/")) {
        return { "/": `./${trimmedPath.slice("data/".length)}` };
      }
      return { "/": `./${trimmedPath.replace(/^\/+/, "")}` };
    }
  }

  return null;
}

function toStrictRelationshipPointer(pointer) {
  if (!pointer || typeof pointer !== "object") return null;

  const select = (keys) => {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(pointer, key)) continue;
      const raw = pointer[key];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      return { key, value: trimmed };
    }
    return null;
  };

  const chosen = select(["cid", "uri", "/"]);
  if (!chosen) return null;

  if (chosen.key === "cid") {
    const normalizedCid = chosen.value.startsWith("cid:")
      ? chosen.value
      : `cid:${chosen.value}`;
    return { cid: normalizedCid };
  }

  if (chosen.key === "uri") {
    return { uri: chosen.value };
  }

  let normalizedPath = normalizePointerPath(chosen.value);
  if (!normalizedPath) {
    const stripped = chosen.value.replace(/^\/+/, "");
    if (!stripped) return null;
    normalizedPath = `./${stripped}`;
  }
  if (normalizedPath.startsWith("./data/")) {
    normalizedPath = `./${normalizedPath.slice("./data/".length)}`;
  }
  return { "/": normalizedPath };
}

function pointerFrom(refLike) {
  if (refLike == null) return null;
  if (typeof refLike === "string") {
    return sanitizePointerObject(normalizePointerOutput(refLike));
  }
  if (typeof refLike !== "object") return null;

  const rawPointer = {};
  if (typeof refLike.cid === "string") {
    const cid = refLike.cid.trim();
    if (cid) rawPointer.cid = cid.startsWith("cid:") ? cid : `cid:${cid}`;
  }
  if (typeof refLike.uri === "string") {
    const uri = refLike.uri.trim();
    if (uri) rawPointer.uri = uri;
  }
  const pathCandidate =
    (typeof refLike["/"] === "string" && refLike["/"]) ||
    (typeof refLike.path === "string" && refLike.path) ||
    (typeof refLike["@ref"] === "string" && refLike["@ref"]) ||
    (typeof refLike.filename === "string" && refLike.filename) ||
    (typeof refLike.file === "string" && refLike.file);
  if (typeof pathCandidate === "string") {
    const normalizedPath = normalizePointerPath(pathCandidate);
    if (normalizedPath) rawPointer["/"] = normalizedPath;
  }
  return stripPointerToAllowedKeys(rawPointer);
}

function buildStrictPathPointer(refLike) {
  if (typeof refLike !== "string") return null;
  const normalized = normalizePointerOutput(refLike);
  const pointer = sanitizePointerObject(normalized);
  if (!pointer || typeof pointer["/"] !== "string") return null;
  let pathValue = pointer["/"].trim();
  if (!pathValue) return null;

  // Normalize to a relative path that matches the schema pointer constraints.
  if (pathValue.startsWith("./")) {
    const withoutDots = pathValue.slice(2);
    pathValue = `./${withoutDots.replace(/^data\//, "")}`;
  } else if (pathValue.startsWith("../")) {
    // Already scoped relative to parent; leave as-is but collapse repeated separators.
    pathValue = pathValue.replace(/\/{2,}/g, "/");
  } else if (pathValue.startsWith("data/")) {
    pathValue = `./${pathValue.slice("data/".length)}`;
  } else {
    pathValue = `./${pathValue.replace(/^\/+/, "")}`;
  }

  if (pathValue.startsWith("./data/")) {
    pathValue = `./${pathValue.slice("./data/".length)}`;
  }

  return { "/": pathValue };
}

function sanitizeRelationshipReference(refLike) {
  const pointer = pointerFrom(refLike);
  if (!pointer) return null;
  const cleaned = {};
  for (const key of POINTER_ALLOWED_KEYS) {
    const raw = pointer[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    cleaned[key] = trimmed;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function normalizeRelationshipEndpoint(refLike) {
  if (refLike == null) return null;
  if (typeof refLike === "string") {
    const pointerFromString = buildStrictPathPointer(refLike);
    if (pointerFromString) return pointerFromString;
    return sanitizeRelationshipReference(refLike);
  }
  if (typeof refLike !== "object") return null;

  if (typeof refLike.cid === "string") {
    const rawCid = refLike.cid.trim();
    if (rawCid) {
      return {
        cid: rawCid.startsWith("cid:") ? rawCid : `cid:${rawCid}`,
      };
    }
  }

  if (typeof refLike.uri === "string") {
    const rawUri = refLike.uri.trim();
    if (rawUri) {
      return { uri: rawUri };
    }
  }

  const pathCandidate =
    (typeof refLike["/"] === "string" && refLike["/"]) ||
    (typeof refLike.path === "string" && refLike.path) ||
    (typeof refLike["@ref"] === "string" && refLike["@ref"]) ||
    (typeof refLike.filename === "string" && refLike.filename) ||
    (typeof refLike.file === "string" && refLike.file);

  if (typeof pathCandidate === "string") {
    const pointerFromPath = buildStrictPathPointer(pathCandidate);
    if (pointerFromPath) return pointerFromPath;
  }

  return sanitizeRelationshipReference(refLike);
}

function pointerNormalizedPath(pointer) {
  if (!pointer) return null;
  if (typeof pointer === "string") {
    const normalized = normalizePointerPath(pointer);
    return normalized || null;
  }
  if (typeof pointer !== "object") return null;
  const path = pointer["/"];
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = normalizePointerPath(trimmed);
  return normalized || null;
}

const RELATIONSHIP_EXPECTED_PREFIXES = {
  deed_has_file: { from: "./deed_", to: "./file_" },
  sales_history_has_deed: { from: "./sales_history_", to: "./deed_" },
  property_has_file: { from: "./property", to: "./file_" },
  property_has_sales_history: { from: "./property", to: "./sales_history_" },
  property_has_layout: { from: "./property", to: "./layout_" },
  sales_history_has_person: { from: "./sales_history_", to: "./person_" },
  sales_history_has_company: { from: "./sales_history_", to: "./company_" },
};

function maybeReorientRelationship(type, fromReference, toReference) {
  if (!fromReference || !toReference) {
    return { from: fromReference, to: toReference };
  }

  const expected = RELATIONSHIP_EXPECTED_PREFIXES[type];
  if (!expected) {
    return { from: fromReference, to: toReference };
  }

  const fromPath = pointerNormalizedPath(fromReference);
  const toPath = pointerNormalizedPath(toReference);
  const matches = (value, prefix) =>
    typeof value === "string" &&
    typeof prefix === "string" &&
    value.toLowerCase().startsWith(prefix.toLowerCase());

  const fromMatchesExpected = matches(fromPath, expected.from);
  const toMatchesExpected = matches(toPath, expected.to);
  if (fromMatchesExpected && toMatchesExpected) {
    return { from: fromReference, to: toReference };
  }

  const fromMatchesReversed = matches(fromPath, expected.to);
  const toMatchesReversed = matches(toPath, expected.from);
  if (fromMatchesReversed && toMatchesReversed) {
    return { from: toReference, to: fromReference };
  }

  return { from: fromReference, to: toReference };
}

function writeRelationship(type, fromRefLike, toRefLike, suffix) {
  if (typeof type !== "string") return;
  const relationshipType = type.trim();
  if (!relationshipType) return;

  const fromReference = normalizeRelationshipEndpoint(fromRefLike);
  const toReference = normalizeRelationshipEndpoint(toRefLike);
  if (!fromReference || !toReference) return;

  const reoriented = maybeReorientRelationship(
    relationshipType,
    fromReference,
    toReference,
  );
  const sanitizedFrom = finalizeRelationshipEndpoint(
    reoriented && reoriented.from,
  );
  const sanitizedTo = finalizeRelationshipEndpoint(reoriented && reoriented.to);
  const strictFrom = toStrictRelationshipPointer(sanitizedFrom);
  const strictTo = toStrictRelationshipPointer(sanitizedTo);
  if (!strictFrom || !strictTo) return;

  const expected = RELATIONSHIP_EXPECTED_PREFIXES[relationshipType];
  if (expected) {
    const matchesPrefix = (value, prefix) =>
      typeof value === "string" &&
      typeof prefix === "string" &&
      value.toLowerCase().startsWith(prefix.toLowerCase());

    const finalFromPath = pointerNormalizedPath(strictFrom);
    const finalToPath = pointerNormalizedPath(strictTo);

    const fromMismatch =
      expected.from &&
      finalFromPath &&
      !matchesPrefix(finalFromPath, expected.from);
    const toMismatch =
      expected.to && finalToPath && !matchesPrefix(finalToPath, expected.to);

    if (fromMismatch || toMismatch) {
      return;
    }
  }

  const relationship = {
    from: strictFrom,
    to: strictTo,
  };

  const suffixPortion =
    suffix === undefined || suffix === null || suffix === "" ? "" : `_${suffix}`;

  const filename = `relationship_${relationshipType}${suffixPortion}.json`;
  writeJSON(path.join("data", filename), relationship);
}

function writeRelationshipFromFilenames(type, fromFilename, toFilename, suffix) {
  if (!fromFilename || !toFilename) return;
  const fromPointer = buildStrictPathPointer(fromFilename);
  const toPointer = buildStrictPathPointer(toFilename);
  if (!fromPointer || !toPointer) return;
  writeRelationship(type, fromPointer, toPointer, suffix);
}

function normalizeSaleDate(value) {
  const iso = parseDateToISO(value);
  if (iso) return iso;
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function parseBookAndPage(raw) {
  if (!raw || typeof raw !== "string") {
    return { book: null, page: null };
  }
  const cleaned = raw.replace(/\s+/g, "");
  const match = cleaned.match(/^(\d+)[/-](\d+)$/);
  if (match) {
    return { book: match[1], page: match[2] };
  }
  return { book: null, page: null };
}

function removeFilesMatchingPatterns(patterns) {
  try {
    const entries = fs.readdirSync("data");
    entries.forEach((filename) => {
      if (patterns.some((regex) => regex.test(filename))) {
        fs.unlinkSync(path.join("data", filename));
      }
    });
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

function sanitizeFileMetadata(file) {
  if (!file || typeof file !== "object") return {};

  const sanitized = {};

  if (typeof file.request_identifier === "string") {
    const trimmed = file.request_identifier.trim();
    if (trimmed) sanitized.request_identifier = trimmed;
  }

  if (file.source_http_request && typeof file.source_http_request === "object") {
    const clonedRequest = cloneDeep(file.source_http_request);
    if (clonedRequest && Object.keys(clonedRequest).length > 0) {
      sanitized.source_http_request = clonedRequest;
    }
  }

  [
    "document_type",
    "file_format",
    "ipfs_url",
    "name",
    "original_url",
  ].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      delete sanitized[key];
    }
  });

  return sanitized;
}

function sanitizeDeedMetadata(deed) {
  if (!deed || typeof deed !== "object") return {};
  const sanitized = {};
  const assignString = (key) => {
    const raw = deed[key];
    if (raw == null) return;
    const normalized = typeof raw === "string" ? raw.trim() : raw;
    if (typeof normalized === "string") {
      if (!normalized) return;
      sanitized[key] = normalized;
      return;
    }
    sanitized[key] = normalized;
  };
  ["book", "deed_type", "instrument_number", "page", "request_identifier", "volume"].forEach(
    assignString,
  );
  if (deed.source_http_request && typeof deed.source_http_request === "object") {
    const cloned = cloneDeep(deed.source_http_request);
    if (cloned && Object.keys(cloned).length > 0) {
      sanitized.source_http_request = cloned;
    }
  }
  return sanitized;
}

function sanitizeSalesHistoryRecord(record) {
  if (!record || typeof record !== "object") return null;
  const sanitized = {};
  const transferRaw = record.ownership_transfer_date;
  if (typeof transferRaw === "string") {
    const trimmed = transferRaw.trim();
    if (!trimmed) return null;
    sanitized.ownership_transfer_date = trimmed;
  } else if (transferRaw) {
    sanitized.ownership_transfer_date = transferRaw;
  } else {
    return null;
  }

  if (record.purchase_price_amount != null) {
    const amount = Number(record.purchase_price_amount);
    if (!Number.isNaN(amount)) {
      sanitized.purchase_price_amount = amount;
    }
  }

  if (typeof record.sale_type === "string") {
    const val = record.sale_type.trim();
    if (val) sanitized.sale_type = val;
  }

  if (typeof record.request_identifier === "string") {
    const reqId = record.request_identifier.trim();
    if (reqId) sanitized.request_identifier = reqId;
  }

  if (record.source_http_request && typeof record.source_http_request === "object") {
    const cloned = cloneDeep(record.source_http_request);
    if (cloned && Object.keys(cloned).length > 0) {
      sanitized.source_http_request = cloned;
    }
  }

  return sanitized;
}

function parseCurrencyToNumber(txt) {
  if (txt == null) return null;
  const s = String(txt).trim();
  if (s === "") return null;
  const n = Number(s.replace(/[$,]/g, ""));
  if (isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function parseDateToISO(txt) {
  if (!txt) return null;
  const s = String(txt).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [_, mm, dd, yyyy] = m;
    const mm2 = mm.padStart(2, "0");
    const dd2 = dd.padStart(2, "0");
    return `${yyyy}-${mm2}-${dd2}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function textOf($el) {
  if (!$el || $el.length === 0) return null;
  return $el.text().trim();
}

function loadHTML() {
  const html = fs.readFileSync("input.html", "utf8");
  return cheerio.load(html);
}

function getParcelId($) {
  let parcelIdText = $(PARCEL_SELECTOR).text().trim();
  if (parcelIdText) {
    return parcelIdText;
  }
  return null;
}

// Helper function to get label text, trying th then td
function getLabelText($row) {
  let label = textOf($row.find("th:first-child"));
  if (!label) {
    label = textOf($row.find("td:first-child"));
  }
  return label;
}

function extractLegalDescription($) {
  let desc = null;
  $(
    OVERALL_DETAILS_TABLE_SELECTOR,
  ).each((i, tr) => {
    const $tr = $(tr);
    const label = getLabelText($tr);
    if ((label || "").toLowerCase().includes("brief tax description")) { // Changed label
      desc = textOf($tr.find("td:last-child span"));
      return false; // Stop iterating once found
    }
  });
  return desc || null;
}

function extractUseCode($) {
  let code = null;
  $(
    OVERALL_DETAILS_TABLE_SELECTOR,
  ).each((i, tr) => {
    const $tr = $(tr);
    const label = getLabelText($tr);
    if ((label || "").toLowerCase().includes("property use code")) {
      code = textOf($tr.find("td:last-child span"));
      return false; // Stop iterating once found
    }
  });
  return code || null;
}

function derivePropertyCategory(code) {
  const fallback = { propertyType: null, structureForm: null };
  if (!code) return fallback;
  const value = code.toUpperCase();

  const setCategory = (propertyType, structureForm = null) => ({
    propertyType,
    structureForm,
  });

  if (value.includes("VACANT")) return setCategory("LandParcel");
  if (value.includes("AG") || value.includes("FARM"))
    return setCategory("LandParcel");
  if (value.includes("MOBILE") || value.includes("MANUFACT"))
    return setCategory("ManufacturedHome", "ManufacturedHousing");
  if (value.includes("CONDO") || value.includes("APART"))
    return setCategory("Building", "ApartmentUnit");
  if (value.includes("TOWN"))
    return setCategory("Building", "TownhouseRowhouse");
  if (value.includes("DUPLEX")) return setCategory("Building", "Duplex");
  if (value.includes("TRIPLEX"))
    return setCategory("Building", "Triplex");
  if (value.includes("QUAD")) return setCategory("Building", "Quadplex");
  if (value.includes("MULTI")) {
    if (value.includes("10") || value.includes("TEN") || value.includes("MORE"))
      return setCategory("Building", "MultiFamilyMoreThan10");
    return setCategory("Building", "MultiFamilyLessThan10");
  }
  if (value.includes("APARTMENT"))
    return setCategory("Building", "ApartmentUnit");

  return setCategory("Building", "SingleFamilyDetached");
}

function collectBuildings($) {
  const buildings = [];
  const section = $("section")
    .filter(
      (_, s) =>
        textTrim($(s).find(".module-header .title").first().text()) ===
        BUILDING_SECTION_TITLE,
    )
    .first();
  if (!section.length) return buildings;

  // Helper to get label text from either th or td strong
  const getBuildingLabelText = ($row) => {
    let label = textTrim($row.find("th strong").first().text());
    if (!label) {
      label = textTrim($row.find("td strong").first().text());
    }
    return label;
  };

  // Collect data from the left column
  const leftColumnData = [];
  $(section)
    .find(
      'div[id^="ctlBodyPane_ctl10_ctl01_lstBuildings_ctl"][id$="_dynamicBuildingDataLeftColumn_divSummary"]',
    )
    .each((_, div) => {
      const map = {};
      $(div)
        .find("table tbody tr")
        .each((__, tr) => {
          const $tr = $(tr);
          const label = getBuildingLabelText($tr);
          const value = textTrim($tr.find("td div span").first().text());
          if (label) map[label] = value;
        });
      if (Object.keys(map).length) leftColumnData.push(map);
    });

  // Collect data from the right column and combine with left column data
  let buildingCount = 0;
  $(section)
    .find(
      'div[id^="ctlBodyPane_ctl10_ctl01_lstBuildings_ctl"][id$="_dynamicBuildingDataRightColumn_divSummary"]',
    )
    .each((_, div) => {
      const map = {};
      $(div)
        .find("table tbody tr")
        .each((__, tr) => {
          const $tr = $(tr);
          const label = getBuildingLabelText($tr);
          const value = textTrim($tr.find("td div span").first().text());
          if (label) map[label] = value;
        });
      if (Object.keys(map).length) {
        // Combine with the corresponding building from the left column
        const combined_map = { ...leftColumnData[buildingCount], ...map };
        buildings[buildingCount++] = combined_map;
      }
    });
  return buildings;
}

function toInt(val) {
  const n = Number(
    String(val || "")
      .replace(/[,]/g, "")
      .trim(),
  );
  return Number.isFinite(n) ? n : 0;
}

function extractBuildingYears($) {
  const buildings = collectBuildings($);
  const yearsActual = [];
  const yearsEffective = [];
  buildings.forEach((b) => {
    yearsActual.push(toInt(b["Actual Year Built"]));
    yearsEffective.push(toInt(b["Effective Year Built"]));
  });
  return {
    actual: yearsActual.length ? Math.min(...yearsActual) : null,
    effective: yearsEffective.length ? Math.min(...yearsEffective) : null,
  };
}

function extractAreas($) {
  let total = 0;
  const buildings = collectBuildings($);
  buildings.forEach((b) => {
    // The sample HTML does not have a "Total Area" field directly.
    // We can use "Total Area" from the building information.
    total += toInt(b["Total Area"]);
  });
  return total;
}

function extractSales($) {
  const rows = $(SALES_TABLE_SELECTOR);
  const out = [];
  rows.each((i, tr) => {
    const $tr = $(tr);
    const tds = $tr.find("td"); // All cells are <td> in the sales table body
    const saleDate = textOf($tr.find("th")); // Sale Date is in <th>
    const salePrice = textOf(tds.eq(0)); // Sale Price is the first <td>
    const instrument = textOf(tds.eq(1));
    const book = textOf(tds.eq(2).find("span")); // Book is in a span
    const page = textOf(tds.eq(3).find("span")); // Page is in a span
    const linkCell = tds.eq(7); // Link button column is the 8th <td>
    const link = linkCell.find("input").attr("onclick"); // Link is in onclick attribute of input button
    const grantor = textOf(tds.eq(6).find("span")); // Grantor is in a span
    // Grantee is not directly available in the sales table, it's the current owner for the most recent sale.
    // For historical sales, the grantee is the owner at that time, which is not explicitly listed here.
    // The ownerMapping script handles the grantee logic.
    const grantee = null;

    let cleanedLink = null;
    if (link) {
      const match = link.match(/window\.open\('([^']+)'\)/);
      if (match && match[1]) {
        cleanedLink = match[1];
      }
    }

    out.push({
      saleDate,
      salePrice,
      instrument,
      bookPage: book && page ? `${book}/${page}` : null, // Combine book and page
      link: cleanedLink,
      grantor,
      grantee,
    });
  });
  return out;
}

function mapInstrumentToDeedType(instr) {
  if (!instr) return null;
  const u = instr.trim().toUpperCase();
  if (u === "WD") return "Warranty Deed";
  if (u == "TD") return "Tax Deed";
  if (u == "QC") return "Quitclaim Deed";
  if (u == "SW") return "Special Warranty Deed";
  if (u == "WM") return "Warranty Deed"; // Added for the provided HTML example
  if (u == "QM") return "Quitclaim Deed"; // Added for the provided HTML example
  if (u == "QD") return "Quitclaim Deed"; // Added for the provided HTML example
  return null;
  // throw {
  //   type: "error",
  //   message: `Unknown enum value ${instr}.`,
  //   path: "deed.deed_type",
  // };
}

function extractValuation($) {
  const table = $(VALUATION_TABLE_SELECTOR);
  if (table.length === 0) return [];
  const years = [];
  // Extract years from the header row
  table.find("thead tr th.value-column").each((i, th) => {
    const headerText = textOf($(th));
    const yearMatch = headerText.match(/(\d{4})/);
    if (yearMatch) {
      years.push({ year: parseInt(yearMatch[1], 10), colIndex: i });
    }
  });

  const rows = table.find("tbody tr");
  const dataMap = {};
  rows.each((i, tr) => {
    const $tr = $(tr);
    // Valuation table labels are always <th>
    const label = textOf($tr.find("th"));
    const tds = $tr.find("td.value-column");
    const vals = [];
    tds.each((j, td) => {
      vals.push($(td).text().trim());
    });
    if (label) dataMap[label] = vals;
  });

  return years.map(({ year, colIndex }) => {
    const get = (label) => {
      const arr = dataMap[label] || [];
      return arr[colIndex] || null;
    };
    return {
      year,
      building: get("Building Value"),
      land: get("Land Value"), // Changed from "Market Land Value" to "Land Value"
      market: get("Just (Market) Value"),
      assessed: get("Assessed Value"),
      taxable: get("Taxable Value"),
    };
  });
}

function writeProperty($, parcelId, context) {
  const { defaultSourceHttpRequest } = context || {};
  const legal = extractLegalDescription($);
  const useCode = extractUseCode($);
  const { propertyType, structureForm } = derivePropertyCategory(useCode);
  const years = extractBuildingYears($);

  const property = {
    parcel_identifier: parcelId || "",
    property_legal_description_text: legal || null,
    property_structure_built_year: years.actual || null,
    property_type: propertyType,
    structure_form: structureForm,
    number_of_units: null,
    subdivision: null,
    zoning: null,
    request_identifier: parcelId || null,
  };
  attachSourceHttpRequest(property, defaultSourceHttpRequest);
  const propertyFilename = "property.json";
  writeJSON(path.join("data", propertyFilename), property);
  if (context) {
    context.propertyNode = property;
    context.propertyFile = propertyFilename;
  }
}

function writeSalesDeedsFilesAndRelationships($, sales, context) {
  const { parcelId, defaultSourceHttpRequest } = context || {};
  const propertyFileOnDisk = path.join("data", "property.json");
  const propertyPointerSource = fs.existsSync(propertyFileOnDisk)
    ? (context && context.propertyFile) || "property.json"
    : null;

  removeFilesMatchingPatterns([
    /^relationship_(deed_has_file|deed_file|property_has_file|property_has_sales_history|sales_history_has_deed|sales_deed|sales_history_has_person|sales_history_has_company|sales_person|sales_company)(?:_\d+)?\.json$/i,
    /^relationship_(file_has_fact_sheet|layout_has_fact_sheet)(?:_\d+)?\.json$/i,
    /^(sales_history|sales|deed|file|fact_sheet)_\d+\.json$/i,
    /^fact_sheet\.json$/i,
  ]);

  const processedSales = [];
  let saleCounter = 0;

  sales.forEach((saleRecord) => {
    const transferDate = normalizeSaleDate(saleRecord.saleDate);
    if (!transferDate) return;

    const saleCandidate = {
      ownership_transfer_date: transferDate,
    };
    const purchasePrice = parseCurrencyToNumber(saleRecord.salePrice);
    if (purchasePrice != null) {
      saleCandidate.purchase_price_amount = purchasePrice;
    }
    attachSourceHttpRequest(saleCandidate, defaultSourceHttpRequest);
    const saleNode = sanitizeSalesHistoryRecord(saleCandidate);
    if (!saleNode) return;

    saleCounter += 1;
    const idx = saleCounter;
    const saleFilename = `sales_history_${idx}.json`;
    writeJSON(path.join("data", saleFilename), saleNode);
    const salePointer = buildStrictPathPointer(saleFilename);

    const deedCandidate = {};
    const deedType = mapInstrumentToDeedType(saleRecord.instrument);
    const { book, page } = parseBookAndPage(saleRecord.bookPage);
    if (deedType) deedCandidate.deed_type = deedType;
    if (book) deedCandidate.book = book;
    if (page) deedCandidate.page = page;
    attachSourceHttpRequest(deedCandidate, defaultSourceHttpRequest);
    const deedNode = sanitizeDeedMetadata(deedCandidate);
    const deedFilename = `deed_${idx}.json`;
    writeJSON(path.join("data", deedFilename), deedNode);

    const parcelIdForRequest = parcelId != null ? String(parcelId).trim() : "";
    const fileRequestIdentifier = parcelIdForRequest
      ? `${parcelIdForRequest}-deed-file-${idx}`
      : `deed-file-${idx}`;
    const fileNodeInput = { request_identifier: fileRequestIdentifier };
    attachSourceHttpRequest(fileNodeInput, defaultSourceHttpRequest);
    const fileNode = sanitizeFileMetadata(fileNodeInput);
    const fileFilename = `file_${idx}.json`;
    writeJSON(path.join("data", fileFilename), fileNode);

    processedSales.push({
      source: saleRecord,
      idx,
      saleFilename,
      salePointer,
      transferDate: saleNode.ownership_transfer_date,
      saleNode,
    });

    writeRelationshipFromFilenames(
      "deed_has_file",
      deedFilename,
      fileFilename,
      idx,
    );
    if (salePointer) {
      writeRelationshipFromFilenames(
        "sales_history_has_deed",
        saleFilename,
        deedFilename,
        idx,
      );
    }
    if (propertyPointerSource) {
      writeRelationshipFromFilenames(
        "property_has_file",
        propertyPointerSource,
        fileFilename,
        idx,
      );
      if (salePointer) {
        writeRelationshipFromFilenames(
          "property_has_sales_history",
          propertyPointerSource,
          saleFilename,
          idx,
        );
      }
    }
  });

  return processedSales;
}
let people = [];
let companies = [];

function findPersonIndexByName(first, last) {
  const tf = titleCaseName(first);
  const tl = titleCaseName(last);
  for (let i = 0; i < people.length; i++) {
    if (people[i].first_name === tf && people[i].last_name === tl)
      return i + 1;
  }
  return null;
}

function findCompanyIndexByName(name) {
  const tn = (name || "").trim();
  for (let i = 0; i < companies.length; i++) {
    if ((companies[i].name || "").trim() === tn) return i + 1;
  }
  return null;
}

function titleCaseName(s) {
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function writePersonCompaniesSalesRelationships(
  parcelId,
  processedSales,
  context,
) {
  const { defaultSourceHttpRequest } = context || {};
  const owners = readJSON(path.join("owners", "owner_data.json"));
  if (!owners) return;
  const key = `property_${parcelId}`;
  const record = owners[key];
  if (!record || !record.owners_by_date) return;
  const ownersByDate = record.owners_by_date;
  const personMap = new Map();
  Object.values(ownersByDate).forEach((arr) => {
    (arr || []).forEach((o) => {
      if (o.type === "person") {
        const k = `${(o.first_name || "").trim().toUpperCase()}|${(o.last_name || "").trim().toUpperCase()}`;
        if (!personMap.has(k))
          personMap.set(k, {
            first_name: o.first_name,
            middle_name: o.middle_name,
            last_name: o.last_name,
          });
        else {
          const existing = personMap.get(k);
          if (!existing.middle_name && o.middle_name)
            existing.middle_name = o.middle_name;
        }
      }
    });
  });
  people = Array.from(personMap.values()).map((p) => ({
    first_name: p.first_name ? titleCaseName(p.first_name) : null,
    middle_name: p.middle_name ? titleCaseName(p.middle_name) : null,
    last_name: p.last_name ? titleCaseName(p.last_name) : null,
    birth_date: null,
    prefix_name: null,
    suffix_name: null,
    us_citizenship_status: null,
    veteran_status: null,
  }));
  people.forEach((p, idx) => {
    attachSourceHttpRequest(p, defaultSourceHttpRequest);
    writeJSON(path.join("data", `person_${idx + 1}.json`), p);
  });
  const companyNames = new Set();
  Object.values(ownersByDate).forEach((arr) => {
    (arr || []).forEach((o) => {
      if (o.type === "company" && (o.name || "").trim())
        companyNames.add((o.name || "").trim());
    });
  });
  companies = Array.from(companyNames).map((n) => ({
    name: n,
  }));
  companies.forEach((c, idx) => {
    attachSourceHttpRequest(c, defaultSourceHttpRequest);
    writeJSON(path.join("data", `company_${idx + 1}.json`), c);
  });
  // Relationships: link sale to owners present on that date (both persons and companies)
  let relPersonCounter = 0;
  let relCompanyCounter = 0;
  processedSales.forEach((rec) => {
    const ownersOnDate = ownersByDate[rec.transferDate] || [];
    const saleRef =
      (rec && rec.salePointer && sanitizePointerObject(rec.salePointer)) ||
      buildStrictPathPointer(rec.saleFilename);
    ownersOnDate
      .filter((o) => o.type === "person")
      .forEach((o) => {
        const pIdx = findPersonIndexByName(o.first_name, o.last_name);
        if (pIdx) {
          const personRef = buildStrictPathPointer(`person_${pIdx}.json`);
          if (!saleRef || !personRef) return;
          relPersonCounter++;
          writeRelationship(
            "sales_history_has_person",
            saleRef,
            personRef,
            relPersonCounter,
          );
        }
      });
    ownersOnDate
      .filter((o) => o.type === "company")
      .forEach((o) => {
        const cIdx = findCompanyIndexByName(o.name);
        if (cIdx) {
          const companyRef = buildStrictPathPointer(`company_${cIdx}.json`);
          if (!saleRef || !companyRef) return;
          relCompanyCounter++;
          writeRelationship(
            "sales_history_has_company",
            saleRef,
            companyRef,
            relCompanyCounter,
          );
        }
      });
  });
}

function writeTaxes($, context) {
  const { defaultSourceHttpRequest } = context || {};
  const vals = extractValuation($);
  vals.forEach((v) => {
    const taxObj = {
      tax_year: v.year || null,
      property_assessed_value_amount: parseCurrencyToNumber(v.assessed),
      property_market_value_amount: parseCurrencyToNumber(v.market),
      property_building_amount: parseCurrencyToNumber(v.building),
      property_land_amount: parseCurrencyToNumber(v.land),
      property_taxable_value_amount: parseCurrencyToNumber(v.taxable),
      monthly_tax_amount: null,
      period_end_date: null,
      period_start_date: null,
    };
    attachSourceHttpRequest(taxObj, defaultSourceHttpRequest);
    writeJSON(path.join("data", `tax_${v.year}.json`), taxObj);
  });
}

function writeUtility(parcelId, context) {
  const { defaultSourceHttpRequest } = context || {};
  const utils = readJSON(path.join("owners", "utilities_data.json"));
  if (!utils) return;
  const key = `property_${parcelId}`;
  const u = utils[key];
  if (!u) return;
  const utility = {
    cooling_system_type: u.cooling_system_type ?? null,
    heating_system_type: u.heating_system_type ?? null,
    public_utility_type: u.public_utility_type ?? null,
    sewer_type: u.sewer_type ?? null,
    water_source_type: u.water_source_type ?? null,
    plumbing_system_type: u.plumbing_system_type ?? null,
    plumbing_system_type_other_description:
      u.plumbing_system_type_other_description ?? null,
    electrical_panel_capacity: u.electrical_panel_capacity ?? null,
    electrical_wiring_type: u.electrical_wiring_type ?? null,
    hvac_condensing_unit_present: u.hvac_condensing_unit_present ?? null,
    electrical_wiring_type_other_description:
      u.electrical_wiring_type_other_description ?? null,
    solar_panel_present: false,
    solar_panel_type: u.solar_panel_type ?? null,
    solar_panel_type_other_description:
      u.solar_panel_type_other_description ?? null,
    smart_home_features: u.smart_home_features ?? null,
    smart_home_features_other_description:
      u.smart_home_features_other_description ?? null,
    hvac_unit_condition: u.hvac_unit_condition ?? null,
    solar_inverter_visible: false,
    hvac_unit_issues: u.hvac_unit_issues ?? null,
    electrical_panel_installation_date:
      u.electrical_panel_installation_date ?? null,
    electrical_rewire_date: u.electrical_rewire_date ?? null,
    hvac_capacity_kw: u.hvac_capacity_kw ?? null,
    hvac_capacity_tons: u.hvac_capacity_tons ?? null,
    hvac_equipment_component: u.hvac_equipment_component ?? null,
    hvac_equipment_manufacturer: u.hvac_equipment_manufacturer ?? null,
    hvac_equipment_model: u.hvac_equipment_model ?? null,
    hvac_installation_date: u.hvac_installation_date ?? null,
    hvac_seer_rating: u.hvac_seer_rating ?? null,
    hvac_system_configuration: u.hvac_system_configuration ?? null,
    plumbing_system_installation_date:
      u.plumbing_system_installation_date ?? null,
    sewer_connection_date: u.sewer_connection_date ?? null,
    solar_installation_date: u.solar_installation_date ?? null,
    solar_inverter_installation_date:
      u.solar_inverter_installation_date ?? null,
    solar_inverter_manufacturer: u.solar_inverter_manufacturer ?? null,
    solar_inverter_model: u.solar_inverter_model ?? null,
    water_connection_date: u.water_connection_date ?? null,
    water_heater_installation_date: u.water_heater_installation_date ?? null,
    water_heater_manufacturer: u.water_heater_manufacturer ?? null,
    water_heater_model: u.water_heater_model ?? null,
    well_installation_date: u.well_installation_date ?? null,
  };
  attachSourceHttpRequest(utility, defaultSourceHttpRequest);
  writeJSON(path.join("data", "utility.json"), utility);
}

function writeLayout(parcelId, context) {
  const { defaultSourceHttpRequest } = context || {};
  const layouts = readJSON(path.join("owners", "layout_data.json"));
  if (!layouts) return;
  const key = `property_${parcelId}`;
  const record = (layouts[key] && layouts[key].layouts) ? layouts[key].layouts : [];
  removeFilesMatchingPatterns([
    /^relationship_property_has_layout(?:_\d+)?\.json$/i,
    /^relationship_layout_has_fact_sheet(?:_\d+)?\.json$/i,
    /^relationship_file_has_fact_sheet(?:_\d+)?\.json$/i,
    /^fact_sheet(?:_\d+)?\.json$/i,
  ]);
  let layoutCounter = 0;
  record.forEach((l) => {
    const layoutIdx = layoutCounter + 1;
    const rawIndex =
      l.space_type_index != null && `${l.space_type_index}`.trim() !== ""
        ? `${l.space_type_index}`.trim()
        : null;
    const normalizedIndex =
      rawIndex != null && `${rawIndex}`.trim() !== ""
        ? `${rawIndex}`.trim()
        : String(layoutIdx);
    const out = {
      space_type: l.space_type ?? null,
      space_type_index: normalizedIndex,
      flooring_material_type: l.flooring_material_type ?? null,
      size_square_feet: l.size_square_feet ?? null,
      floor_level: l.floor_level ?? null,
      has_windows: l.has_windows ?? null,
      window_design_type: l.window_design_type ?? null,
      window_material_type: l.window_material_type ?? null,
      window_treatment_type: l.window_treatment_type ?? null,
      is_finished: l.is_finished ?? null,
      furnished: l.furnished ?? null,
      paint_condition: l.paint_condition ?? null,
      flooring_wear: l.flooring_wear ?? null,
      clutter_level: l.clutter_level ?? null,
      visible_damage: l.visible_damage ?? null,
      countertop_material: l.countertop_material ?? null,
      cabinet_style: l.cabinet_style ?? null,
      fixture_finish_quality: l.fixture_finish_quality ?? null,
      design_style: l.design_style ?? null,
      natural_light_quality: l.natural_light_quality ?? null,
      decor_elements: l.decor_elements ?? null,
      pool_type: l.pool_type ?? null,
      pool_equipment: l.pool_equipment ?? null,
      spa_type: l.spa_type ?? null,
      safety_features: l.safety_features ?? null,
      view_type: l.view_type ?? null,
      lighting_features: l.lighting_features ?? null,
      condition_issues: l.condition_issues ?? null,
      is_exterior: l.is_exterior ?? false,
      pool_condition: l.pool_condition ?? null,
      pool_surface_type: l.pool_surface_type ?? null,
      pool_water_quality: l.pool_water_quality ?? null,
    };
    const ensuredIndex =
      out.space_type_index != null &&
      String(out.space_type_index).trim() !== ""
        ? String(out.space_type_index).trim()
        : String(layoutIdx);
    let normalizedIndexValue =
      ensuredIndex && ensuredIndex !== "" ? ensuredIndex : String(layoutIdx);
    normalizedIndexValue = String(normalizedIndexValue).trim();
    if (!normalizedIndexValue) {
      normalizedIndexValue = String(layoutIdx);
    }
    if (!/^\d+(\.\d+)?(\.\d+)?$/.test(normalizedIndexValue)) {
      normalizedIndexValue = String(layoutIdx);
    }
    out.space_type_index = normalizedIndexValue;
    layoutCounter += 1;
    attachSourceHttpRequest(out, defaultSourceHttpRequest);
    const layoutFilename = `layout_${layoutCounter}.json`;
    writeJSON(path.join("data", layoutFilename), out);
    if (context && fs.existsSync(path.join("data", "property.json"))) {
      const propertyRelationshipPath =
        (typeof context.propertyFile === "string" &&
          context.propertyFile.trim()) ||
        "property.json";
      const propertyPointer = buildStrictPathPointer(propertyRelationshipPath);
      const layoutPointer = buildStrictPathPointer(layoutFilename);
      if (propertyPointer && layoutPointer) {
        writeRelationship(
          "property_has_layout",
          propertyPointer,
          layoutPointer,
          layoutCounter,
        );
      }
    }
  });
}

function extractSecTwpRng($) {
  let value = null;
  $(
    OVERALL_DETAILS_TABLE_SELECTOR,
  ).each((i, tr) => {
    const $tr = $(tr);
    const label = getLabelText($tr);
    if ((label || "").toLowerCase().includes("tax district")) { // Changed label to "Tax District"
      value = textOf($tr.find("td:last-child span"));
      return false; // Stop iterating once found
    }
  });
  if (!value) return { section: null, township: null, range: null };
  // Updated regex to be more flexible for township and range (can be alphanumeric)
  // The "Tax District" field does not contain Sec/Twp/Rng information in the provided HTML.
  // This function will now return null for section, township, and range.
  return { section: null, township: null, range: null };
}

function attemptWriteAddress(unnorm, secTwpRng, context) {
  const { defaultSourceHttpRequest } = context || {};
  const normalizedSource =
    unnorm && typeof unnorm.normalized_address === "object"
      ? unnorm.normalized_address
      : null;

  const stringOrNull = (value) => {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  };

  const normalizedRequiredKeys = [
    "street_number",
    "street_name",
    "city_name",
    "state_code",
    "postal_code",
  ];
  const normalizedValues =
    normalizedSource && typeof normalizedSource === "object"
      ? normalizedRequiredKeys.map((key) =>
          stringOrNull(normalizedSource[key]),
        )
      : [];
  const hasCompleteNormalizedAddress =
    normalizedSource &&
    normalizedValues.every((val) => val && typeof val === "string");

  const address = {};
  const countyName = stringOrNull(unnorm && unnorm.county_jurisdiction);
  if (countyName) address.county_name = countyName;

  if (secTwpRng && secTwpRng.section) address.section = secTwpRng.section;
  if (secTwpRng && secTwpRng.township) address.township = secTwpRng.township;
  if (secTwpRng && secTwpRng.range) address.range = secTwpRng.range;

  if (hasCompleteNormalizedAddress) {
    const [
      streetNumber,
      streetName,
      cityName,
      stateCode,
      postalCode,
    ] = normalizedValues;
    address.street_number = streetNumber;
    address.street_name = streetName;
    address.city_name = cityName ? cityName.toUpperCase() : null;
    address.state_code = stateCode;
    address.postal_code = postalCode;
    const normalizedCountry = stringOrNull(
      normalizedSource && normalizedSource.country_code,
    );
    address.country_code = normalizedCountry || "US";
    const suffix = stringOrNull(
      normalizedSource && normalizedSource.street_suffix_type,
    );
    if (suffix) address.street_suffix_type = suffix;
    const preDir = stringOrNull(
      normalizedSource && normalizedSource.street_pre_directional_text,
    );
    if (preDir) address.street_pre_directional_text = preDir;
    const postDir = stringOrNull(
      normalizedSource && normalizedSource.street_post_directional_text,
    );
    if (postDir) address.street_post_directional_text = postDir;
    const unit = stringOrNull(
      normalizedSource && normalizedSource.unit_identifier,
    );
    if (unit) address.unit_identifier = unit;
    const route = stringOrNull(
      normalizedSource && normalizedSource.route_number,
    );
    if (route) address.route_number = route;
    const plusFour = stringOrNull(
      normalizedSource && normalizedSource.plus_four_postal_code,
    );
    if (plusFour) address.plus_four_postal_code = plusFour;
  } else {
    const fallbackUnnormalized =
      stringOrNull(unnorm && unnorm.full_address) ||
      stringOrNull(unnorm && unnorm.address) ||
      stringOrNull(unnorm && unnorm.address_text) ||
      stringOrNull(normalizedSource && normalizedSource.original_address);
    if (fallbackUnnormalized) {
      address.unnormalized_address = fallbackUnnormalized;
    }
    const normalizedCountry = stringOrNull(
      normalizedSource && normalizedSource.country_code,
    );
    if (normalizedCountry) {
      address.country_code = normalizedCountry;
    } else if (!address.country_code) {
      address.country_code = "US";
    }
    const normalizedState = stringOrNull(
      normalizedSource && normalizedSource.state_code,
    );
    if (normalizedState) address.state_code = normalizedState;
    const normalizedPostalCode = stringOrNull(
      normalizedSource && normalizedSource.postal_code,
    );
    if (normalizedPostalCode) address.postal_code = normalizedPostalCode;
    const normalizedCity = stringOrNull(
      normalizedSource && normalizedSource.city_name,
    );
    if (normalizedCity) address.city_name = normalizedCity.toUpperCase();
  }

  const requestIdentifier = stringOrNull(
    unnorm && unnorm.request_identifier,
  );
  if (requestIdentifier) address.request_identifier = requestIdentifier;
  const sourceRequest =
    (unnorm && unnorm.source_http_request) || defaultSourceHttpRequest;
  attachSourceHttpRequest(address, sourceRequest);
  writeJSON(path.join("data", "address.json"), address);
}

function main() {
  ensureDir("data");
  const $ = loadHTML();

  const propertySeed = readJSON("property_seed.json");
  const unnormalized = readJSON("unnormalized_address.json");

  const parcelFromHTML = getParcelId($);
  const parcelId =
    parcelFromHTML || (propertySeed && propertySeed.parcel_id) || null;

  const defaultSourceHttpRequest =
    (unnormalized && unnormalized.source_http_request) ||
    (propertySeed && propertySeed.source_http_request) ||
    DEFAULT_SOURCE_HTTP_REQUEST;
  const context = {
    parcelId,
    defaultSourceHttpRequest,
  };

  if (parcelId) writeProperty($, parcelId, context);

  const sales = extractSales($);
  const processedSales = writeSalesDeedsFilesAndRelationships(
    $,
    sales,
    context,
  );

  writeTaxes($, context);

  if (parcelId) {
    writePersonCompaniesSalesRelationships(
      parcelId,
      processedSales || [],
      context,
    );
    // writeOwnersCurrentAndRelationships(parcelId);
    // writeHistoricalBuyerPersonsAndRelationships(parcelId, sales);
    writeUtility(parcelId, context);
    writeLayout(parcelId, context);
  }

  // Address last
  const secTwpRng = extractSecTwpRng($);
  attemptWriteAddress(unnormalized, secTwpRng, context);
}

if (require.main === module) {
  try {
    main();
    console.log("Extraction complete.");
  } catch (e) {
    if (e && e.type === "error") {
      writeJSON(path.join("data", "error.json"), e);
      console.error("Extraction error:", e);
      process.exit(1);
    } else {
      console.error("Unexpected error:", e);
      process.exit(1);
    }
  }
}
