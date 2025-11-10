#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const cheerio = require("cheerio");

async function readJson(p) {
  const s = await fsp.readFile(p, "utf8");
  return JSON.parse(s);
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function assignIfValue(target, key, value) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    target[key] = trimmed;
    return;
  }
  target[key] = value;
}

function deepClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function createRelationshipPayload(fromPath, toPath, extras = {}) {
  const payload =
    extras && typeof extras === "object" ? { ...extras } : {};

  const normalizeEndpoint = (value) => {
    if (value == null) return null;

    const normalizeStringPath = (input) => {
      if (typeof input !== "string") return null;
      const trimmed = input.trim();
      return trimmed || null;
    };

    const buildRefObject = (normalizedPath) =>
      normalizedPath ? { "/": normalizedPath } : null;

    if (typeof value === "string") {
      return buildRefObject(normalizeStringPath(value));
    }

    if (value && typeof value === "object") {
      if (typeof value["/"] === "string") {
        return buildRefObject(normalizeStringPath(value["/"]));
      }
      if (typeof value.path === "string") {
        return buildRefObject(normalizeStringPath(value.path));
      }
      if (typeof value.ref === "string") {
        return buildRefObject(normalizeStringPath(value.ref));
      }
    }
    return null;
  };

  const fromValue = normalizeEndpoint(
    Object.prototype.hasOwnProperty.call(payload, "from")
      ? payload.from
      : fromPath,
  );
  const toValue = normalizeEndpoint(
    Object.prototype.hasOwnProperty.call(payload, "to") ? payload.to : toPath,
  );

  const hasFrom = fromValue != null;
  const hasTo = toValue != null;

  if (!hasFrom && !hasTo) {
    const extraKeys = Object.keys(payload).filter(
      (key) => key !== "from" && key !== "to",
    );
    if (extraKeys.length === 0) {
      return null;
    }
  }

  payload.from = hasFrom ? fromValue : null;
  payload.to = hasTo ? toValue : null;

  return payload;
}

async function writeRelationshipFile(fileName, fromPath, toPath, extras = {}) {
  const payload = createRelationshipPayload(fromPath, toPath, extras);
  if (!payload) return false;
  await fsp.writeFile(
    path.join("data", fileName),
    JSON.stringify(payload, null, 2),
  );
  return true;
}

function textClean(s) {
  // Improved textClean to remove HTML comments and non-breaking spaces more aggressively
  return (s || "")
    .replace(/<!--.*?-->/g, "") // Remove HTML comments
    .replace(/\u00a0/g, " ") // Replace non-breaking spaces
    .replace(/\s+/g, " ") // Replace multiple spaces with a single space
    .trim();
}

function parseCurrencyToNumber(str) {
  if (str == null) return null;
  const s = String(str).replace(/[^0-9.\-]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return n;
}

function parseDateToISO(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeCountyName(value) {
  if (!value) return null;
  const cleaned = textClean(String(value));
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === "st lucie" || lower === "st. lucie" || lower === "saint lucie") {
    return "St. Lucie";
  }
  return cleaned
    .split(/\s+/)
    .map((part) =>
      part
        ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        : part,
    )
    .join(" ");
}

function normalizeCityName(value) {
  if (!value) return null;
  const cleaned = textClean(String(value));
  if (!cleaned) return null;
  return cleaned.toUpperCase();
}

function sanitizePostalCode(value) {
  if (!value) return null;
  const digits = String(value).match(/\d/g);
  if (!digits || digits.length < 5) return null;
  return digits.join("").slice(0, 5);
}

function sanitizePlusFour(value) {
  if (!value) return null;
  const digits = String(value).match(/\d/g);
  if (!digits || digits.length < 4) return null;
  return digits.join("").slice(0, 4);
}

function filterMailingAddressLines(lines) {
  if (!Array.isArray(lines)) return [];
  const STATE_ZIP_REGEX =
    /\b(AL|AK|AS|AZ|AR|CA|CO|CT|DE|DC|FL|GA|GU|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|MP|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|VI|WA|WV|WI|WY)\b[\s,]*\d{5}/i;
  const filtered = lines.filter((line) => {
    if (!line || typeof line !== "string") return false;
    if (/\d/.test(line)) return true;
    if (STATE_ZIP_REGEX.test(line)) return true;
    if (/\bP\.?\s*O\.?\s*BOX\b/i.test(line)) return true;
    return false;
  });
  return filtered.length ? filtered : lines;
}

const STREET_DIRECTION_ALLOWED = new Set([
  "N",
  "S",
  "E",
  "W",
  "NE",
  "NW",
  "SE",
  "SW",
]);

const STREET_DIRECTION_MAP = {
  N: "N",
  NORTH: "N",
  NO: "N",
  SOUTH: "S",
  S: "S",
  EAST: "E",
  E: "E",
  WEST: "W",
  W: "W",
  NORTHEAST: "NE",
  NE: "NE",
  NORTHWEST: "NW",
  NW: "NW",
  SOUTHEAST: "SE",
  SE: "SE",
  SOUTHWEST: "SW",
  SW: "SW",
};

const STREET_SUFFIX_ALLOWED = new Set([
  "Rds",
  "Blvd",
  "Lk",
  "Pike",
  "Ky",
  "Vw",
  "Curv",
  "Psge",
  "Ldg",
  "Mt",
  "Un",
  "Mdw",
  "Via",
  "Cor",
  "Kys",
  "Vl",
  "Pr",
  "Cv",
  "Isle",
  "Lgt",
  "Hbr",
  "Btm",
  "Hl",
  "Mews",
  "Hls",
  "Pnes",
  "Lgts",
  "Strm",
  "Hwy",
  "Trwy",
  "Skwy",
  "Is",
  "Est",
  "Vws",
  "Ave",
  "Exts",
  "Cvs",
  "Row",
  "Rte",
  "Fall",
  "Gtwy",
  "Wls",
  "Clb",
  "Frk",
  "Cpe",
  "Fwy",
  "Knls",
  "Rdg",
  "Jct",
  "Rst",
  "Spgs",
  "Cir",
  "Crst",
  "Expy",
  "Smt",
  "Trfy",
  "Cors",
  "Land",
  "Uns",
  "Jcts",
  "Ways",
  "Trl",
  "Way",
  "Trlr",
  "Aly",
  "Spg",
  "Pkwy",
  "Cmn",
  "Dr",
  "Grns",
  "Oval",
  "Cirs",
  "Pt",
  "Shls",
  "Vly",
  "Hts",
  "Clf",
  "Flt",
  "Mall",
  "Frds",
  "Cyn",
  "Lndg",
  "Mdws",
  "Rd",
  "Xrds",
  "Ter",
  "Prt",
  "Radl",
  "Grvs",
  "Rdgs",
  "Inlt",
  "Trak",
  "Byu",
  "Vlgs",
  "Ctr",
  "Ml",
  "Cts",
  "Arc",
  "Bnd",
  "Riv",
  "Flds",
  "Mtwy",
  "Msn",
  "Shrs",
  "Rue",
  "Crse",
  "Cres",
  "Anx",
  "Drs",
  "Sts",
  "Holw",
  "Vlg",
  "Prts",
  "Sta",
  "Fld",
  "Xrd",
  "Wall",
  "Tpke",
  "Ft",
  "Bg",
  "Knl",
  "Plz",
  "St",
  "Cswy",
  "Bgs",
  "Rnch",
  "Frks",
  "Ln",
  "Mtn",
  "Ctrs",
  "Orch",
  "Iss",
  "Brks",
  "Br",
  "Fls",
  "Trce",
  "Park",
  "Gdns",
  "Rpds",
  "Shl",
  "Lf",
  "Rpd",
  "Lcks",
  "Gln",
  "Pl",
  "Path",
  "Vis",
  "Lks",
  "Run",
  "Frg",
  "Brg",
  "Sqs",
  "Xing",
  "Pln",
  "Glns",
  "Blfs",
  "Plns",
  "Dl",
  "Clfs",
  "Ext",
  "Pass",
  "Gdn",
  "Brk",
  "Grn",
  "Mnr",
  "Cp",
  "Pne",
  "Spur",
  "Opas",
  "Upas",
  "Tunl",
  "Sq",
  "Lck",
  "Ests",
  "Shr",
  "Dm",
  "Mls",
  "Wl",
  "Mnrs",
  "Stra",
  "Frgs",
  "Frst",
  "Flts",
  "Ct",
  "Mtns",
  "Frd",
  "Nck",
  "Ramp",
  "Vlys",
  "Pts",
  "Bch",
  "Loop",
  "Byp",
  "Cmns",
  "Fry",
  "Walk",
  "Hbrs",
  "Dv",
  "Hvn",
  "Blf",
  "Grv",
  "Crk",
]);

const STRUCTURED_ADDRESS_FIELDS = [
  "street_number",
  "street_name",
  "street_pre_directional_text",
  "street_post_directional_text",
  "street_suffix_type",
  "unit_identifier",
  "route_number",
  "block",
  "lot",
  "municipality_name",
  "city_name",
  "state_code",
  "postal_code",
  "plus_four_postal_code",
  "country_code",
];

const STRUCTURED_ADDRESS_REQUIRED_KEYS = [
  "street_number",
  "street_name",
  "city_name",
  "state_code",
  "postal_code",
];

const STRUCTURED_ADDRESS_OPTIONAL_KEYS = STRUCTURED_ADDRESS_FIELDS.filter(
  (key) => !STRUCTURED_ADDRESS_REQUIRED_KEYS.includes(key),
);

const ADDRESS_METADATA_KEYS = [
  "county_name",
  "latitude",
  "longitude",
  "township",
  "range",
  "section",
];

function normalizeUnnormalizedAddressValue(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => (typeof part === "string" ? textClean(part) : textClean(String(part ?? ""))))
      .filter((part) => part && part.length > 0);
    if (parts.length === 0) return null;
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    return joined.length > 0 ? joined : null;
  }
  if (typeof value === "object") {
    const preferredKeys = [
      "unnormalized_address",
      "full_address",
      "address",
      "line1",
      "line_1",
      "line2",
      "line_2",
      "line3",
      "line_3",
      "city",
      "state",
      "state_code",
      "postal_code",
      "zip",
      "zip_code",
    ];
    const seen = new Set();
    const parts = [];
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const rawPart = value[key];
      if (rawPart == null) continue;
      const cleaned =
        typeof rawPart === "string"
          ? textClean(rawPart)
          : textClean(String(rawPart));
      if (!cleaned) continue;
      const signature = `${key}:${cleaned}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      parts.push(cleaned);
    }
    if (parts.length > 0) {
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined.length > 0) return joined;
    }
    const fallback = textClean(String(value));
    return fallback && fallback.length > 0 ? fallback : null;
  }
  const fallback = textClean(String(value));
  return fallback && fallback.length > 0 ? fallback : null;
}

function buildFallbackUnnormalizedAddress(structuredValues) {
  if (!structuredValues || typeof structuredValues !== "object") return null;

  const normalizedPart = (value, transform = (v) => v) => {
    if (value == null) return null;
    const text = typeof value === "string" ? value.trim() : String(value).trim();
    if (!text) return null;
    return transform(text);
  };

  const line1Parts = [
    normalizedPart(structuredValues.street_number),
    normalizedPart(
      structuredValues.street_pre_directional_text,
      (v) => v.toUpperCase(),
    ),
    normalizedPart(structuredValues.street_name),
    normalizedPart(structuredValues.street_suffix_type, (v) => v),
    normalizedPart(structuredValues.unit_identifier),
  ].filter(Boolean);

  const line1 = line1Parts.join(" ").replace(/\s+/g, " ").trim();

  const cityStateZipParts = [];
  const city = normalizedPart(
    structuredValues.city_name,
    (v) => v.toUpperCase(),
  );
  if (city) cityStateZipParts.push(city);

  const state = normalizedPart(
    structuredValues.state_code,
    (v) => v.toUpperCase(),
  );
  if (state) cityStateZipParts.push(state);

  let postalSegment = normalizedPart(structuredValues.postal_code, (v) =>
    v.replace(/\s+/g, ""),
  );
  const plusFour = normalizedPart(
    structuredValues.plus_four_postal_code,
    (v) => v.replace(/\s+/g, ""),
  );
  if (postalSegment && plusFour) {
    postalSegment = `${postalSegment}-${plusFour}`;
  } else if (!postalSegment && plusFour) {
    postalSegment = plusFour;
  }
  if (postalSegment) cityStateZipParts.push(postalSegment);

  const line2 = cityStateZipParts.join(" ").replace(/\s+/g, " ").trim();

  const trailingParts = [
    normalizedPart(structuredValues.municipality_name),
    normalizedPart(structuredValues.route_number),
    normalizedPart(structuredValues.block),
    normalizedPart(structuredValues.lot),
  ].filter(Boolean);

  const segments = [];
  if (line1) segments.push(line1);
  if (line2) segments.push(line2);
  if (trailingParts.length) segments.push(trailingParts.join(" "));

  if (!segments.length) return null;

  const fallback = segments.join(", ").replace(/\s+/g, " ").trim();
  return fallback.length > 0 ? fallback : null;
}

function hasStructuredAddressFields(address) {
  if (!address || typeof address !== "object") return false;
  return STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = address[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function hasUnnormalizedAddressValue(address) {
  if (!address || typeof address !== "object") return false;
  const normalized = normalizeUnnormalizedAddressValue(
    address.unnormalized_address,
  );
  return typeof normalized === "string" && normalized.length > 0;
}

function reconcileAddressForSchema(address) {
  if (!address || typeof address !== "object") {
    return { hasStructured: false, hasUnnormalized: false };
  }

  const normalizeStructuredValue = (value) => {
    if (value == null) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    const normalized = normalizeStructuredValue(address[key]);
    if (normalized === null) {
      delete address[key];
    } else {
      address[key] = normalized;
    }
  }

  const normalizedUnnormalized = Object.prototype.hasOwnProperty.call(
    address,
    "unnormalized_address",
  )
    ? normalizeUnnormalizedAddressValue(address.unnormalized_address)
    : null;

  if (normalizedUnnormalized) {
    address.unnormalized_address = normalizedUnnormalized;
  } else if (
    Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
  ) {
    delete address.unnormalized_address;
  }

  let hasStructured = hasStructuredAddressFields(address);
  let hasUnnormalized = normalizedUnnormalized != null;

  if (hasStructured && hasUnnormalized) {
    delete address.unnormalized_address;
    hasUnnormalized = false;
  } else if (!hasStructured && hasUnnormalized) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(address, key)) {
        delete address[key];
      }
    }
  } else if (!hasStructured && !hasUnnormalized) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(address, key)) {
        delete address[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(address, "unnormalized_address")) {
      delete address.unnormalized_address;
    }
  }

  return {
    hasStructured: hasStructuredAddressFields(address),
    hasUnnormalized: hasUnnormalizedAddressValue(address),
  };
}

function pruneAddressFieldsForSchema(address, hasStructured, hasUnnormalized) {
  if (!address || typeof address !== "object") return;
  if (hasStructured) {
    if (Object.prototype.hasOwnProperty.call(address, "unnormalized_address")) {
      delete address.unnormalized_address;
    }
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
      const value = address[key];
      if (value == null) {
        delete address[key];
        continue;
      }
      if (typeof value === "string" && !value.trim()) {
        delete address[key];
      }
    }
  } else {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(address, key)) {
        delete address[key];
      }
    }
    if (
      !hasUnnormalized &&
      Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
    ) {
      delete address.unnormalized_address;
    }
  }
}

function finalizeAddressForSchema(address, preferredMode = null) {
  if (!address || typeof address !== "object") {
    return { mode: null, hasAddress: false };
  }

  const normalizedPreferred =
    preferredMode === "structured" ? "structured" : "unnormalized";

  const cleanupStructuredFields = () => {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
      const value = address[key];
      if (value == null) {
        delete address[key];
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          delete address[key];
        } else {
          address[key] = trimmed;
        }
        continue;
      }
      delete address[key];
    }
  };

  const dropStructuredFields = () => {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(address, key)) {
        delete address[key];
      }
    }
  };

  cleanupStructuredFields();

  let hasStructured = hasStructuredAddressFields(address);
  let hasUnnormalized = hasUnnormalizedAddressValue(address);

  const keepStructured = () => {
    if (
      Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
    ) {
      delete address.unnormalized_address;
    }
    cleanupStructuredFields();
    hasStructured = hasStructuredAddressFields(address);
    return {
      mode: hasStructured ? "structured" : null,
      hasAddress: hasStructured,
    };
  };

  const keepUnnormalized = () => {
    dropStructuredFields();
    if (
      Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
    ) {
      const normalized = normalizeUnnormalizedAddressValue(
        address.unnormalized_address,
      );
      if (normalized) {
        address.unnormalized_address = normalized;
      } else {
        delete address.unnormalized_address;
      }
    }
    hasUnnormalized = hasUnnormalizedAddressValue(address);
    return {
      mode: hasUnnormalized ? "unnormalized" : null,
      hasAddress: hasUnnormalized,
    };
  };

  if (normalizedPreferred === "structured" && hasStructured) {
    return keepStructured();
  }
  if (normalizedPreferred === "unnormalized" && hasUnnormalized) {
    return keepUnnormalized();
  }

  if (hasStructured && hasUnnormalized) {
    return normalizedPreferred === "structured"
      ? keepStructured()
      : keepUnnormalized();
  }
  if (hasStructured) {
    return keepStructured();
  }
  if (hasUnnormalized) {
    return keepUnnormalized();
  }

  dropStructuredFields();
  if (Object.prototype.hasOwnProperty.call(address, "unnormalized_address")) {
    delete address.unnormalized_address;
  }
  return { mode: null, hasAddress: false };
}

function stripStructuredAddressFields(address) {
  if (!address || typeof address !== "object") return;
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(address, key)) {
      delete address[key];
    }
  }
}

function removeUnnormalizedAddress(address) {
  if (
    address &&
    typeof address === "object" &&
    Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
  ) {
    delete address.unnormalized_address;
  }
}

function enforcePreferredAddressMode(address) {
  if (!address || typeof address !== "object") return null;
  const clone = { ...address };

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")
      ? clone.unnormalized_address
      : null,
  );

  if (normalizedUnnormalized) {
    stripStructuredAddressFields(clone);
    clone.unnormalized_address = normalizedUnnormalized;
    return clone;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = clone[key];
    if (typeof value === "string") return value.trim().length > 0;
    return value != null;
  });

  if (hasStructured) {
    removeUnnormalizedAddress(clone);
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(clone, key)) continue;
      const value = clone[key];
      if (value == null) {
        delete clone[key];
        continue;
      }
      if (typeof value === "string") {
        let cleaned = textClean(value);
        if (!cleaned) {
          delete clone[key];
          continue;
        }
        if (key === "city_name" || key === "state_code") {
          cleaned = cleaned.toUpperCase();
        } else if (key === "postal_code" || key === "plus_four_postal_code") {
          cleaned = cleaned.replace(/\s+/g, "");
        }
        clone[key] = cleaned;
      }
    }
    return clone;
  }

  return null;
}

function normalizeAddressForOutput(address, preferredMode = null) {
  const reconciliation = reconcileAddressForSchema(address);
  pruneAddressFieldsForSchema(
    address,
    reconciliation.hasStructured,
    reconciliation.hasUnnormalized,
  );
  const resolution = finalizeAddressForSchema(address, preferredMode);

  if (!resolution.hasAddress) {
    stripStructuredAddressFields(address);
    removeUnnormalizedAddress(address);
    return resolution;
  }

  if (resolution.mode === "structured") {
    removeUnnormalizedAddress(address);
  } else if (resolution.mode === "unnormalized") {
    stripStructuredAddressFields(address);
  }

  return resolution;
}

function buildAddressPayload(address, mode) {
  if (!address || typeof address !== "object") return null;
  if (mode !== "structured" && mode !== "unnormalized") return null;

  const payload = {
    request_identifier: address.request_identifier || null,
  };

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    const value = address[key];
    if (value == null) continue;
    payload[key] = value;
  }

  if (mode === "structured") {
    const hasAllRequired = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
      const value = address[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (!hasAllRequired) return null;

    for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
      payload[key] = address[key].trim();
    }

    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
      const value = address[key];
      if (value == null) continue;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) continue;
        payload[key] = trimmed;
      } else {
        payload[key] = value;
      }
    }

    return payload;
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    address.unnormalized_address,
  );
  if (!normalizedUnnormalized) return null;
  payload.unnormalized_address = normalizedUnnormalized;
  return payload;
}

function sanitizeAddressPayloadForOneOf(payload) {
  if (!payload || typeof payload !== "object") return null;

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = payload[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const rawUnnormalized = Object.prototype.hasOwnProperty.call(
    payload,
    "unnormalized_address",
  )
    ? payload.unnormalized_address
    : null;

  const hasUnnormalized =
    typeof rawUnnormalized === "string" && rawUnnormalized.trim().length > 0;

  if (hasStructured && hasUnnormalized) {
    delete payload.unnormalized_address;
    return payload;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const value = payload[key];
      if (value == null) {
        delete payload[key];
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          delete payload[key];
        } else {
          payload[key] = trimmed;
        }
      }
    }
    if (hasUnnormalized) {
      delete payload.unnormalized_address;
    }
    return payload;
  }

  if (hasUnnormalized) {
    const normalized = normalizeUnnormalizedAddressValue(rawUnnormalized);
    if (!normalized) return null;
    payload.unnormalized_address = normalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        delete payload[key];
      }
    }
    return payload;
  }

  return null;
}

function coerceAddressPayloadToOneOf(payload) {
  if (!payload || typeof payload !== "object") return null;

  const base = {};

  if (
    Object.prototype.hasOwnProperty.call(payload, "request_identifier") &&
    payload.request_identifier != null
  ) {
    const trimmed =
      typeof payload.request_identifier === "string"
        ? payload.request_identifier.trim()
        : payload.request_identifier;
    base.request_identifier = trimmed;
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = payload[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      base[key] = trimmed;
      continue;
    }
    base[key] = value;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = payload[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    payload.unnormalized_address,
  );
  const hasUnnormalized =
    typeof normalizedUnnormalized === "string" &&
    normalizedUnnormalized.length > 0;

  if (hasStructured) {
    const structured = {};
    for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
      structured[key] = payload[key].trim();
    }
    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const raw = payload[key];
      if (raw == null) continue;
      const text =
        typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
      if (!text) continue;
      structured[key] = text;
    }
    return { ...base, ...structured };
  }

  if (hasUnnormalized) {
    return { ...base, unnormalized_address: normalizedUnnormalized };
  }

  return null;
}

function enforceAddressOneOfCompliance(payload) {
  if (!payload || typeof payload !== "object") return null;

  const clone = { ...payload };

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = clone[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const hasUnnormalized =
    typeof clone.unnormalized_address === "string" &&
    clone.unnormalized_address.trim().length > 0;

  if (hasStructured && hasUnnormalized) {
    delete clone.unnormalized_address;
    return clone;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(clone, key)) continue;
      const value = clone[key];
      if (value == null) {
        delete clone[key];
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          delete clone[key];
        } else {
          clone[key] = trimmed;
        }
      }
    }
    delete clone.unnormalized_address;
    return clone;
  }

  if (hasUnnormalized) {
    const normalized = normalizeUnnormalizedAddressValue(
      clone.unnormalized_address,
    );
    if (!normalized) return null;
    clone.unnormalized_address = normalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    return clone;
  }

  return null;
}

function ensureExclusiveAddressMode(address) {
  if (!address || typeof address !== "object") return null;

  const clone = { ...address };
  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = clone[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    clone.unnormalized_address,
  );
  const hasUnnormalized =
    typeof normalizedUnnormalized === "string" &&
    normalizedUnnormalized.length > 0;

  if (hasStructured && hasUnnormalized) {
    delete clone.unnormalized_address;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(clone, key)) continue;
      const value = clone[key];
      if (value == null) {
        delete clone[key];
        continue;
      }
      if (typeof value === "string") {
        let trimmed = value.trim();
        if (!trimmed) {
          delete clone[key];
          continue;
        }
        if (key === "city_name" || key === "state_code") {
          trimmed = trimmed.toUpperCase();
        } else if (
          key === "postal_code" ||
          key === "plus_four_postal_code"
        ) {
          trimmed = trimmed.replace(/\s+/g, "");
        }
        clone[key] = trimmed;
      }
    }
    return clone;
  }

  if (hasStructured) {
    return clone;
  }

  if (hasUnnormalized) {
    clone.unnormalized_address = normalizedUnnormalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    return clone;
  }

  return null;
}

function coerceAddressToSingleMode(address, fallbackUnnormalized = null) {
  if (!address || typeof address !== "object") return null;

  const clone = deepClone(address);
  if (!clone || typeof clone !== "object") return null;

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")
      ? clone.unnormalized_address
      : null,
  );

  if (normalizedUnnormalized) {
    clone.unnormalized_address = normalizedUnnormalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    return clone;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(clone, key)) return false;
    const value = clone[key];
    if (value == null) return false;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return false;
      clone[key] = trimmed;
    }
    return true;
  });

  if (hasStructured) {
    if (Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")) {
      delete clone.unnormalized_address;
    }
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(clone, key)) continue;
      const value = clone[key];
      if (value == null) {
        delete clone[key];
      } else if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) clone[key] = trimmed;
        else delete clone[key];
      }
    }
    return clone;
  }

  const fallbackValue = normalizeUnnormalizedAddressValue(
    fallbackUnnormalized,
  );
  if (fallbackValue) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    clone.unnormalized_address = fallbackValue;
    return clone;
  }

  return null;
}

function enforceSingleAddressModeForWrite(
  payload,
  preferStructured = false,
) {
  if (!payload || typeof payload !== "object") return null;

  const working = deepClone(payload);
  if (!working || typeof working !== "object") return null;

  const normalizeStructuredField = (key, raw) => {
    if (raw == null) return null;
    let value =
      typeof raw === "string"
        ? raw.trim()
        : String(raw ?? "").trim();
    if (!value) return null;
    if (key === "city_name" || key === "state_code") {
      return value.toUpperCase();
    }
    if (key === "postal_code" || key === "plus_four_postal_code") {
      return value.replace(/\s+/g, "");
    }
    return value;
  };

  const structuredValues = {};
  let hasStructured = true;
  for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(working, key)) {
      hasStructured = false;
      break;
    }
    const normalized = normalizeStructuredField(key, working[key]);
    if (!normalized) {
      hasStructured = false;
      break;
    }
    structuredValues[key] = normalized;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(working, key)) continue;
      const normalized = normalizeStructuredField(key, working[key]);
      if (normalized) {
        structuredValues[key] = normalized;
      } else {
        delete structuredValues[key];
      }
    }
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(working, "unnormalized_address")
      ? working.unnormalized_address
      : null,
  );
  const hasUnnormalized =
    typeof normalizedUnnormalized === "string" &&
    normalizedUnnormalized.length > 0;

  let result = { ...working };

  if (hasStructured && hasUnnormalized) {
    if (preferStructured) {
      delete result.unnormalized_address;
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(structuredValues, key)) {
          result[key] = structuredValues[key];
        } else if (Object.prototype.hasOwnProperty.call(result, key)) {
          delete result[key];
        }
      }
      return result;
    }
    stripStructuredAddressFields(result);
    result.unnormalized_address = normalizedUnnormalized;
    return result;
  }

  if (hasStructured) {
    delete result.unnormalized_address;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(structuredValues, key)) {
        result[key] = structuredValues[key];
      } else if (Object.prototype.hasOwnProperty.call(result, key)) {
        delete result[key];
      }
    }
    return result;
  }

  if (hasUnnormalized) {
    stripStructuredAddressFields(result);
    result.unnormalized_address = normalizedUnnormalized;
    return result;
  }

  return null;
}

function projectAddressPayloadToSchema(
  address,
  {
    fallbackUnnormalized = null,
    structuredFallback = null,
    metadataSources = [],
    requestIdentifier = null,
  } = {},
) {
  const aggregatedSources = [];
  if (address && typeof address === "object") aggregatedSources.push(address);
  if (
    structuredFallback &&
    typeof structuredFallback === "object" &&
    structuredFallback !== address
  ) {
    aggregatedSources.push(structuredFallback);
  }
  if (metadataSources) {
    const list = Array.isArray(metadataSources)
      ? metadataSources
      : [metadataSources];
    for (const source of list) {
      if (
        source &&
        typeof source === "object" &&
        !aggregatedSources.includes(source)
      ) {
        aggregatedSources.push(source);
      }
    }
  }

  const metadata = {};
  let resolvedRequestIdentifier =
    requestIdentifier != null ? requestIdentifier : null;

  const assignRequestIdentifier = (value) => {
    if (value == null || resolvedRequestIdentifier != null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) resolvedRequestIdentifier = trimmed;
    } else {
      resolvedRequestIdentifier = value;
    }
  };

  const assignMetadata = (key, value) => {
    if (value == null) return;
    if (Object.prototype.hasOwnProperty.call(metadata, key)) return;
    if (typeof value === "string") {
      const cleaned = textClean(value);
      if (!cleaned) return;
      metadata[key] = cleaned;
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) metadata[key] = value;
      return;
    }
    metadata[key] = value;
  };

  for (const source of aggregatedSources) {
    if (!source || typeof source !== "object") continue;

    if (
      Object.prototype.hasOwnProperty.call(source, "request_identifier") &&
      resolvedRequestIdentifier == null
    ) {
      assignRequestIdentifier(source.request_identifier);
    }

    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      assignMetadata(key, source[key]);
    }
  }

  const unnormalizedCandidates = [];
  if (
    address &&
    typeof address === "object" &&
    Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
  ) {
    unnormalizedCandidates.push(address.unnormalized_address);
  }
  if (fallbackUnnormalized != null) {
    unnormalizedCandidates.push(fallbackUnnormalized);
  }

  let normalizedUnnormalized = null;
  for (const candidate of unnormalizedCandidates) {
    const normalized = normalizeUnnormalizedAddressValue(candidate);
    if (normalized) {
      normalizedUnnormalized = normalized;
      break;
    }
  }

  const structuredCandidates = [];
  if (address && typeof address === "object") {
    structuredCandidates.push(address);
  }
  if (
    structuredFallback &&
    typeof structuredFallback === "object" &&
    structuredFallback !== address
  ) {
    structuredCandidates.push(structuredFallback);
  }

  let structured = null;
  for (const candidate of structuredCandidates) {
    const normalized = pickStructuredAddress(candidate);
    if (normalized) {
      structured = normalized;
      break;
    }
  }

  const base = { ...metadata };
  if (resolvedRequestIdentifier != null) {
    if (typeof resolvedRequestIdentifier === "string") {
      const trimmed = resolvedRequestIdentifier.trim();
      if (trimmed) base.request_identifier = trimmed;
    } else {
      base.request_identifier = resolvedRequestIdentifier;
    }
  }

  if (normalizedUnnormalized) {
    const payload = {
      ...base,
      unnormalized_address: normalizedUnnormalized,
    };
    return ensureExclusiveAddressMode(payload) || payload;
  }

  if (structured) {
    const payload = {
      ...base,
      ...structured,
    };
    return ensureExclusiveAddressMode(payload) || payload;
  }

  return null;
}

function enforceAddressModePreference(address, fallbackUnnormalized = null) {
  if (!address || typeof address !== "object") return null;

  const clone = { ...address };

  const structuredSnapshot = {};
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clone, key)) {
      structuredSnapshot[key] = clone[key];
    }
  }

  const rawUnnormalized = Object.prototype.hasOwnProperty.call(
    clone,
    "unnormalized_address",
  )
    ? clone.unnormalized_address
    : null;

  let normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    rawUnnormalized,
  );
  if (!normalizedUnnormalized && typeof fallbackUnnormalized === "string") {
    normalizedUnnormalized = normalizeUnnormalizedAddressValue(
      fallbackUnnormalized,
    );
  }

  if (normalizedUnnormalized) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    clone.unnormalized_address = normalizedUnnormalized;
    return clone;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(structuredSnapshot, key)) {
      return false;
    }
    const value = structuredSnapshot[key];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value != null;
  });

  if (hasStructured) {
    if (
      Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")
    ) {
      delete clone.unnormalized_address;
    }
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structuredSnapshot, key)) {
        if (Object.prototype.hasOwnProperty.call(clone, key)) {
          delete clone[key];
        }
        continue;
      }
      const rawValue = structuredSnapshot[key];
      if (rawValue == null) {
        if (Object.prototype.hasOwnProperty.call(clone, key)) {
          delete clone[key];
        }
        continue;
      }
      if (typeof rawValue === "string") {
        const trimmed = rawValue.trim();
        if (!trimmed) {
          if (Object.prototype.hasOwnProperty.call(clone, key)) {
            delete clone[key];
          }
        } else {
          clone[key] = trimmed;
        }
      } else {
        clone[key] = rawValue;
      }
    }
    return clone;
  }

  const fallbackFromStructured = buildFallbackUnnormalizedAddress(
    structuredSnapshot,
  );
  const normalizedFallback = normalizeUnnormalizedAddressValue(
    fallbackFromStructured,
  );
  if (normalizedFallback) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    clone.unnormalized_address = normalizedFallback;
    return clone;
  }

  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clone, key)) {
      delete clone[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")) {
    delete clone.unnormalized_address;
  }

  return Object.keys(clone).length > 0 ? clone : null;
}

function finalizeResolvedAddressPayload(resolution, preferredMode = null) {
  if (!resolution || typeof resolution !== "object") return null;
  const rawPayload = resolution.payload;
  if (!rawPayload || typeof rawPayload !== "object") return null;

  const prefer =
    preferredMode === "structured" ? "structured" : "unnormalized";

  const attemptSanitized = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;
    const enforced =
      enforceAddressOneOfCompliance(candidate) ||
      sanitizeAddressPayloadForOneOf(candidate) ||
      coerceAddressPayloadToOneOf(candidate) ||
      ensureExclusiveAddressMode(candidate);
    return enforced && typeof enforced === "object" ? enforced : null;
  };

  const sanitized =
    attemptSanitized(rawPayload) || attemptSanitized(ensureExclusiveAddressMode(rawPayload));
  if (!sanitized) return null;

  const clone = deepClone(sanitized);
  if (!clone) return null;

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = clone[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    clone.unnormalized_address,
  );
  const hasUnnormalized =
    typeof normalizedUnnormalized === "string" &&
    normalizedUnnormalized.length > 0;

  if (hasStructured && hasUnnormalized) {
    if (prefer === "unnormalized") {
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(clone, key)) {
          delete clone[key];
        }
      }
      clone.unnormalized_address = normalizedUnnormalized;
      return { payload: clone, mode: "unnormalized" };
    }
    delete clone.unnormalized_address;
    return { payload: clone, mode: "structured" };
  }

  if (hasStructured) {
    if (
      Object.prototype.hasOwnProperty.call(clone, "unnormalized_address")
    ) {
      delete clone.unnormalized_address;
    }
    return { payload: clone, mode: "structured" };
  }

  if (hasUnnormalized) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
      }
    }
    clone.unnormalized_address = normalizedUnnormalized;
    return { payload: clone, mode: "unnormalized" };
  }

  return null;
}

function harmonizeAddressPayload(address) {
  if (!address || typeof address !== "object") {
    return null;
  }

  const clone = { ...address };

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = clone[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const hasUnnormalized =
    typeof clone.unnormalized_address === "string" &&
    clone.unnormalized_address.trim().length > 0;

  if (!hasStructured && !hasUnnormalized) {
    return null;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(clone, key)) continue;
      const value = clone[key];
      if (value == null) {
        delete clone[key];
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          delete clone[key];
          continue;
        }
        clone[key] = trimmed;
      }
    }
    if (hasUnnormalized) {
      delete clone.unnormalized_address;
    }
    return clone;
  }

  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clone, key)) {
      delete clone[key];
    }
  }
  clone.unnormalized_address = clone.unnormalized_address.trim().replace(/\s+/g, " ");
  return clone;
}

const STREET_SUFFIX_NORMALIZATION = {
  ALLEY: "Aly",
  ALY: "Aly",
  ANNEX: "Anx",
  ANX: "Anx",
  ARCADE: "Arc",
  ARC: "Arc",
  AVE: "Ave",
  AV: "Ave",
  AVENUE: "Ave",
  BAYOU: "Byu",
  BYP: "Byp",
  BYPASS: "Byp",
  BEACH: "Bch",
  BEND: "Bnd",
  BLUFFS: "Blfs",
  BLUFF: "Blf",
  BLVD: "Blvd",
  BOULEVARD: "Blvd",
  BOT: "Btm",
  BOTTOM: "Btm",
  BRANCH: "Br",
  BR: "Br",
  BRIDGE: "Brg",
  BRG: "Brg",
  BROOK: "Brk",
  BRK: "Brk",
  BROOKS: "Brks",
  BRKS: "Brks",
  CANYON: "Cyn",
  CANYN: "Cyn",
  CNYN: "Cyn",
  CAUSEWAY: "Cswy",
  CSWY: "Cswy",
  CENTER: "Ctr",
  CENTERS: "Ctrs",
  CTR: "Ctr",
  CTRS: "Ctrs",
  CIRCLE: "Cir",
  CIR: "Cir",
  CIRCLES: "Cirs",
  CIRS: "Cirs",
  CLIFF: "Clf",
  CLIFFS: "Clfs",
  CLFS: "Clfs",
  CLF: "Clf",
  CLUB: "Clb",
  COMMONS: "Cmns",
  COMMON: "Cmn",
  CMN: "Cmn",
  CORNERS: "Cors",
  CORNER: "Cor",
  COR: "Cor",
  COURSE: "Crse",
  COURT: "Ct",
  CRT: "Ct",
  COURTS: "Cts",
  CTS: "Cts",
  COVE: "Cv",
  CV: "Cv",
  COVES: "Cvs",
  CVS: "Cvs",
  CREEK: "Crk",
  CRK: "Crk",
  CRESCENT: "Cres",
  CRES: "Cres",
  CREST: "Crst",
  CROSSING: "Xing",
  XING: "Xing",
  CROSSROAD: "Xrd",
  XRDS: "Xrds",
  CURVE: "Curv",
  DALE: "Dl",
  DL: "Dl",
  DAM: "Dm",
  DIVIDE: "Dv",
  DV: "Dv",
  DRIVE: "Dr",
  DR: "Dr",
  DRIVES: "Drs",
  DRS: "Drs",
  ESTATE: "Est",
  ESTS: "Ests",
  ESTATES: "Ests",
  EXPRESSWAY: "Expy",
  EXPY: "Expy",
  EXTENSION: "Ext",
  EXTENSIONS: "Exts",
  FALL: "Fall",
  FALLS: "Fls",
  FERRY: "Fry",
  FRY: "Fry",
  FIELD: "Fld",
  FIELDS: "Flds",
  FLATS: "Flts",
  FLT: "Flt",
  FORGE: "Frg",
  FORGES: "Frgs",
  FORK: "Frk",
  FORKS: "Frks",
  FOREST: "Frst",
  FORT: "Ft",
  FRST: "Frst",
  FREEWAY: "Fwy",
  FWY: "Fwy",
  GARDEN: "Gdn",
  GARDENS: "Gdns",
  GATEWAY: "Gtwy",
  GLEN: "Gln",
  GLENS: "Glns",
  GREEN: "Grn",
  GREENS: "Grns",
  GROVE: "Grv",
  GROVES: "Grvs",
  HARBOR: "Hbr",
  HARBORS: "Hbrs",
  HAVEN: "Hvn",
  HEIGHTS: "Hts",
  HIGHWAY: "Hwy",
  HILL: "Hl",
  HILLS: "Hls",
  HOLLOW: "Holw",
  INLET: "Inlt",
  ISLAND: "Is",
  ISLANDS: "Iss",
  ISLES: "Isle",
  JUNCTION: "Jct",
  JUNCTIONS: "Jcts",
  KEYS: "Kys",
  KEY: "Ky",
  KNOLL: "Knl",
  KNOLLS: "Knls",
  LANDING: "Lndg",
  LANE: "Ln",
  LAKE: "Lk",
  LAKES: "Lks",
  LIGHT: "Lgt",
  LIGHTS: "Lgts",
  LOAF: "Lf",
  LOCK: "Lck",
  LOCKS: "Lcks",
  LODGE: "Ldg",
  LOOP: "Loop",
  MANOR: "Mnr",
  MANORS: "Mnrs",
  MEADOW: "Mdw",
  MEADOWS: "Mdws",
  MEWS: "Mews",
  MILL: "Ml",
  MILLS: "Mls",
  MISSION: "Msn",
  MOUNTAIN: "Mtn",
  MOUNTAINS: "Mtns",
  NECK: "Nck",
  ORCHARD: "Orch",
  OVAL: "Oval",
  PARK: "Park",
  PARKS: "Park",
  PARKWAY: "Pkwy",
  PARKWAYS: "Pkwy",
  PASS: "Pass",
  PASSAGE: "Psge",
  PATH: "Path",
  PIKE: "Pike",
  PINE: "Pne",
  PINES: "Pnes",
  PLACE: "Pl",
  PLAIN: "Pln",
  PLAINS: "Plns",
  PLAZA: "Plz",
  POINT: "Pt",
  POINTS: "Pts",
  PORT: "Prt",
  PORTS: "Prts",
  PRAIRIE: "Pr",
  RADIAL: "Radl",
  RAMP: "Ramp",
  RANCH: "Rnch",
  RAPID: "Rpd",
  RAPIDS: "Rpds",
  REST: "Rst",
  RIDGE: "Rdg",
  RIDGES: "Rdgs",
  RIVER: "Riv",
  ROAD: "Rd",
  ROADS: "Rds",
  ROUTE: "Rte",
  ROW: "Row",
  RUE: "Rue",
  RUN: "Run",
  SHOAL: "Shl",
  SHOALS: "Shls",
  SHORE: "Shr",
  SHORES: "Shrs",
  SKYWAY: "Skwy",
  SPRING: "Spg",
  SPRINGS: "Spgs",
  SPURS: "Spur",
  SQUARE: "Sq",
  SQUARES: "Sqs",
  STATION: "Sta",
  STRAVENUE: "Stra",
  STREAM: "Strm",
  STREET: "St",
  STREETS: "Sts",
  SUMMIT: "Smt",
  TERRACE: "Ter",
  TRACK: "Trak",
  TRAIL: "Trl",
  TRAILER: "Trlr",
  TUNNEL: "Tunl",
  TURNPIKE: "Tpke",
  UNDERPASS: "Upas",
  UNION: "Un",
  UNIONS: "Uns",
  VALLEY: "Vly",
  VALLEYS: "Vlys",
  VIADUCT: "Via",
  VIEW: "Vw",
  VIEWS: "Vws",
  VILLAGE: "Vlg",
  VILLAGES: "Vlgs",
  VILLE: "Vl",
  VISTA: "Vis",
  WALKS: "Walk",
  WALK: "Walk",
  WALL: "Wall",
  WAY: "Way",
  WAYS: "Ways",
  WELL: "Wl",
  WELLS: "Wls",
};

function normalizeStreetDirectional(value) {
  if (!value) return null;
  const cleaned = textClean(String(value));
  if (!cleaned) return null;
  const alpha = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!alpha) return null;
  const mapped = STREET_DIRECTION_MAP[alpha] || null;
  const finalVal = mapped || alpha;
  return STREET_DIRECTION_ALLOWED.has(finalVal) ? finalVal : null;
}

function normalizeStreetSuffix(value) {
  if (!value) return null;
  const cleaned = textClean(String(value));
  if (!cleaned) return null;
  const alpha = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  const mapped = STREET_SUFFIX_NORMALIZATION[alpha] || STREET_SUFFIX_NORMALIZATION[cleaned.toUpperCase()] || null;
  let candidate = mapped || null;
  if (!candidate && STREET_SUFFIX_ALLOWED.has(cleaned)) {
    candidate = cleaned;
  }
  if (!candidate) {
    const title =
      alpha.length > 0
        ? alpha.charAt(0) + alpha.slice(1).toLowerCase()
        : null;
    if (title && STREET_SUFFIX_ALLOWED.has(title)) {
      candidate = title;
    }
  }
  if (!candidate && STREET_SUFFIX_ALLOWED.has(alpha)) {
    candidate = alpha;
  }
  return candidate && STREET_SUFFIX_ALLOWED.has(candidate) ? candidate : null;
}

function pickStructuredAddress(candidate) {
