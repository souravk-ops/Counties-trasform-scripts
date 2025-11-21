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

function clonePointerPayload(pointer) {
  return pointer ? cloneDeep(pointer) : null;
}

function nonEmptyString(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
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

function pointerFromRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) return null;
  const normalized = normalizePointerPath(relativePath);
  return normalized ? { "/": normalized } : null;
}

function buildSimplePointer(relativePath, extras = null, allowedExtras = []) {
  if (typeof relativePath !== "string") return null;
  const normalizedPath = normalizePointerPath(relativePath);
  if (!normalizedPath) return null;
  const pointer = { "/": normalizedPath };
  if (
    extras &&
    typeof extras === "object" &&
    Array.isArray(allowedExtras) &&
    allowedExtras.length > 0
  ) {
    const extrasToCopy = new Set(
      allowedExtras
        .filter((key) => key && !FORBIDDEN_POINTER_KEYS.includes(String(key)))
        .map((key) => String(key)),
    );
    extrasToCopy.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(extras, key)) return;
      const normalizedValue = sanitizePointerExtraValue(key, extras[key]);
      if (normalizedValue != null) {
        pointer[key] = normalizedValue;
      }
    });
  }
  return pointer;
}

function pointerWithAllowedExtras(relativePath, extras, allowedExtras = []) {
  const pointer = pointerFromRelativePath(relativePath);
  if (!pointer) return null;
  if (!extras || !Array.isArray(allowedExtras) || allowedExtras.length === 0) {
    return pointer;
  }
  allowedExtras.forEach((key) => {
    if (!key || !Object.prototype.hasOwnProperty.call(extras, key)) return;
    const raw = extras[key];
    if (raw == null) return;
    if (key === "ownership_transfer_date") {
      const normalized = formatPointerDate(raw);
      if (normalized) {
        pointer[key] = normalized;
      }
      return;
    }
    const trimmed = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (trimmed) {
      pointer[key] = trimmed;
    }
  });
  return pointer;
}

function buildPointerForWrite(relativePath, extras = null, allowedExtras = []) {
  const normalizedPath = normalizePointerPath(relativePath);
  if (!normalizedPath) return null;
  const pointer = { "/": normalizedPath };
  if (extras && Array.isArray(allowedExtras) && allowedExtras.length > 0) {
    allowedExtras.forEach((key) => {
      const normalizedKey = String(key);
      if (!normalizedKey || FORBIDDEN_POINTER_KEYS.includes(normalizedKey)) {
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(extras, key)) return;
      const raw = extras[key];
      if (raw == null) return;
      if (normalizedKey === "ownership_transfer_date") {
        const iso = formatPointerDate(raw);
        if (iso) {
          pointer[normalizedKey] = iso;
        }
        return;
      }
      const trimmed = String(raw).trim();
      if (trimmed) {
        pointer[normalizedKey] = trimmed;
      }
    });
  }
  return pointer;
}

function buildSalesHistoryPointer(relativePath, saleNode) {
  if (!saleNode || !saleNode.ownership_transfer_date) return null;
  const extras = {
    ownership_transfer_date: saleNode.ownership_transfer_date,
  };
  if (
    saleNode.request_identifier &&
    typeof saleNode.request_identifier === "string" &&
    saleNode.request_identifier.trim()
  ) {
    extras.request_identifier = saleNode.request_identifier.trim();
  }
  const pointer = buildPointerForWrite(relativePath, extras, [
    "ownership_transfer_date",
    "request_identifier",
  ]);
  if (!pointer || !pointer.ownership_transfer_date) return null;
  return pointer;
}

function buildLayoutPointer(relativePath, rawSpaceTypeIndex) {
  if (!relativePath) return null;
  const normalizedIndex =
    rawSpaceTypeIndex != null ? String(rawSpaceTypeIndex).trim() : "";
  if (!normalizedIndex) return null;
  return buildPointerForWrite(
    relativePath,
    { space_type_index: normalizedIndex },
    ["space_type_index"],
  );
}

function buildPointerPayloadFromFilename(
  filename,
  extrasSource = null,
  allowedExtras = [],
) {
  if (typeof filename !== "string") return null;
  const normalizedPath = normalizePointerPath(filename);
  if (!normalizedPath) return null;
  const pointer = { "/": normalizedPath };
  if (
    extrasSource &&
    typeof extrasSource === "object" &&
    Array.isArray(allowedExtras) &&
    allowedExtras.length > 0
  ) {
    allowedExtras.forEach((key) => {
      const normalizedKey = String(key);
      if (!Object.prototype.hasOwnProperty.call(extrasSource, normalizedKey)) {
        return;
      }
      const raw = extrasSource[normalizedKey];
      if (raw == null) return;
      if (normalizedKey === "ownership_transfer_date") {
        const normalizedDate = formatPointerDate(raw);
        if (normalizedDate) {
          pointer[normalizedKey] = normalizedDate;
        }
      } else {
        const trimmed = String(raw).trim();
        if (trimmed) {
          pointer[normalizedKey] = trimmed;
        }
      }
    });
  }
  return stripForbiddenPointerKeys(pointer);
}

function preparePointerForRelationship(type, pointerInput, sideKey) {
  if (!type || !pointerInput) return null;
  let candidate = null;
  if (
    typeof pointerInput === "object" &&
    POINTER_BASE_KEYS.some(
      (key) =>
        Object.prototype.hasOwnProperty.call(pointerInput, key) &&
        typeof pointerInput[key] === "string" &&
        pointerInput[key].trim(),
    )
  ) {
    candidate = { ...pointerInput };
  } else {
    candidate = pointerFromRef(pointerInput);
  }
  if (!candidate) return null;
  const hint = RELATIONSHIP_HINTS[type];
  const sideHint = hint ? hint[sideKey] : null;
  const enrichedCandidate =
    hydratePointerExtras(candidate, pointerInput, sideHint) || candidate;
  return finalizePointerForWrite(enrichedCandidate, sideHint);
}

function writeSimpleRelationshipFile(type, index, fromPointer, toPointer) {
  if (!type) return;
  const preparedFrom = preparePointerForRelationship(type, fromPointer, "from");
  const preparedTo = preparePointerForRelationship(type, toPointer, "to");
  if (!preparedFrom || !preparedTo) return;
  writeStrictRelationshipRecord(type, index, preparedFrom, preparedTo);
}

function canonicalizeRelationshipPointer(pointerInput, hintSide = {}) {
  if (!pointerInput) return null;
  let pointer = pointerInput;
  if (typeof pointerInput === "string") {
    pointer = pointerFromRelativePath(pointerInput);
  }
  if (!pointer || typeof pointer !== "object") return null;

  const sanitizedSource = {};
  Object.keys(pointer).forEach((key) => {
    if (FORBIDDEN_POINTER_KEYS.includes(String(key))) {
      return;
    }
    sanitizedSource[key] = pointer[key];
  });

  const base = {};
  if (typeof sanitizedSource.cid === "string" && sanitizedSource.cid.trim()) {
    base.cid = sanitizedSource.cid.trim();
  } else if (
    typeof sanitizedSource.uri === "string" &&
    sanitizedSource.uri.trim()
  ) {
    base.uri = sanitizedSource.uri.trim();
  } else if (
    typeof sanitizedSource["/"] === "string" &&
    sanitizedSource["/"].trim()
  ) {
    const normalized = normalizePointerPath(sanitizedSource["/"]);
    if (!normalized) return null;
    base["/"] = normalized;
  } else {
    return null;
  }

  const allowedExtras = Array.isArray(hintSide.allowedExtras)
    ? hintSide.allowedExtras.map((key) => String(key))
    : [];
  const requiredExtras = Array.isArray(hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => {
    if (!allowedExtras.includes(key)) {
      allowedExtras.push(key);
    }
  });

  allowedExtras.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(sanitizedSource, key)) return;
    let value = sanitizedSource[key];
    if (value == null) return;
    if (key === "ownership_transfer_date") {
      value = formatPointerDate(value);
    } else {
      value = String(value).trim();
    }
    if (value) {
      base[key] = value;
    }
  });

  const missingRequired = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(base, key) ||
      base[key] == null ||
      String(base[key]).trim() === "",
  );
  if (missingRequired) {
    return null;
  }
  return base;
}

function preparePointerForRelationshipOutput(
  pointer,
  hintSide,
  schemaSide,
) {
  if (!pointer) return null;
  const strictPointer = schemaSide
    ? buildStrictPointerForSchema(pointer, schemaSide)
    : pointer;
  if (!strictPointer) return null;
  const finalized = finalizeRelationshipPointerPayload(
    strictPointer,
    hintSide || {},
  );
  if (!finalized) return null;
  const ensured = ensurePointerHasRequiredExtras(
    { ...finalized },
    hintSide || {},
  );
  if (
    !ensured ||
    (hintSide &&
      Array.isArray(hintSide.requiredExtras) &&
      !hasRequiredExtras(ensured, hintSide.requiredExtras))
  ) {
    return null;
  }
  pruneToAllowedPointerKeys(ensured, hintSide || {});
  stripForbiddenPointerKeys(ensured);
  return ensured;
}

function writeRelationshipPayloadFile(
  type,
  suffix,
  fromPointer,
  toPointer,
) {
  if (!type || !fromPointer || !toPointer) return;
  const hint = RELATIONSHIP_HINTS[type] || {};
  const schema = STRICT_RELATIONSHIP_SCHEMAS[type] || {};
  const preparedFrom = preparePointerForRelationshipOutput(
    fromPointer,
    hint.from,
    schema.from,
  );
  const preparedTo = preparePointerForRelationshipOutput(
    toPointer,
    hint.to,
    schema.to,
  );
  if (!preparedFrom || !preparedTo) return;
  const sanitizedFrom = sanitizeRelationshipPointerByRule(
    type,
    "from",
    preparedFrom,
  );
  const sanitizedTo = sanitizeRelationshipPointerByRule(
    type,
    "to",
    preparedTo,
  );
  if (!sanitizedFrom || !sanitizedTo) {
    return;
  }
  const targetPath = resolveRelationshipFilePath(type, suffix);
  writeJSON(targetPath, {
    from: sanitizedFrom,
    to: sanitizedTo,
  });
}

function orientRelationshipPointers(type, fromPointer, toPointer, hint = RELATIONSHIP_HINTS[type] || {}) {
  if (!fromPointer || !toPointer) {
    return null;
  }
  const activeHint = hint || {};
  const allowSwap = !(activeHint.preventSwap === true);
  const fromMatches = pointerMatchesHint(fromPointer, activeHint.from);
  const toMatches = pointerMatchesHint(toPointer, activeHint.to);
  if (fromMatches && toMatches) {
    return { from: fromPointer, to: toPointer };
  }
  if (!allowSwap) {
    return null;
  }
  const swappedFromMatches = pointerMatchesHint(toPointer, activeHint.from);
  const swappedToMatches = pointerMatchesHint(fromPointer, activeHint.to);
  if (swappedFromMatches && swappedToMatches) {
    // Swap the endpoints when the intent is obvious to keep the payload schema-valid.
    return { from: toPointer, to: fromPointer };
  }
  return null;
}

function writeStrictRelationshipRecord(
  type,
  index,
  fromPointer,
  toPointer,
) {
  if (!type || !fromPointer || !toPointer) return;
  const hint = RELATIONSHIP_HINTS[type] || {};
  const schema = STRICT_RELATIONSHIP_SCHEMAS[type] || {};
  const preparedFrom = preparePointerForRelationshipOutput(
    fromPointer,
    hint.from,
    schema.from,
  );
  const preparedTo = preparePointerForRelationshipOutput(
    toPointer,
    hint.to,
    schema.to,
  );
  if (!preparedFrom || !preparedTo) return;
  const oriented = orientRelationshipPointers(
    type,
    preparedFrom,
    preparedTo,
    hint,
  );
  if (!oriented) return;
  const suffix =
    index === undefined ||
    index === null ||
    (typeof index === "string" && index.trim() === "")
      ? undefined
      : String(index).trim();
  const targetPath = resolveRelationshipFilePath(type, suffix);
  writeJSON(targetPath, oriented);
}

function writeCanonicalRelationshipRecord(type, index, fromPointer, toPointer) {
  if (!type || !fromPointer || !toPointer) return;
  const suffix =
    index === undefined ||
    index === null ||
    (typeof index === "string" && index.trim() === "")
      ? undefined
      : String(index).trim();
  writeRelationshipPayloadFile(type, suffix, fromPointer, toPointer);
}

function writeRelationshipPayloadDirect(type, index, fromPointer, toPointer) {
  writeCanonicalRelationshipRecord(type, index, fromPointer, toPointer);
}

function attachSourceHttpRequest(target, request) {
  if (!target) return;
}

function formatPointerDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = parseDateToISO(trimmed);
    return parsed || null;
  }
  return null;
}

function normalizePointerValue(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  if (/^cid:/i.test(trimmed)) {
    const cidValue = trimmed.slice(4).trim();
    return cidValue ? { cid: `cid:${cidValue}` } : null;
  }

  if (/^(?:baf|bag)[a-z0-9]+$/i.test(trimmed)) {
    return { cid: trimmed.startsWith("cid:") ? trimmed : `cid:${trimmed}` };
  }

  const normalizedPath = normalizePointerPath(trimmed);
  return normalizedPath ? { "/": normalizedPath } : null;
}

function normalizePointerExtras(source) {
  if (!source || typeof source !== "object") return {};
  const extras = {};

  if (Object.prototype.hasOwnProperty.call(source, "ownership_transfer_date")) {
    const normalized = formatPointerDate(source.ownership_transfer_date);
    if (normalized) extras.ownership_transfer_date = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(source, "space_type_index")) {
    const value = source.space_type_index;
    if (value != null) {
      const trimmed = String(value).trim();
      if (trimmed) extras.space_type_index = trimmed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "request_identifier")) {
    const value = source.request_identifier;
    if (value != null) {
      const trimmed = String(value).trim();
      if (trimmed) extras.request_identifier = trimmed;
    }
  }

  return extras;
}

function pointerFromRef(refLike) {
  if (refLike == null) return null;

  if (typeof refLike === "string" || typeof refLike === "number") {
    return normalizePointerValue(refLike);
  }

  if (typeof refLike !== "object") return null;

  let base = null;

  if (typeof refLike.cid === "string" && refLike.cid.trim()) {
    base = normalizePointerValue(refLike.cid);
  } else if (typeof refLike.uri === "string" && refLike.uri.trim()) {
    base = normalizePointerValue(refLike.uri);
  } else {
    const pathCandidate =
      (typeof refLike["/"] === "string" && refLike["/"]) ||
      (typeof refLike.path === "string" && refLike.path) ||
      (typeof refLike.filename === "string" && refLike.filename) ||
      (typeof refLike.file === "string" && refLike.file) ||
      (typeof refLike["@ref"] === "string" && refLike["@ref"]);
    if (typeof pathCandidate === "string") {
      base = normalizePointerValue(pathCandidate);
    }
  }

  if (!base) return null;

  const extras = normalizePointerExtras(refLike);
  return Object.keys(extras).length ? { ...base, ...extras } : base;
}

const ALLOWED_POINTER_EXTRAS = ["ownership_transfer_date", "space_type_index", "request_identifier"];
const POINTER_BASE_KEYS = ["cid", "uri", "/"];
const FORBIDDEN_POINTER_KEYS = [
  "book",
  "deed_type",
  "document_type",
  "file_format",
  "instrument_number",
  "ipfs_url",
  "name",
  "original_url",
  "page",
  "purchase_price_amount",
  "volume",
];

function resolveAllowedExtrasList(hintSide) {
  if (hintSide && Object.prototype.hasOwnProperty.call(hintSide, "allowedExtras")) {
    if (!Array.isArray(hintSide.allowedExtras)) {
      return [];
    }
    return hintSide.allowedExtras.map((key) => String(key));
  }
  return ALLOWED_POINTER_EXTRAS.map((key) => String(key));
}

function enforcePointerForSide(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  let allowedExtras = resolveAllowedExtrasList(hintSide);

  if (hintSide && Array.isArray(hintSide.disallowExtras) && hintSide.disallowExtras.length > 0) {
    const disallowed = new Set(hintSide.disallowExtras.map((key) => String(key)));
    allowedExtras = allowedExtras.filter((key) => !disallowed.has(String(key)));
  }

  const requiredExtras =
    Array.isArray(hintSide && hintSide.requiredExtras) && hintSide.requiredExtras.length > 0
      ? hintSide.requiredExtras.map((key) => String(key))
      : [];

  requiredExtras.forEach((key) => {
    if (!allowedExtras.includes(String(key))) {
      allowedExtras.push(String(key));
    }
  });

  const cleaned = {};
  let hasBase = false;

  POINTER_BASE_KEYS.forEach((key) => {
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) {
        cleaned["/"] = normalizedPath;
        hasBase = true;
      }
      return;
    }
    cleaned[key] = trimmed;
    hasBase = true;
  });

  if (!hasBase) return null;

  allowedExtras.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const raw = pointer[key];
    if (raw == null) return;
    let value = null;
    if (key === "ownership_transfer_date") {
      value = formatPointerDate(raw);
    } else {
      const trimmed = String(raw).trim();
      if (trimmed) value = trimmed;
    }
    if (value != null) {
      cleaned[key] = value;
    }
  });

  for (const key of requiredExtras) {
    if (
      !Object.prototype.hasOwnProperty.call(cleaned, key) ||
      cleaned[key] == null ||
      String(cleaned[key]).trim() === ""
    ) {
      return null;
    }
  }

  return cleaned;
}

function stripDisallowedExtras(pointer, disallowList) {
  if (!pointer || typeof pointer !== "object") return;
  if (!Array.isArray(disallowList) || disallowList.length === 0) return;
  disallowList.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(pointer, key)) {
      delete pointer[key];
    }
  });
}

function resolvePointerExtra(meta, key) {
  if (!meta) return null;
  if (FORBIDDEN_POINTER_KEYS.includes(String(key))) return null;
  const sources = [];

  if (
    meta.pointerRaw &&
    typeof meta.pointerRaw === "object" &&
    Object.prototype.hasOwnProperty.call(meta.pointerRaw, key)
  ) {
    sources.push(meta.pointerRaw[key]);
  }

  if (
    meta.refLike &&
    typeof meta.refLike === "object" &&
    Object.prototype.hasOwnProperty.call(meta.refLike, key)
  ) {
    sources.push(meta.refLike[key]);
  }

  if (meta.path) {
    const node = readJsonFromData(meta.path);
    if (node && Object.prototype.hasOwnProperty.call(node, key)) {
      sources.push(node[key]);
    }
  }

  for (const candidate of sources) {
    if (candidate == null) continue;
    if (key === "ownership_transfer_date") {
      const normalized = formatPointerDate(candidate);
      if (normalized) return normalized;
    } else {
      const trimmed = String(candidate).trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

function hydratePointerExtras(pointerCandidate, refLike, hintSide) {
  if (!pointerCandidate || typeof pointerCandidate !== "object") {
    return pointerCandidate;
  }
  const allowedExtrasList = resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => {
    if (!allowedExtrasList.includes(key)) {
      allowedExtrasList.push(key);
    }
  });
  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );
  if (
    allowedExtrasList.length === 0 &&
    disallowedExtras.size === 0 &&
    requiredExtras.length === 0
  ) {
    return pointerCandidate;
  }
  const meta = buildPointerMeta(refLike || pointerCandidate);
  if (!meta) {
    return pointerCandidate;
  }
  const hydrated = { ...pointerCandidate };
  disallowedExtras.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(hydrated, key)) {
      delete hydrated[key];
    }
  });
  FORBIDDEN_POINTER_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(hydrated, key)) {
      delete hydrated[key];
    }
  });
  allowedExtrasList.forEach((key) => {
    if (disallowedExtras.has(key) || FORBIDDEN_POINTER_KEYS.includes(key)) {
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(hydrated, key) &&
      hydrated[key] != null &&
      String(hydrated[key]).trim() !== ""
    ) {
      if (key === "ownership_transfer_date") {
        const normalized = formatPointerDate(hydrated[key]);
        if (normalized) {
          hydrated[key] = normalized;
          return;
        }
      } else {
        hydrated[key] = String(hydrated[key]).trim();
        return;
      }
    }
    const resolved = resolvePointerExtra(meta, key);
    if (resolved != null) {
      hydrated[key] = resolved;
    }
  });
  return hydrated;
}

function stripForbiddenPointerKeys(pointer) {
  if (!pointer || typeof pointer !== "object") return pointer;
  FORBIDDEN_POINTER_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(pointer, key)) {
      delete pointer[key];
    }
  });
  return pointer;
}

function ensurePointerHasRequiredExtras(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object" || !hintSide) {
    return pointer;
  }
  const requiredExtras = Array.isArray(hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  if (requiredExtras.length === 0) {
    return pointer;
  }

  const missing = requiredExtras.filter(
    (key) =>
      !Object.prototype.hasOwnProperty.call(pointer, key) ||
      pointer[key] == null ||
      String(pointer[key]).trim() === "",
  );
  if (missing.length === 0) {
    return pointer;
  }

  const pointerPath =
    (typeof pointer["/"] === "string" && pointer["/"]) ||
    (typeof pointer.path === "string" && pointer.path) ||
    null;
  const meta = {
    pointerRaw: pointer,
    refLike: pointer,
    path: pointerPath,
  };

  missing.forEach((extraKey) => {
    const resolved = resolvePointerExtra(meta, extraKey);
    if (resolved == null) return;
    if (extraKey === "ownership_transfer_date") {
      const iso = formatPointerDate(resolved);
      if (iso) {
        pointer[extraKey] = iso;
      }
      return;
    }
    const trimmed = String(resolved).trim();
    if (trimmed) {
      pointer[extraKey] = trimmed;
    }
  });

  const unresolved = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(pointer, key) ||
      pointer[key] == null ||
      String(pointer[key]).trim() === "",
  );
  return unresolved ? null : pointer;
}

function sanitizePointerExtraValue(key, raw) {
  if (raw == null) return null;
  if (key === "ownership_transfer_date") {
    return formatPointerDate(raw);
  }
  const trimmed = typeof raw === "string" ? raw.trim() : String(raw).trim();
  return trimmed || null;
}

function ensurePointerExtrasFromSource(pointer, source, keys) {
  if (
    !pointer ||
    typeof pointer !== "object" ||
    !source ||
    typeof source !== "object" ||
    !Array.isArray(keys) ||
    keys.length === 0
  ) {
    return pointer;
  }
  keys.forEach((key) => {
    if (!key) return;
    if (
      Object.prototype.hasOwnProperty.call(pointer, key) &&
      pointer[key] != null &&
      String(pointer[key]).trim() !== ""
    ) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(source, key)) return;
    const normalized = sanitizePointerExtraValue(key, source[key]);
    if (normalized != null) {
      pointer[key] = normalized;
    }
  });
  return pointer;
}

function resolvePointerBasePath(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  if (typeof pointer.cid === "string" && pointer.cid.trim()) {
    const trimmed = pointer.cid.trim();
    return trimmed.startsWith("cid:") ? trimmed : `cid:${trimmed}`;
  }
  if (typeof pointer.uri === "string" && pointer.uri.trim()) {
    return pointer.uri.trim();
  }
  const candidates = [
    pointer["/"],
    pointer.path,
    pointer.filename,
    pointer.file,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizePointerPath(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function readPointerExtraFromNode(relativePath, key) {
  if (!relativePath || !key) return null;
  const sanitized = relativePath.replace(/^[./\\]+/, "");
  const dataPath = path.join("data", sanitized);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return null;
  return sanitizePointerExtraValue(key, payload[key]);
}

function sanitizePointerAgainstStrictSchema(pointer, schemaSide = {}) {
  if (!pointer || typeof pointer !== "object") return null;
  const normalizedBase = resolvePointerBasePath(pointer);
  if (!normalizedBase) return null;
  const isFilePath = !/^([a-z]+:)/i.test(normalizedBase);
  const relativePath = isFilePath
    ? normalizedBase.replace(/^[./\\]+/, "")
    : null;
  const pathPrefixes = Array.isArray(schemaSide.pathPrefixes)
    ? schemaSide.pathPrefixes
    : [];
  if (
    pathPrefixes.length > 0 &&
    (!relativePath ||
      !pathPrefixes.some((prefix) => relativePath.startsWith(prefix)))
  ) {
    return null;
  }

  const allowedExtras = Array.isArray(schemaSide.allowedExtras)
    ? schemaSide.allowedExtras.map((key) => String(key))
    : [];
  const requiredExtras = Array.isArray(schemaSide.requiredExtras)
    ? schemaSide.requiredExtras.map((key) => String(key))
    : [];

  const sanitized = {};
  if (normalizedBase.startsWith("cid:")) {
    sanitized.cid = normalizedBase.startsWith("cid:")
      ? normalizedBase
      : `cid:${normalizedBase}`;
  } else if (
    /^[a-z]+:/i.test(normalizedBase) &&
    !normalizedBase.startsWith("./")
  ) {
    return null;
  } else {
    sanitized["/"] = normalizedBase;
  }

  allowedExtras.forEach((key) => {
    const normalizedValue = sanitizePointerExtraValue(
      key,
      pointer && pointer[key],
    );
    if (normalizedValue != null) {
      sanitized[key] = normalizedValue;
    }
  });

  for (const key of requiredExtras) {
    if (
      Object.prototype.hasOwnProperty.call(sanitized, key) &&
      sanitized[key] != null &&
      String(sanitized[key]).trim() !== ""
    ) {
      continue;
    }
    const resolved =
      relativePath != null
        ? readPointerExtraFromNode(relativePath, key)
        : null;
    if (resolved != null) {
      sanitized[key] = resolved;
    }
  }

  const missingRequired = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(sanitized, key) ||
      sanitized[key] == null ||
      String(sanitized[key]).trim() === "",
  );
  if (missingRequired) {
    return null;
  }
  return sanitized;
}

function finalizeRelationshipPointerPayload(pointer, hintSide = {}) {
  if (!pointer || typeof pointer !== "object") return null;
  const basePath = resolvePointerBasePath(pointer);
  if (!basePath) return null;

  const sanitized = {};
  if (basePath.startsWith("cid:")) {
    const normalizedCid = basePath.startsWith("cid:")
      ? basePath
      : `cid:${basePath}`;
    sanitized.cid = normalizedCid;
  } else {
    if (
      /^[a-z]+:/i.test(basePath) &&
      !basePath.startsWith("./")
    ) {
      return null;
    }
    const normalizedRelative = normalizePointerPath(basePath);
    if (!normalizedRelative) return null;
    sanitized["/"] = normalizedRelative;
  }

  const allowedExtras = new Set(
    resolveAllowedExtrasList(hintSide).map((key) => String(key)),
  );
  const requiredExtras = Array.isArray(hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => allowedExtras.add(String(key)));

  allowedExtras.forEach((key) => {
    if (FORBIDDEN_POINTER_KEYS.includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const normalizedValue = sanitizePointerExtraValue(key, pointer[key]);
    if (normalizedValue != null) {
      sanitized[key] = normalizedValue;
    }
  });

  stripForbiddenPointerKeys(sanitized);
  pruneToAllowedPointerKeys(sanitized, hintSide || {});

  const missingRequired = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(sanitized, key) ||
      sanitized[key] == null ||
      String(sanitized[key]).trim() === "",
  );
  if (missingRequired) {
    return null;
  }

  return sanitized;
}

function enforceRelationshipSchemaRules(types) {
  if (!Array.isArray(types) || types.length === 0) return;
  types.forEach((type) => {
    const schema = STRICT_RELATIONSHIP_SCHEMAS[type];
    if (!schema) return;
    const dirPath = path.join("relationships", type);
    let entries;
    try {
      entries = fs
        .readdirSync(dirPath)
        .filter((filename) => /\.json$/i.test(filename));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    entries.forEach((filename) => {
      const fullPath = path.join(dirPath, filename);
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (err) {
        return;
      }
      const sanitizedFrom = sanitizePointerAgainstStrictSchema(
        payload && payload.from,
        schema.from || {},
      );
      const sanitizedTo = sanitizePointerAgainstStrictSchema(
        payload && payload.to,
        schema.to || {},
      );
      if (!sanitizedFrom || !sanitizedTo) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
        return;
      }
      const nextPayload = { from: sanitizedFrom, to: sanitizedTo };
      if (JSON.stringify(payload) !== JSON.stringify(nextPayload)) {
        writeJSON(fullPath, nextPayload);
      }
    });
  });
}

function enforcePointerSchema(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  const base = {};
  POINTER_BASE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) {
        base["/"] = normalizedPath;
      }
    } else {
      base[key] = trimmed;
    }
  });

  if (!pointerHasBase(base)) {
    return null;
  }

  let allowedExtras =
    hintSide && Object.prototype.hasOwnProperty.call(hintSide, "allowedExtras")
      ? Array.isArray(hintSide.allowedExtras)
        ? hintSide.allowedExtras.map((key) => String(key))
        : []
      : ALLOWED_POINTER_EXTRAS.slice();

  const requiredExtras = Array.isArray(
    hintSide && hintSide.requiredExtras,
  )
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];

  requiredExtras.forEach((key) => {
    if (!allowedExtras.includes(String(key))) {
      allowedExtras.push(String(key));
    }
  });

  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );

  allowedExtras.forEach((extraKey) => {
    const key = String(extraKey);
    if (disallowedExtras.has(key)) return;
    if (FORBIDDEN_POINTER_KEYS.includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const value = sanitizePointerExtraValue(key, pointer[key]);
    if (value != null) {
      base[key] = value;
    }
  });

  for (const key of requiredExtras) {
    const strKey = String(key);
    if (
      !Object.prototype.hasOwnProperty.call(base, strKey) ||
      base[strKey] == null ||
      String(base[strKey]).trim() === ""
    ) {
      return null;
    }
  }

  return base;
}

function scrubPointerRefLike(refLike) {
  if (!refLike || typeof refLike !== "object") {
    return refLike;
  }
  const sanitized = {};
  Object.keys(refLike).forEach((key) => {
    if (FORBIDDEN_POINTER_KEYS.includes(String(key))) {
      return;
    }
    sanitized[key] = refLike[key];
  });
  return sanitized;
}

function normalizePointerOutput(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  const pointerCandidate = {};
  Object.keys(pointer).forEach((key) => {
    pointerCandidate[key] = pointer[key];
  });
  stripForbiddenPointerKeys(pointerCandidate);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(pointerCandidate, hintSide.disallowExtras);
  }

  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  const allowedExtrasList = resolveAllowedExtrasList(hintSide);
  requiredExtras.forEach((key) => {
    const strKey = String(key);
    if (!allowedExtrasList.includes(strKey)) {
      allowedExtrasList.push(strKey);
    }
  });
  const allowedExtras = new Set(allowedExtrasList.map((key) => String(key)));

  const cleaned = {};
  POINTER_BASE_KEYS.forEach((key) => {
    const raw = pointerCandidate[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) cleaned["/"] = normalizedPath;
    } else {
      cleaned[key] = trimmed;
    }
  });

  if (!pointerHasBase(cleaned)) return null;

  allowedExtras.forEach((key) => {
    if (disallowedExtras.has(key)) return;
    if (FORBIDDEN_POINTER_KEYS.includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(pointerCandidate, key)) return;
    const raw = pointerCandidate[key];
    if (raw == null) return;
    let value = null;
    if (key === "ownership_transfer_date") {
      value = formatPointerDate(raw);
    } else {
      const trimmed = String(raw).trim();
      if (trimmed) value = trimmed;
    }
    if (value != null) {
      cleaned[key] = value;
    }
  });

  stripForbiddenPointerKeys(cleaned);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(cleaned, hintSide.disallowExtras);
  }

  Object.keys(cleaned).forEach((key) => {
    if (POINTER_BASE_KEYS.includes(key)) return;
    if (!allowedExtras.has(String(key)) || disallowedExtras.has(String(key))) {
      delete cleaned[key];
    }
  });

  for (const key of requiredExtras) {
    const strKey = String(key);
    if (
      !Object.prototype.hasOwnProperty.call(cleaned, strKey) ||
      cleaned[strKey] == null ||
      String(cleaned[strKey]).trim() === ""
    ) {
      return null;
    }
  }

  return pointerHasBase(cleaned) ? cleaned : null;
}

function sanitizePointerForHint(pointer, hintSide) {
  return normalizePointerOutput(pointer, hintSide);
}

function restrictPointerKeys(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;
  const allowedExtrasList = resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  );
  const allowedKeys = new Set(POINTER_BASE_KEYS);
  allowedExtrasList.forEach((key) => allowedKeys.add(String(key)));
  const requiredExtras =
    hintSide && Array.isArray(hintSide.requiredExtras)
      ? hintSide.requiredExtras.map((key) => String(key))
      : [];
  requiredExtras.forEach((key) => allowedKeys.add(String(key)));
  const sanitized = {};
  Object.keys(pointer).forEach((key) => {
    const strKey = String(key);
    if (!allowedKeys.has(strKey)) return;
    sanitized[strKey] = pointer[key];
  });
  return pointerHasBase(sanitized) ? sanitized : null;
}

function pruneToAllowedPointerKeys(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return pointer;
  const allowedExtras = resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  const allowedKeys = new Set([...POINTER_BASE_KEYS, ...allowedExtras, ...requiredExtras]);
  Object.keys(pointer).forEach((key) => {
    const normalizedKey = String(key);
    if (!allowedKeys.has(normalizedKey)) {
      delete pointer[key];
    }
  });
  return pointer;
}

function prepareRelationshipPointer(meta, pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  const cleaned = {};
  let hasBase = false;
  POINTER_BASE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (!normalizedPath) return;
      cleaned["/"] = normalizedPath;
    } else {
      cleaned[key] = trimmed;
    }
    hasBase = true;
  });
  if (!hasBase) return null;

  const allowedExtrasList = resolveAllowedExtrasList(hintSide);
  const disallowExtrasSet =
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? new Set(hintSide.disallowExtras.map((key) => String(key)))
      : new Set();
  const requiredExtras =
    hintSide && Array.isArray(hintSide.requiredExtras)
      ? hintSide.requiredExtras.map((key) => String(key))
      : [];

  requiredExtras.forEach((key) => {
    if (!allowedExtrasList.includes(key)) {
      allowedExtrasList.push(key);
    }
  });

  allowedExtrasList.forEach((extraKey) => {
    const key = String(extraKey);
    if (FORBIDDEN_POINTER_KEYS.includes(key) || disallowExtrasSet.has(key)) {
      return;
    }
    let value =
      Object.prototype.hasOwnProperty.call(pointer, key) && pointer[key] != null
        ? pointer[key]
        : null;
    if (value == null && meta) {
      value = resolvePointerExtra(meta, key);
    }
    if (value == null) return;
    let normalized = null;
    if (key === "ownership_transfer_date") {
      normalized = formatPointerDate(value);
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) normalized = trimmed;
    } else {
      const str = String(value).trim();
      if (str) normalized = str;
    }
    if (normalized != null) {
      cleaned[key] = normalized;
    }
  });

  let missingRequired = false;
  requiredExtras.forEach((extraKey) => {
    const key = String(extraKey);
    if (
      Object.prototype.hasOwnProperty.call(cleaned, key) &&
      cleaned[key] != null &&
      String(cleaned[key]).trim() !== ""
    ) {
      return;
    }
    let resolved = null;
    if (meta) {
      resolved = resolvePointerExtra(meta, key);
    }
    if (resolved == null) {
      missingRequired = true;
      return;
    }
    if (key === "ownership_transfer_date") {
      const normalized = formatPointerDate(resolved);
      if (normalized) {
        cleaned[key] = normalized;
      } else {
        missingRequired = true;
      }
    } else {
      const trimmed = String(resolved).trim();
      if (trimmed) {
        cleaned[key] = trimmed;
      } else {
        missingRequired = true;
      }
    }
  });

  if (missingRequired) return null;

  stripForbiddenPointerKeys(cleaned);
  disallowExtrasSet.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(cleaned, key)) {
      delete cleaned[key];
    }
  });

  return cleaned;
}

function pointerHasBase(pointer) {
  if (!pointer || typeof pointer !== "object") return false;
  return POINTER_BASE_KEYS.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return false;
    const value = pointer[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

function sanitizePointerMetaForRelationship(meta, hintSide) {
  if (!meta || !meta.pointerRaw || typeof meta.pointerRaw !== "object") {
    return null;
  }

  const allowedExtras = new Set(
    resolveAllowedExtrasList(hintSide).map((key) => String(key)),
  );
  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => allowedExtras.add(String(key)));

  const sanitized = {};

  POINTER_BASE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(meta.pointerRaw, key)) return;
    const raw = meta.pointerRaw[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) sanitized["/"] = normalizedPath;
    } else {
      sanitized[key] = trimmed;
    }
  });

  if (!pointerHasBase(sanitized)) return null;

  const tryAssignExtra = (source, key) => {
    if (!source || typeof source !== "object") return;
    const strKey = String(key);
    if (disallowedExtras.has(strKey)) return;
    if (!allowedExtras.has(strKey)) return;
    if (!Object.prototype.hasOwnProperty.call(source, key)) return;
    const raw = source[key];
    if (raw == null) return;
    let value = null;
    if (key === "ownership_transfer_date") {
      value = formatPointerDate(raw);
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return;
      value = trimmed;
    } else {
      const trimmed = String(raw).trim();
      if (!trimmed) return;
      value = trimmed;
    }
    if (value != null) {
      sanitized[key] = value;
    }
  };

  allowedExtras.forEach((key) => {
    if (
      Object.prototype.hasOwnProperty.call(sanitized, key) &&
      sanitized[key] != null &&
      String(sanitized[key]).trim() !== ""
    ) {
      return;
    }
    tryAssignExtra(meta.pointerRaw, key);
  });

  if (
    meta.refLike &&
    typeof meta.refLike === "object" &&
    meta.refLike !== meta.pointerRaw
  ) {
    allowedExtras.forEach((key) => {
      if (
        Object.prototype.hasOwnProperty.call(sanitized, key) &&
        sanitized[key] != null &&
        String(sanitized[key]).trim() !== ""
      ) {
        return;
      }
      tryAssignExtra(meta.refLike, key);
    });
  }

  allowedExtras.forEach((key) => {
    if (
      Object.prototype.hasOwnProperty.call(sanitized, key) &&
      sanitized[key] != null &&
      String(sanitized[key]).trim() !== ""
    ) {
      return;
    }
    const resolved = resolvePointerExtra(meta, key);
    if (resolved == null) return;
    if (key === "ownership_transfer_date") {
      const normalized = formatPointerDate(resolved);
      if (normalized) sanitized[key] = normalized;
    } else {
      const trimmed = String(resolved).trim();
      if (trimmed) sanitized[key] = trimmed;
    }
  });

  stripForbiddenPointerKeys(sanitized);
  disallowedExtras.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      delete sanitized[key];
    }
  });

  Object.keys(sanitized).forEach((key) => {
    if (POINTER_BASE_KEYS.includes(key)) return;
    if (!allowedExtras.has(String(key))) {
      delete sanitized[key];
    }
  });

  for (const key of requiredExtras) {
    if (
      !Object.prototype.hasOwnProperty.call(sanitized, key) ||
      sanitized[key] == null ||
      String(sanitized[key]).trim() === ""
    ) {
      return null;
    }
  }

  return sanitized;
}

function buildRelationshipPointer(meta, hintSide) {
  const prepared = sanitizePointerMetaForRelationship(meta, hintSide);
  if (!prepared) return null;
  return sanitizePointerForHint(prepared, hintSide);
}

function finalizePointerForSide(meta, hintSide) {
  if (!meta || !meta.pointerRaw) return null;

  const allowedExtras = new Set(resolveAllowedExtrasList(hintSide));
  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];

  requiredExtras.forEach((key) => {
    if (!allowedExtras.has(String(key))) {
      allowedExtras.add(String(key));
    }
  });

  const sanitized = {};

  POINTER_BASE_KEYS.forEach((key) => {
    const raw =
      (meta.pointerRaw && meta.pointerRaw[key]) ||
      (meta.refLike && meta.refLike[key]);
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) sanitized["/"] = normalizedPath;
    } else {
      sanitized[key] = trimmed;
    }
  });

  if (!pointerHasBase(sanitized)) {
    return null;
  }

  allowedExtras.forEach((key) => {
    if (!key || disallowedExtras.has(String(key))) return;
    const resolved = resolvePointerExtra(meta, key);
    if (resolved == null) return;
    let value = null;
    if (key === "ownership_transfer_date") {
      value = formatPointerDate(resolved);
    } else {
      const trimmed = String(resolved).trim();
      if (trimmed) value = trimmed;
    }
    if (value != null) {
      sanitized[key] = value;
    }
  });

  for (const key of requiredExtras) {
    if (
      !Object.prototype.hasOwnProperty.call(sanitized, key) ||
      sanitized[key] == null ||
      String(sanitized[key]).trim() === ""
    ) {
      const resolved = resolvePointerExtra(meta, key);
      let normalized = null;
      if (resolved != null) {
        if (key === "ownership_transfer_date") {
          normalized = formatPointerDate(resolved);
        } else {
          const trimmed = String(resolved).trim();
          if (trimmed) normalized = trimmed;
        }
      }
      if (normalized != null) {
        sanitized[key] = normalized;
      } else {
        return null;
      }
    }
  }
  return normalizePointerOutput(sanitized, hintSide);
}

function extractPointerExtraFromSource(source, key) {
  if (!source || typeof source !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null;
  const raw = source[key];
  if (raw == null) return null;
  if (key === "ownership_transfer_date") {
    return formatPointerDate(raw);
  }
  const trimmed =
    typeof raw === "string" ? raw.trim() : String(raw).trim();
  return trimmed || null;
}

function cleanRelationshipPointer(meta, pointerCandidate, hintSide) {
  const allowedList = resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  );
  const allowedSet = new Set(allowedList);
  const disallowedSet = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );
  const requiredList = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredList.forEach((key) => allowedSet.add(key));

  const baseSources = [];
  if (pointerCandidate && typeof pointerCandidate === "object") {
    baseSources.push(pointerCandidate);
  }
  if (meta && meta.pointerRaw && meta.pointerRaw !== pointerCandidate) {
    baseSources.push(meta.pointerRaw);
  }
  if (meta && meta.refLike && typeof meta.refLike === "object") {
    baseSources.push(meta.refLike);
  }

  const cleaned = {};

  POINTER_BASE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(cleaned, key)) return;
    for (const source of baseSources) {
      if (!source || typeof source !== "object") continue;
      const raw = source[key];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (key === "/") {
        const normalizedPath = normalizePointerPath(trimmed);
        if (normalizedPath) {
          cleaned["/"] = normalizedPath;
          break;
        }
      } else {
        cleaned[key] = trimmed;
        break;
      }
    }
  });

  if (!pointerHasBase(cleaned) && meta) {
    const fallbackPath = getRefPath(meta.refLike, meta.pointerRaw);
    if (fallbackPath) {
      const normalizedFallback = normalizePointerPath(fallbackPath);
      if (normalizedFallback) {
        cleaned["/"] = normalizedFallback;
      }
    }
  }

  if (!pointerHasBase(cleaned)) return null;

  const tryAssignFromSource = (source, extraKey) => {
    if (!source || typeof source !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(source, extraKey)) return false;
    const normalized = extractPointerExtraFromSource(source, extraKey);
    if (!normalized) return false;
    cleaned[extraKey] = normalized;
    return true;
  };

  for (const key of allowedSet) {
    if (POINTER_BASE_KEYS.includes(key)) continue;
    if (disallowedSet.has(key)) continue;
    if (FORBIDDEN_POINTER_KEYS.includes(key)) continue;
    if (
      Object.prototype.hasOwnProperty.call(cleaned, key) &&
      cleaned[key] != null &&
      String(cleaned[key]).trim() !== ""
    ) {
      const normalizedExisting = extractPointerExtraFromSource(cleaned, key);
      if (normalizedExisting) {
        cleaned[key] = normalizedExisting;
        continue;
      }
      delete cleaned[key];
    }
    if (tryAssignFromSource(pointerCandidate, key)) continue;
    if (tryAssignFromSource(meta && meta.pointerRaw, key)) continue;
    if (
      meta &&
      meta.refLike &&
      meta.refLike !== meta.pointerRaw &&
      tryAssignFromSource(meta.refLike, key)
    ) {
      continue;
    }
    const resolved = resolvePointerExtra(meta, key);
    if (resolved != null) {
      cleaned[key] = resolved;
    }
  }

  stripForbiddenPointerKeys(cleaned);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(cleaned, hintSide.disallowExtras);
  }

  Object.keys(cleaned).forEach((key) => {
    if (POINTER_BASE_KEYS.includes(key)) return;
    const strKey = String(key);
    if (!allowedSet.has(strKey) || disallowedSet.has(strKey)) {
      delete cleaned[key];
    }
  });

  for (const key of requiredList) {
    if (
      !Object.prototype.hasOwnProperty.call(cleaned, key) ||
      cleaned[key] == null ||
      String(cleaned[key]).trim() === ""
    ) {
      return null;
    }
  }

  return cleaned;
}

function pruneRelationshipPointer(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  const sanitized = {};
  POINTER_BASE_KEYS.forEach((key) => {
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) {
        sanitized["/"] = normalizedPath;
      }
    } else {
      sanitized[key] = trimmed;
    }
  });

  if (!pointerHasBase(sanitized)) {
    return null;
  }

  const allowedExtras = new Set(resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  ));
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => allowedExtras.add(String(key)));
  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );

  Object.keys(pointer).forEach((key) => {
    if (POINTER_BASE_KEYS.includes(key)) return;
    const strKey = String(key);
    if (FORBIDDEN_POINTER_KEYS.includes(strKey)) return;
    if (!allowedExtras.has(strKey)) return;
    if (disallowedExtras.has(strKey)) return;
    const raw = pointer[key];
    if (raw == null) return;
    let value = null;
    if (strKey === "ownership_transfer_date") {
      value = formatPointerDate(raw);
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) value = trimmed;
    } else {
      const asString = String(raw).trim();
      if (asString) value = asString;
    }
    if (value != null) {
      sanitized[strKey] = value;
    }
  });

  stripForbiddenPointerKeys(sanitized);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(sanitized, hintSide.disallowExtras);
  }

  for (const key of requiredExtras) {
    const strKey = String(key);
    if (
      !Object.prototype.hasOwnProperty.call(sanitized, strKey) ||
      sanitized[strKey] == null ||
      String(sanitized[strKey]).trim() === ""
    ) {
      return null;
    }
  }

  return pointerHasBase(sanitized) ? sanitized : null;
}

const POINTER_JSON_CACHE = new Map();

function sanitizeRelationshipPointerSimple(pointer, hintSide = {}) {
  if (!pointer || typeof pointer !== "object") return null;
  const baseRaw =
    (typeof pointer["/"] === "string" && pointer["/"]) ||
    (typeof pointer.path === "string" && pointer.path) ||
    (typeof pointer.filename === "string" && pointer.filename) ||
    (typeof pointer.file === "string" && pointer.file);
  if (typeof baseRaw !== "string") return null;
  const normalizedBase = normalizePointerPath(baseRaw);
  if (!normalizedBase) return null;
  const normalizedForMatch = normalizedBase.replace(/^[./\\]+/, "");
  const prefixes = Array.isArray(hintSide.pathPrefixes)
    ? hintSide.pathPrefixes
    : [];
  if (prefixes.length && !matchesPathPrefix(normalizedForMatch, prefixes)) {
    return null;
  }
  const allowedExtras = Array.isArray(hintSide.allowedExtras)
    ? hintSide.allowedExtras.map((key) => String(key))
    : [];
  const requiredExtras = Array.isArray(hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  const cleaned = { "/": normalizedBase };
  const extrasToCopy = new Set([...allowedExtras, ...requiredExtras]);
  extrasToCopy.forEach((key) => {
    if (!key || FORBIDDEN_POINTER_KEYS.includes(String(key))) return;
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const normalizedValue = sanitizePointerExtraValue(key, pointer[key]);
    if (normalizedValue != null) {
      cleaned[key] = normalizedValue;
    }
  });
  const missing = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(cleaned, key) ||
      cleaned[key] == null ||
      String(cleaned[key]).trim() === "",
  );
  if (missing) return null;
  return cleaned;
}

function writeRelationshipRecordSimple(
  type,
  index,
  fromPointer,
  toPointer,
) {
  if (!type) return;
  const hint = RELATIONSHIP_HINTS[type] || {};
  const fromHint = hint.from || {};
  const toHint = hint.to || {};
  const preparedFrom = sanitizeRelationshipPointerSimple(
    fromPointer,
    fromHint,
  );
  const preparedTo = sanitizeRelationshipPointerSimple(
    toPointer,
    toHint,
  );
  if (!preparedFrom || !preparedTo) return;
  stripForbiddenPointerKeys(preparedFrom);
  stripForbiddenPointerKeys(preparedTo);
  pruneToAllowedPointerKeys(preparedFrom, fromHint);
  pruneToAllowedPointerKeys(preparedTo, toHint);
  const suffix =
    index === undefined ||
    index === null ||
    (typeof index === "string" && index.trim() === "")
      ? undefined
      : String(index).trim();
  const targetPath = resolveRelationshipFilePath(type, suffix);
  writeJSON(targetPath, {
    from: preparedFrom,
    to: preparedTo,
  });
}

const RELATIONSHIP_HINTS = {
  deed_has_file: {
    preventSwap: true,
    from: {
      pathPrefixes: ["deed_"],
      allowedExtras: [],
      disallowExtras: [
        "deed_type",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
      ],
    },
    to: {
      pathPrefixes: ["file_"],
      allowedExtras: ["request_identifier"],
      disallowExtras: [
        "book",
        "deed_type",
        "instrument_number",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
        "ownership_transfer_date",
        "page",
        "purchase_price_amount",
        "volume",
      ],
    },
  },
  file_has_fact_sheet: {
    preventSwap: true,
    from: {
      pathPrefixes: ["file_"],
      allowedExtras: ["request_identifier"],
      disallowExtras: [
        "deed_type",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
        "ownership_transfer_date",
        "purchase_price_amount",
      ],
    },
    to: { pathPrefixes: ["fact_sheet"], allowedExtras: [] },
  },
  layout_has_fact_sheet: {
    preventSwap: true,
    from: {
      pathPrefixes: ["layout_"],
      requiredExtras: ["space_type_index"],
      allowedExtras: ["space_type_index"],
      disallowExtras: [
        "deed_type",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
        "ownership_transfer_date",
        "request_identifier",
      ],
    },
    to: { pathPrefixes: ["fact_sheet"], allowedExtras: [] },
  },
  property_has_layout: {
    preventSwap: true,
    from: { pathPrefixes: ["property"], allowedExtras: [] },
    to: {
      pathPrefixes: ["layout_"],
      requiredExtras: ["space_type_index"],
      allowedExtras: ["space_type_index"],
      disallowExtras: [
        "deed_type",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
        "ownership_transfer_date",
        "request_identifier",
      ],
    },
  },
  property_has_sales_history: {
    from: { pathPrefixes: ["property"], allowedExtras: [] },
    to: {
      pathPrefixes: ["sales_history_"],
      requiredExtras: ["ownership_transfer_date"],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
    },
  },
  sales_history_has_company: {
    from: {
      pathPrefixes: ["sales_history_"],
      requiredExtras: ["ownership_transfer_date"],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
    },
    to: {
      pathPrefixes: ["company_"],
      allowedExtras: [],
      disallowExtras: ["ownership_transfer_date"],
    },
  },
  sales_history_has_deed: {
    preventSwap: true,
    from: {
      pathPrefixes: ["sales_history_"],
      requiredExtras: ["ownership_transfer_date"],
      disallowExtras: [
        "purchase_price_amount",
        "deed_type",
        "document_type",
        "file_format",
        "ipfs_url",
        "name",
        "original_url",
      ],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
    },
    to: {
      pathPrefixes: ["deed_"],
      allowedExtras: [],
      disallowExtras: [
        "book",
        "deed_type",
        "instrument_number",
        "ipfs_url",
        "name",
        "original_url",
        "ownership_transfer_date",
        "page",
        "purchase_price_amount",
        "volume",
      ],
    },
  },
  sales_history_has_person: {
    from: {
      pathPrefixes: ["sales_history_"],
      requiredExtras: ["ownership_transfer_date"],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
    },
    to: {
      pathPrefixes: ["person_"],
      allowedExtras: [],
      disallowExtras: ["ownership_transfer_date"],
    },
  },
};

const RELATIONSHIPS_MANAGED_EXTERNALLY = new Set([
  "file_has_fact_sheet",
  "layout_has_fact_sheet",
]);

const STRICT_RELATIONSHIP_SCHEMAS = {
  deed_has_file: {
    from: {
      pathPrefixes: ["deed_"],
      allowedExtras: [],
      requiredExtras: [],
    },
    to: {
      pathPrefixes: ["file_"],
      allowedExtras: ["request_identifier"],
      requiredExtras: [],
    },
  },
  sales_history_has_deed: {
    from: {
      pathPrefixes: ["sales_history_"],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
    to: {
      pathPrefixes: ["deed_"],
      allowedExtras: [],
      requiredExtras: [],
    },
  },
  property_has_layout: {
    from: {
      pathPrefixes: ["property"],
      allowedExtras: [],
      requiredExtras: [],
    },
    to: {
      pathPrefixes: ["layout_"],
      allowedExtras: ["space_type_index"],
      requiredExtras: ["space_type_index"],
    },
  },
  property_has_sales_history: {
    from: {
      pathPrefixes: ["property"],
      allowedExtras: [],
      requiredExtras: [],
    },
    to: {
      pathPrefixes: ["sales_history_"],
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
  },
};

const RELATIONSHIP_POINTER_RULES = {
  deed_has_file: {
    from: { allowedExtras: [] },
    to: { allowedExtras: ["request_identifier"] },
  },
  file_has_fact_sheet: {
    from: { allowedExtras: ["request_identifier"] },
    to: { allowedExtras: [] },
  },
  layout_has_fact_sheet: {
    from: {
      allowedExtras: ["space_type_index"],
      requiredExtras: ["space_type_index"],
    },
    to: { allowedExtras: [] },
  },
  property_has_layout: {
    from: { allowedExtras: [] },
    to: {
      allowedExtras: ["space_type_index"],
      requiredExtras: ["space_type_index"],
    },
  },
  property_has_sales_history: {
    from: { allowedExtras: [] },
    to: {
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
  },
  sales_history_has_deed: {
    from: {
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
    to: { allowedExtras: [] },
  },
  sales_history_has_company: {
    from: {
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
    to: { allowedExtras: [] },
  },
  sales_history_has_person: {
    from: {
      allowedExtras: ["ownership_transfer_date", "request_identifier"],
      requiredExtras: ["ownership_transfer_date"],
    },
    to: { allowedExtras: [] },
  },
};

function sanitizeRelationshipPointerByRule(type, side, pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  const rules =
    (RELATIONSHIP_POINTER_RULES[type] &&
      RELATIONSHIP_POINTER_RULES[type][side]) ||
    null;
  const allowedKeys = new Set(["/", "cid", "uri"]);
  const extras =
    rules && Array.isArray(rules.allowedExtras) && rules.allowedExtras.length
      ? rules.allowedExtras.map((key) => String(key))
      : ALLOWED_POINTER_EXTRAS;
  extras.forEach((key) => {
    if (!FORBIDDEN_POINTER_KEYS.includes(String(key))) {
      allowedKeys.add(String(key));
    }
  });

  const sanitized = {};
  allowedKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) {
      return;
    }
    if (key === "/") {
      const normalized = normalizePointerPath(pointer["/"]);
      if (normalized) sanitized["/"] = normalized;
      return;
    }
    if (key === "cid" || key === "uri") {
      const trimmed = String(pointer[key]).trim();
      if (trimmed) sanitized[key] = trimmed;
      return;
    }
    const value = sanitizePointerExtraValue(key, pointer[key]);
    if (value != null) {
      sanitized[key] = value;
    }
  });

  if (!pointerHasBase(sanitized)) {
    return null;
  }

  if (rules && Array.isArray(rules.requiredExtras)) {
    const missing = rules.requiredExtras.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(sanitized, key) ||
        sanitized[key] == null ||
        String(sanitized[key]).trim() === "",
    );
    if (missing) {
      return null;
    }
  }

  return sanitized;
}

function enforceStrictRelationshipPointers(type, fromPointer, toPointer) {
  if (!fromPointer || !toPointer) {
    return null;
  }
  const schema = STRICT_RELATIONSHIP_SCHEMAS[type];
  if (!schema) {
    return { from: fromPointer, to: toPointer };
  }
  const strictFrom = sanitizePointerAgainstStrictSchema(
    fromPointer,
    schema.from || {},
  );
  const strictTo = sanitizePointerAgainstStrictSchema(
    toPointer,
    schema.to || {},
  );
  if (!strictFrom || !strictTo) {
    return null;
  }
  return { from: strictFrom, to: strictTo };
}

function buildStrictPointerForSchema(pointer, schemaSide = {}) {
  if (!pointer || typeof pointer !== "object") return null;
  const strictPointer = sanitizePointerAgainstStrictSchema(
    pointer,
    schemaSide || {},
  );
  if (!strictPointer) return null;
  stripForbiddenPointerKeys(strictPointer);
  pruneToAllowedPointerKeys(strictPointer, schemaSide);
  return strictPointer;
}

function readJsonFromData(relativePath) {
  if (!relativePath) return null;
  const trimmed = relativePath.replace(/^[./\\]+/, "").trim();
  if (!trimmed) return null;
  const fullPath = path.join("data", trimmed);
  if (POINTER_JSON_CACHE.has(fullPath)) {
    return POINTER_JSON_CACHE.get(fullPath);
  }
  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    POINTER_JSON_CACHE.set(fullPath, parsed);
    return parsed;
  } catch (err) {
    POINTER_JSON_CACHE.set(fullPath, null);
    return null;
  }
}

function getRefPath(refLike, pointerRaw) {
  let candidate = null;
  if (pointerRaw && typeof pointerRaw === "object" && typeof pointerRaw["/"] === "string") {
    candidate = pointerRaw["/"];
  }
  if (!candidate && refLike && typeof refLike === "object") {
    candidate =
      (typeof refLike["/"] === "string" && refLike["/"]) ||
      (typeof refLike.path === "string" && refLike.path) ||
      (typeof refLike.filename === "string" && refLike.filename) ||
      (typeof refLike.file === "string" && refLike.file);
  }
  if (!candidate && typeof refLike === "string") {
    candidate = refLike;
  }
  if (typeof candidate !== "string") return null;
  const normalized = normalizePointerPath(candidate);
  if (!normalized) return null;
  return normalized.replace(/^\.\//, "");
}

function matchesPathPrefix(pathValue, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false;
  if (!pathValue) return false;
  return prefixes.some((prefix) => pathValue.startsWith(prefix));
}

function fetchValueFromRefLike(refLike, key) {
  if (!refLike || typeof refLike !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(refLike, key)) {
    const value = refLike[key];
    if (value == null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    return value;
  }
  return null;
}

function pointerHasRequiredExtras(meta, hintSide) {
  if (!hintSide || !Array.isArray(hintSide.requiredExtras) || hintSide.requiredExtras.length === 0) {
    return true;
  }
  return hintSide.requiredExtras.every((key) => {
    const fromPointer =
      meta.pointerRaw &&
      Object.prototype.hasOwnProperty.call(meta.pointerRaw, key) &&
      meta.pointerRaw[key] != null &&
      String(meta.pointerRaw[key]).trim() !== "";
    if (fromPointer) return true;
    const fromRef = fetchValueFromRefLike(meta.refLike, key);
    if (fromRef != null && String(fromRef).trim() !== "") return true;
    if (meta.path) {
      const node = readJsonFromData(meta.path);
      if (node && Object.prototype.hasOwnProperty.call(node, key)) {
        const value = node[key];
        if (value != null && String(value).trim() !== "") return true;
      }
    }
    return false;
  });
}

function buildPointerMeta(refLike) {
  const pointerRaw = pointerFromRef(refLike);
  if (!pointerRaw) {
    return {
      refLike,
      pointerRaw: null,
      path: getRefPath(refLike, null),
    };
  }
  return {
    refLike,
    pointerRaw,
    path: getRefPath(refLike, pointerRaw),
  };
}

function pointerPathFromPointer(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  const rawPath = pointer["/"];
  if (typeof rawPath !== "string") return null;
  const normalized = normalizePointerPath(rawPath);
  if (!normalized) return null;
  let sanitized = normalized.replace(/^[./\\]+/, "");
  if (/^data[\\/]/i.test(sanitized)) {
    sanitized = sanitized.replace(/^data[\\/]+/i, "");
  }
  if (/^relationships[\\/]/i.test(sanitized)) {
    sanitized = sanitized.replace(/^relationships[\\/]+/i, "");
  }
  return sanitized;
}

function hasRequiredExtras(pointer, extras) {
  if (!pointer || typeof pointer !== "object") return false;
  if (!Array.isArray(extras) || extras.length === 0) return true;
  return extras.every((key) => {
    const strKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(pointer, strKey)) return false;
    const value = pointer[strKey];
    if (value == null) return false;
    return String(value).trim() !== "";
  });
}

function pointerMatchesHint(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return false;
  if (
    !hintSide ||
    !Array.isArray(hintSide.pathPrefixes) ||
    hintSide.pathPrefixes.length === 0
  ) {
    return true;
  }
  const pointerPath = pointerPathFromPointer(pointer);
  if (!pointerPath) return false;
  const normalizedPath = pointerPath.replace(/^[./\\]+/, "");
  return matchesPathPrefix(normalizedPath, hintSide.pathPrefixes);
}

function relationshipAppearsSwapped(originalFrom, originalTo, hint) {
  if (!hint || !originalFrom || !originalTo) return false;
  const hasFromPrefixes =
    hint.from &&
    Array.isArray(hint.from.pathPrefixes) &&
    hint.from.pathPrefixes.length > 0;
  const hasToPrefixes =
    hint.to &&
    Array.isArray(hint.to.pathPrefixes) &&
    hint.to.pathPrefixes.length > 0;
  if (!hasFromPrefixes || !hasToPrefixes) return false;
  const fromLooksLikeTo = pointerMatchesHint(originalFrom, hint.to);
  const toLooksLikeFrom = pointerMatchesHint(originalTo, hint.from);
  return fromLooksLikeTo && toLooksLikeFrom;
}


function sanitizeRelationshipPointer(refLike, hintSide) {
  if (refLike == null) return null;
  const meta = buildPointerMeta(refLike);
  if (!meta || !meta.pointerRaw) return null;
  const sideHint = hintSide || {};
  const normalizedPointer =
    cleanRelationshipPointer(meta, meta.pointerRaw, sideHint) ||
    enforcePointerForSide(meta.pointerRaw, sideHint);
  if (!normalizedPointer) return null;
  return pruneRelationshipPointer(normalizedPointer, sideHint);
}

function safeSanitizePointerForRelationship(refLike, hintSide) {
  if (refLike == null) return null;
  const pointer = sanitizeRelationshipPointer(refLike, hintSide);
  if (pointer) return pointer;
  const refPointer = pointerFromRef(refLike);
  if (!refPointer) return null;
  const finalized =
    finalizePointerForWrite(refPointer, hintSide) ||
    enforcePointerSchema(refPointer, hintSide);
  if (!finalized) return null;
  stripForbiddenPointerKeys(finalized);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(finalized, hintSide.disallowExtras);
  }
  return finalized;
}

function buildNormalizedRelationshipPointer(refLike, hintSide) {
  if (refLike == null) return null;
  const sanitizedPointer =
    safeSanitizePointerForRelationship(refLike, hintSide) ||
    sanitizeRelationshipPointer(refLike, hintSide) ||
    pointerFromRef(refLike);
  if (!sanitizedPointer) return null;
  const normalizedForHint = sanitizePointerForHint(
    sanitizedPointer,
    hintSide,
  );
  if (!normalizedForHint) return null;
  const strictPointer =
    restrictPointerKeys(normalizedForHint, hintSide) || normalizedForHint;
  if (!strictPointer) return null;
  stripForbiddenPointerKeys(strictPointer);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(strictPointer, hintSide.disallowExtras);
  }
  return pointerHasBase(strictPointer) ? strictPointer : null;
}

function sanitizeRelationshipDirectories(types) {
  if (!Array.isArray(types) || types.length === 0) return;
  types.forEach((type) => {
    if (typeof type !== "string") return;
    const trimmed = type.trim();
    if (!trimmed) return;
    const hint = RELATIONSHIP_HINTS[trimmed];
    if (!hint) return;
    const dirPath = path.join("relationships", trimmed);
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    entries.forEach((filename) => {
      if (!/\.json$/i.test(filename)) return;
      const fullPath = path.join(dirPath, filename);
      let payload;
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        payload = JSON.parse(raw);
      } catch (err) {
        return;
      }
      const originalFrom = payload ? payload.from : null;
      const originalTo = payload ? payload.to : null;
      let sanitizedFrom = safeSanitizePointerForRelationship(
        originalFrom,
        hint.from,
      );
      let sanitizedTo = safeSanitizePointerForRelationship(
        originalTo,
        hint.to,
      );

      let fromMatches = pointerMatchesHint(sanitizedFrom, hint.from);
      let toMatches = pointerMatchesHint(sanitizedTo, hint.to);
      const swappingAllowed = !hint || hint.preventSwap !== true;

      const looksReversed = relationshipAppearsSwapped(
        originalFrom,
        originalTo,
        hint,
      );
      if (looksReversed && swappingAllowed) {
        sanitizedFrom = safeSanitizePointerForRelationship(
          originalTo,
          hint.from,
        );
        sanitizedTo = safeSanitizePointerForRelationship(
          originalFrom,
          hint.to,
        );
        fromMatches = pointerMatchesHint(sanitizedFrom, hint.from);
        toMatches = pointerMatchesHint(sanitizedTo, hint.to);
      }

      if (
        (!sanitizedFrom || !sanitizedTo || !fromMatches || !toMatches) &&
        originalFrom &&
        originalTo &&
        swappingAllowed
      ) {
        const swappedFrom = safeSanitizePointerForRelationship(
          originalTo,
          hint.from,
        );
        const swappedTo = safeSanitizePointerForRelationship(
          originalFrom,
          hint.to,
        );
        const swapMatches =
          pointerMatchesHint(swappedFrom, hint.from) &&
          pointerMatchesHint(swappedTo, hint.to);
        const swapAllowed =
          swappingAllowed &&
          swapMatches &&
          (!fromMatches && !toMatches);
        if (swapAllowed) {
          sanitizedFrom = swappedFrom;
          sanitizedTo = swappedTo;
          fromMatches = pointerMatchesHint(sanitizedFrom, hint.from);
          toMatches = pointerMatchesHint(sanitizedTo, hint.to);
        }
      }

      if (!sanitizedFrom || !sanitizedTo || !fromMatches || !toMatches) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
        return;
      }

      stripForbiddenPointerKeys(sanitizedFrom);
      stripForbiddenPointerKeys(sanitizedTo);
      if (hint.from && Array.isArray(hint.from.disallowExtras)) {
        stripDisallowedExtras(sanitizedFrom, hint.from.disallowExtras);
      }
      if (hint.to && Array.isArray(hint.to.disallowExtras)) {
        stripDisallowedExtras(sanitizedTo, hint.to.disallowExtras);
      }
      pruneToAllowedPointerKeys(sanitizedFrom, hint.from);
      pruneToAllowedPointerKeys(sanitizedTo, hint.to);

      const normalizedFrom = sanitizePointerForHint(
        sanitizedFrom,
        hint.from,
      );
      const normalizedTo = sanitizePointerForHint(
        sanitizedTo,
        hint.to,
      );
      if (!normalizedFrom || !normalizedTo) return;
      let strictFrom =
        restrictPointerKeys(normalizedFrom, hint.from) || normalizedFrom;
      let strictTo =
        restrictPointerKeys(normalizedTo, hint.to) || normalizedTo;
      if (!strictFrom || !strictTo) return;

      strictFrom = ensurePointerHasRequiredExtras(strictFrom, hint.from);
      strictTo = ensurePointerHasRequiredExtras(strictTo, hint.to);
      if (
        !strictFrom ||
        !strictTo ||
        (hint.from &&
          Array.isArray(hint.from.requiredExtras) &&
          !hasRequiredExtras(strictFrom, hint.from.requiredExtras)) ||
        (hint.to &&
          Array.isArray(hint.to.requiredExtras) &&
          !hasRequiredExtras(strictTo, hint.to.requiredExtras))
      ) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
        return;
      }

      stripForbiddenPointerKeys(strictFrom);
      stripForbiddenPointerKeys(strictTo);
      if (hint.from && Array.isArray(hint.from.disallowExtras)) {
        stripDisallowedExtras(strictFrom, hint.from.disallowExtras);
      }
      if (hint.to && Array.isArray(hint.to.disallowExtras)) {
        stripDisallowedExtras(strictTo, hint.to.disallowExtras);
      }
      pruneToAllowedPointerKeys(strictFrom, hint.from);
      pruneToAllowedPointerKeys(strictTo, hint.to);

      const unchanged =
        JSON.stringify(originalFrom) === JSON.stringify(strictFrom) &&
        JSON.stringify(originalTo) === JSON.stringify(strictTo);
      if (unchanged) return;
      writeJSON(fullPath, { from: strictFrom, to: strictTo });
    });
  });
}

function rebuildRelationshipPointer(rawPointer, hintSide = {}, schemaSide = {}) {
  if (!rawPointer) return null;
  const canonical =
    canonicalizeRelationshipPointer(rawPointer, hintSide) ||
    pointerFromRef(rawPointer) ||
    null;
  if (!canonical) return null;
  const strictPointer =
    buildStrictPointerForSchema(canonical, schemaSide) || canonical;
  if (!strictPointer) return null;
  let finalized = finalizeRelationshipPointerPayload(strictPointer, hintSide);
  if (!finalized) return null;
  finalized = ensurePointerHasRequiredExtras(finalized, hintSide);
  if (
    hintSide &&
    Array.isArray(hintSide.requiredExtras) &&
    !hasRequiredExtras(finalized, hintSide.requiredExtras)
  ) {
    const requiredExtras = hintSide.requiredExtras.map((key) => String(key));
    const meta = buildPointerMeta(strictPointer);
    let hydrated = { ...finalized };
    requiredExtras.forEach((key) => {
      if (
        Object.prototype.hasOwnProperty.call(hydrated, key) &&
        hydrated[key] != null &&
        String(hydrated[key]).trim() !== ""
      ) {
        return;
      }
      const resolved = resolvePointerExtra(meta, key);
      if (resolved != null) {
        hydrated[key] = resolved;
      }
    });
    if (!hasRequiredExtras(hydrated, requiredExtras)) {
      return null;
    }
    finalized = hydrated;
  }
  stripForbiddenPointerKeys(finalized);
  pruneToAllowedPointerKeys(finalized, hintSide);
  return finalized;
}

function normalizeRelationshipDirectory(type) {
  if (typeof type !== "string" || !type.trim()) return;
  const relationshipType = type.trim();
  const dirPath = path.join("relationships", relationshipType);
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;
  const hint = RELATIONSHIP_HINTS[relationshipType] || {};
  const schema = STRICT_RELATIONSHIP_SCHEMAS[relationshipType] || {};
  entries.forEach((name) => {
    if (!/\.json$/i.test(name)) return;
    const fullPath = path.join(dirPath, name);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (err) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      return;
    }
    const normalizedFrom = rebuildRelationshipPointer(
      payload && payload.from,
      hint.from || {},
      schema.from || {},
    );
    const normalizedTo = rebuildRelationshipPointer(
      payload && payload.to,
      hint.to || {},
      schema.to || {},
    );
    if (!normalizedFrom || !normalizedTo) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      return;
    }
    writeJSON(fullPath, { from: normalizedFrom, to: normalizedTo });
  });
}

function normalizeManagedRelationshipPayloads() {
  const managedTypes = [
    "deed_has_file",
    "sales_history_has_deed",
    "property_has_layout",
    "property_has_sales_history",
  ];
  managedTypes.forEach((type) => normalizeRelationshipDirectory(type));
  removeRelationshipDirectories(["file_has_fact_sheet", "layout_has_fact_sheet"]);
}

function buildPointerFromCandidateForRepair(candidate, hintSide = {}) {
  if (!candidate) return null;
  let pointerSource = candidate;
  if (typeof candidate === "string") {
    pointerSource = pointerFromRelativePath(candidate);
  }
  if (!pointerSource || typeof pointerSource !== "object") return null;

  const basePath = resolvePointerBasePath(pointerSource);
  if (!basePath) return null;

  let normalizedBase = basePath;
  if (!/^([a-z]+:)/i.test(basePath) || basePath.startsWith("./")) {
    normalizedBase = normalizePointerPath(basePath);
  }
  if (!normalizedBase) return null;

  const pathPrefixes = Array.isArray(hintSide.pathPrefixes)
    ? hintSide.pathPrefixes
    : [];
  if (
    pathPrefixes.length > 0 &&
    !pathPrefixes.some((prefix) =>
      normalizedBase.replace(/^[./\\]+/, "").startsWith(prefix),
    )
  ) {
    return null;
  }

  const pointer = {};
  if (normalizedBase.startsWith("cid:")) {
    pointer.cid = normalizedBase.startsWith("cid:")
      ? normalizedBase
      : `cid:${normalizedBase}`;
  } else {
    if (
      /^[a-z]+:/i.test(normalizedBase) &&
      !normalizedBase.startsWith("./")
    ) {
      return null;
    }
    const ensured = normalizePointerPath(normalizedBase);
    if (!ensured) return null;
    pointer["/"] = ensured;
  }

  const allowedExtras = Array.isArray(hintSide.allowedExtras)
    ? hintSide.allowedExtras.map((key) => String(key))
    : [];
  const requiredExtras = Array.isArray(hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => {
    if (!allowedExtras.includes(key)) {
      allowedExtras.push(key);
    }
  });

  const relativePath = pointer["/"]
    ? pointer["/"].replace(/^[./\\]+/, "")
    : null;
  allowedExtras.forEach((key) => {
    if (FORBIDDEN_POINTER_KEYS.includes(key)) return;
    let value = sanitizePointerExtraValue(key, pointerSource[key]);
    if ((value == null || value === "") && relativePath) {
      value = readPointerExtraFromNode(relativePath, key);
    }
    if (value != null) {
      pointer[key] = value;
    }
  });

  const missingRequired = requiredExtras.some(
    (key) =>
      !Object.prototype.hasOwnProperty.call(pointer, key) ||
      pointer[key] == null ||
      String(pointer[key]).trim() === "",
  );
  if (missingRequired) {
    return null;
  }

  stripForbiddenPointerKeys(pointer);
  pruneToAllowedPointerKeys(pointer, {
    allowedExtras,
    requiredExtras,
  });
  return pointerHasBase(pointer) ? pointer : null;
}

function repairRelationshipDirectory(type, hint = {}) {
  if (typeof type !== "string" || !type.trim()) return;
  const relationshipType = type.trim();
  const preventSwap = hint && hint.preventSwap === true;
  const fromHint = (hint && hint.from) || {};
  const toHint = (hint && hint.to) || {};
  const dirPath = path.join("relationships", relationshipType);
  let entries;
  try {
    entries = fs
      .readdirSync(dirPath)
      .filter((filename) => /\.json$/i.test(filename));
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }

  entries.forEach((filename) => {
    const fullPath = path.join(dirPath, filename);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (err) {
      return;
    }
    if (!payload) return;

    let fromCandidate = payload.from;
    let toCandidate = payload.to;
    const fromMatches = pointerMatchesHint(fromCandidate, fromHint);
    const toMatches = pointerMatchesHint(toCandidate, toHint);
    if (!preventSwap && (!fromMatches || !toMatches)) {
      const swappedFromMatches = pointerMatchesHint(
        payload.to,
        fromHint,
      );
      const swappedToMatches = pointerMatchesHint(
        payload.from,
        toHint,
      );
      if (swappedFromMatches && swappedToMatches) {
        fromCandidate = payload.to;
        toCandidate = payload.from;
      }
    }

    const normalizedFrom = buildPointerFromCandidateForRepair(
      fromCandidate,
      fromHint,
    );
    const normalizedTo = buildPointerFromCandidateForRepair(
      toCandidate,
      toHint,
    );

    if (!normalizedFrom || !normalizedTo) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      return;
    }

    const nextPayload = { from: normalizedFrom, to: normalizedTo };
    if (JSON.stringify(payload) !== JSON.stringify(nextPayload)) {
      writeJSON(fullPath, nextPayload);
    }
  });
}

function repairAllManagedRelationships() {
  Object.entries(RELATIONSHIP_HINTS).forEach(([type, hint]) => {
    const repairHint = {
      ...(hint || {}),
      from: hint && hint.from ? { ...hint.from } : {},
      to: hint && hint.to ? { ...hint.to } : {},
    };
    repairRelationshipDirectory(type, repairHint);
  });
}

function finalizePointerForWrite(pointer, hintSide) {
  if (!pointer || typeof pointer !== "object") return null;

  const allowedExtrasList = resolveAllowedExtrasList(hintSide).map((key) =>
    String(key),
  );
  const requiredExtras = Array.isArray(hintSide && hintSide.requiredExtras)
    ? hintSide.requiredExtras.map((key) => String(key))
    : [];
  requiredExtras.forEach((key) => {
    if (!allowedExtrasList.includes(key)) {
      allowedExtrasList.push(key);
    }
  });
  const allowedExtras = new Set(allowedExtrasList);
  const disallowedExtras = new Set(
    hintSide && Array.isArray(hintSide.disallowExtras)
      ? hintSide.disallowExtras.map((key) => String(key))
      : [],
  );

  const cleaned = {};
  POINTER_BASE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalizedPath = normalizePointerPath(trimmed);
      if (normalizedPath) {
        cleaned["/"] = normalizedPath;
      }
    } else {
      cleaned[key] = trimmed;
    }
  });

  if (!pointerHasBase(cleaned)) {
    return null;
  }

  Object.keys(pointer).forEach((key) => {
    if (POINTER_BASE_KEYS.includes(key)) return;
    const strKey = String(key);
    if (disallowedExtras.has(strKey)) return;
    if (!allowedExtras.has(strKey)) return;
    if (FORBIDDEN_POINTER_KEYS.includes(strKey)) return;
    let value = pointer[key];
    if (value == null) return;
    if (strKey === "ownership_transfer_date") {
      value = formatPointerDate(value);
      if (!value) return;
    } else {
      value = String(value).trim();
      if (!value) return;
    }
    cleaned[strKey] = value;
  });

  stripForbiddenPointerKeys(cleaned);
  if (hintSide && Array.isArray(hintSide.disallowExtras)) {
    stripDisallowedExtras(cleaned, hintSide.disallowExtras);
  }

  for (const key of requiredExtras) {
    const strKey = String(key);
    if (
      !Object.prototype.hasOwnProperty.call(cleaned, strKey) ||
      cleaned[strKey] == null ||
      String(cleaned[strKey]).trim() === ""
    ) {
      return null;
    }
  }

  return cleaned;
}

function nextRelationshipIndex(dirPath) {
  let maxIndex = -1;
  try {
    const entries = fs.readdirSync(dirPath);
    entries.forEach((name) => {
      const match = name.match(/^(\d+)\.json$/);
      if (match) {
        const value = Number(match[1]);
        if (Number.isInteger(value) && value > maxIndex) {
          maxIndex = value;
        }
      }
    });
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      throw err;
    }
  }
  return String(maxIndex + 1);
}

function resolveRelationshipFilePath(type, suffix) {
  const baseDir = path.join("relationships", type);
  ensureDir(baseDir);
  const supplied =
    suffix === undefined || suffix === null
      ? ""
      : String(suffix).trim();
  const filename = supplied
    ? `${supplied}.json`
    : `${nextRelationshipIndex(baseDir)}.json`;
  return path.join(baseDir, filename);
}

function writeRelationship(type, fromRefLike, toRefLike, suffix) {
  if (typeof type !== "string") return;
  const relationshipType = type.trim();
  if (!relationshipType) return;
  if (RELATIONSHIPS_MANAGED_EXTERNALLY.has(relationshipType)) {
    return;
  }

  const hint = RELATIONSHIP_HINTS[relationshipType] || {};
  const swappingAllowed = hint.preventSwap !== true;
  const preparedFrom = scrubPointerRefLike(fromRefLike);
  const preparedTo = scrubPointerRefLike(toRefLike);
  let strictFrom = buildNormalizedRelationshipPointer(
    preparedFrom,
    hint && hint.from,
  );
  let strictTo = buildNormalizedRelationshipPointer(
    preparedTo,
    hint && hint.to,
  );
  let fromMatches = pointerMatchesHint(strictFrom, hint.from);
  let toMatches = pointerMatchesHint(strictTo, hint.to);
  if (
    swappingAllowed &&
    (!fromMatches || !toMatches) &&
    preparedFrom &&
    preparedTo
  ) {
    const swappedFrom = buildNormalizedRelationshipPointer(
      preparedTo,
      hint && hint.from,
    );
    const swappedTo = buildNormalizedRelationshipPointer(
      preparedFrom,
      hint && hint.to,
    );
    const swappedMatches =
      pointerMatchesHint(swappedFrom, hint.from) &&
      pointerMatchesHint(swappedTo, hint.to);
    const swapAllowed =
      swappingAllowed && swappedMatches && (!fromMatches && !toMatches);
    if (swapAllowed) {
      strictFrom = swappedFrom;
      strictTo = swappedTo;
      fromMatches = true;
      toMatches = true;
    }
  }
  if (!fromMatches || !toMatches) {
    return;
  }
  let enforcedFrom = ensurePointerHasRequiredExtras(
    strictFrom,
    hint && hint.from,
  );
  let enforcedTo = ensurePointerHasRequiredExtras(strictTo, hint && hint.to);
  if (!enforcedFrom || !enforcedTo) return;
  const strictPair = enforceStrictRelationshipPointers(
    relationshipType,
    enforcedFrom,
    enforcedTo,
  );
  if (!strictPair) return;
  enforcedFrom = strictPair.from;
  enforcedTo = strictPair.to;
  if (!enforcedFrom || !enforcedTo) return;

  stripForbiddenPointerKeys(enforcedFrom);
  stripForbiddenPointerKeys(enforcedTo);
  if (hint.from && Array.isArray(hint.from.disallowExtras)) {
    stripDisallowedExtras(enforcedFrom, hint.from.disallowExtras);
  }
  if (hint.to && Array.isArray(hint.to.disallowExtras)) {
    stripDisallowedExtras(enforcedTo, hint.to.disallowExtras);
  }
  pruneToAllowedPointerKeys(enforcedFrom, hint.from);
  pruneToAllowedPointerKeys(enforcedTo, hint.to);
  enforcedFrom = finalizeRelationshipPointerPayload(
    enforcedFrom,
    hint && hint.from,
  );
  enforcedTo = finalizeRelationshipPointerPayload(
    enforcedTo,
    hint && hint.to,
  );
  if (!enforcedFrom || !enforcedTo) return;

  const targetPath = resolveRelationshipFilePath(relationshipType, suffix);
  writeJSON(targetPath, {
    from: enforcedFrom,
    to: enforcedTo,
  });
}

function writeRelationshipFromFilenames(type, fromFilename, toFilename, suffix) {
  if (!fromFilename || !toFilename) return;
  const preparedFrom = preparePointerForRelationship(type, fromFilename, "from");
  const preparedTo = preparePointerForRelationship(type, toFilename, "to");
  if (!preparedFrom || !preparedTo) return;
  writeRelationship(type, preparedFrom, preparedTo, suffix);
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

function deriveDeedRequestIdentifier(
  saleRecord,
  idx,
  parcelId,
  transferDate,
) {
  const candidates = [
    nonEmptyString(saleRecord && saleRecord.instrument),
    transferDate && nonEmptyString(saleRecord && saleRecord.bookPage)
      ? `${transferDate}_${nonEmptyString(saleRecord.bookPage)}`
      : null,
    parcelId ? `${parcelId}_deed_${idx}` : null,
    `deed_${idx}`,
  ];
  for (const value of candidates) {
    const normalized = nonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

function buildFileArtifactsForSale(
  saleRecord,
  idx,
  context,
) {
  const { parcelId } = context || {};
  const instrument = nonEmptyString(saleRecord && saleRecord.instrument);
  const bookPage = nonEmptyString(saleRecord && saleRecord.bookPage);
  const normalizedBookPage = bookPage
    ? bookPage.replace(/[^0-9A-Za-z]+/g, "_")
    : null;
  const identifierCandidates = [
    instrument && normalizedBookPage
      ? `${instrument}_${normalizedBookPage}`
      : null,
    normalizedBookPage ? `book_page_${normalizedBookPage}` : null,
    instrument ? `${instrument}_${idx}` : null,
    parcelId ? `${parcelId}_file_${idx}` : null,
    `deed_file_${idx}`,
  ];
  let requestIdentifier = null;
  for (const value of identifierCandidates) {
    const normalized = nonEmptyString(value);
    if (normalized) {
      requestIdentifier = normalized;
      break;
    }
  }
  if (!requestIdentifier) return null;
  const fileNode = {
    request_identifier: requestIdentifier,
  };
  const filename = `file_${idx}.json`;
  return {
    fileNode,
    filename,
    pointerExtras: {
      request_identifier: requestIdentifier,
    },
  };
}

function removeFilesMatchingPatterns(patterns, directories = ["data"]) {
  if (!Array.isArray(patterns) || patterns.length === 0) return;
  const dirs =
    Array.isArray(directories) && directories.length > 0
      ? directories
      : ["data"];
  dirs.forEach((dir) => {
    if (!dir || typeof dir !== "string") return;
    try {
      const entries = fs.readdirSync(dir);
      entries.forEach((filename) => {
        if (patterns.some((regex) => regex.test(filename))) {
          fs.unlinkSync(path.join(dir, filename));
        }
      });
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  });
}

function removeRelationshipDirectories(types) {
  if (!Array.isArray(types) || types.length === 0) return;
  types.forEach((type) => {
    if (typeof type !== "string") return;
    const trimmed = type.trim();
    if (!trimmed) return;
    const targetDir = path.join("relationships", trimmed);
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  });
}

const EXTERNALLY_MANAGED_PATTERNS = [
  /^relationship_file_has_fact_sheet(?:_\d+)?\.json$/i,
  /^relationship_layout_has_fact_sheet(?:_\d+)?\.json$/i,
  /^file_\d+\.json$/i,
  /^fact_sheet(?:_\d+)?\.json$/i,
];

const MANAGED_RELATIONSHIP_TYPES = [
  "deed_has_file",
  "property_has_layout",
  "property_has_sales_history",
  "sales_history_has_deed",
  "sales_history_has_person",
  "sales_history_has_company",
];

function purgeExternallyManagedArtifacts() {
  removeFilesMatchingPatterns(EXTERNALLY_MANAGED_PATTERNS, [
    "data",
    "relationships",
  ]);
  removeRelationshipDirectories([
    "file_has_fact_sheet",
    "layout_has_fact_sheet",
  ]);
}

function purgeManagedRelationshipDirectories() {
  removeRelationshipDirectories(MANAGED_RELATIONSHIP_TYPES);
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
  ["book", "instrument_number", "page", "request_identifier", "volume"].forEach(
    assignString,
  );
  [
    "deed_type",
    "document_type",
    "file_format",
    "ipfs_url",
    "name",
    "original_url",
  ].forEach((prop) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, prop)) {
      delete sanitized[prop];
    }
  });
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
        cleanedLink = match[1].replace(/&amp;/g, "&").trim();
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
  const propertyRelationshipRef = fs.existsSync(propertyFileOnDisk)
    ? (context && context.propertyFile) || "property.json"
    : null;

  const salesCleanupPatterns = [
    /^relationship_(deed_has_file|deed_file|property_has_file|property_has_sales_history|sales_history_has_deed|sales_deed|sales_history_has_person|sales_history_has_company|sales_person|sales_company)(?:_\d+)?\.json$/i,
    /^relationship_(file_has_fact_sheet|layout_has_fact_sheet)(?:_\d+)?\.json$/i,
    /^(sales_history|sales|deed|file|fact_sheet)_\d+\.json$/i,
    /^fact_sheet\.json$/i,
  ];
  removeFilesMatchingPatterns(salesCleanupPatterns, ["data", "relationships"]);
  removeRelationshipDirectories([
    "deed_has_file",
    "deed_file",
    "file_has_fact_sheet",
    "layout_has_fact_sheet",
    "property_has_file",
    "property_has_sales_history",
    "sales_history_has_deed",
    "sales_history_has_person",
    "sales_history_has_company",
    "sales_deed",
    "sales_person",
    "sales_company",
  ]);

  const processedSales = [];
  let saleCounter = 0;
  // Build deed/file artifacts for sales so downstream validators receive fully-specified relationships.
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

    const deedCandidate = {};
    const { book, page } = parseBookAndPage(saleRecord.bookPage);
    if (book) deedCandidate.book = book;
    if (page) deedCandidate.page = page;
    const deedRequestIdentifier = deriveDeedRequestIdentifier(
      saleRecord,
      idx,
      parcelId,
      transferDate,
    );
    if (deedRequestIdentifier) {
      deedCandidate.request_identifier = deedRequestIdentifier;
    }
    attachSourceHttpRequest(deedCandidate, defaultSourceHttpRequest);
    const deedNode = sanitizeDeedMetadata(deedCandidate);
    const deedFilename = `deed_${idx}.json`;
    writeJSON(path.join("data", deedFilename), deedNode);

    const fileArtifacts = buildFileArtifactsForSale(
      saleRecord,
      idx,
      context,
    );
    if (fileArtifacts) {
      writeJSON(
        path.join("data", fileArtifacts.filename),
        fileArtifacts.fileNode,
      );
    }

    processedSales.push({
      source: saleRecord,
      idx,
      saleFilename,
      transferDate: saleNode.ownership_transfer_date,
      saleNode,
      deedFilename,
      fileArtifact: fileArtifacts
        ? {
            filename: fileArtifacts.filename,
            request_identifier:
              fileArtifacts.pointerExtras &&
              fileArtifacts.pointerExtras.request_identifier,
          }
        : null,
    });
  });

  writeSalesRelationshipPayloads(
    processedSales,
    propertyRelationshipRef,
  );

  return processedSales;
}

function relationshipPointersNeedSwap(type, fromPointer, toPointer) {
  const hint = RELATIONSHIP_HINTS[type];
  if (hint && hint.preventSwap === true) {
    return false;
  }
  if (
    !hint ||
    !hint.from ||
    !hint.to ||
    !fromPointer ||
    !toPointer
  ) {
    return false;
  }
  const fromMatches = pointerMatchesHint(fromPointer, hint.from);
  const toMatches = pointerMatchesHint(toPointer, hint.to);
  if (fromMatches && toMatches) {
    return false;
  }
  const swappedFromMatches = pointerMatchesHint(toPointer, hint.from);
  const swappedToMatches = pointerMatchesHint(fromPointer, hint.to);
  return (
    !fromMatches &&
    !toMatches &&
    swappedFromMatches &&
    swappedToMatches
  );
}

function writeOrientedRelationshipRecord(
  type,
  index,
  fromPointer,
  toPointer,
) {
  if (!fromPointer || !toPointer) return;
  let preparedFrom = fromPointer;
  let preparedTo = toPointer;
  if (relationshipPointersNeedSwap(type, fromPointer, toPointer)) {
    preparedFrom = toPointer;
    preparedTo = fromPointer;
  }
  writeCanonicalRelationshipRecord(
    type,
    index,
    preparedFrom,
    preparedTo,
  );
}

function writeDirectRelationship(type, index, fromPointer, toPointer) {
  writeSimpleRelationshipFile(type, index, fromPointer, toPointer);
}

function extractPointerForDirectRelationship(pointer, hintSide = {}) {
  if (!pointer || typeof pointer !== "object") return null;
  const sanitized = {};
  POINTER_BASE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const raw = pointer[key];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (key === "/") {
      const normalized = normalizePointerPath(trimmed);
      if (normalized) {
        sanitized["/"] = normalized;
      }
    } else {
      sanitized[key] = trimmed;
    }
  });
  if (!pointerHasBase(sanitized)) {
    return null;
  }
  const allowedExtras = resolveAllowedExtrasList(hintSide);
  allowedExtras.forEach((key) => {
    if (FORBIDDEN_POINTER_KEYS.includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(pointer, key)) return;
    const value = sanitizePointerExtraValue(key, pointer[key]);
    if (value != null) {
      sanitized[key] = value;
    }
  });
  if (
    hintSide &&
    Array.isArray(hintSide.requiredExtras) &&
    !hasRequiredExtras(sanitized, hintSide.requiredExtras)
  ) {
    return null;
  }
  return sanitized;
}

function writeSalesRelationshipPayloads(
  processedSales,
  propertyRelationshipRef,
) {
  if (!Array.isArray(processedSales) || processedSales.length === 0) {
    return;
  }
  removeRelationshipDirectories([
    "deed_has_file",
    "sales_history_has_deed",
    "property_has_sales_history",
  ]);
  const propertyPointer = propertyRelationshipRef
    ? buildSimplePointer(propertyRelationshipRef)
    : null;

  processedSales.forEach((rec) => {
    const salePointer = buildSimplePointer(
      rec.saleFilename,
      rec.saleNode,
      ["ownership_transfer_date", "request_identifier"],
    );
    if (
      !salePointer ||
      !Object.prototype.hasOwnProperty.call(
        salePointer,
        "ownership_transfer_date",
      )
    ) {
      return;
    }
    const deedPointer = buildSimplePointer(rec.deedFilename);
    if (!deedPointer) {
      return;
    }

    writeRelationshipRecordSimple(
      "sales_history_has_deed",
      rec.idx,
      salePointer,
      deedPointer,
    );

    if (rec.fileArtifact && rec.fileArtifact.filename) {
      const filePointer = buildSimplePointer(
        rec.fileArtifact.filename,
        { request_identifier: rec.fileArtifact.request_identifier },
        ["request_identifier"],
      );
      if (filePointer) {
        writeRelationshipRecordSimple(
          "deed_has_file",
          rec.idx,
          deedPointer,
          filePointer,
        );
      }
    }

    if (propertyPointer) {
      writeRelationshipRecordSimple(
        "property_has_sales_history",
        rec.idx,
        propertyPointer,
        salePointer,
      );
    }
  });
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
      buildSalesHistoryPointer(rec.saleFilename, rec.saleNode) || null;
    if (!saleRef) {
      return;
    }
    ownersOnDate
      .filter((o) => o.type === "person")
      .forEach((o) => {
        const pIdx = findPersonIndexByName(o.first_name, o.last_name);
        if (pIdx) {
          const personRef = pointerFromRelativePath(`person_${pIdx}.json`);
          if (!personRef) return;
          relPersonCounter++;
          writeSimpleRelationshipFile(
            "sales_history_has_person",
            relPersonCounter,
            saleRef,
            personRef,
          );
        }
      });
    ownersOnDate
      .filter((o) => o.type === "company")
      .forEach((o) => {
        const cIdx = findCompanyIndexByName(o.name);
        if (cIdx) {
          const companyRef = pointerFromRelativePath(`company_${cIdx}.json`);
          if (!companyRef) return;
          relCompanyCounter++;
          writeSimpleRelationshipFile(
            "sales_history_has_company",
            relCompanyCounter,
            saleRef,
            companyRef,
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
  const layoutCleanupPatterns = [
    /^relationship_property_has_layout(?:_\d+)?\.json$/i,
    /^relationship_layout_has_fact_sheet(?:_\d+)?\.json$/i,
    /^relationship_file_has_fact_sheet(?:_\d+)?\.json$/i,
    /^fact_sheet(?:_\d+)?\.json$/i,
  ];
  removeFilesMatchingPatterns(layoutCleanupPatterns, [
    "data",
    "relationships",
  ]);
  removeRelationshipDirectories([
    "property_has_layout",
    "layout_has_fact_sheet",
    "file_has_fact_sheet",
  ]);
  if (!layouts) return;
  const key = `property_${parcelId}`;
  const record = (layouts[key] && layouts[key].layouts) ? layouts[key].layouts : [];
  const propertyFilename =
    (context &&
      typeof context.propertyFile === "string" &&
      context.propertyFile.trim()) ||
    "property.json";
  const propertyPointer = fs.existsSync(path.join("data", propertyFilename))
    ? buildPointerPayloadFromFilename(propertyFilename)
    : null;
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
    if (propertyPointer && out.space_type_index) {
      const layoutPointer = buildPointerPayloadFromFilename(
        layoutFilename,
        { space_type_index: out.space_type_index },
        ["space_type_index"],
      );
      if (
        layoutPointer &&
        Object.prototype.hasOwnProperty.call(layoutPointer, "space_type_index")
      ) {
        writeDirectRelationship(
          "property_has_layout",
          layoutCounter,
          propertyPointer,
          layoutPointer,
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
  const unnormalizedValue =
    nonEmptyString(unnorm && unnorm.full_address) ||
    nonEmptyString(unnorm && unnorm.address) ||
    nonEmptyString(unnorm && unnorm.address_text) ||
    nonEmptyString(normalizedSource && normalizedSource.original_address);
  const normalizedCountry = nonEmptyString(
    normalizedSource && normalizedSource.country_code,
  );

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
          nonEmptyString(normalizedSource[key]),
        )
      : [];
  const hasCompleteNormalizedAddress =
    normalizedSource &&
    normalizedValues.every((val) => val && typeof val === "string");

  const address = {};
  const countyName = nonEmptyString(unnorm && unnorm.county_jurisdiction);
  if (countyName) address.county_name = countyName;

  if (secTwpRng && secTwpRng.section) address.section = secTwpRng.section;
  if (secTwpRng && secTwpRng.township) address.township = secTwpRng.township;
  if (secTwpRng && secTwpRng.range) address.range = secTwpRng.range;

  const shouldPreferUnnormalized = Boolean(unnormalizedValue);

  if (shouldPreferUnnormalized) {
    address.unnormalized_address = unnormalizedValue;
  } else if (hasCompleteNormalizedAddress) {
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
    const suffix = nonEmptyString(
      normalizedSource && normalizedSource.street_suffix_type,
    );
    if (suffix) address.street_suffix_type = suffix;
    const preDir = nonEmptyString(
      normalizedSource && normalizedSource.street_pre_directional_text,
    );
    if (preDir) address.street_pre_directional_text = preDir;
    const postDir = nonEmptyString(
      normalizedSource && normalizedSource.street_post_directional_text,
    );
    if (postDir) address.street_post_directional_text = postDir;
    const unit = nonEmptyString(
      normalizedSource && normalizedSource.unit_identifier,
    );
    if (unit) address.unit_identifier = unit;
    const route = nonEmptyString(
      normalizedSource && normalizedSource.route_number,
    );
    if (route) address.route_number = route;
    const plusFour = nonEmptyString(
      normalizedSource && normalizedSource.plus_four_postal_code,
    );
    if (plusFour) address.plus_four_postal_code = plusFour;
  } else if (unnormalizedValue) {
    address.unnormalized_address = unnormalizedValue;
  }

  if (address.unnormalized_address) {
    address.country_code = normalizedCountry || address.country_code || "US";
  } else if (hasCompleteNormalizedAddress) {
    address.country_code = normalizedCountry || "US";
  } else if (normalizedCountry && !address.country_code) {
    address.country_code = normalizedCountry;
  } else if (!address.country_code) {
    address.country_code = "US";
  }

  const requestIdentifier = nonEmptyString(
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
  purgeExternallyManagedArtifacts();
  purgeManagedRelationshipDirectories();
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
  repairAllManagedRelationships();
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
