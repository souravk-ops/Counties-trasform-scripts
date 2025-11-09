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

    const toRefObject = (pathValue) =>
      pathValue ? { "/": pathValue } : null;

    if (typeof value === "string") {
      return toRefObject(normalizeStringPath(value));
    }

    if (value && typeof value === "object") {
      if (typeof value["/"] === "string") {
        return toRefObject(normalizeStringPath(value["/"]));
      }
      if (typeof value.path === "string") {
        return toRefObject(normalizeStringPath(value.path));
      }
      if (typeof value.ref === "string") {
        return toRefObject(normalizeStringPath(value.ref));
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
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(address, key)) {
        delete address[key];
      }
    }
    address.unnormalized_address = normalizedUnnormalized;
    hasStructured = false;
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

  if (hasStructured && hasUnnormalized) {
    return { ...base, unnormalized_address: normalizedUnnormalized };
  }

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
    clone.unnormalized_address = normalizedUnnormalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
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

function buildFinalAddressRecord(address, preferStructured = false) {
  if (!address || typeof address !== "object") return null;

  const source = deepClone(address);
  if (!source || typeof source !== "object") return null;

  const base = {};

  if (Object.prototype.hasOwnProperty.call(source, "request_identifier")) {
    const rawRequestId = source.request_identifier;
    if (rawRequestId != null) {
      if (typeof rawRequestId === "string") {
        const trimmed = rawRequestId.trim();
        if (trimmed) base.request_identifier = trimmed;
      } else {
        base.request_identifier = rawRequestId;
      }
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const rawValue = source[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      const cleaned = textClean(rawValue);
      if (!cleaned) continue;
      base[key] = cleaned;
    } else {
      base[key] = rawValue;
    }
  }

  const normalizeStructuredField = (key, raw) => {
    if (raw == null) return null;
    const value =
      typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
    if (!value) return null;
    if (key === "city_name" || key === "state_code") {
      return value.toUpperCase();
    }
    if (key === "postal_code" || key === "plus_four_postal_code") {
      return value.replace(/\s+/g, "");
    }
    return value;
  };

  const structured = {};
  let hasStructured = true;
  for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
    const normalized = normalizeStructuredField(key, source[key]);
    if (!normalized) {
      hasStructured = false;
      break;
    }
    structured[key] = normalized;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const normalized = normalizeStructuredField(key, source[key]);
      if (normalized) {
        structured[key] = normalized;
      }
    }
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(source, "unnormalized_address")
      ? source.unnormalized_address
      : null,
  );
  const hasUnnormalized =
    typeof normalizedUnnormalized === "string" &&
    normalizedUnnormalized.length > 0;

  const mergeWithBase = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (Object.keys(payload).length === 0) return null;
    return { ...base, ...payload };
  };

  if (preferStructured && hasStructured) {
    return mergeWithBase(structured);
  }

  if (hasUnnormalized && (!hasStructured || !preferStructured)) {
    return mergeWithBase({ unnormalized_address: normalizedUnnormalized });
  }

  if (hasStructured) {
    return mergeWithBase(structured);
  }

  if (hasUnnormalized) {
    return mergeWithBase({ unnormalized_address: normalizedUnnormalized });
  }

  return null;
}

function normalizeFinalAddressForWrite(address) {
  if (!address || typeof address !== "object") return null;
  const working = ensureExclusiveAddressMode(address);
  if (!working || typeof working !== "object") return null;

  if (hasUnnormalizedAddressValue(working)) {
    const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
      working.unnormalized_address,
    );
    if (!normalizedUnnormalized) return null;
    working.unnormalized_address = normalizedUnnormalized;
    stripStructuredAddressFields(working);
    return Object.keys(working).length > 0 ? working : null;
  }

  removeUnnormalizedAddress(working);
  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(working, key)) return false;
    const value = working[key];
    if (value == null) return false;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (key === "city_name" || key === "state_code") {
        working[key] = trimmed.toUpperCase();
      } else if (key === "postal_code" || key === "plus_four_postal_code") {
        working[key] = trimmed.replace(/\s+/g, "");
      } else {
        working[key] = trimmed;
      }
    }
    return true;
  });
  if (!hasStructured) return null;

  for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(working, key)) continue;
    const value = working[key];
    if (value == null) {
      delete working[key];
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        delete working[key];
        continue;
      }
      if (key === "city_name" || key === "state_code") {
        working[key] = trimmed.toUpperCase();
      } else if (key === "postal_code" || key === "plus_four_postal_code") {
        working[key] = trimmed.replace(/\s+/g, "");
      } else {
        working[key] = trimmed;
      }
    }
  }

  return Object.keys(working).length > 0 ? working : null;
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

function sanitizeStructuredAddressCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const sanitized = {};

  for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      return null;
    }
    let value = candidate[key];
    if (value == null) return null;
    if (typeof value !== "string") value = String(value);
    let trimmed = value.trim();
    if (!trimmed) return null;

    switch (key) {
      case "city_name":
        trimmed = normalizeCityName(trimmed);
        if (!trimmed) return null;
        break;
      case "state_code":
        trimmed = trimmed.slice(0, 2).toUpperCase();
        if (trimmed.length !== 2) return null;
        break;
      case "postal_code": {
        const postal = sanitizePostalCode(trimmed);
        if (!postal) return null;
        trimmed = postal;
        break;
      }
      default:
        trimmed = textClean(trimmed);
        if (!trimmed) return null;
    }

    sanitized[key] = trimmed;
  }

  for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
    let value = candidate[key];
    if (value == null) continue;
    if (typeof value !== "string") value = String(value);
    let trimmed = value.trim();
    if (!trimmed) continue;

    switch (key) {
      case "city_name":
        trimmed = normalizeCityName(trimmed);
        break;
      case "state_code":
        trimmed = trimmed.slice(0, 2).toUpperCase();
        break;
      case "postal_code":
        trimmed = sanitizePostalCode(trimmed) || "";
        break;
      case "plus_four_postal_code":
        trimmed = sanitizePlusFour(trimmed) || "";
        break;
      case "street_pre_directional_text":
      case "street_post_directional_text":
        trimmed = normalizeStreetDirectional(trimmed) || "";
        break;
      case "street_suffix_type":
        trimmed = normalizeStreetSuffix(trimmed) || "";
        break;
      default:
        trimmed = textClean(trimmed);
    }

    if (!trimmed) continue;
    sanitized[key] = trimmed;
  }

  if (!sanitized.country_code) {
    sanitized.country_code = "US";
  }

  return sanitized;
}

function buildBasicAddressRecord({
  structuredSources = [],
  unnormalizedCandidates = [],
  metadata = [],
  requestIdentifier = null,
} = {}) {
  const base = {};

  if (requestIdentifier != null) {
    if (typeof requestIdentifier === "string") {
      const trimmed = requestIdentifier.trim();
      if (trimmed) base.request_identifier = trimmed;
    } else {
      base.request_identifier = requestIdentifier;
    }
  }

  const metadataSources = Array.isArray(metadata) ? metadata : [metadata];
  for (const source of metadataSources) {
    if (!source || typeof source !== "object") continue;
    for (const key of ADDRESS_METADATA_KEYS) {
      if (base[key] != null) continue;
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value == null) continue;
      if (typeof value === "number") {
        if (Number.isFinite(value)) base[key] = value;
        continue;
      }
      if (typeof value === "string") {
        const cleaned = textClean(value);
        if (cleaned) base[key] = cleaned;
        continue;
      }
      base[key] = value;
    }
  }

  const structuredList = Array.isArray(structuredSources)
    ? structuredSources
    : [structuredSources];

  for (const source of structuredList) {
    const sanitized = sanitizeStructuredAddressCandidate(source);
    if (sanitized) {
      return { ...base, ...sanitized };
    }
  }

  const unnormalizedList = Array.isArray(unnormalizedCandidates)
    ? unnormalizedCandidates
    : [unnormalizedCandidates];

  for (const candidate of unnormalizedList) {
    const normalized = normalizeUnnormalizedAddressValue(candidate);
    if (normalized) {
      return {
        ...base,
        unnormalized_address: normalized,
      };
    }
  }

  return null;
}

function pickStructuredAddress(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const streetNumber = textClean(candidate.street_number);
  const streetName = textClean(candidate.street_name);
  const cityName = textClean(candidate.city_name);
  const stateCodeRaw = textClean(candidate.state_code);
  const postalCodeRaw = textClean(candidate.postal_code);
  const postalCode = sanitizePostalCode(postalCodeRaw);
  if (
    !streetNumber ||
    !streetName ||
    !cityName ||
    !stateCodeRaw ||
    !postalCode
  ) {
    return null;
  }

  const structured = {
    street_number: streetNumber,
    street_name: streetName,
    city_name: normalizeCityName(cityName),
    state_code: stateCodeRaw.slice(0, 2).toUpperCase(),
    postal_code: postalCode,
    country_code: candidate.country_code
      ? String(candidate.country_code).trim().toUpperCase()
      : "US",
  };

  const plusFour = sanitizePlusFour(candidate.plus_four_postal_code);
  if (plusFour) structured.plus_four_postal_code = plusFour;

  const preDir = normalizeStreetDirectional(
    candidate.street_pre_directional_text,
  );
  if (preDir) structured.street_pre_directional_text = preDir;

  const postDir = normalizeStreetDirectional(
    candidate.street_post_directional_text,
  );
  if (postDir) structured.street_post_directional_text = postDir;

  const suffix = normalizeStreetSuffix(candidate.street_suffix_type);
  if (suffix) structured.street_suffix_type = suffix;

  const spreadKeys = [
    "unit_identifier",
    "route_number",
    "block",
    "lot",
    "municipality_name",
  ];
  for (const key of spreadKeys) {
    const val = candidate[key];
    if (val != null) {
      const cleaned = textClean(String(val));
      if (cleaned) structured[key] = cleaned;
    }
  }

  return structured;
}

function selectStructuredAddressCandidate(structuredSources) {
  if (!Array.isArray(structuredSources)) return null;
  for (const candidate of structuredSources) {
    if (!candidate || typeof candidate !== "object") continue;
    const structured = pickStructuredAddress(candidate);
    if (structured) return structured;
  }
  return null;
}

function selectUnnormalizedAddressCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const normalized = normalizeUnnormalizedAddressValue(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function collectAddressMetadata(metadataSources) {
  if (!Array.isArray(metadataSources)) return {};
  const metadata = {};
  for (const source of metadataSources) {
    if (!source || typeof source !== "object") continue;
    for (const key of ADDRESS_METADATA_KEYS) {
      if (metadata[key] != null) continue;
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value == null) continue;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) metadata[key] = trimmed;
      } else {
        metadata[key] = value;
      }
    }
  }
  return metadata;
}

function resolveAddressRequestIdentifier(...sources) {
  const queue = [];
  for (const source of sources) {
    if (source == null) continue;
    if (Array.isArray(source)) {
      for (const nested of source) queue.push(nested);
    } else {
      queue.push(source);
    }
  }

  for (const candidate of queue) {
    if (candidate == null) continue;
    let value = null;
    if (typeof candidate === "object") {
      if (Object.prototype.hasOwnProperty.call(candidate, "request_identifier")) {
        value = candidate.request_identifier;
      } else if (
        Object.prototype.hasOwnProperty.call(candidate, "requestIdentifier")
      ) {
        value = candidate.requestIdentifier;
      }
    } else {
      value = candidate;
    }
    if (value == null) continue;
    const normalized = textClean(String(value));
    if (normalized) return normalized;
  }
  return null;
}

function buildSchemaCompliantAddressOutput({
  structuredSources = [],
  unnormalizedCandidates = [],
  metadataSources = [],
  requestIdentifier = null,
  preferStructured = false,
} = {}) {
  const structured = selectStructuredAddressCandidate(
    Array.isArray(structuredSources) ? structuredSources : [structuredSources],
  );
  const unnormalized = selectUnnormalizedAddressCandidate(
    Array.isArray(unnormalizedCandidates)
      ? unnormalizedCandidates
      : [unnormalizedCandidates],
  );

  let mode = null;
  if (structured && (preferStructured || !unnormalized)) {
    mode = "structured";
  } else if (unnormalized) {
    mode = "unnormalized";
  } else if (structured) {
    mode = "structured";
  } else {
    return null;
  }

  const output = {
    ...collectAddressMetadata(
      Array.isArray(metadataSources) ? metadataSources : [metadataSources],
    ),
  };

  if (mode === "structured") {
    const sanitized = { ...structured };
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
      let value = sanitized[key];
      if (value == null) {
        delete sanitized[key];
        continue;
      }
      if (typeof value !== "string") value = String(value);
      let trimmed = value.trim();
      if (!trimmed) {
        delete sanitized[key];
        continue;
      }

      switch (key) {
        case "city_name":
          sanitized[key] = normalizeCityName(trimmed);
          break;
        case "state_code":
          sanitized[key] = trimmed.slice(0, 2).toUpperCase();
          break;
        case "postal_code": {
          const zip = sanitizePostalCode(trimmed);
          if (!zip) return null;
          sanitized[key] = zip;
          break;
        }
        case "plus_four_postal_code": {
          const plusFour = sanitizePlusFour(trimmed);
          if (plusFour) sanitized[key] = plusFour;
          else delete sanitized[key];
          break;
        }
        case "street_pre_directional_text":
        case "street_post_directional_text": {
          const dir = normalizeStreetDirectional(trimmed);
          if (dir) sanitized[key] = dir;
          else delete sanitized[key];
          break;
        }
        case "street_suffix_type": {
          const suffix = normalizeStreetSuffix(trimmed);
          if (suffix) sanitized[key] = suffix;
          else delete sanitized[key];
          break;
        }
        default:
          sanitized[key] = trimmed;
      }
    }

    const hasAllRequired = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
      const value = sanitized[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (!hasAllRequired) return null;

    if (!sanitized.country_code) sanitized.country_code = "US";

    Object.assign(output, sanitized);
  } else {
    output.unnormalized_address = unnormalized;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(output, key)) {
        delete output[key];
      }
    }
  }

  const resolvedRequestId = resolveAddressRequestIdentifier(
    requestIdentifier,
    structuredSources,
    unnormalizedCandidates,
    metadataSources,
  );
  if (resolvedRequestId) {
    output.request_identifier = resolvedRequestId;
  }

  return Object.keys(output).length > 0 ? output : null;
}

function buildAddressRecord({
  structuredAddress = null,
  unnormalizedValue = null,
  metadata = {},
  requestIdentifier = null,
  preferMode = "unnormalized",
}) {
  const payload = {};

  assignIfValue(payload, "request_identifier", requestIdentifier);

  if (metadata && typeof metadata === "object") {
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
      assignIfValue(payload, key, metadata[key]);
    }
  }

  const structuredCandidate =
    structuredAddress && typeof structuredAddress === "object"
      ? pickStructuredAddress(structuredAddress)
      : null;

  const hasStructured =
    structuredCandidate &&
    STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
      const value = structuredCandidate[key];
      return typeof value === "string" && value.trim().length > 0;
    });

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    unnormalizedValue,
  );

  if (preferMode === "structured" && hasStructured) {
    for (const [key, value] of Object.entries(structuredCandidate)) {
      assignIfValue(payload, key, value);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "unnormalized_address")) {
      delete payload.unnormalized_address;
    }
    return payload;
  }

  if (normalizedUnnormalized) {
    payload.unnormalized_address = normalizedUnnormalized;
    return payload;
  }

  if (hasStructured) {
    for (const [key, value] of Object.entries(structuredCandidate)) {
      assignIfValue(payload, key, value);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "unnormalized_address")) {
      delete payload.unnormalized_address;
    }
    return payload;
  }

  return null;
}

function createAddressPayload({
  structuredSource = null,
  unnormalizedValue = null,
  metadata = {},
  requestIdentifier = null,
  preferStructured = true,
} = {}) {
  const base = {};

  assignIfValue(base, "request_identifier", requestIdentifier);

  if (metadata && typeof metadata === "object") {
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
      assignIfValue(base, key, metadata[key]);
    }
  }

  const structuredCandidate = structuredSource
    ? pickStructuredAddress(structuredSource)
    : null;
  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    unnormalizedValue,
  );

  let payload = null;
  if (
    structuredCandidate &&
    (preferStructured || !normalizedUnnormalized)
  ) {
    payload = { ...base, ...structuredCandidate };
  } else if (normalizedUnnormalized) {
    payload = { ...base, unnormalized_address: normalizedUnnormalized };
  } else if (structuredCandidate) {
    payload = { ...base, ...structuredCandidate };
  }

  if (!payload) return null;

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) =>
    Object.prototype.hasOwnProperty.call(payload, key),
  );
  const hasUnnormalized = Object.prototype.hasOwnProperty.call(
    payload,
    "unnormalized_address",
  );

  if (hasStructured && hasUnnormalized) {
    if (normalizedUnnormalized) {
      payload.unnormalized_address = normalizedUnnormalized;
    }
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        delete payload[key];
      }
    }
    return payload;
  }

  if (hasStructured) return payload;
  if (hasUnnormalized) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        delete payload[key];
      }
    }
    return payload;
  }

  return null;
}

function resolveAddressForOutput(candidate, preferredMode = null) {
  if (!candidate || typeof candidate !== "object") return null;

  const attempts = [];
  const enqueueAttempt = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const clone = deepClone(payload);
    if (!clone) return;
    attempts.push(clone);
  };

  enqueueAttempt(candidate);

  const sanitized = sanitizeAddressPayloadForOneOf(deepClone(candidate));
  if (sanitized) enqueueAttempt(sanitized);

  const enforced = enforceAddressOneOfCompliance(deepClone(candidate));
  if (enforced) enqueueAttempt(enforced);

  const coerced = coerceAddressPayloadToOneOf(deepClone(candidate));
  if (coerced) enqueueAttempt(coerced);

  for (const attempt of attempts) {
    const working = deepClone(attempt);
    if (!working) continue;
    const resolution = normalizeAddressForOutput(working, preferredMode);
    if (resolution && resolution.hasAddress && resolution.mode) {
      let payloadCandidate = ensureExclusiveAddressMode(working);
      if (!payloadCandidate) continue;

      const primarySanitized = sanitizeAddressPayloadForOneOf({
        ...payloadCandidate,
      });
      if (primarySanitized) {
        payloadCandidate = primarySanitized;
      } else {
        const enforced = enforceAddressOneOfCompliance(payloadCandidate);
        if (enforced) {
          payloadCandidate = enforced;
        }
      }

      payloadCandidate = ensureExclusiveAddressMode(payloadCandidate);
      if (!payloadCandidate) continue;

      return {
        payload: payloadCandidate,
        mode: resolution.mode,
      };
    }
  }

  return null;
}

function prepareAddressPayloadForWrite(resolution) {
  if (!resolution || typeof resolution !== "object") return null;
  const { payload, mode } = resolution;
  if (!payload || typeof payload !== "object") return null;
  if (mode !== "structured" && mode !== "unnormalized") return null;

  const metadata = {};
  if (
    Object.prototype.hasOwnProperty.call(payload, "request_identifier") &&
    payload.request_identifier != null
  ) {
    const rawRequestId = payload.request_identifier;
    if (typeof rawRequestId === "string") {
      const cleaned = rawRequestId.trim();
      if (cleaned) metadata.request_identifier = cleaned;
    } else {
      metadata.request_identifier = rawRequestId;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, "request_identifier") &&
    payload.request_identifier != null
  ) {
    const raw = payload.request_identifier;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) metadata.request_identifier = trimmed;
    } else {
      metadata.request_identifier = raw;
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = payload[key];
    if (value == null) continue;
    if (typeof value === "string") {
      const cleaned = textClean(value);
      if (!cleaned) continue;
      metadata[key] = cleaned;
    } else {
      metadata[key] = value;
    }
  }

  if (mode === "structured") {
    const normalizedStructured = pickStructuredAddress(payload);
    if (!normalizedStructured) return null;
    return { ...metadata, ...normalizedStructured };
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    payload.unnormalized_address,
  );
  if (!normalizedUnnormalized) return null;

  return {
    ...metadata,
    unnormalized_address: normalizedUnnormalized,
  };
}

function buildSchemaCompliantAddress(payload, fallbackUnnormalized = null) {
  if (!payload || typeof payload !== "object") return null;

  const metadata = {};
  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const rawValue = payload[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      const cleaned = textClean(rawValue);
      if (!cleaned) continue;
      metadata[key] = cleaned;
    } else {
      metadata[key] = rawValue;
    }
  }

  const structured = {};
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    let value = payload[key];
    if (value == null) continue;
    if (typeof value === "string") {
      let cleaned = textClean(value);
      if (!cleaned) continue;
      if (key === "city_name") cleaned = cleaned.toUpperCase();
      if (key === "state_code") cleaned = cleaned.toUpperCase();
      if (key === "postal_code" || key === "plus_four_postal_code") {
        cleaned = cleaned.replace(/\s+/g, "");
      }
      value = cleaned;
    }
    structured[key] = value;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(structured, key)) return false;
    const value = structured[key];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value != null;
  });

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    payload.unnormalized_address,
  );
  const fallbackNormalized =
    !normalizedUnnormalized && typeof fallbackUnnormalized === "string"
      ? normalizeUnnormalizedAddressValue(fallbackUnnormalized)
      : null;

  if (hasStructured) {
    const out = { ...metadata };
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structured, key)) continue;
      out[key] = structured[key];
    }
    return out;
  }

  if (normalizedUnnormalized || fallbackNormalized) {
    return {
      ...metadata,
      unnormalized_address: normalizedUnnormalized || fallbackNormalized,
    };
  }

  if (Object.keys(structured).length > 0) {
    const fallback = buildFallbackUnnormalizedAddress(structured);
    const normalizedFallback = normalizeUnnormalizedAddressValue(fallback);
    if (normalizedFallback) {
      return {
        ...metadata,
        unnormalized_address: normalizedFallback,
      };
    }
  }

  return null;
}

function finalizeAddressOutputForSchema(address, fallbackUnnormalized = null) {
  if (!address || typeof address !== "object") return null;

  const base = {};

  if (Object.prototype.hasOwnProperty.call(address, "request_identifier")) {
    const rawRequestId = address.request_identifier;
    if (rawRequestId != null) {
      if (typeof rawRequestId === "string") {
        const trimmed = rawRequestId.trim();
        if (trimmed) base.request_identifier = trimmed;
      } else {
        base.request_identifier = rawRequestId;
      }
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    const value = address[key];
    if (value == null) continue;
    if (typeof value === "string") {
      const cleaned = textClean(value);
      if (!cleaned) continue;
      base[key] = cleaned;
    } else {
      base[key] = value;
    }
  }

  const rawUnnormalized = Object.prototype.hasOwnProperty.call(
    address,
    "unnormalized_address",
  )
    ? address.unnormalized_address
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
    return {
      ...base,
      unnormalized_address: normalizedUnnormalized,
    };
  }

  const structuredCandidate = pickStructuredAddress(address);
  if (structuredCandidate) {
    const structuredOut = {};
    for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
      structuredOut[key] = structuredCandidate[key];
    }
    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(structuredCandidate, key)) {
        structuredOut[key] = structuredCandidate[key];
      }
    }
    return {
      ...base,
      ...structuredOut,
    };
  }

  return null;
}

function enforceAddressOneOfForWrite(address, preferMode = "unnormalized") {
  if (!address || typeof address !== "object") return null;

  const sanitized = deepClone(address);
  if (!sanitized || typeof sanitized !== "object") return null;

  const normalizeCommonValue = (value) => {
    if (value == null) return null;
    if (typeof value === "string") {
      const cleaned = textClean(value);
      return cleaned || null;
    }
    return value;
  };

  if (Object.prototype.hasOwnProperty.call(sanitized, "request_identifier")) {
    const normalizedRequestId = normalizeCommonValue(
      sanitized.request_identifier,
    );
    if (normalizedRequestId == null) {
      delete sanitized.request_identifier;
    } else {
      sanitized.request_identifier = normalizedRequestId;
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
    const normalizedMeta = normalizeCommonValue(sanitized[key]);
    if (normalizedMeta == null) {
      delete sanitized[key];
    } else {
      sanitized[key] = normalizedMeta;
    }
  }

  const normalizeStructuredValue = (key, value) => {
    if (value == null) return null;
    if (typeof value === "string") {
      let cleaned = textClean(value);
      if (!cleaned) return null;
      if (key === "city_name" || key === "state_code") {
        cleaned = cleaned.toUpperCase();
      }
      if (key === "postal_code" || key === "plus_four_postal_code") {
        cleaned = cleaned.replace(/\s+/g, "");
      }
      return cleaned;
    }
    return value;
  };

  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
    const normalized = normalizeStructuredValue(key, sanitized[key]);
    if (normalized == null) {
      delete sanitized[key];
    } else {
      sanitized[key] = normalized;
    }
  }

  const structuredSnapshot = {};
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
    structuredSnapshot[key] = sanitized[key];
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(sanitized, "unnormalized_address")
      ? sanitized.unnormalized_address
      : null,
  );
  if (normalizedUnnormalized) {
    sanitized.unnormalized_address = normalizedUnnormalized;
  } else {
    delete sanitized.unnormalized_address;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(structuredSnapshot, key)) {
      return false;
    }
    const value = structuredSnapshot[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const preferStructured =
    typeof preferMode === "string" && preferMode.toLowerCase() === "structured";

  if (preferStructured && hasStructured) {
    delete sanitized.unnormalized_address;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structuredSnapshot, key)) {
        delete sanitized[key];
        continue;
      }
      const value = structuredSnapshot[key];
      if (value == null) {
        delete sanitized[key];
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          delete sanitized[key];
        } else if (key === "city_name" || key === "state_code") {
          sanitized[key] = trimmed.toUpperCase();
        } else if (key === "postal_code" || key === "plus_four_postal_code") {
          sanitized[key] = trimmed.replace(/\s+/g, "");
        } else {
          sanitized[key] = trimmed;
        }
      }
    }
    return sanitized;
  }

  if (normalizedUnnormalized) {
    stripStructuredAddressFields(sanitized);
    sanitized.unnormalized_address = normalizedUnnormalized;
    return sanitized;
  }

  if (hasStructured) {
    delete sanitized.unnormalized_address;
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structuredSnapshot, key)) {
        delete sanitized[key];
      }
    }
    return sanitized;
  }

  const fallbackUnnormalized = buildFallbackUnnormalizedAddress(
    structuredSnapshot,
  );
  const normalizedFallback =
    normalizeUnnormalizedAddressValue(fallbackUnnormalized);
  if (normalizedFallback) {
    stripStructuredAddressFields(sanitized);
    sanitized.unnormalized_address = normalizedFallback;
    return sanitized;
  }

  stripStructuredAddressFields(sanitized);
  delete sanitized.unnormalized_address;
  return null;
}

async function enforceAddressFileOneOf(
  fileName,
  preferMode = "unnormalized",
) {
  if (!fileName || typeof fileName !== "string") return null;
  const normalizedMode =
    typeof preferMode === "string" &&
    preferMode.toLowerCase() === "structured"
      ? "structured"
      : "unnormalized";

  const filePath = path.join("data", fileName);
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const sanitized =
    enforceAddressOneOfForWrite(parsed, normalizedMode) ||
    enforceAddressOneOfForWrite(
      parsed,
      normalizedMode === "structured" ? "unnormalized" : "structured",
    ) ||
    ensureExclusiveAddressMode(parsed);

  if (!sanitized || typeof sanitized !== "object") {
    return null;
  }

  const fallbackUnnormalized =
    normalizedMode === "structured"
      ? null
      : normalizeUnnormalizedAddressValue(sanitized.unnormalized_address);

  const normalizedPayload =
    coerceAddressToSingleMode(sanitized, fallbackUnnormalized) || sanitized;

  const finalPayload =
    sanitizeAddressForSchema(normalizedPayload, normalizedMode) ||
    enforceAddressOneOfForWrite(normalizedPayload, normalizedMode);

  if (!finalPayload || typeof finalPayload !== "object") {
    return null;
  }

  await fsp.writeFile(
    filePath,
    JSON.stringify(finalPayload, null, 2),
  );
  return finalPayload;
}

async function enforceAddressOutputMode(
  fileName,
  preferStructured = false,
  fallbackUnnormalized = null,
) {
  if (!fileName || typeof fileName !== "string") return null;
  const filePath = path.join("data", fileName);

  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const metadata = {};

  if (Object.prototype.hasOwnProperty.call(parsed, "request_identifier")) {
    const requestId = parsed.request_identifier;
    if (requestId != null) {
      if (typeof requestId === "string") {
        const trimmed = requestId.trim();
        if (trimmed) metadata.request_identifier = trimmed;
      } else {
        metadata.request_identifier = requestId;
      }
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const value = parsed[key];
    if (value == null) continue;
    if (typeof value === "string") {
      const cleaned = textClean(value);
      if (!cleaned) continue;
      metadata[key] = cleaned;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      metadata[key] = value;
    } else {
      metadata[key] = value;
    }
  }

  const structuredCandidate = sanitizeStructuredAddressCandidate(parsed);
  const normalizedUnnormalized =
    normalizeUnnormalizedAddressValue(parsed.unnormalized_address) ||
    normalizeUnnormalizedAddressValue(fallbackUnnormalized);

  const preferStructuredMode = Boolean(preferStructured);

  let output = { ...metadata };
  if (preferStructuredMode && structuredCandidate) {
    output = { ...output, ...structuredCandidate };
  } else if (!preferStructuredMode && normalizedUnnormalized) {
    output.unnormalized_address = normalizedUnnormalized;
  } else if (!preferStructuredMode && structuredCandidate && !normalizedUnnormalized) {
    output = { ...output, ...structuredCandidate };
  } else if (normalizedUnnormalized) {
    output.unnormalized_address = normalizedUnnormalized;
  } else if (structuredCandidate) {
    output = { ...output, ...structuredCandidate };
  } else {
    await fsp.unlink(filePath).catch(() => {});
    return null;
  }

  await fsp.writeFile(filePath, JSON.stringify(output, null, 2));
  return output;
}

async function enforceAddressPreferredDataMode(fileName) {
  if (!fileName || typeof fileName !== "string") return null;
  const filePath = path.join("data", fileName);

  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const updated = { ...parsed };
  const hasUnnormalized =
    Object.prototype.hasOwnProperty.call(updated, "unnormalized_address") &&
    updated.unnormalized_address != null &&
    String(updated.unnormalized_address).trim();

  if (hasUnnormalized) {
    const normalized = normalizeUnnormalizedAddressValue(
      updated.unnormalized_address,
    );
    if (normalized) {
      updated.unnormalized_address = normalized;
      stripStructuredAddressFields(updated);
    } else {
      delete updated.unnormalized_address;
      stripStructuredAddressFields(updated);
    }
  } else {
    let hasStructured = true;
    for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(updated, key)) {
        hasStructured = false;
        break;
      }
      const value = updated[key];
      if (value == null) {
        hasStructured = false;
        break;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          hasStructured = false;
          break;
        }
        if (key === "city_name" || key === "state_code") {
          updated[key] = trimmed.toUpperCase();
        } else if (key === "postal_code" || key === "plus_four_postal_code") {
          updated[key] = trimmed.replace(/\s+/g, "");
        } else {
          updated[key] = trimmed;
        }
      }
    }

    if (!hasStructured) {
      stripStructuredAddressFields(updated);
    }
  }

  await fsp.writeFile(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

function sanitizeAddressForSchema(address, preferMode = "unnormalized") {
  if (!address || typeof address !== "object") return null;

  const normalized =
    enforceAddressOneOfForWrite(address, preferMode) ||
    ensureExclusiveAddressMode(address);
  if (!normalized || typeof normalized !== "object") return null;

  const result = {};

  const assignRequestIdentifier = (value) => {
    if (value == null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || null;
    }
    return value;
  };

  const normalizedRequestId = assignRequestIdentifier(
    normalized.request_identifier,
  );
  if (normalizedRequestId != null) {
    result.request_identifier = normalizedRequestId;
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
    const rawValue = normalized[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      const cleaned = textClean(rawValue);
      if (!cleaned) continue;
      result[key] = cleaned;
    } else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) continue;
      result[key] = rawValue;
    } else {
      result[key] = rawValue;
    }
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(normalized, "unnormalized_address")
      ? normalized.unnormalized_address
      : null,
  );

  const structuredValues = {};
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
    const rawValue = normalized[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      let cleaned = textClean(rawValue);
      if (!cleaned) continue;
      if (key === "city_name" || key === "state_code") {
        cleaned = cleaned.toUpperCase();
      } else if (key === "postal_code" || key === "plus_four_postal_code") {
        cleaned = cleaned.replace(/\s+/g, "");
      }
      structuredValues[key] = cleaned;
    } else {
      structuredValues[key] = rawValue;
    }
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = structuredValues[key];
    if (typeof value === "string") return value.trim().length > 0;
    return value != null;
  });

  if (normalizedUnnormalized) {
    return {
      ...result,
      unnormalized_address: normalizedUnnormalized,
    };
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structuredValues, key)) continue;
      const value = structuredValues[key];
      if (value == null) continue;
      result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}

function finalizeAddressPayloadForWrite(payload) {
  if (!payload || typeof payload !== "object") return null;

  const hasUnnormalized = hasUnnormalizedAddressValue(payload);
  const preferMode = hasUnnormalized ? "unnormalized" : "structured";

  const attempts = [
    sanitizeAddressForSchema(payload, preferMode),
    sanitizeAddressForSchema(payload, hasUnnormalized ? "structured" : "unnormalized"),
    enforceAddressOneOfForWrite(payload, preferMode),
    enforceAddressOneOfForWrite(payload, hasUnnormalized ? "structured" : "unnormalized"),
    enforceAddressOneOfForWrite(payload, "unnormalized"),
    enforceAddressOneOfForWrite(payload, "structured"),
  ];

  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== "object") continue;
    const candidate = deepClone(attempt);
    if (!candidate || typeof candidate !== "object") continue;

    const candidateHasUnnormalized = hasUnnormalizedAddressValue(candidate);
    if (candidateHasUnnormalized) {
      stripStructuredAddressFields(candidate);
      candidate.unnormalized_address = normalizeUnnormalizedAddressValue(
        candidate.unnormalized_address,
      );
      if (!candidate.unnormalized_address) continue;
      const sanitized =
        sanitizeAddressForSchema(candidate, "unnormalized") ||
        enforceAddressOneOfForWrite(candidate, "unnormalized");
      if (
        sanitized &&
        typeof sanitized === "object" &&
        Object.keys(sanitized).length > 0
      ) {
        stripStructuredAddressFields(sanitized);
        sanitized.unnormalized_address = normalizeUnnormalizedAddressValue(
          sanitized.unnormalized_address,
        );
        if (!sanitized.unnormalized_address) continue;
        return sanitized;
      }
      continue;
    }

    const hasStructuredCandidate = STRUCTURED_ADDRESS_REQUIRED_KEYS.every(
      (key) => {
        const value = candidate[key];
        return typeof value === "string" && value.trim().length > 0;
      },
    );
    if (!hasStructuredCandidate) continue;

    removeUnnormalizedAddress(candidate);
    const sanitized =
      sanitizeAddressForSchema(candidate, "structured") ||
      enforceAddressOneOfForWrite(candidate, "structured");
    if (
      sanitized &&
      typeof sanitized === "object" &&
      Object.keys(sanitized).length > 0
    ) {
      removeUnnormalizedAddress(sanitized);
      const hasRequired = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
        const value = sanitized[key];
        return typeof value === "string" && value.trim().length > 0;
      });
      if (!hasRequired) continue;
      return sanitized;
    }
  }

  return null;
}

function finalizeAddressForSchemaOutput(address, preferredMode = "unnormalized") {
  if (!address || typeof address !== "object") return null;

  const attemptOrder =
    preferredMode === "structured"
      ? ["structured", "unnormalized"]
      : ["unnormalized", "structured"];
  const visited = new Set();

  for (const mode of [...attemptOrder, "unnormalized", "structured"]) {
    if (visited.has(mode)) continue;
    visited.add(mode);

    const sanitized = sanitizeAddressForSchema(address, mode);
    if (!sanitized || typeof sanitized !== "object") continue;

    const exclusive = ensureExclusiveAddressMode(sanitized) || sanitized;
    if (!exclusive) continue;

    if (
      Object.prototype.hasOwnProperty.call(exclusive, "unnormalized_address")
    ) {
      const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
        exclusive.unnormalized_address,
      );
      if (!normalizedUnnormalized) continue;
      exclusive.unnormalized_address = normalizedUnnormalized;
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(exclusive, key)) {
          delete exclusive[key];
        }
      }
    } else {
      let hasRequiredStructured = true;
      for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(exclusive, key)) {
          hasRequiredStructured = false;
          break;
        }
        const value = exclusive[key];
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (!trimmed) {
            hasRequiredStructured = false;
            break;
          }
          exclusive[key] = trimmed;
        } else if (value == null) {
          hasRequiredStructured = false;
          break;
        }
      }
      if (!hasRequiredStructured) continue;
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(exclusive, key)) continue;
        const raw = exclusive[key];
        if (raw == null) {
          delete exclusive[key];
          continue;
        }
        if (typeof raw === "string") {
          const cleaned =
            key === "city_name" || key === "state_code"
              ? textClean(raw).toUpperCase()
              : key === "postal_code" || key === "plus_four_postal_code"
              ? raw.replace(/\s+/g, "")
              : textClean(raw);
          if (!cleaned) {
            delete exclusive[key];
            continue;
          }
          exclusive[key] = cleaned;
        }
      }
    }

    const normalizedMetadata = {};
    if (
      Object.prototype.hasOwnProperty.call(exclusive, "request_identifier") &&
      exclusive.request_identifier != null
    ) {
      const value = exclusive.request_identifier;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) normalizedMetadata.request_identifier = trimmed;
      } else {
        normalizedMetadata.request_identifier = value;
      }
    }
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(exclusive, key)) continue;
      const value = exclusive[key];
      if (value == null) continue;
      if (typeof value === "string") {
        const cleaned = textClean(value);
        if (!cleaned) continue;
        normalizedMetadata[key] = cleaned;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) continue;
        normalizedMetadata[key] = value;
      } else {
        normalizedMetadata[key] = value;
      }
    }

    const result = { ...normalizedMetadata };
    if (
      Object.prototype.hasOwnProperty.call(exclusive, "unnormalized_address")
    ) {
      result.unnormalized_address = exclusive.unnormalized_address;
    } else {
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(exclusive, key)) continue;
        result[key] = exclusive[key];
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}

function normalizeAddressPayloadForSchema(
  address,
  preferMode = "unnormalized",
  fallbackUnnormalized = null,
) {
  if (!address || typeof address !== "object") return null;

  const candidates = [];
  candidates.push(deepClone(address));

  const compliantFromBuilder = buildSchemaCompliantAddress(
    address,
    fallbackUnnormalized,
  );
  if (compliantFromBuilder) {
    candidates.push(compliantFromBuilder);
  }

  const finalizedCandidate = finalizeAddressOutputForSchema(
    address,
    fallbackUnnormalized,
  );
  if (finalizedCandidate) {
    candidates.push(finalizedCandidate);
  }

  const tryNormalize = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;
    const pipeline = [
      (payload) => enforceAddressOneOfForWrite(payload, preferMode),
      (payload) => enforceAddressOneOfCompliance(payload),
      (payload) => coerceAddressPayloadToOneOf(payload),
      (payload) => ensureExclusiveAddressMode(payload),
    ];

    for (const step of pipeline) {
      const snapshot = deepClone(candidate);
      const normalized = step(snapshot);
      if (!normalized || typeof normalized !== "object") continue;

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "unnormalized_address",
        )
      ) {
        const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
          normalized.unnormalized_address,
        );
        if (!normalizedUnnormalized) continue;
        stripStructuredAddressFields(normalized);
        normalized.unnormalized_address = normalizedUnnormalized;
      } else {
        let hasStructured = true;
        for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
            hasStructured = false;
            break;
          }
          const value = normalized[key];
          if (typeof value !== "string" || !value.trim()) {
            hasStructured = false;
            break;
          }
        }
        if (!hasStructured) continue;
      }

      return normalized;
    }
    return null;
  };

  for (const candidate of candidates) {
    const normalized = tryNormalize(candidate);
    if (normalized) return normalized;
  }

  const normalizedFallback = normalizeUnnormalizedAddressValue(
    fallbackUnnormalized,
  );
  if (!normalizedFallback) return null;

  const fallbackBase = {};
  if (
    Object.prototype.hasOwnProperty.call(address, "request_identifier") &&
    address.request_identifier != null
  ) {
    if (typeof address.request_identifier === "string") {
      const trimmed = address.request_identifier.trim();
      if (trimmed) fallbackBase.request_identifier = trimmed;
    } else {
      fallbackBase.request_identifier = address.request_identifier;
    }
  }
  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    const rawValue = address[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      const cleaned = textClean(rawValue);
      if (!cleaned) continue;
      fallbackBase[key] = cleaned;
    } else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) continue;
      fallbackBase[key] = rawValue;
    } else {
      fallbackBase[key] = rawValue;
    }
  }
  fallbackBase.unnormalized_address = normalizedFallback;

  return tryNormalize(fallbackBase);
}

function collectStructuredAddressFields(source) {
  if (!source || typeof source !== "object") return null;
  const collected = {};
  let hasValue = false;
  for (const key of STRUCTURED_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value == null) continue;
    collected[key] = value;
    hasValue = true;
  }
  return hasValue ? collected : null;
}

function buildCanonicalAddressPayload({
  requestIdentifier = null,
  structuredSource = null,
  metadataSources = [],
  unnormalizedCandidates = [],
  preferStructured = false,
} = {}) {
  const payload = {};

  assignIfValue(payload, "request_identifier", requestIdentifier);

  const normalizedMetadata = normalizeAddressMetadataFromSources(
    metadataSources,
  );
  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(normalizedMetadata, key)) continue;
    assignIfValue(payload, key, normalizedMetadata[key]);
  }

  const structuredCandidate = structuredSource
    ? pickStructuredAddress(structuredSource)
    : null;
  const hasStructured = Boolean(structuredCandidate);

  let normalizedUnnormalized = null;
  const unnormalizedList = Array.isArray(unnormalizedCandidates)
    ? unnormalizedCandidates
    : [unnormalizedCandidates];
  for (const candidate of unnormalizedList) {
    const normalized = normalizeUnnormalizedAddressValue(candidate);
    if (normalized) {
      normalizedUnnormalized = normalized;
      break;
    }
  }

  const preferStructuredMode =
    preferStructured === true ||
    (preferStructured !== false && hasStructured);

  let useStructured = false;
  let useUnnormalized = false;

  if (hasStructured && preferStructuredMode) {
    useStructured = true;
  } else if (hasStructured && !normalizedUnnormalized) {
    useStructured = true;
  } else if (normalizedUnnormalized) {
    useUnnormalized = true;
  } else if (hasStructured) {
    useStructured = true;
  }

  if (useStructured) {
    return { ...payload, ...structuredCandidate };
  }

  if (useUnnormalized) {
    payload.unnormalized_address = normalizedUnnormalized;
    return payload;
  }

  return null;
}

function sanitizeAddressRecordForOneOf(address, preferStructured = false) {
  if (!address || typeof address !== "object") return null;

  const metadataSource = {};
  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    metadataSource[key] = address[key];
  }

  const structuredSource = collectStructuredAddressFields(address);

  const unnormalizedCandidates = [];
  if (
    Object.prototype.hasOwnProperty.call(address, "unnormalized_address") &&
    address.unnormalized_address != null
  ) {
    unnormalizedCandidates.push(address.unnormalized_address);
  }

  return buildCanonicalAddressPayload({
    requestIdentifier: address.request_identifier ?? null,
    structuredSource,
    metadataSources: [metadataSource],
    unnormalizedCandidates,
    preferStructured,
  });
}

function buildSchemaReadyAddress({
  requestIdentifier = null,
  metadataSources = [],
  structuredSources = [],
  unnormalizedCandidates = [],
  preferStructured = false,
} = {}) {
  const payload = {};
  assignIfValue(payload, "request_identifier", requestIdentifier);

  const metadataList = Array.isArray(metadataSources)
    ? metadataSources
    : [metadataSources];
  for (const source of metadataList) {
    if (!source || typeof source !== "object") continue;
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      assignIfValue(payload, key, source[key]);
    }
  }

  const structuredList = Array.isArray(structuredSources)
    ? structuredSources
    : [structuredSources];
  let structuredCandidate = null;
  for (const source of structuredList) {
    if (!source || typeof source !== "object") continue;
    const candidate = pickStructuredAddress(source);
    if (candidate) {
      structuredCandidate = candidate;
      break;
    }
  }

  const unnormalizedList = Array.isArray(unnormalizedCandidates)
    ? unnormalizedCandidates
    : [unnormalizedCandidates];
  let normalizedUnnormalized = null;
  for (const candidate of unnormalizedList) {
    const normalized = normalizeUnnormalizedAddressValue(candidate);
    if (normalized) {
      normalizedUnnormalized = normalized;
      break;
    }
  }

  if (structuredCandidate && preferStructured) {
    if (Object.prototype.hasOwnProperty.call(payload, "unnormalized_address")) {
      delete payload.unnormalized_address;
    }
    return { ...payload, ...structuredCandidate };
  }

  if (structuredCandidate && !normalizedUnnormalized) {
    if (Object.prototype.hasOwnProperty.call(payload, "unnormalized_address")) {
      delete payload.unnormalized_address;
    }
    return { ...payload, ...structuredCandidate };
  }

  if (normalizedUnnormalized) {
    const base = { ...payload };
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        delete base[key];
      }
    }
    base.unnormalized_address = normalizedUnnormalized;
    return base;
  }

  if (structuredCandidate) {
    if (Object.prototype.hasOwnProperty.call(payload, "unnormalized_address")) {
      delete payload.unnormalized_address;
    }
    return { ...payload, ...structuredCandidate };
  }

  return null;
}

function buildPreferredSchemaAddressPayload({
  candidate = null,
  structuredSources = [],
  unnormalizedCandidates = [],
  metadataSources = [],
  requestIdentifier = null,
  preferStructured = false,
} = {}) {
  const collectedMetadata = {};
  let resolvedRequestIdentifier = null;

  const setRequestIdentifier = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (resolvedRequestIdentifier == null) {
        resolvedRequestIdentifier = trimmed;
      }
      return;
    }
    if (resolvedRequestIdentifier == null) {
      resolvedRequestIdentifier = value;
    }
  };

  const addMetadataFromSource = (source) => {
    if (!source || typeof source !== "object") return;
    if (
      Object.prototype.hasOwnProperty.call(source, "request_identifier") &&
      source.request_identifier != null
    ) {
      setRequestIdentifier(source.request_identifier);
    }
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (Object.prototype.hasOwnProperty.call(collectedMetadata, key)) continue;
      const value = source[key];
      if (value == null) continue;
      if (typeof value === "string") {
        const cleaned = textClean(value);
        if (!cleaned) continue;
        collectedMetadata[key] = cleaned;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) continue;
        collectedMetadata[key] = value;
      } else {
        collectedMetadata[key] = value;
      }
    }
  };

  if (candidate && typeof candidate === "object") {
    addMetadataFromSource(candidate);
  }
  if (Array.isArray(metadataSources)) {
    for (const source of metadataSources) {
      addMetadataFromSource(source);
    }
  } else if (metadataSources && typeof metadataSources === "object") {
    addMetadataFromSource(metadataSources);
  }

  if (requestIdentifier != null) {
    setRequestIdentifier(requestIdentifier);
  }

  const structuredSourceList = [];
  if (candidate && typeof candidate === "object") {
    structuredSourceList.push(candidate);
  }
  if (Array.isArray(structuredSources)) {
    for (const source of structuredSources) {
      if (source && typeof source === "object") {
        structuredSourceList.push(source);
      }
    }
  } else if (structuredSources && typeof structuredSources === "object") {
    structuredSourceList.push(structuredSources);
  }

  let structuredPayload = null;
  for (const source of structuredSourceList) {
    const normalized = pickStructuredAddress(source);
    if (normalized) {
      structuredPayload = normalized;
      break;
    }
  }

  const unnormalizedValueCandidates = [];
  if (
    candidate &&
    typeof candidate === "object" &&
    Object.prototype.hasOwnProperty.call(candidate, "unnormalized_address")
  ) {
    unnormalizedValueCandidates.push(candidate.unnormalized_address);
  }
  if (Array.isArray(unnormalizedCandidates)) {
    for (const value of unnormalizedCandidates) {
      if (value != null) {
        unnormalizedValueCandidates.push(value);
      }
    }
  } else if (unnormalizedCandidates != null) {
    unnormalizedValueCandidates.push(unnormalizedCandidates);
  }

  let normalizedUnnormalized = null;
  for (const value of unnormalizedValueCandidates) {
    const normalized = normalizeUnnormalizedAddressValue(value);
    if (normalized) {
      normalizedUnnormalized = normalized;
      break;
    }
  }

  const base = { ...collectedMetadata };
  if (resolvedRequestIdentifier != null) {
    if (typeof resolvedRequestIdentifier === "string") {
      const trimmed = resolvedRequestIdentifier.trim();
      if (trimmed) base.request_identifier = trimmed;
    } else {
      base.request_identifier = resolvedRequestIdentifier;
    }
  }

  if (preferStructured && structuredPayload) {
    return { ...base, ...structuredPayload };
  }

  if (normalizedUnnormalized) {
    return { ...base, unnormalized_address: normalizedUnnormalized };
  }

  if (structuredPayload) {
    return { ...base, ...structuredPayload };
  }

  return null;
}

function normalizeAddressMetadataFromSources(sources) {
  const normalized = {};
  const list = Array.isArray(sources) ? sources : [sources];
  for (const source of list) {
    if (!source || typeof source !== "object") continue;
    for (const key of ADDRESS_METADATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (
        Object.prototype.hasOwnProperty.call(normalized, key) &&
        normalized[key] != null
      ) {
        continue;
      }
      const raw = source[key];
      if (raw == null) continue;
      if (typeof raw === "number") {
        if (Number.isFinite(raw)) normalized[key] = raw;
        continue;
      }
      if (typeof raw === "string") {
        let cleaned = textClean(raw);
        if (!cleaned) continue;
        if (key === "latitude" || key === "longitude") {
          const numeric = Number(cleaned);
          if (Number.isFinite(numeric)) {
            normalized[key] = numeric;
            continue;
          }
        }
        normalized[key] = cleaned;
        continue;
      }
      normalized[key] = raw;
    }
  }
  return normalized;
}

function buildAddressRecordForSchema({
  addressCandidate = null,
  structuredFallback = null,
  metadataSources = [],
  fallbackUnnormalized = null,
  requestIdentifier = null,
} = {}) {
  const metadata = normalizeAddressMetadataFromSources(metadataSources);

  const requestIdSources = [];
  if (addressCandidate && typeof addressCandidate === "object") {
    requestIdSources.push(addressCandidate);
  }
  if (structuredFallback && typeof structuredFallback === "object") {
    requestIdSources.push(structuredFallback);
  }
  requestIdSources.push({ request_identifier: requestIdentifier });

  let normalizedRequestId = null;
  for (const source of requestIdSources) {
    if (!source || typeof source !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(source, "request_identifier")) {
      continue;
    }
    const raw = source.request_identifier;
    if (raw == null) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      normalizedRequestId = trimmed;
      break;
    }
    normalizedRequestId = raw;
    break;
  }

  const structuredSources = [];
  if (addressCandidate && typeof addressCandidate === "object") {
    structuredSources.push(addressCandidate);
  }
  if (structuredFallback && typeof structuredFallback === "object") {
    structuredSources.push(structuredFallback);
  }

  let structuredCandidate = null;
  for (const candidate of structuredSources) {
    const picked = pickStructuredAddress(candidate);
    if (picked) {
      structuredCandidate = picked;
      break;
    }
  }

  let normalizedUnnormalized = null;
  const unnormalizedSources = [];
  if (
    addressCandidate &&
    typeof addressCandidate === "object" &&
    Object.prototype.hasOwnProperty.call(addressCandidate, "unnormalized_address")
  ) {
    unnormalizedSources.push(addressCandidate.unnormalized_address);
  }
  if (structuredFallback && typeof structuredFallback === "object") {
    if (
      Object.prototype.hasOwnProperty.call(
        structuredFallback,
        "unnormalized_address",
      )
    ) {
      unnormalizedSources.push(structuredFallback.unnormalized_address);
    }
  }
  if (fallbackUnnormalized != null) {
    unnormalizedSources.push(fallbackUnnormalized);
  }
  for (const value of unnormalizedSources) {
    const normalized = normalizeUnnormalizedAddressValue(value);
    if (normalized) {
      normalizedUnnormalized = normalized;
      break;
    }
  }

  const base = {};
  if (normalizedRequestId != null) {
    base.request_identifier = normalizedRequestId;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value != null) {
      base[key] = value;
    }
  }

  if (structuredCandidate) {
    const hasAllRequired = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
      const value = structuredCandidate[key];
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return value != null;
    });
    if (hasAllRequired) {
      return { ...base, ...structuredCandidate };
    }
  }

  if (normalizedUnnormalized) {
    return {
      ...base,
      unnormalized_address: normalizedUnnormalized,
    };
  }

  return null;
}

function enforcePreferredAddressMode(address, preferredMode = "unnormalized") {
  if (!address || typeof address !== "object") return null;

  const preferStructured = preferredMode === "structured";
  const output = {};

  if (Object.prototype.hasOwnProperty.call(address, "request_identifier")) {
    const requestId = address.request_identifier;
    if (requestId != null) {
      if (typeof requestId === "string") {
        const trimmed = requestId.trim();
        if (trimmed) output.request_identifier = trimmed;
      } else {
        output.request_identifier = requestId;
      }
    }
  }

  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
    const raw = address[key];
    if (raw == null) continue;
    if (typeof raw === "string") {
      const cleaned = textClean(raw);
      if (!cleaned) continue;
      output[key] = cleaned;
    } else if (typeof raw === "number") {
      if (!Number.isFinite(raw)) continue;
      output[key] = raw;
    } else {
      output[key] = raw;
    }
  }

  const structuredValues = {};
  let hasStructured = true;
  for (const key of STRUCTURED_ADDRESS_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(address, key)) {
      hasStructured = false;
      break;
    }
    const raw = address[key];
    if (raw == null) {
      hasStructured = false;
      break;
    }
    let text =
      typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
    if (!text) {
      hasStructured = false;
      break;
    }
    if (key === "city_name" || key === "state_code") {
      text = textClean(text).toUpperCase();
    } else if (key === "postal_code" || key === "plus_four_postal_code") {
      text = text.replace(/\s+/g, "");
    } else {
      text = textClean(text);
    }
    if (!text) {
      hasStructured = false;
      break;
    }
    structuredValues[key] = text;
  }

  if (hasStructured) {
    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(address, key)) continue;
      const raw = address[key];
      if (raw == null) continue;
      let text =
        typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
      if (!text) continue;
      if (key === "city_name" || key === "state_code") {
        text = textClean(text).toUpperCase();
      } else if (key === "postal_code" || key === "plus_four_postal_code") {
        text = text.replace(/\s+/g, "");
      } else {
        text = textClean(text);
      }
      if (!text) continue;
      structuredValues[key] = text;
    }
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    Object.prototype.hasOwnProperty.call(address, "unnormalized_address")
      ? address.unnormalized_address
      : null,
  );

  let mode = null;
  if (hasStructured && normalizedUnnormalized) {
    mode = preferStructured ? "structured" : "unnormalized";
  } else if (hasStructured) {
    mode = "structured";
  } else if (normalizedUnnormalized) {
    mode = "unnormalized";
  }

  if (!mode) {
    return null;
  }

  if (mode === "structured") {
    for (const key of STRUCTURED_ADDRESS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(structuredValues, key)) continue;
      const value = structuredValues[key];
      if (value == null) continue;
      output[key] = value;
    }
  } else {
    output.unnormalized_address = normalizedUnnormalized;
  }

  const hasAddressData =
    mode === "structured"
      ? STRUCTURED_ADDRESS_FIELDS.some((key) =>
          Object.prototype.hasOwnProperty.call(output, key),
        )
      : Object.prototype.hasOwnProperty.call(
          output,
          "unnormalized_address",
        );

  if (!hasAddressData) {
    return null;
  }

  return output;
}

function prepareAddressForWrite(payload, options = {}) {
  if (!payload || typeof payload !== "object") return null;

  const preferMode =
    options && options.preferMode === "structured"
      ? "structured"
      : "unnormalized";
  const fallbackUnnormalized =
    options && typeof options.fallbackUnnormalized === "string"
      ? options.fallbackUnnormalized
      : null;

  const tryFinalize = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;
    const finalized =
      finalizeAddressPayloadForWrite(candidate) ||
      enforceAddressOneOfForWrite(candidate, preferMode);
    return finalized || null;
  };

  const primary = tryFinalize(deepClone(payload));
  if (primary) return primary;

  const compliant = buildSchemaCompliantAddress(
    deepClone(payload),
    fallbackUnnormalized,
  );
  if (!compliant) return null;

  return tryFinalize(compliant) || compliant;
}

function finalizeAddressPayloadForWrite(payload) {
  if (!payload || typeof payload !== "object") return null;
  let working = ensureExclusiveAddressMode(payload);
  if (!working) return null;

  const sanitized =
    sanitizeAddressPayloadForOneOf({ ...working }) ||
    enforceAddressOneOfCompliance(working) ||
    coerceAddressPayloadToOneOf(working) ||
    working;

  working = ensureExclusiveAddressMode(sanitized);
  if (!working) return null;

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    working.unnormalized_address,
  );
  if (normalizedUnnormalized) {
    stripStructuredAddressFields(working);
    working.unnormalized_address = normalizedUnnormalized;
    return working;
  }

  const hasStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
    const value = working[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  if (hasStructured) {
    delete working.unnormalized_address;
    return working;
  }

  return null;
}

function toTitleCaseName(part) {
  if (!part) return null;
  const normalized = part.trim().toLowerCase();
  if (!normalized) return null;
  let result = "";
  let shouldCapitalize = true;
  for (const ch of normalized) {
    if (/[a-z]/.test(ch)) {
      result += shouldCapitalize ? ch.toUpperCase() : ch;
      shouldCapitalize = false;
    } else {
      result += ch;
      shouldCapitalize = /[\s'.-]/.test(ch);
    }
  }
  return result;
}

function normalizeOwnerKey(name) {
  const cleaned = textClean(name);
  if (!cleaned) return "";
  return cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COMPANY_NAME_REGEX =
  /\b(assn|association|bank|church|company|co\b|corp|corporation|enterprises|foundation|group|holdings|inc\b|investments|llc\b|llp\b|ltd\b|management|partners|partnership|properties|realty|solutions|trust)\b/i;

function guessOwnerType(name) {
  if (!name) return "person";
  return COMPANY_NAME_REGEX.test(name) ? "company" : "person";
}

function parsePersonNameTokens(name, options = {}) {
  let cleaned = textClean(name);
  if (!cleaned) return null;

  // Remove common descriptors like (EST), (TR), etc.
  // This regex looks for words in parentheses that are common legal/estate terms
  cleaned = cleaned.replace(/\s*\((EST|TR|ET AL|JR|SR|II|III|IV)\)\s*/gi, ' ').trim();
  // Also remove common suffixes that might be mistaken for middle names or part of the last name
  cleaned = cleaned.replace(/,?\s*(JR|SR|II|III|IV)\.?$/i, '').trim();


  if (cleaned.includes(",")) {
    const [lastPart, rest] = cleaned.split(",", 2);
    const restTokens = textClean(rest)
      .split(/\s+/)
      .filter(Boolean);
    if (restTokens.length === 0) {
      return {
        first_name: null,
        middle_name: null,
        last_name: toTitleCaseName(textClean(lastPart)) || null,
      };
    }
    const first = toTitleCaseName(restTokens[0] || null);
    const middleRaw =
      restTokens.length > 1 ? restTokens.slice(1).join(" ") : null;
    const middle = toTitleCaseName(middleRaw);
    return {
      first_name: first || null,
      middle_name: middle || null,
      last_name: toTitleCaseName(textClean(lastPart)) || null,
    };
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { first_name: null, middle_name: null, last_name: null };
  }
  if (tokens.length === 1) {
    return { first_name: toTitleCaseName(tokens[0]), middle_name: null, last_name: null };
  }
  const middleNamePattern = /^[A-Z][a-zA-Z\s\-',.]*$/;

  if (options && options.assumeLastFirst && tokens.length >= 2) {
    const lastToken = toTitleCaseName(tokens[0]);
    const firstToken = toTitleCaseName(tokens[1]);
    const middleRaw =
      tokens.length > 2 ? tokens.slice(2).join(" ") || null : null;
    const middleCandidate = toTitleCaseName(middleRaw);
    const validatedMiddle =
      middleCandidate && middleNamePattern.test(middleCandidate)
        ? middleCandidate
        : null;
    return {
      first_name: firstToken || null,
      middle_name: validatedMiddle,
      last_name: lastToken || null,
    };
  }

  let first = toTitleCaseName(tokens[0]);
  let last = toTitleCaseName(tokens[tokens.length - 1]);
  const middleRaw =
    tokens.length > 2 ? tokens.slice(1, -1).join(" ") || null : null;
  const middle = toTitleCaseName(middleRaw);

  // Validate middle name against the pattern if it exists
  let validatedMiddle = (middle && middleNamePattern.test(middle)) ? middle : null;

  if ((!last || last.length <= 1) && tokens.length >= 2) {
    const altLast = toTitleCaseName(tokens[0]);
    const altFirst = toTitleCaseName(tokens[1]);
    const altMiddleRaw =
      tokens.length > 2 ? tokens.slice(2).join(" ") || null : null;
    const altMiddle = toTitleCaseName(altMiddleRaw);
    const altValidatedMiddle =
      altMiddle && middleNamePattern.test(altMiddle) ? altMiddle : null;
    if (altLast) last = altLast;
    if (altFirst) first = altFirst;
    validatedMiddle = altValidatedMiddle;
  }

  return {
    first_name: first || null,
    middle_name: validatedMiddle, // Use the validated middle name
    last_name: last || null,
  };
}

const PERSON_NAME_PATTERN =
  /^[A-Z][a-z]*([ \-',.][A-Za-z][a-z]*)*$/;
const PERSON_MIDDLE_NAME_PATTERN =
  /^[A-Z][a-zA-Z\s\-',.]*$/;

function normalizeNameToPattern(value, pattern) {
  if (!value) return null;
  let cleaned = textClean(String(value));
  if (!cleaned) return null;
  if (cleaned.normalize) {
    cleaned = cleaned.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  cleaned = cleaned
    .replace(/[^A-Za-z \-',.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  let result = "";
  let shouldCapitalize = true;
  for (const ch of cleaned) {
    if (/[A-Za-z]/.test(ch)) {
      const letter = shouldCapitalize ? ch.toUpperCase() : ch.toLowerCase();
      result += letter;
      shouldCapitalize = false;
    } else if (/[ \-',.]/.test(ch)) {
      if (result.length && /[ \-',.]$/.test(result)) continue;
      result += ch === " " ? " " : ch;
      shouldCapitalize = true;
    }
  }

  result = result.replace(/\s+/g, " ").replace(/([ \-',.])+$/g, "").trim();
  if (!result) return null;
  return pattern.test(result) ? result : null;
}

function enforceNamePattern(value, pattern) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return pattern.test(trimmed) ? trimmed : null;
}

function normalizePersonNameValue(value, pattern = PERSON_NAME_PATTERN) {
  return normalizeNameToPattern(value, pattern);
}

function ensurePersonNamePattern(value, pattern = PERSON_NAME_PATTERN) {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (pattern.test(trimmed)) {
      return trimmed;
    }
  }
  const normalized = normalizeNameToPattern(value, pattern);
  if (!normalized) return null;
  return pattern.test(normalized) ? normalized : null;
}

function sanitizePersonData(raw, fallbackDisplay) {
  if (!raw || typeof raw !== "object") return null;
  const base = {
    birth_date: raw.birth_date ?? null,
    prefix_name: raw.prefix_name ?? null,
    suffix_name: raw.suffix_name ?? null,
    us_citizenship_status: raw.us_citizenship_status ?? null,
    veteran_status: raw.veteran_status ?? null,
    request_identifier: raw.request_identifier ?? null,
  };

  base.first_name = normalizePersonNameValue(raw.first_name);
  base.last_name = normalizePersonNameValue(raw.last_name);
  base.middle_name = normalizePersonNameValue(
    raw.middle_name,
    PERSON_MIDDLE_NAME_PATTERN,
  );

  const fallbackSource =
    fallbackDisplay ||
    buildPersonDisplayName(raw) ||
    null;
  if ((!base.first_name || !base.last_name) && fallbackSource) {
    const parsed = parsePersonNameTokens(fallbackSource);
    if (parsed) {
      if (!base.first_name && parsed.first_name) {
        base.first_name = normalizePersonNameValue(parsed.first_name);
      }
      if (!base.last_name && parsed.last_name) {
        base.last_name = normalizePersonNameValue(parsed.last_name);
      }
      if (!base.middle_name && parsed.middle_name) {
        base.middle_name = normalizePersonNameValue(
          parsed.middle_name,
          PERSON_MIDDLE_NAME_PATTERN,
        );
      }
    }
  }

  base.last_name = enforceNamePattern(base.last_name, PERSON_NAME_PATTERN);
  if (!base.last_name) return null;

  base.first_name = enforceNamePattern(base.first_name, PERSON_NAME_PATTERN);
  base.middle_name = enforceNamePattern(
    base.middle_name,
    PERSON_MIDDLE_NAME_PATTERN,
  );

  return base;
}

function preparePersonForWrite(rawPerson) {
  if (!rawPerson || typeof rawPerson !== "object") return null;

  const normalizedLast = normalizePersonNameValue(
    rawPerson.last_name,
    PERSON_NAME_PATTERN,
  );
  const normalizedFirst = normalizePersonNameValue(
    rawPerson.first_name,
    PERSON_NAME_PATTERN,
  );
  const safeLast = ensurePersonNamePattern(
    normalizedLast,
    PERSON_NAME_PATTERN,
  );
  const safeFirst = ensurePersonNamePattern(
    normalizedFirst,
    PERSON_NAME_PATTERN,
  );
  if (!safeLast || !safeFirst) return null;

  const normalizedMiddle = normalizePersonNameValue(
    rawPerson.middle_name,
    PERSON_MIDDLE_NAME_PATTERN,
  );
  const middleValue = ensurePersonNamePattern(
    normalizedMiddle,
    PERSON_MIDDLE_NAME_PATTERN,
  );

  const sanitizeLooseField = (value) => {
    if (value == null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    return value;
  };

  return {
    birth_date: sanitizeLooseField(rawPerson.birth_date),
    first_name: safeFirst,
    last_name: safeLast,
    middle_name: middleValue ?? null,
    prefix_name: sanitizeLooseField(rawPerson.prefix_name),
    suffix_name: sanitizeLooseField(rawPerson.suffix_name),
    us_citizenship_status: sanitizeLooseField(
      rawPerson.us_citizenship_status,
    ),
    veteran_status: sanitizeLooseField(rawPerson.veteran_status),
    request_identifier: sanitizeLooseField(rawPerson.request_identifier),
  };
}

function finalizePersonNamesForSchema(person) {
  if (!person || typeof person !== "object") return null;

  const next = { ...person };

  const normalizeField = (value, pattern) => {
    if (value == null) return null;
    const normalized = normalizeNameToPattern(value, pattern);
    if (!normalized) return null;
    return pattern.test(normalized) ? normalized : null;
  };

  const safeLast = normalizeField(next.last_name, PERSON_NAME_PATTERN);
  const safeFirst = normalizeField(next.first_name, PERSON_NAME_PATTERN);
  if (!safeLast || !safeFirst) return null;

  const safeMiddle =
    next.middle_name != null
      ? normalizeField(next.middle_name, PERSON_MIDDLE_NAME_PATTERN)
      : null;

  next.last_name = safeLast;
  next.first_name = safeFirst;
  next.middle_name = safeMiddle;

  return next;
}

function enforcePersonSchema(person) {
  if (!person || typeof person !== "object") return null;

  const coerceName = (value, pattern) => {
    if (value == null) return null;
    const normalized = normalizeNameToPattern(value, pattern);
    if (!normalized) return null;
    return pattern.test(normalized) ? normalized : null;
  };

  const next = { ...person };

  const safeLast = coerceName(next.last_name, PERSON_NAME_PATTERN);
  const safeFirst = coerceName(next.first_name, PERSON_NAME_PATTERN);

  if (!safeLast || !safeFirst) return null;

  next.last_name = safeLast;
  next.first_name = safeFirst;

  if (next.middle_name != null) {
    const safeMiddle = coerceName(
      next.middle_name,
      PERSON_MIDDLE_NAME_PATTERN,
    );
    next.middle_name = safeMiddle ?? null;
  }

  return next;
}

function enforcePersonNamePatterns(person) {
  if (!person || typeof person !== "object") return null;

  const last = ensurePersonNamePattern(person.last_name, PERSON_NAME_PATTERN);
  const first = ensurePersonNamePattern(person.first_name, PERSON_NAME_PATTERN);
  if (!last || !first) return null;

  const middle =
    person.middle_name != null
      ? ensurePersonNamePattern(
          person.middle_name,
          PERSON_MIDDLE_NAME_PATTERN,
        )
      : null;

  return {
    ...person,
    last_name: last,
    first_name: first,
    middle_name: middle ?? null,
  };
}

function buildPersonDisplayName(person) {
  if (!person) return null;
  const parts = [
    person.first_name,
    person.middle_name,
    person.last_name,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function slugify(value, fallback = "unspecified") {
  if (!value || typeof value !== "string") return fallback;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const trimmed = cleaned.replace(/^_+|_+$/g, "");
  return trimmed || fallback;
}

function detectMultiRequest(inputObj) {
  if (!inputObj || typeof inputObj !== "object") return false;
  const keys = Object.keys(inputObj);
  if (keys.length === 0) return false;
  return keys.some(
    (k) =>
      inputObj[k] &&
      typeof inputObj[k] === "object" &&
      inputObj[k].source_http_request &&
      inputObj[k].response,
  );
}

function getFileFormatFromUrl(u) {
  if (!u) return null;
  const m = u.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  if (!m) return null;
  const ext = m[1];
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "png") return "png";
  // Removed "pdf" as it's not in the schema's enum for file_format
  return null; // other extensions => null per schema enum
}

function extractDeedReference(rawText, rawUrl) {
  const details = {
    book: null,
    page: null,
    volume: null,
    instrument_number: null,
  };

  const assignIfMissing = (key, value) => {
    if (value == null) return;
    const trimmed = textClean(String(value));
    if (!trimmed) return;
    if (details[key] == null) details[key] = trimmed;
  };

  if (rawUrl) {
    try {
      const url = new URL(rawUrl, "https://placeholder.local/");
      const segments = url.pathname.split("/").filter(Boolean);
      const lowerSegments = segments.map((s) => s.toLowerCase());
      const docIdx = lowerSegments.indexOf("getdocumentbybookpage");
      if (docIdx !== -1) {
        const after = segments.slice(docIdx + 1);
        if (after.length >= 1) assignIfMissing("volume", after[0]);
        if (after.length >= 2) assignIfMissing("book", after[1]);
        if (after.length >= 3) assignIfMissing("page", after[2]);
      }
      for (const [key, value] of url.searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes("instrument") ||
          (lowerKey.includes("document") && lowerKey.includes("number")) ||
          lowerKey.includes("record")
        ) {
          assignIfMissing("instrument_number", value);
          break;
        }
      }
    } catch (err) {
      // Ignore malformed URLs; fall back to text extraction.
    }
  }

  const text = textClean(rawText);
  if (text) {
    const slashMatch = text.match(/([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)/);
    if (slashMatch) {
      assignIfMissing("book", slashMatch[1]);
      assignIfMissing("page", slashMatch[2]);
      if (slashMatch.index != null && slashMatch.index > 0 && details.volume == null) {
        const prefix = text.slice(0, slashMatch.index).replace(/[-:,]?\s*$/, "");
        if (prefix && !/book|page|inst/i.test(prefix)) assignIfMissing("volume", prefix);
      }
    }

    const bookMatch = text.match(/book\s*[:#-]?\s*([A-Za-z0-9]+)/i);
    if (bookMatch) assignIfMissing("book", bookMatch[1]);

    const pageMatch = text.match(/page\s*[:#-]?\s*([A-Za-z0-9]+)/i);
    if (pageMatch) assignIfMissing("page", pageMatch[1]);

    const volumeMatch = text.match(/vol(?:ume)?\s*[:#-]?\s*([A-Za-z0-9]+)/i);
    if (volumeMatch) assignIfMissing("volume", volumeMatch[1]);

    const instrumentMatch = text.match(
      /(?:inst(?:r(?:ument)?)?|doc(?:ument)?|record(?:ing)?|clerk)\s*(?:no\.?|number|#|:)?\s*([A-Za-z0-9\-\/]+)/i,
    );
    if (instrumentMatch) assignIfMissing("instrument_number", instrumentMatch[1]);
  }

  return details;
}

function mapImprovementType(permitNumber, description) {
  const desc = textClean(description).toLowerCase();
  const prefix = (permitNumber || "").split("-")[0]?.toUpperCase() || "";

  if (desc.includes("new construction") || desc.includes("new home")) {
    return "ResidentialConstruction";
  }
  if (desc.includes("electric")) return "Electrical";
  if (desc.includes("plumb")) return "Plumbing";
  if (desc.includes("air conditioning") || desc.includes("hvac") || desc.includes("mechanical")) {
    return "MechanicalHVAC";
  }
  if (desc.includes("roof")) return "Roofing";
  if (desc.includes("pool") || desc.includes("spa")) return "PoolSpaInstallation";
  if (desc.includes("demolition") || desc.includes("demo")) return "Demolition";
  if (desc.includes("addition")) return "BuildingAddition";
  if (desc.includes("fence")) return "Fencing";
  if (desc.includes("window") || desc.includes("door") || desc.includes("shutter") || desc.includes("finish")) {
    return "ExteriorOpeningsAndFinishes";
  }

  switch (prefix) {
    case "BLDR":
    case "BLDG":
    case "RES":
      return "ResidentialConstruction";
    case "ELER":
    case "ELEC":
      return "Electrical";
    case "PLMR":
    case "PLMB":
      return "Plumbing";
    case "MECR":
    case "MECH":
      return "MechanicalHVAC";
    case "ROOFR":
    case "ROOF":
      return "Roofing";
    case "POOL":
    case "SPAS":
      return "PoolSpaInstallation";
    default:
      return null;
  }
}

function mapImprovementAction(description) {
  const desc = textClean(description).toLowerCase();
  if (!desc) return null;
  if (desc.includes("new")) return "New";
  if (desc.includes("repair")) return "Repair";
  if (desc.includes("replace") || desc.includes("re-roof") || desc.includes("reroof")) {
    return "Replacement";
  }
  if (desc.includes("addition") || desc.includes("add ")) return "Addition";
  if (desc.includes("demo") || desc.includes("demolition") || desc.includes("remove")) {
    return "Remove";
  }
  return null;
}

async function removeExisting(pattern) {
  try {
    const files = await fsp.readdir("data");
    const targets = files.filter((f) => pattern.test(f));
    await Promise.all(
      targets.map((f) => fsp.unlink(path.join("data", f)).catch(() => {})),
    );
  } catch {}
}

const propertyTypeMapping = [
  {
    "st_lucie_property_type": "0000 - Vac Residential",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Residential",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "0004 - Vac Res-Cond",
    "ownership_estate_type": "Condominium",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Residential",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "0005 - Vac Res Coop",
    "ownership_estate_type": "Cooperative",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Residential",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "0100 - Single Family",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "SingleFamilyDetached",
    "property_usage_type": "Residential",
    "property_type": "SingleFamily"
  },
  {
    "st_lucie_property_type": "0101 - SingleFam TH (Townhouse)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "TownhouseRowhouse",
    "property_usage_type": "Residential",
    "property_type": "Townhouse"
  },
  {
    "st_lucie_property_type": "0105 - SingFam-Coop",
    "ownership_estate_type": "Cooperative",
    "build_status": "Improved",
    "structure_form": "SingleFamilyDetached",
    "property_usage_type": "Residential",
    "property_type": "Cooperative"
  },
  {
    "st_lucie_property_type": "0200 - Mobile Homes",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "MobileHome",
    "property_usage_type": "Residential",
    "property_type": "MobileHome"
  },
  {
    "st_lucie_property_type": "0205 - MobHome-Coop",
    "ownership_estate_type": "Cooperative",
    "build_status": "Improved",
    "structure_form": "ManufacturedHomeInPark",
    "property_usage_type": "Residential",
    "property_type": "Cooperative"
  },
  {
    "st_lucie_property_type": "0300 - M-F >= 10U (Multi-Family >= 10 Units)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "MultiFamily5Plus",
    "property_usage_type": "Residential",
    "property_type": "MultiFamilyMoreThan10"
  },
  {
    "st_lucie_property_type": "0400 - Condo",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": "ApartmentUnit",
    "property_usage_type": "Residential",
    "property_type": "Condominium"
  },
  {
    "st_lucie_property_type": "0425 - Time Share",
    "ownership_estate_type": "Timeshare",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Recreational",
    "property_type": "Timeshare"
  },
  {
    "st_lucie_property_type": "0500 - Cooperatives",
    "ownership_estate_type": "Cooperative",
    "build_status": "Improved",
    "structure_form": "ApartmentUnit",
    "property_usage_type": "Residential",
    "property_type": "Cooperative"
  },
  {
    "st_lucie_property_type": "0700 - Misc Res (Miscellaneous Residential)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Residential",
    "property_type": "MiscellaneousResidential"
  },
  {
    "st_lucie_property_type": "0800 - M-F < 10U (Multi-Family < 10 Units)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "MultiFamilyLessThan10",
    "property_usage_type": "Residential",
    "property_type": "MultiFamilyLessThan10"
  },
  {
    "st_lucie_property_type": "0900 - ResCommonElemnt (Residential Common Element)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ResidentialCommonElementsAreas",
    "property_type": "ResidentialCommonElementsAreas"
  },
  {
    "st_lucie_property_type": "1000 - Vac Comm (Vacant Commercial)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "1004 - Vac Com Cond (Vacant Commercial Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "1009 - Vac Comm (Vacant Commercial - duplicate entry, possibly a typo or specific sub-category)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "1100 - STOR-1STR (Store - 1 Story)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "RetailStore",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1104 - Store Condo",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "RetailStore",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "1200 - MX-STR OFCE (Mixed Store/Office)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1300 - DEPT STORE (Department Store)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "DepartmentStore",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1304 - DeptSt_Condo (Department Store Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "DepartmentStore",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "1400 - SUPMARKET (Supermarket)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Supermarket",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1600 - COM SHOP CNT (Community Shopping Center)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ShoppingCenterCommunity",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1700 - OFCE BLDG (Office Building)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "OfficeBuilding",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1704 - OFFICE CONDO",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "OfficeBuilding",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "1800 - OFCE BLDG (Office Building - duplicate entry, possibly a typo or specific sub-category)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "OfficeBuilding",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1900 - PROF SERV (Professional Services)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "OfficeBuilding",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "1904 - MED CONDO (Medical Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "MedicalOffice",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "2000 - AIRPT/MARINA (Airport/Marina)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "TransportationTerminal",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2100 - REST CAF (Restaurant/Cafe)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Restaurant",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2104 - REST CONDO (Restaurant Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Restaurant",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "2200 - DRV IN REST (Drive-In Restaurant)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Restaurant",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2204 - DRV IN Condo (Drive-In Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Restaurant",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "2300 - FIN INST (Financial Institution)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "FinancialInstitution",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2500 - RPR SRVC SHO (Repair Service Shop)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2502 - Dry Cleaner/Laundromat",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Commercial",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2600 - SRVC STAT (Service Station)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ServiceStation",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2603 - Car Wash",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "AutoSalesRepair",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2700 - AUTO SALS (Auto Sales)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "AutoSalesRepair",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "2800 - PRKG/MOBILE (Parking/Mobile)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": "MobileHomePark",
    "property_usage_type": "MobileHomePark",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "3000 - FLRT GRNHSE (Florist/Greenhouse)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "NurseryGreenhouse",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3200 - ENC THETHRS (Enclosed Theaters)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Theater",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3300 - NgtClub Bars (Nightclub/Bars)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Entertainment",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3400 - BWLNG ALYS (Bowling Alleys)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Entertainment",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3500 - TRST ATRCT (Tourist Attraction)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Entertainment",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3800 - GLF CRSES (Golf Courses)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "GolfCourse",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3900 - HTLS MTLS (Hotels/Motels)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Hotel",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "3904 - Hotel-Condo",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Hotel",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "4000 - VCNT INDUS (Vacant Industrial)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Industrial",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "4100 - LGHT MNFCT (Light Manufacturing)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "LightManufacturing",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4200 - HVY INDSTRL (Heavy Industrial)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "HeavyManufacturing",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4300 - LMBR YRD (Lumber Yard)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "LumberYard",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4400 - PCKNG PLNTS (Packing Plants)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "PackingPlant",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4500 - CANRIS FRT (Canneries/Fruit)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Cannery",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4600 - OTHR FOOD (Other Food Processing)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "LightManufacturing",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4700 - MNRAL (Mineral)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "MineralProcessing",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4800 - WRHSNG DIST (Warehousing/Distribution)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Warehouse",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4804 - INDUS CONDO (Industrial Condominium)",
    "ownership_estate_type": "Condominium",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Warehouse",
    "property_type": "Unit"
  },
  {
    "st_lucie_property_type": "4820 - INDMINIWHS (Industrial Mini-Warehouse)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Warehouse",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "4900 - OPN STRGE (Open Storage)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "OpenStorage",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "5100 - CRPLD SL CAP (Cropland Soil Capability)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "DrylandCropland",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "5400 - TMBL STE (Timberland)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "TimberLand",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "6000 - GRZNG SLD CP (Grazing Soil Capability)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "GrazingLand",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "6600 - ORCHRD GRV (Orchard/Grove)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "OrchardGroves",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "6700 - MISC AG TYPES (Miscellaneous Agricultural Types)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Agricultural",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "6900 - NURSERY",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "NurseryGreenhouse",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7000 - VAC INST (Vacant Institutional)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "7100 - CHRCHS (Churches)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Church",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7200 - PRVTE SCHLS (Private Schools)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "PrivateSchool",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7300 - PRVTE HOSP (Private Hospitals)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "PrivateHospital",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7400 - HMS AGED (Homes for the Aged)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "HomesForAged",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7500 - Orph/Non Prf (Orphanage/Non-Profit)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "NonProfitCharity",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7502 - Rehab Living Facility",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "HomesForAged",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7600 - MRTURIES (Mortuaries)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "MortuaryCemetery",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7700 - CLUBS",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ClubsLodges",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7704 - HOA Clubhous (Homeowners Association Clubhouse)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ClubsLodges",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "7900 - CLTRAL ORGA (Cultural Organization)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "CulturalOrganization",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8000 - VAC GOVT (Vacant Government)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "8100 - MILITARY",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Military",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8200 - FRST PRKS (Forest/Parks)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "ForestParkRecreation",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "8300 - PBL CTY SCH (Public City School)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "PublicSchool",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8400 - COLLEGES",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "CulturalOrganization",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8500 - HOSPITAL",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "PublicHospital",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8600 - COUNTIES",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8700 - STATE",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8800 - FEDERAL",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "8900 - Mncpal Prop (Municipal Property)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "GovernmentProperty",
    "property_type": "Building"
  },
  {
    "st_lucie_property_type": "9000 - LSHLD INTER (Leasehold Interest)",
    "ownership_estate_type": "Leasehold",
    "build_status": null,
    "structure_form": null,
    "property_usage_type": "Unknown",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9100 - UTLTY (Utility)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Utility",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9200 - MINING LANDS",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "MineralProcessing",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9300 - SBSRFCE RGHT (Subsurface Rights)",
    "ownership_estate_type": "SubsurfaceRights",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Unknown",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "9400 - R/W ST RDS,DITCH,IRRIGTN (Right-of-Way, State Roads, Ditch, Irrigation)",
    "ownership_estate_type": "RightOfWay",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "Unknown",
    "property_type": "VacantLand"
  },
  {
    "st_lucie_property_type": "9500 - RVRS, LKS,SUBMRGED (Rivers, Lakes, Submerged)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "RiversLakes",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9600 - WASTELANDS,MARSH,DUNES",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "TransitionalProperty",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9700 - OTDR RCRTNL (Outdoor Recreational)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Recreational",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9800 - CNTRLY ASSED (Centrally Assessed)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "Improved",
    "structure_form": null,
    "property_usage_type": "Utility",
    "property_type": "LandParcel"
  },
  {
    "st_lucie_property_type": "9900 - Non-Ag ACRG (Non-Agricultural Acreage)",
    "ownership_estate_type": "FeeSimple",
    "build_status": "VacantLand",
    "structure_form": null,
    "property_usage_type": "TransitionalProperty",
    "property_type": "VacantLand"
  }
];

const PROPERTY_TYPE_ENUM = new Set([
  "LandParcel",
  "Building",
  "Unit",
  "ManufacturedHome",
]);

const LEGACY_PROPERTY_TYPE_TO_ELEPHANT = Object.freeze({
  LandParcel: "LandParcel",
  VacantLand: "LandParcel",
  ResidentialCommonElementsAreas: "LandParcel",
  SingleFamily: "Building",
  Townhouse: "Building",
  MiscellaneousResidential: "Building",
  MultiFamilyMoreThan10: "Building",
  MultiFamilyLessThan10: "Building",
  Building: "Building",
  Condominium: "Unit",
  Cooperative: "Unit",
  Timeshare: "Unit",
  Unit: "Unit",
  MobileHome: "ManufacturedHome",
  ManufacturedHome: "ManufacturedHome",
});

const STRUCTURE_FORM_ENUM = new Set([
  "SingleFamilyDetached",
  "SingleFamilySemiDetached",
  "TownhouseRowhouse",
  "Duplex",
  "Triplex",
  "Quadplex",
  "MultiFamily5Plus",
  "ApartmentUnit",
  "Loft",
  "ManufacturedHomeOnLand",
  "ManufacturedHomeInPark",
  "MultiFamilyMoreThan10",
  "MultiFamilyLessThan10",
  "MobileHome",
  "ManufacturedHousingMultiWide",
  "ManufacturedHousing",
  "ManufacturedHousingSingleWide",
  "Modular",
]);

const BUILD_STATUS_ENUM = new Set(["VacantLand", "Improved", "UnderConstruction"]);

const OWNERSHIP_ESTATE_ENUM = new Set([
  "Condominium",
  "Cooperative",
  "LifeEstate",
  "Timeshare",
  "OtherEstate",
  "FeeSimple",
  "Leasehold",
  "RightOfWay",
  "NonWarrantableCondo",
  "SubsurfaceRights",
]);

const PROPERTY_USAGE_ENUM = new Set([
  "Residential",
  "Commercial",
  "Industrial",
  "Agricultural",
  "Recreational",
  "Conservation",
  "Retirement",
  "ResidentialCommonElementsAreas",
  "DrylandCropland",
  "HayMeadow",
  "CroplandClass2",
  "CroplandClass3",
  "TimberLand",
  "GrazingLand",
  "OrchardGroves",
  "Poultry",
  "Ornamentals",
  "Church",
  "PrivateSchool",
  "PrivateHospital",
  "HomesForAged",
  "NonProfitCharity",
  "MortuaryCemetery",
  "ClubsLodges",
  "SanitariumConvalescentHome",
  "CulturalOrganization",
  "Military",
  "ForestParkRecreation",
  "PublicSchool",
  "PublicHospital",
  "GovernmentProperty",
  "RetailStore",
  "DepartmentStore",
  "Supermarket",
  "ShoppingCenterRegional",
  "ShoppingCenterCommunity",
  "OfficeBuilding",
  "MedicalOffice",
  "TransportationTerminal",
  "Restaurant",
  "FinancialInstitution",
  "ServiceStation",
  "AutoSalesRepair",
  "MobileHomePark",
  "WholesaleOutlet",
  "Theater",
  "Entertainment",
  "Hotel",
  "RaceTrack",
  "GolfCourse",
  "LightManufacturing",
  "HeavyManufacturing",
  "LumberYard",
  "PackingPlant",
  "Cannery",
  "MineralProcessing",
  "Warehouse",
  "OpenStorage",
  "Utility",
  "RiversLakes",
  "SewageDisposal",
  "Railroad",
  "TransitionalProperty",
  "ReferenceParcel",
  "NurseryGreenhouse",
  "AgriculturalPackingFacility",
  "LivestockFacility",
  "Aquaculture",
  "VineyardWinery",
  "DataCenter",
  "TelecommunicationsFacility",
  "SolarFarm",
  "WindFarm",
  "NativePasture",
  "ImprovedPasture",
  "Rangeland",
  "PastureWithTimber",
  "Unknown",
]);

function coerceEnum(value, allowedSet) {
  if (value == null) return null;
  return allowedSet.has(value) ? value : null;
}

function normalizePropertyMapping(rawMapping) {
  if (!rawMapping || typeof rawMapping !== "object") return {};

  const normalized = { ...rawMapping };

  normalized.ownership_estate_type = coerceEnum(
    normalized.ownership_estate_type,
    OWNERSHIP_ESTATE_ENUM,
  );

  normalized.build_status = coerceEnum(
    normalized.build_status,
    BUILD_STATUS_ENUM,
  );

  normalized.structure_form = coerceEnum(
    normalized.structure_form,
    STRUCTURE_FORM_ENUM,
  );

  normalized.property_usage_type = coerceEnum(
    normalized.property_usage_type,
    PROPERTY_USAGE_ENUM,
  );

  const legacyType = normalized.property_type;
  if (legacyType == null) {
    normalized.property_type = null;
  } else if (PROPERTY_TYPE_ENUM.has(legacyType)) {
    normalized.property_type = legacyType;
  } else if (Object.prototype.hasOwnProperty.call(LEGACY_PROPERTY_TYPE_TO_ELEPHANT, legacyType)) {
    normalized.property_type =
      LEGACY_PROPERTY_TYPE_TO_ELEPHANT[legacyType] || null;
  } else {
    normalized.property_type = null;
  }

  return normalized;
}

function mapPropertyType(stLuciePropertyType) {
  // Extract only the number part from the st_lucie_property_type string
  const codeMatch = stLuciePropertyType ? stLuciePropertyType.match(/^(\d{4})/) : null;
  const code = codeMatch ? codeMatch[1] : null;

  if (!code) return {}; // Return empty object if no code found

  // Find mapping by matching the extracted code with the start of the mapping's st_lucie_property_type
  const mapping = propertyTypeMapping.find(
    (item) => item.st_lucie_property_type.startsWith(code)
  );
  return normalizePropertyMapping(mapping);
}

async function main() {
  ensureDirSync("data");
  await removeExisting(/^error\.json$/);

  const inputHtmlRaw = await fsp.readFile("input.html", "utf8");

  let inputAsJson = null;
  try {
    inputAsJson = JSON.parse(inputHtmlRaw);
  } catch {}
  const isMulti = detectMultiRequest(inputAsJson);

  // Initialize cheerio here, before any potential usage
  const $ = isMulti ? null : cheerio.load(inputHtmlRaw);

  // Removed addressPath and parcelPath as input files
  const ownersDir = "owners";
  const ownerDataPath = path.join(ownersDir, "owner_data.json");
  const utilitiesDataPath = path.join(ownersDir, "utilities_data.json");
  const layoutDataPath = path.join(ownersDir, "layout_data.json");
  const structureDataPath = path.join(ownersDir, "structure_data.json");
  const unnormalizedAddressPath = "unnormalized_address.json";
  const propertySeedPath = "property_seed.json"; // Added property_seed.json

  // Removed readJson(addressPath) and readJson(parcelPath)
  const ownerData = await readJson(ownerDataPath).catch(() => null);
  const utilitiesData = await readJson(utilitiesDataPath).catch(() => null);
  const layoutData = await readJson(layoutDataPath).catch(() => null);
  const structureData = await readJson(structureDataPath).catch(() => null);
  const unnormalizedAddressData = await readJson(unnormalizedAddressPath).catch(() => null);
  const propertySeedData = await readJson(propertySeedPath).catch(() => null); // Read property_seed.json

  const propertyRef = "./property.json";
  const addressFileName = "address.json";

  // Base data for address output, derived from property_seed or unnormalized_address
  const baseRequestData = propertySeedData || unnormalizedAddressData || {};

  await removeExisting(/^property_improvement_.*\.json$/);
  await removeExisting(/^relationship_property_has_property_improvement_.*\.json$/);
  await removeExisting(/^relationship_property_has_address.*\.json$/);
  await removeExisting(/^relationship_address_has_fact_sheet.*\.json$/);
  await removeExisting(/^relationship_person_.*_has_fact_sheet.*\.json$/);
  await removeExisting(/^address\.json$/);
  await removeExisting(/^mailing_address\.json$/);
  const propertyImprovementRecords = [];


  // --- Address extraction ---
  let siteAddress = null;
  let secTownRange = null;
  let jurisdiction = null;
  let parcelIdentifierDashed = null;

  let township = null;
  let range = null;
  let section = null;
  if (!isMulti) {
    $("article#property-identification table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      if (/Site Address/i.test(th)) {
        siteAddress = textClean($(tr).find("td").text());
      } else if (/Sec\/Town\/Range/i.test(th)) {
        secTownRange = textClean($(tr).find("td").text());
      } else if (/Jurisdiction/i.test(th)) {
        jurisdiction = textClean($(tr).find("td").text());
      } else if (/Parcel ID/i.test(th)) {
        parcelIdentifierDashed = textClean($(tr).find("td").text());
      }
    });
  }

  const countySource =
    (unnormalizedAddressData && unnormalizedAddressData.county_jurisdiction) ||
    jurisdiction ||
    null;
  const normalizedCounty = normalizeCountyName(countySource) || "St. Lucie";
  const addressMetadata = {
    county_name: normalizedCounty,
    latitude:
      unnormalizedAddressData && unnormalizedAddressData.latitude != null
        ? unnormalizedAddressData.latitude
        : null,
    longitude:
      unnormalizedAddressData && unnormalizedAddressData.longitude != null
        ? unnormalizedAddressData.longitude
        : null,
  };

  const normalizedAddressSourceRaw =
    (baseRequestData && baseRequestData.normalized_address) ||
    (unnormalizedAddressData && unnormalizedAddressData.normalized_address) ||
    null;

  const structuredAddressSource =
    normalizedAddressSourceRaw && typeof normalizedAddressSourceRaw === "object"
      ? normalizedAddressSourceRaw
      : null;

  let unnormalizedAddressCandidate =
    (unnormalizedAddressData &&
      (unnormalizedAddressData.unnormalized_address ||
        unnormalizedAddressData.full_address)) ||
    null;

  if (
    !unnormalizedAddressCandidate &&
    baseRequestData &&
    typeof baseRequestData === "object"
  ) {
    const baseUnnormalized =
      baseRequestData.unnormalized_address ||
      baseRequestData.full_address ||
      baseRequestData.mailing_address ||
      null;
    if (baseUnnormalized) {
      unnormalizedAddressCandidate = baseUnnormalized;
    }
  }

  if (!unnormalizedAddressCandidate && siteAddress) {
    unnormalizedAddressCandidate = siteAddress;
  }

  if (secTownRange) {
    const strMatch = secTownRange.match(/^(\d+)\/(\d+[NS])\/(\d+[EW])$/i);
    if (strMatch) {
      section = strMatch[1];
      township = strMatch[2];
      range = strMatch[3];
    }
  }

  if (township) addressMetadata.township = township;
  if (range) addressMetadata.range = range;
  if (section) addressMetadata.section = section;

  const cleanedAddressMetadata = {};
  for (const key of ADDRESS_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(addressMetadata, key)) continue;
    const rawValue = addressMetadata[key];
    if (rawValue == null) continue;
    if (typeof rawValue === "string") {
      const cleaned = textClean(rawValue);
      if (!cleaned) continue;
      cleanedAddressMetadata[key] = cleaned;
    } else {
      cleanedAddressMetadata[key] = rawValue;
    }
  }

  const normalizedUnnormalized = normalizeUnnormalizedAddressValue(
    unnormalizedAddressCandidate,
  );

  const structuredCandidate =
    structuredAddressSource && typeof structuredAddressSource === "object"
      ? pickStructuredAddress(structuredAddressSource)
      : null;

  const hasUnnormalizedSource = Boolean(
    normalizedUnnormalized ||
      (typeof unnormalizedAddressCandidate === "string" &&
        unnormalizedAddressCandidate.trim()) ||
      (baseRequestData &&
        typeof baseRequestData === "object" &&
        typeof baseRequestData.unnormalized_address === "string" &&
        baseRequestData.unnormalized_address.trim()) ||
      (unnormalizedAddressData &&
        typeof unnormalizedAddressData === "object" &&
        typeof unnormalizedAddressData.unnormalized_address === "string" &&
        unnormalizedAddressData.unnormalized_address.trim()),
  );

  const preferredAddressMode = hasUnnormalizedSource
    ? "unnormalized"
    : structuredCandidate
      ? "structured"
      : "unnormalized";

  const requestIdentifierValue =
    baseRequestData && baseRequestData.request_identifier
      ? baseRequestData.request_identifier
      : null;

  const addressRecordPayload =
    buildAddressRecord({
      structuredAddress: structuredCandidate,
      unnormalizedValue: unnormalizedAddressCandidate,
      metadata: cleanedAddressMetadata,
      requestIdentifier: requestIdentifierValue,
      preferMode: preferredAddressMode,
    }) ||
    createAddressPayload({
      structuredSource: structuredCandidate,
      unnormalizedValue: unnormalizedAddressCandidate,
      metadata: cleanedAddressMetadata,
      requestIdentifier: requestIdentifierValue,
      preferStructured: preferredAddressMode === "structured",
    });

  let finalAddressOutput = null;
  if (addressRecordPayload) {
    const preparedAddress =
      prepareAddressForWrite(addressRecordPayload, {
        fallbackUnnormalized: unnormalizedAddressCandidate,
        preferMode: preferredAddressMode,
      }) || ensureExclusiveAddressMode(addressRecordPayload);

    const candidateForFinalize = preparedAddress || addressRecordPayload;
    const fallbackForUnnormalized =
      preferredAddressMode === "structured" ? null : unnormalizedAddressCandidate;

    finalAddressOutput =
      finalizeAddressOutputForSchema(
        candidateForFinalize,
        fallbackForUnnormalized,
      ) ||
      buildSchemaCompliantAddress(
        candidateForFinalize,
        fallbackForUnnormalized,
      );

    if (!finalAddressOutput && preparedAddress) {
      const resolution = resolveAddressForOutput(
        preparedAddress,
        preferredAddressMode,
      );
      const finalizedResolution = finalizeResolvedAddressPayload(
        resolution,
        preferredAddressMode,
      );
      if (finalizedResolution && finalizedResolution.payload) {
        finalAddressOutput = finalizeAddressOutputForSchema(
          finalizedResolution.payload,
          fallbackForUnnormalized,
        );
      }
    }

    if (!finalAddressOutput) {
      const resolution = resolveAddressForOutput(
        addressRecordPayload,
        preferredAddressMode,
      );
      const finalizedResolution = finalizeResolvedAddressPayload(
        resolution,
        preferredAddressMode,
      );
      if (finalizedResolution && finalizedResolution.payload) {
        finalAddressOutput = finalizeAddressOutputForSchema(
          finalizedResolution.payload,
          fallbackForUnnormalized,
        );
      }
    }
  }

  if (!finalAddressOutput && normalizedUnnormalized) {
    const fallbackAddress = {
      ...cleanedAddressMetadata,
      unnormalized_address: normalizedUnnormalized,
    };
    if (requestIdentifierValue) {
      fallbackAddress.request_identifier = requestIdentifierValue;
    }
    finalAddressOutput = enforcePreferredAddressMode(
      ensureExclusiveAddressMode(fallbackAddress) || fallbackAddress,
      "unnormalized",
    );
  }

  if (finalAddressOutput) {
    const enforcedFallback =
      preferredAddressMode === "structured"
        ? null
        : normalizedUnnormalized || unnormalizedAddressCandidate || null;
    const preferenced = enforceAddressModePreference(
      finalAddressOutput,
      enforcedFallback,
    );
    const sanitizedCandidate = sanitizeAddressForSchema(
      preferenced || finalAddressOutput,
      preferredAddressMode,
    );
    finalAddressOutput = enforcePreferredAddressMode(
      sanitizedCandidate || preferenced,
      preferredAddressMode,
    );
  }

  if (
    (!finalAddressOutput || Object.keys(finalAddressOutput).length === 0) &&
    normalizedUnnormalized
  ) {
    const fallbackAddressCandidate = {
      ...cleanedAddressMetadata,
      unnormalized_address: normalizedUnnormalized,
    };
    if (requestIdentifierValue != null) {
      fallbackAddressCandidate.request_identifier = requestIdentifierValue;
    }
    finalAddressOutput = enforcePreferredAddressMode(
      sanitizeAddressForSchema(
        fallbackAddressCandidate,
        "unnormalized",
      ) || fallbackAddressCandidate,
      "unnormalized",
    );
  }

  if (finalAddressOutput) {
    const preferredFinal =
      finalizeAddressForSchemaOutput(
        finalAddressOutput,
        preferredAddressMode,
      ) ||
      finalizeAddressForSchemaOutput(
        finalAddressOutput,
        normalizedUnnormalized ? "unnormalized" : "structured",
      ) ||
      finalizeAddressForSchemaOutput(finalAddressOutput, "unnormalized") ||
      finalizeAddressForSchemaOutput(finalAddressOutput, "structured");
    finalAddressOutput = preferredFinal || null;
  }

  const fallbackUnnormalizedValue =
    normalizedUnnormalized || unnormalizedAddressCandidate || null;

  let addressForWrite =
    finalAddressOutput && typeof finalAddressOutput === "object"
      ? buildAddressRecordForSchema({
          addressCandidate: finalAddressOutput,
          structuredFallback: structuredCandidate,
          metadataSources: [cleanedAddressMetadata, finalAddressOutput],
          fallbackUnnormalized: fallbackUnnormalizedValue,
          requestIdentifier: requestIdentifierValue,
        })
      : null;

  if (!addressForWrite && structuredCandidate) {
    addressForWrite = buildAddressRecordForSchema({
      addressCandidate: structuredCandidate,
      structuredFallback: structuredCandidate,
      metadataSources: [cleanedAddressMetadata, structuredCandidate],
      fallbackUnnormalized: fallbackUnnormalizedValue,
      requestIdentifier: requestIdentifierValue,
    });
  }

  if (!addressForWrite && fallbackUnnormalizedValue) {
    addressForWrite = buildAddressRecordForSchema({
      addressCandidate: { unnormalized_address: fallbackUnnormalizedValue },
      metadataSources: [cleanedAddressMetadata],
      fallbackUnnormalized: fallbackUnnormalizedValue,
      requestIdentifier: requestIdentifierValue,
    });
  }

  if (
    addressForWrite &&
    typeof addressForWrite === "object" &&
    Object.keys(addressForWrite).length > 0
  ) {
    const normalizedAddress = normalizeAddressPayloadForSchema(
      addressForWrite,
      preferredAddressMode,
      fallbackUnnormalizedValue,
    );

    if (normalizedAddress) {
      addressForWrite = normalizedAddress;
    } else if (fallbackUnnormalizedValue) {
      const fallbackAddress = {
        ...cleanedAddressMetadata,
        unnormalized_address: fallbackUnnormalizedValue,
      };
      if (requestIdentifierValue != null) {
        fallbackAddress.request_identifier = requestIdentifierValue;
      }
      addressForWrite =
        normalizeAddressPayloadForSchema(
          fallbackAddress,
          "unnormalized",
          fallbackUnnormalizedValue,
        ) || null;
    } else {
      addressForWrite = null;
    }
  }

  const addressCandidateForOutput = addressForWrite;
  const structuredSourcesForAddress = [
    addressCandidateForOutput,
    finalAddressOutput,
    addressRecordPayload,
    structuredCandidate,
  ].filter((source) => source && typeof source === "object");

  const unnormalizedCandidatesForAddress = [];
  if (
    addressCandidateForOutput &&
    typeof addressCandidateForOutput === "object" &&
    Object.prototype.hasOwnProperty.call(
      addressCandidateForOutput,
      "unnormalized_address",
    )
  ) {
    unnormalizedCandidatesForAddress.push(
      addressCandidateForOutput.unnormalized_address,
    );
  }
  if (
    finalAddressOutput &&
    typeof finalAddressOutput === "object" &&
    Object.prototype.hasOwnProperty.call(
      finalAddressOutput,
      "unnormalized_address",
    )
  ) {
    unnormalizedCandidatesForAddress.push(
      finalAddressOutput.unnormalized_address,
    );
  }
  if (fallbackUnnormalizedValue) {
    unnormalizedCandidatesForAddress.push(fallbackUnnormalizedValue);
  }
  if (normalizedUnnormalized && normalizedUnnormalized !== fallbackUnnormalizedValue) {
    unnormalizedCandidatesForAddress.push(normalizedUnnormalized);
  }
  if (
    unnormalizedAddressCandidate &&
    (!normalizedUnnormalized ||
      normalizeUnnormalizedAddressValue(unnormalizedAddressCandidate) !==
        normalizedUnnormalized)
  ) {
    unnormalizedCandidatesForAddress.push(unnormalizedAddressCandidate);
  }

  addressForWrite = buildPreferredSchemaAddressPayload({
    candidate: addressCandidateForOutput,
    structuredSources: structuredSourcesForAddress,
    unnormalizedCandidates: unnormalizedCandidatesForAddress,
    metadataSources: [cleanedAddressMetadata, addressRecordPayload, finalAddressOutput],
    requestIdentifier: requestIdentifierValue,
    preferStructured: preferredAddressMode === "structured",
  });

  let addressFileRef = null;
  if (addressForWrite && typeof addressForWrite === "object") {
    const finalizedAddress = finalizeAddressPayloadForWrite(addressForWrite);
    const fallbackForProjection =
      preferredAddressMode === "structured" ? null : fallbackUnnormalizedValue;
    const projectedAddress = projectAddressPayloadToSchema(
      finalizedAddress || addressForWrite,
      {
        fallbackUnnormalized: fallbackForProjection,
        structuredFallback: structuredCandidate,
        metadataSources: [
          cleanedAddressMetadata,
          addressRecordPayload,
          finalAddressOutput,
          addressForWrite,
        ],
        requestIdentifier: requestIdentifierValue,
      },
    );

    if (
      projectedAddress &&
      typeof projectedAddress === "object" &&
      Object.keys(projectedAddress).length > 0
    ) {
      const oneOfSafeAddress = coerceAddressToSingleMode(
        projectedAddress,
        fallbackUnnormalizedValue,
      );
      if (
        oneOfSafeAddress &&
        typeof oneOfSafeAddress === "object" &&
        Object.keys(oneOfSafeAddress).length > 0
      ) {
        let normalizedAddressForWrite = deepClone(oneOfSafeAddress);
        if (
          normalizedAddressForWrite &&
          typeof normalizedAddressForWrite === "object"
        ) {
          const normalizedPrimaryUnnormalized = normalizeUnnormalizedAddressValue(
            Object.prototype.hasOwnProperty.call(
              normalizedAddressForWrite,
              "unnormalized_address",
            )
              ? normalizedAddressForWrite.unnormalized_address
              : null,
          );
          if (normalizedPrimaryUnnormalized) {
            normalizedAddressForWrite.unnormalized_address =
              normalizedPrimaryUnnormalized;
            stripStructuredAddressFields(normalizedAddressForWrite);
          } else {
            const hasStructuredForWrite = STRUCTURED_ADDRESS_REQUIRED_KEYS.every(
              (key) => {
                if (
                  !Object.prototype.hasOwnProperty.call(
                    normalizedAddressForWrite,
                    key,
                  )
                ) {
                  return false;
                }
                const value = normalizedAddressForWrite[key];
                if (value == null) return false;
                if (typeof value === "string") {
                  const trimmed = value.trim();
                  if (!trimmed) return false;
                  if (key === "city_name" || key === "state_code") {
                    normalizedAddressForWrite[key] = trimmed.toUpperCase();
                  } else if (
                    key === "postal_code" ||
                    key === "plus_four_postal_code"
                  ) {
                    normalizedAddressForWrite[key] = trimmed.replace(/\s+/g, "");
                  } else {
                    normalizedAddressForWrite[key] = trimmed;
                  }
                }
                return true;
              },
            );

            if (hasStructuredForWrite) {
              delete normalizedAddressForWrite.unnormalized_address;
              for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
                if (
                  !Object.prototype.hasOwnProperty.call(
                    normalizedAddressForWrite,
                    key,
                  )
                ) {
                  continue;
                }
                const optionalValue = normalizedAddressForWrite[key];
                if (optionalValue == null) {
                  delete normalizedAddressForWrite[key];
                  continue;
                }
                if (typeof optionalValue === "string") {
                  const trimmedOptional = optionalValue.trim();
                  if (!trimmedOptional) {
                    delete normalizedAddressForWrite[key];
                    continue;
                  }
                  if (key === "city_name" || key === "state_code") {
                    normalizedAddressForWrite[key] = trimmedOptional.toUpperCase();
                  } else if (
                    key === "postal_code" ||
                    key === "plus_four_postal_code"
                  ) {
                    normalizedAddressForWrite[key] =
                      trimmedOptional.replace(/\s+/g, "");
                  } else {
                    normalizedAddressForWrite[key] = trimmedOptional;
                  }
                }
              }
            } else {
              const fallbackUnnormalizedForWrite =
                normalizeUnnormalizedAddressValue(
                  fallbackUnnormalizedValue != null
                    ? fallbackUnnormalizedValue
                    : normalizedUnnormalized,
                );
              if (fallbackUnnormalizedForWrite) {
                stripStructuredAddressFields(normalizedAddressForWrite);
                normalizedAddressForWrite.unnormalized_address =
                  fallbackUnnormalizedForWrite;
              } else {
                normalizedAddressForWrite = null;
              }
            }
        }
      }

      if (
        normalizedAddressForWrite &&
        typeof normalizedAddressForWrite === "object"
      ) {
        const exclusiveNormalized = enforceSingleAddressModeForWrite(
          normalizedAddressForWrite,
          preferredAddressMode === "structured",
        );
        if (exclusiveNormalized) {
          normalizedAddressForWrite = exclusiveNormalized;
        }
      }

      if (
        normalizedAddressForWrite &&
        typeof normalizedAddressForWrite === "object" &&
        Object.keys(normalizedAddressForWrite).length > 0
      ) {
        const finalAddressPayload = normalizeFinalAddressForWrite(
          normalizedAddressForWrite,
        );
        if (
          finalAddressPayload &&
          typeof finalAddressPayload === "object" &&
          Object.keys(finalAddressPayload).length > 0
        ) {
          const schemaSafeAddress = enforceAddressOneOfForWrite(
            finalAddressPayload,
            preferredAddressMode === "structured" ? "structured" : "unnormalized",
          );
          if (
            schemaSafeAddress &&
            typeof schemaSafeAddress === "object" &&
            Object.keys(schemaSafeAddress).length > 0
          ) {
            const finalAddressForFile = buildFinalAddressRecord(
              schemaSafeAddress,
              preferredAddressMode === "structured",
            );
            if (
              finalAddressForFile &&
              typeof finalAddressForFile === "object" &&
              Object.keys(finalAddressForFile).length > 0
            ) {
              const preferModeForWrite =
                preferredAddressMode === "structured" ? "structured" : "unnormalized";
              const fallbackForOneOf =
                normalizeUnnormalizedAddressValue(
                  normalizedUnnormalized ||
                    fallbackUnnormalizedValue ||
                    unnormalizedAddressCandidate,
                ) || null;

              const coercedFinalAddress =
                coerceAddressToSingleMode(
                  finalAddressForFile,
                  fallbackForOneOf,
                ) || finalAddressForFile;

              const sanitizedFinalAddress =
                sanitizeAddressForSchema(coercedFinalAddress, preferModeForWrite) ||
                enforceAddressOneOfForWrite(coercedFinalAddress, preferModeForWrite) ||
                sanitizeAddressForSchema(
                  coercedFinalAddress,
                  preferModeForWrite === "structured" ? "unnormalized" : "structured",
                ) ||
                enforceAddressOneOfForWrite(
                  coercedFinalAddress,
                  preferModeForWrite === "structured" ? "unnormalized" : "structured",
                );

              const normalizedFinalAddress =
                sanitizedFinalAddress
                  ? coerceAddressToSingleMode(
                      sanitizedFinalAddress,
                      fallbackForOneOf,
                    ) || sanitizedFinalAddress
                  : null;

              if (
                normalizedFinalAddress &&
                typeof normalizedFinalAddress === "object" &&
                Object.keys(normalizedFinalAddress).length > 0
              ) {
                addressForWrite = normalizedFinalAddress;
                await fsp.writeFile(
                  path.join("data", addressFileName),
                  JSON.stringify(addressForWrite, null, 2),
                );
                addressFileRef = `./${addressFileName}`;
              } else {
                addressForWrite = null;
              }
            } else {
              addressForWrite = null;
            }
          } else {
            addressForWrite = null;
          }
        } else {
          addressForWrite = null;
        }
      } else {
        addressForWrite = null;
      }
    } else {
      addressForWrite = null;
    }
  }

  if (addressFileRef) {
    const addressPath = path.join("data", addressFileName);
    try {
      const rawAddress = await fsp.readFile(addressPath, "utf8");
      const parsedAddress = JSON.parse(rawAddress);
      const sanitizedAddress = buildSchemaReadyAddress({
        requestIdentifier:
          parsedAddress.request_identifier ??
          requestIdentifierValue ??
          addressRecordPayload?.request_identifier ??
          null,
        metadataSources: [
          cleanedAddressMetadata,
          parsedAddress,
          addressRecordPayload,
          finalAddressOutput,
          addressForWrite,
        ],
        structuredSources: [
          parsedAddress,
          structuredCandidate,
          finalAddressOutput,
          addressRecordPayload,
          addressForWrite,
          structuredAddressSource,
        ],
        unnormalizedCandidates: [
          parsedAddress.unnormalized_address,
          normalizedUnnormalized,
          fallbackUnnormalizedValue,
          unnormalizedAddressCandidate,
          finalAddressOutput?.unnormalized_address,
          addressRecordPayload?.unnormalized_address,
        ],
        preferStructured: Boolean(structuredCandidate),
      });
      if (sanitizedAddress) {
        await fsp.writeFile(
          addressPath,
          JSON.stringify(sanitizedAddress, null, 2),
        );
      } else {
        await fsp.unlink(addressPath).catch(() => {});
        addressFileRef = null;
      }
    } catch {
      addressFileRef = null;
    }
  }

  if (!addressFileRef) {
    const fallbackAddressRecord = buildSchemaReadyAddress({
      requestIdentifier: requestIdentifierValue,
      metadataSources: [
        cleanedAddressMetadata,
        addressRecordPayload,
        finalAddressOutput,
        addressForWrite,
      ],
      structuredSources: [
        structuredCandidate,
        structuredAddressSource,
        finalAddressOutput,
        addressRecordPayload,
        addressForWrite,
      ],
      unnormalizedCandidates: [
        normalizedUnnormalized,
        unnormalizedAddressCandidate,
        fallbackUnnormalizedValue,
        baseRequestData?.unnormalized_address,
        baseRequestData?.full_address,
        baseRequestData?.mailing_address,
        unnormalizedAddressData?.unnormalized_address,
        unnormalizedAddressData?.full_address,
        siteAddress,
      ],
      preferStructured: Boolean(structuredCandidate),
    });
    if (fallbackAddressRecord) {
      await fsp.writeFile(
        path.join("data", addressFileName),
        JSON.stringify(fallbackAddressRecord, null, 2),
      );
      addressFileRef = `./${addressFileName}`;
    }
  }

  const combinedStructuredSources = [
    ...structuredSourcesForAddress,
    structuredAddressSource,
    normalizedAddressSourceRaw,
    baseRequestData?.normalized_address,
    propertySeedData?.normalized_address,
  ].filter((source) => source && typeof source === "object");

  const combinedUnnormalizedCandidates = [
    ...unnormalizedCandidatesForAddress,
    normalizedUnnormalized,
    unnormalizedAddressCandidate,
    fallbackUnnormalizedValue,
    baseRequestData,
    baseRequestData?.unnormalized_address,
    baseRequestData?.full_address,
    baseRequestData?.mailing_address,
    propertySeedData,
    propertySeedData?.unnormalized_address,
    propertySeedData?.full_address,
    unnormalizedAddressData,
    unnormalizedAddressData?.unnormalized_address,
    unnormalizedAddressData?.full_address,
    siteAddress,
  ];

  const addressMetadataSources = [
    cleanedAddressMetadata,
    addressRecordPayload,
    finalAddressOutput,
    addressForWrite,
    baseRequestData,
    propertySeedData,
    unnormalizedAddressData,
  ];

  const simplifiedAddress = buildBasicAddressRecord({
    structuredSources: combinedStructuredSources,
    unnormalizedCandidates: combinedUnnormalizedCandidates,
    metadata: addressMetadataSources,
    requestIdentifier: requestIdentifierValue,
  });

  const addressPath = path.join("data", addressFileName);
  const exclusiveSimplifiedAddress =
    simplifiedAddress && typeof simplifiedAddress === "object"
      ? coerceAddressToSingleMode(
          simplifiedAddress,
          fallbackUnnormalizedValue,
        ) || simplifiedAddress
      : null;

  if (exclusiveSimplifiedAddress) {
    await fsp.writeFile(
      addressPath,
      JSON.stringify(exclusiveSimplifiedAddress, null, 2),
    );
    addressFileRef = `./${addressFileName}`;
  } else {
    await fsp.unlink(addressPath).catch(() => {});
    addressFileRef = null;
  }

  if (addressFileRef) {
    const preferStructuredMode = Boolean(structuredCandidate);
    const enforcedAddress = await enforceAddressFileOneOf(
      addressFileName,
      preferStructuredMode ? "structured" : "unnormalized",
    );
    if (!enforcedAddress) {
      await fsp.unlink(addressPath).catch(() => {});
      addressFileRef = null;
    } else {
      const normalizedAddress = await enforceAddressOutputMode(
        addressFileName,
        preferStructuredMode,
        fallbackUnnormalizedValue,
      );
      if (!normalizedAddress) {
        await fsp.unlink(addressPath).catch(() => {});
        addressFileRef = null;
      } else {
        await enforceAddressPreferredDataMode(addressFileName);
      }
    }
  }

  // --- Parcel extraction ---
  // parcelIdentifierDashed is already extracted from HTML
  const parcelOut = {
    request_identifier: baseRequestData.request_identifier || null,
    parcel_identifier: parcelIdentifierDashed || null,
  };
  await fsp.writeFile(
    path.join("data", "parcel.json"),
    JSON.stringify(parcelOut, null, 2),
  );

  // --- Property extraction ---
  let propertyOut = null;
  if (!isMulti) {
    // Legal description
    let legalDescription = null;
    const legalSectionDiv = $("article#property-identification .section-title")
      .filter((i, el) => /Legal Description/i.test(textClean($(el).text())))
      .first();
    if (legalSectionDiv && legalSectionDiv.length) {
      const p = legalSectionDiv.next(".bottom-text").find("p").first();
      legalDescription = textClean(p.text());
    }

    // Zoning
    let zoningVal = null;
    $("article#property-identification table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      const td = textClean($(tr).find("td").text());
      if (/Zoning/i.test(th)) zoningVal = td;
    });

    // Land Use Code
    let landUseCodeText = null;
    $("article#property-identification table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      const td = textClean($(tr).find("td").text());
      if (/Land Use Code/i.test(th))
        landUseCodeText = td;
    });

    // Building Type from HTML (This is not directly used in the mapping, but kept for completeness if needed elsewhere)
    let buildingType = null;
    $("article#building-info table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      const td = textClean($(tr).find("td").text());
      if (/Building Type/i.test(th)) {
        buildingType = td;
      }
    });

    const mappedPropertyDetails = mapPropertyType(landUseCodeText);

    // Number of Units
    let numberOfUnits = null;
    $("article#building-info table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      if (/Number of Units/i.test(th)) {
        const v = textClean($(tr).find("td").text());
        const n = parseInt(v.replace(/[^0-9\-]/g, ""), 10);
        if (!isNaN(n)) numberOfUnits = n;
      }
    });

    // Areas from Total Areas table
    let landAcres = null;
    let landSqft = null;
    $(
      "article#property-identification .area-container table.container tr",
    ).each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      const td = textClean($(tr).find("td").text());
      if (/Land Size \(acres\)/i.test(th)) landAcres = td || null;
      if (/Land Size \(SF\)/i.test(th)) landSqft = td || null;
    });

    propertyOut = {
      request_identifier: baseRequestData.request_identifier || null,
      parcel_identifier: parcelIdentifierDashed || null, // Use the extracted parcel ID
      property_legal_description_text: legalDescription || null,
      property_type: mappedPropertyDetails.property_type || "LandParcel", // Default if not found
      property_usage_type: mappedPropertyDetails.property_usage_type || null,
      zoning: zoningVal || null,
      number_of_units: typeof numberOfUnits === "number" ? numberOfUnits : null,
      build_status: mappedPropertyDetails.build_status || "VacantLand",
      area_under_air: null,
      livable_floor_area: null,
      total_area: null,
      subdivision: null,
      structure_form: mappedPropertyDetails.structure_form || null,
      ownership_estate_type: mappedPropertyDetails.ownership_estate_type || null,
      property_structure_built_year: null,
      property_effective_built_year: null,
      historic_designation: false,
    };

    await fsp.writeFile(
      path.join("data", "property.json"),
      JSON.stringify(propertyOut, null, 2),
    );

    if (addressFileRef) {
      await writeRelationshipFile(
        "relationship_property_has_address.json",
        propertyRef,
        addressFileRef,
      );
      await writeRelationshipFile(
        "relationship_address_has_fact_sheet.json",
        addressFileRef,
        propertyRef,
      );
    }

    // Lot data

    const lotOut = {
      request_identifier: baseRequestData.request_identifier || null,
      lot_type: null,
      lot_length_feet: null,
      lot_width_feet: null,
      lot_area_sqft: null,
      landscaping_features: null,
      view: null,
      fencing_type: null,
      fence_height: null,
      fence_length: null,
      driveway_material: null,
      driveway_condition: null,
      lot_condition_issues: null,
      lot_size_acre: null,
    };
    if (landAcres) {
      const n = Number(String(landAcres).replace(/[^0-9.\-]/g, ""));
      if (isFinite(n)) lotOut.lot_size_acre = n;
    }
    if (landSqft) {
      const n = Number(String(landSqft).replace(/[^0-9.\-]/g, ""));
      if (isFinite(n)) lotOut.lot_area_sqft = Math.round(n);
    }
    await fsp.writeFile(
      path.join("data", "lot.json"),
      JSON.stringify(lotOut, null, 2),
    );


    const permitRows = $("article#permit-info table tbody tr").toArray();
    let propertyImprovementIdx = 0;
    for (const row of permitRows) {
      const cells = $(row).find("th, td");
      if (!cells || cells.length === 0) continue;

      const permitNumber = textClean($(cells[0]).text());
      const issueDateText = textClean($(cells[1]).text());
      const descriptionText = textClean($(cells[2]).text());

      if (!permitNumber && !issueDateText && !descriptionText) continue;

      propertyImprovementIdx += 1;
      const improvementFile = `property_improvement_${propertyImprovementIdx}.json`;
      const permitIssueDate = parseDateToISO(issueDateText);
      const improvementType = mapImprovementType(permitNumber, descriptionText);
      const improvementAction = mapImprovementAction(descriptionText);

      const improvementOut = {
        request_identifier: baseRequestData.request_identifier || null,
        permit_number: permitNumber || null,
        permit_issue_date: permitIssueDate || null,
        permit_close_date: null,
        completion_date: null,
        final_inspection_date: null,
        application_received_date: null,
        improvement_type: improvementType || null,
        improvement_action: improvementAction || null,
        improvement_status: null,
        contractor_type: null,
        is_disaster_recovery: null,
        is_owner_builder: null,
        private_provider_inspections: null,
        private_provider_plan_review: null,
        permit_required: true,
      };

      await fsp.writeFile(
        path.join("data", improvementFile),
        JSON.stringify(improvementOut, null, 2),
      );

      propertyImprovementRecords.push({
        index: propertyImprovementIdx,
        file: improvementFile,
      });
    }
  }

  // --- Ownership and Sales Extraction ---
  const sales = [];
  let fileIdx = 0;

  if (!isMulti) {
    const ownerRecords = new Map();
    const ownerAliasToId = new Map();
    let ownerRecordSerial = 0;
    const ownerPropertyRoles = new Map();
    const currentOwnerRecordIds = new Set();
    const currentOwnerRecordsList = [];

    function getOwnerRecordByAlias(alias) {
      const key = normalizeOwnerKey(alias);
      if (!key) return null;
      const recordId = ownerAliasToId.get(key);
      if (!recordId) return null;
      return ownerRecords.get(recordId) || null;
    }

    function registerAlias(record, alias) {
      if (!record || !alias) return;
      const key = normalizeOwnerKey(alias);
      if (!key) return;
      if (!ownerAliasToId.has(key)) {
        ownerAliasToId.set(key, record.id);
      }
      record.aliases.add(key);
      if (!record.displayName) record.displayName = textClean(alias) || record.displayName;
    }

    function createOwnerRecord(type, initial = {}) {
      ownerRecordSerial += 1;
      const record = {
        id: `owner_${ownerRecordSerial}`,
        type,
        aliases: new Set(),
        displayName: initial.displayName || null,
        person:
          type === "person"
            ? {
                birth_date: initial.person?.birth_date ?? null,
                first_name: initial.person?.first_name ?? null,
                last_name: initial.person?.last_name ?? null,
                middle_name: initial.person?.middle_name ?? null,
                prefix_name: initial.person?.prefix_name ?? null,
                suffix_name: initial.person?.suffix_name ?? null,
                us_citizenship_status: initial.person?.us_citizenship_status ?? null,
                veteran_status: initial.person?.veteran_status ?? null,
                request_identifier: initial.person?.request_identifier ?? null,
              }
            : undefined,
        company:
          type === "company"
            ? {
                name: initial.company?.name ?? null,
                request_identifier: initial.company?.request_identifier ?? null,
              }
            : undefined,
      };
      ownerRecords.set(record.id, record);
      return record;
    }

    function ensureOwnerRecordFromOwnerData(ownerEntry) {
      if (!ownerEntry || typeof ownerEntry !== "object") return null;
      const ownerType = ownerEntry.type === "company" ? "company" : "person";
      if (ownerType === "person") {
        const rawPersonData = {
          birth_date: ownerEntry.birth_date ?? null,
          first_name: ownerEntry.first_name ?? null,
          last_name: ownerEntry.last_name ?? null,
          middle_name: ownerEntry.middle_name ?? null,
          prefix_name: ownerEntry.prefix_name ?? null,
          suffix_name: ownerEntry.suffix_name ?? null,
          us_citizenship_status: ownerEntry.us_citizenship_status ?? null,
          veteran_status: ownerEntry.veteran_status ?? null,
          request_identifier: ownerEntry.request_identifier ?? null,
        };
        const candidateDisplay =
          ownerEntry.full_name ||
          buildPersonDisplayName(rawPersonData) ||
          ownerEntry.name ||
          ownerEntry.raw_name ||
          null;

        const sanitizedPerson =
          sanitizePersonData(
            rawPersonData,
            candidateDisplay ||
              ownerEntry.raw_name ||
              ownerEntry.name ||
              null,
          ) || null;

        if (!sanitizedPerson) {
          const fallbackName =
            candidateDisplay ||
            ownerEntry.raw_name ||
            ownerEntry.name ||
            null;
          if (!fallbackName) return null;
          return ensureOwnerRecordFromOwnerData({
            type: "company",
            name: fallbackName,
            company_name: fallbackName,
            raw_name: ownerEntry.raw_name || fallbackName,
            request_identifier: ownerEntry.request_identifier ?? null,
          });
        }

        const primaryDisplay =
          buildPersonDisplayName(sanitizedPerson) ||
          candidateDisplay ||
          null;

        let record =
          (primaryDisplay ? getOwnerRecordByAlias(primaryDisplay) : null) ||
          (candidateDisplay && primaryDisplay !== candidateDisplay
            ? getOwnerRecordByAlias(candidateDisplay)
            : null);
        if (!record) {
          record = createOwnerRecord("person", {
            person: sanitizedPerson,
            displayName: primaryDisplay,
          });
        } else if (record.person) {
          for (const [k, v] of Object.entries(sanitizedPerson)) {
            if (record.person[k] == null && v != null) {
              record.person[k] = v;
            }
          }
          if (!record.displayName && primaryDisplay) {
            record.displayName = primaryDisplay;
          }
        }
        if (primaryDisplay) registerAlias(record, primaryDisplay);
        if (candidateDisplay && candidateDisplay !== primaryDisplay) {
          registerAlias(record, candidateDisplay);
        }
        if (ownerEntry.raw_name) registerAlias(record, ownerEntry.raw_name);
        if (!record.displayName) {
          record.displayName =
            buildPersonDisplayName(record.person) || record.displayName;
        }
        return record;
      }

      const companyData = {
        name:
          ownerEntry.name ??
          ownerEntry.company_name ??
          ownerEntry.full_name ??
          ownerEntry.raw_name ??
          null,
        request_identifier: ownerEntry.request_identifier ?? null,
      };
      const candidateDisplay = companyData.name || ownerEntry.raw_name || null;
      let record = candidateDisplay
        ? getOwnerRecordByAlias(candidateDisplay)
        : null;
      if (!record) {
        record = createOwnerRecord("company", {
          company: companyData,
          displayName: candidateDisplay,
        });
      } else if (record.company) {
        if (!record.company.name && companyData.name) {
          record.company.name = companyData.name;
        }
        if (
          record.company.request_identifier == null &&
          companyData.request_identifier != null
        ) {
          record.company.request_identifier = companyData.request_identifier;
        }
        if (!record.displayName && candidateDisplay) {
          record.displayName = candidateDisplay;
        }
      }
      if (companyData.name) registerAlias(record, companyData.name);
      if (ownerEntry.raw_name) registerAlias(record, ownerEntry.raw_name);
      if (!record.displayName && companyData.name) {
        record.displayName = companyData.name;
      }
      return record;
    }

    function ensureOwnerRecordFromName(name, options = {}) {
      const cleaned = textClean(name);
      if (!cleaned) return null;
      const existing = getOwnerRecordByAlias(cleaned);
      if (existing) {
        registerAlias(existing, cleaned);
        return existing;
      }
      if (options && options.assumeLastFirst) {
        const tokens = cleaned.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2) {
          const swappedTokens = [...tokens.slice(1), tokens[0]];
          const swappedCandidate = swappedTokens.join(" ");
          const swappedExisting = getOwnerRecordByAlias(swappedCandidate);
          if (swappedExisting) {
            registerAlias(swappedExisting, cleaned);
            return swappedExisting;
          }
        }
      }
      const ownerType = guessOwnerType(cleaned);
      if (ownerType === "company") {
        const record = createOwnerRecord("company", {
          company: { name: cleaned },
          displayName: cleaned,
        });
        registerAlias(record, cleaned);
        return record;
      }
      const parsed = parsePersonNameTokens(cleaned, options) || null;
      const sanitizedPerson =
        sanitizePersonData(
          {
            first_name: parsed?.first_name ?? null,
            last_name: parsed?.last_name ?? null,
            middle_name: parsed?.middle_name ?? null,
            birth_date: null,
            prefix_name: null,
            suffix_name: null,
            us_citizenship_status: null,
            veteran_status: null,
            request_identifier: null,
          },
          cleaned,
        ) || null;
      if (!sanitizedPerson) {
        const record = createOwnerRecord("company", {
          company: { name: cleaned },
          displayName: cleaned,
        });
        registerAlias(record, cleaned);
        return record;
      }
      const display =
        buildPersonDisplayName(sanitizedPerson) || cleaned;
      const record = createOwnerRecord("person", {
        person: sanitizedPerson,
        displayName: display,
      });
      if (display) registerAlias(record, display);
      if (cleaned !== display) registerAlias(record, cleaned);
      return record;
    }

    function registerPropertyRole(record, roleLabel) {
      if (!record) return;
      const key = record.id;
      const set = ownerPropertyRoles.get(key) || new Set();
      if (roleLabel && typeof roleLabel === "string") set.add(roleLabel);
      else set.add("current");
      ownerPropertyRoles.set(key, set);
    }

    const possibleOwnerKeys = [];
    if (propertyOut && propertyOut.parcel_identifier) {
      possibleOwnerKeys.push(`property_${propertyOut.parcel_identifier}`);
    }
    if (parcelIdentifierDashed) {
      possibleOwnerKeys.push(`property_${parcelIdentifierDashed}`);
    }
    const ownerKey =
      possibleOwnerKeys.find(
        (key) =>
          ownerData && Object.prototype.hasOwnProperty.call(ownerData, key),
      ) || null;
    const ownerPropertyData = ownerKey ? ownerData[ownerKey] : null;

    let currentOwnerRecord = null;
    let currentOwnerName = null;
    let mailingAddressText = null; // Variable to store mailing address text
    let mailingAddressOut = null; // Declare mailingAddressOut here

    let currentOwnerAliasKeys = new Set();
    let currentOwnerDisplayNames = [];
    let currentOwnerDisplayNamesUpper = [];

    if (ownerPropertyData && ownerPropertyData.owners_by_date) {
      const allOwnerEntries = [];
      for (const [roleKey, ownersList] of Object.entries(ownerPropertyData.owners_by_date)) {
        if (Array.isArray(ownersList)) {
          for (const ownerEntry of ownersList) {
            allOwnerEntries.push({ ownerEntry, roleKey });
          }
        }
      }

      allOwnerEntries.sort((a, b) => {
        if (a.roleKey.toLowerCase() === 'current' && b.roleKey.toLowerCase() !== 'current') return -1;
        if (a.roleKey.toLowerCase() !== 'current' && b.roleKey.toLowerCase() === 'current') return 1;
        return 0;
      });

      for (const { ownerEntry, roleKey } of allOwnerEntries) {
        const record = ensureOwnerRecordFromOwnerData(ownerEntry);
        if (!record) continue;
        registerPropertyRole(record, roleKey);
        if (roleKey.toLowerCase() === "current" && !currentOwnerRecord) {
          currentOwnerRecord = record;
        }
        if (roleKey.toLowerCase() === "current" && record) {
          if (!currentOwnerRecordIds.has(record.id)) {
            currentOwnerRecordIds.add(record.id);
            currentOwnerRecordsList.push(record);
          }
        }
      }

      for (const record of currentOwnerRecordsList) {
        if (record.aliases && record.aliases.size) {
          for (const aliasKey of record.aliases) {
            currentOwnerAliasKeys.add(aliasKey);
          }
        }
        if (record.displayName) {
          currentOwnerDisplayNames.push(record.displayName);
        }
        if (record.person) {
          const display = buildPersonDisplayName(record.person);
          if (display) currentOwnerDisplayNames.push(display);
        }
        if (record.company?.name) {
          currentOwnerDisplayNames.push(record.company.name);
        }
      }

      currentOwnerDisplayNamesUpper = currentOwnerDisplayNames
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.toUpperCase());
    }

    // Extract owner name and mailing address from HTML
    const ownerP = $("article#ownership .bottom-text p").first();
    if (ownerP && ownerP.length) {
      console.log("--- Mailing Address Debugging ---");
      console.log("Raw HTML of Ownership P tag:", ownerP.html());

      // Replace all <br> tags (with or without attributes) with a newline character
      const htmlContent = ownerP.html();
      const cleanedHtml = htmlContent.replace(/<br[^>]*>/gi, '\n'); 
      
      // Split by newline characters, then clean each line and filter out any empty ones
      const lines = cleanedHtml.split('\n').map(line => textClean(line)).filter(Boolean);

      console.log("Lines after replacing <br> with \\n and cleaning:", lines);

      if (lines.length > 0) {
        const normalizedLines = lines.map((line, index) => ({
          line,
          index,
          key: normalizeOwnerKey(line),
        }));

        const ownerLineIndices = new Set();
        for (const item of normalizedLines) {
          const { index, key, line } = item;
          if (key && currentOwnerAliasKeys.has(key)) {
            ownerLineIndices.add(index);
            continue;
          }
          const upperLine = line.toUpperCase();
          if (currentOwnerDisplayNamesUpper.includes(upperLine)) {
            ownerLineIndices.add(index);
          }
        }

        if (ownerLineIndices.size === 0) {
          ownerLineIndices.add(0);
        }

        const sortedOwnerIndices = Array.from(ownerLineIndices).sort(
          (a, b) => a - b,
        );
        if (!currentOwnerName && sortedOwnerIndices.length) {
          currentOwnerName = normalizedLines[sortedOwnerIndices[0]].line;
        } else if (!currentOwnerName && normalizedLines.length) {
          currentOwnerName = normalizedLines[0].line;
        }

        let mailingAddressLines = normalizedLines
          .filter(({ index }) => !ownerLineIndices.has(index))
          .map(({ line }) => line)
          .filter(Boolean);

        mailingAddressLines = filterMailingAddressLines(mailingAddressLines);

        mailingAddressText =
          mailingAddressLines.length > 0
            ? mailingAddressLines.join(" ").trim()
            : null;
      }
      console.log("Extracted currentOwnerName:", currentOwnerName);
      console.log("Extracted mailingAddressText (raw):", mailingAddressText);
    }

    // If current owner not found from owner_data.json, create from HTML
    if (!currentOwnerRecord && currentOwnerName) {
      currentOwnerRecord = ensureOwnerRecordFromName(currentOwnerName);
      registerPropertyRole(currentOwnerRecord, "current");
    } else if (currentOwnerRecord && !currentOwnerName) {
      currentOwnerName = currentOwnerRecord.displayName || null;
    }

    // --- Mailing Address File Creation ---
    if (mailingAddressText) {
      const mailingAddressPayload = buildAddressRecord({
        structuredAddress: null,
        unnormalizedValue: mailingAddressText,
        metadata: {},
        requestIdentifier: baseRequestData.request_identifier || null,
      });

      if (mailingAddressPayload) {
        const preparedMailingAddress = prepareAddressForWrite(
          mailingAddressPayload,
          {
            fallbackUnnormalized: mailingAddressText,
            preferMode: "unnormalized",
          },
        );
        let finalMailingAddress = finalizeAddressOutputForSchema(
          preparedMailingAddress,
          mailingAddressText,
        );
        let fallbackMailingUnnormalized = mailingAddressText;

        if (finalMailingAddress) {
          finalMailingAddress = enforceAddressModePreference(
            finalMailingAddress,
            mailingAddressText,
          );
        }
        if (finalMailingAddress) {
          const sanitizedMailing =
            enforceAddressOneOfForWrite(
              deepClone(finalMailingAddress),
              "unnormalized",
            ) || ensureExclusiveAddressMode(finalMailingAddress);
          if (
            sanitizedMailing &&
            typeof sanitizedMailing === "object" &&
            Object.keys(sanitizedMailing).length > 0
          ) {
            finalMailingAddress = sanitizedMailing;
          } else {
            finalMailingAddress = null;
          }
        }
        if (finalMailingAddress) {
          const hasMailingStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
            const value = finalMailingAddress[key];
            return typeof value === "string" && value.trim().length > 0;
          });
          const normalizedMailingUnnormalized = normalizeUnnormalizedAddressValue(
            Object.prototype.hasOwnProperty.call(finalMailingAddress, "unnormalized_address")
              ? finalMailingAddress.unnormalized_address
              : null,
          );

          if (normalizedMailingUnnormalized) {
            stripStructuredAddressFields(finalMailingAddress);
            finalMailingAddress.unnormalized_address = normalizedMailingUnnormalized;
          } else if (hasMailingStructured) {
            removeUnnormalizedAddress(finalMailingAddress);
            for (const key of STRUCTURED_ADDRESS_FIELDS) {
              if (Object.prototype.hasOwnProperty.call(finalMailingAddress, key)) {
                const value = finalMailingAddress[key];
                if (typeof value === "string") {
                  const trimmed = value.trim();
                  if (trimmed) finalMailingAddress[key] = trimmed;
                  else delete finalMailingAddress[key];
                } else if (value == null) {
                  delete finalMailingAddress[key];
                }
              }
            }
          } else {
            finalMailingAddress = null;
          }
        }
        if (finalMailingAddress) {
          const mailingCandidate = finalMailingAddress;
          const mailingStructuredSources = [
            mailingCandidate,
            mailingAddressPayload,
          ].filter((source) => source && typeof source === "object");
          const mailingUnnormalizedCandidates = [];
          if (
            mailingCandidate &&
            typeof mailingCandidate === "object" &&
            Object.prototype.hasOwnProperty.call(
              mailingCandidate,
              "unnormalized_address",
            )
          ) {
            mailingUnnormalizedCandidates.push(
              mailingCandidate.unnormalized_address,
            );
          }
          if (mailingAddressText) {
            mailingUnnormalizedCandidates.push(mailingAddressText);
          }
          const preferMailingStructured = STRUCTURED_ADDRESS_REQUIRED_KEYS.every(
            (key) => {
              const value =
                mailingCandidate && Object.prototype.hasOwnProperty.call(mailingCandidate, key)
                  ? mailingCandidate[key]
                  : null;
              return typeof value === "string" && value.trim().length > 0;
            },
          );

          fallbackMailingUnnormalized = preferMailingStructured ? null : mailingAddressText;

          finalMailingAddress = buildPreferredSchemaAddressPayload({
            candidate: mailingCandidate,
            structuredSources: mailingStructuredSources,
            unnormalizedCandidates: mailingUnnormalizedCandidates,
            metadataSources: mailingAddressPayload,
            requestIdentifier: baseRequestData.request_identifier || null,
            preferStructured: preferMailingStructured,
          });
        }
        if (
          finalMailingAddress &&
          typeof finalMailingAddress === "object" &&
          Object.keys(finalMailingAddress).length > 0
        ) {
          const projectedMailingAddress = projectAddressPayloadToSchema(
            finalMailingAddress,
            {
              fallbackUnnormalized: fallbackMailingUnnormalized,
              metadataSources: mailingAddressPayload,
              requestIdentifier: baseRequestData.request_identifier || null,
            },
          );
          if (
            projectedMailingAddress &&
            typeof projectedMailingAddress === "object" &&
            Object.keys(projectedMailingAddress).length > 0
          ) {
            const oneOfSafeMailing = coerceAddressToSingleMode(
              projectedMailingAddress,
              mailingAddressText,
            );
            if (
              oneOfSafeMailing &&
              typeof oneOfSafeMailing === "object" &&
              Object.keys(oneOfSafeMailing).length > 0
            ) {
              let normalizedMailingForWrite = deepClone(oneOfSafeMailing);
              if (
                normalizedMailingForWrite &&
                typeof normalizedMailingForWrite === "object"
              ) {
                const normalizedMailingUnnormalized = normalizeUnnormalizedAddressValue(
                  Object.prototype.hasOwnProperty.call(
                    normalizedMailingForWrite,
                    "unnormalized_address",
                  )
                    ? normalizedMailingForWrite.unnormalized_address
                    : null,
                );
                if (normalizedMailingUnnormalized) {
                  normalizedMailingForWrite.unnormalized_address =
                    normalizedMailingUnnormalized;
                  stripStructuredAddressFields(normalizedMailingForWrite);
                } else {
                  const hasMailingStructuredForWrite =
                    STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
                      if (
                        !Object.prototype.hasOwnProperty.call(
                          normalizedMailingForWrite,
                          key,
                        )
                      ) {
                        return false;
                      }
                      const value = normalizedMailingForWrite[key];
                      if (value == null) return false;
                      if (typeof value === "string") {
                        const trimmed = value.trim();
                        if (!trimmed) return false;
                        if (key === "city_name" || key === "state_code") {
                          normalizedMailingForWrite[key] = trimmed.toUpperCase();
                        } else if (
                          key === "postal_code" ||
                          key === "plus_four_postal_code"
                        ) {
                          normalizedMailingForWrite[key] =
                            trimmed.replace(/\s+/g, "");
                        } else {
                          normalizedMailingForWrite[key] = trimmed;
                        }
                      }
                      return true;
                    });

                  if (hasMailingStructuredForWrite) {
                    delete normalizedMailingForWrite.unnormalized_address;
                    for (const key of STRUCTURED_ADDRESS_OPTIONAL_KEYS) {
                      if (
                        !Object.prototype.hasOwnProperty.call(
                          normalizedMailingForWrite,
                          key,
                        )
                      ) {
                        continue;
                      }
                      const optionalValue = normalizedMailingForWrite[key];
                      if (optionalValue == null) {
                        delete normalizedMailingForWrite[key];
                        continue;
                      }
                      if (typeof optionalValue === "string") {
                        const trimmedOptional = optionalValue.trim();
                        if (!trimmedOptional) {
                          delete normalizedMailingForWrite[key];
                          continue;
                        }
                        if (key === "city_name" || key === "state_code") {
                          normalizedMailingForWrite[key] =
                            trimmedOptional.toUpperCase();
                        } else if (
                          key === "postal_code" ||
                          key === "plus_four_postal_code"
                        ) {
                          normalizedMailingForWrite[key] =
                            trimmedOptional.replace(/\s+/g, "");
                        } else {
                          normalizedMailingForWrite[key] = trimmedOptional;
                        }
                      }
                    }
                  } else {
                    const fallbackMailingUnnormalizedForWrite =
                      normalizeUnnormalizedAddressValue(mailingAddressText);
                    if (fallbackMailingUnnormalizedForWrite) {
                      stripStructuredAddressFields(normalizedMailingForWrite);
                      normalizedMailingForWrite.unnormalized_address =
                        fallbackMailingUnnormalizedForWrite;
                    } else {
                      normalizedMailingForWrite = null;
                    }
                  }
              }
            }

            let preferMailingStructuredForWrite = false;

            if (
              normalizedMailingForWrite &&
              typeof normalizedMailingForWrite === "object"
            ) {
              preferMailingStructuredForWrite =
                STRUCTURED_ADDRESS_REQUIRED_KEYS.every((key) => {
                  const value = normalizedMailingForWrite[key];
                  if (typeof value !== "string") return false;
                  return value.trim().length > 0;
                });
              const exclusiveMailingForWrite = enforceSingleAddressModeForWrite(
                normalizedMailingForWrite,
                preferMailingStructuredForWrite,
              );
              if (exclusiveMailingForWrite) {
                normalizedMailingForWrite = exclusiveMailingForWrite;
              }
            }

            if (
              normalizedMailingForWrite &&
              typeof normalizedMailingForWrite === "object" &&
              Object.keys(normalizedMailingForWrite).length > 0
            ) {
              const finalMailingForFile = buildFinalAddressRecord(
                normalizedMailingForWrite,
                false,
              );
              if (
                finalMailingForFile &&
                typeof finalMailingForFile === "object" &&
                Object.keys(finalMailingForFile).length > 0
              ) {
                const mailingSchemaSafe = buildSchemaCompliantAddressOutput({
                  structuredSources: [
                    finalMailingForFile,
                    normalizedMailingForWrite,
                  ],
                  unnormalizedCandidates: [
                    finalMailingForFile,
                    normalizedMailingForWrite,
                    mailingAddressText,
                  ],
                  metadataSources: [finalMailingForFile],
                  requestIdentifier:
                    finalMailingForFile.request_identifier ??
                    requestIdentifierValue,
                  preferStructured: false,
                });
                if (mailingSchemaSafe) {
                  const exclusiveMailingAddress =
                    coerceAddressToSingleMode(
                      mailingSchemaSafe,
                      mailingAddressText,
                    ) || mailingSchemaSafe;
                  await fsp.writeFile(
                    path.join("data", "mailing_address.json"),
                    JSON.stringify(exclusiveMailingAddress, null, 2),
                  );
                  const enforcedMailing = await enforceAddressFileOneOf(
                    "mailing_address.json",
                    preferMailingStructuredForWrite ? "structured" : "unnormalized",
                  );
                  if (enforcedMailing) {
                    const normalizedMailing = await enforceAddressOutputMode(
                      "mailing_address.json",
                      preferMailingStructuredForWrite,
                      mailingAddressText,
                    );
                    if (normalizedMailing) {
                      mailingAddressOut = normalizedMailing;
                      await enforceAddressPreferredDataMode(
                        "mailing_address.json",
                      );
                      console.log("mailing_address.json created.");
                    } else {
                      await fsp
                        .unlink(path.join("data", "mailing_address.json"))
                        .catch(() => {});
                      mailingAddressOut = null;
                    }
                  } else {
                    await fsp
                      .unlink(path.join("data", "mailing_address.json"))
                      .catch(() => {});
                    mailingAddressOut = null;
                  }
                } else {
                  await fsp
                    .unlink(path.join("data", "mailing_address.json"))
                    .catch(() => {});
                  mailingAddressOut = null;
                }
              } else {
                mailingAddressOut = null;
              }
            } else {
              mailingAddressOut = null;
            }
          } else {
            mailingAddressOut = null;
          }
        } else {
          mailingAddressOut = null;
        }
      } else {
        mailingAddressOut = null;
      }
    } else {
      mailingAddressOut = null;
    }


    const salesRows = $("article#sale-info table.table tbody tr").toArray();
    for (let i = salesRows.length - 1; i >= 0; i--) { // Iterate in reverse to get chronological order
      const tr = salesRows[i];
      const tds = $(tr).find("th, td");
      if (!tds || tds.length < 6) continue;

      const dateTxt = textClean($(tds[0]).text());
      const bookPageText = textClean($(tds[1]).text());
      const bookPageLink = $(tds[1]).find("a").attr("href");
      const deedCode = textClean($(tds[3]).text());
      const grantorName = textClean($(tds[4]).text());
      const priceTxt = textClean($(tds[5]).text());

      const iso = parseDateToISO(dateTxt);
      if (!iso) continue;
      const priceNum = parseCurrencyToNumber(priceTxt);
      const deedReference = extractDeedReference(bookPageText, bookPageLink);

      const sale = {
        ownership_transfer_date: iso,
        purchase_price_amount: priceNum && priceNum > 0 ? priceNum : 0,
        _deed_code: deedCode || null,
        _book_page: bookPageText || null,
        _book_page_url: bookPageLink || null,
        _deed_reference: deedReference,
        _deed_book: deedReference.book,
        _deed_page: deedReference.page,
        _deed_volume: deedReference.volume,
        _deed_instrument_number: deedReference.instrument_number,
        _grantor_name: grantorName || null,
        _grantee_name: null, // Will be set below
        _grantor_record_id: null, // Will be set below
        _grantee_record_id: null, // Will be set below
      };
      sales.push(sale); // Push to maintain chronological order
    }

    // Now, assign grantees based on the chronological order of sales
    let previousGranteeRecord = currentOwnerRecord; // The grantee of the *first* sale is the current owner
    let previousGranteeName = currentOwnerName;

    for (let i = sales.length - 1; i >= 0; i--) { // Iterate sales in reverse chronological order for assignment
      const sale = sales[i];

      // The grantee of the current sale is the previousGranteeRecord
      sale._grantee_record_id = previousGranteeRecord ? previousGranteeRecord.id : null;
      sale._grantee_name = previousGranteeName;

      // Ensure grantor record exists or create it
      let grantorRecord = sale._grantor_name
        ? ensureOwnerRecordFromName(sale._grantor_name, { assumeLastFirst: true })
        : null;
      sale._grantor_record_id = grantorRecord ? grantorRecord.id : null;

      // For the next iteration (previous sale chronologically), this sale's grantor becomes the grantee
      previousGranteeRecord = grantorRecord;
      previousGranteeName = sale._grantor_name;
    }


    await removeExisting(/^person_.*\.json$/);
    await removeExisting(/^company_.*\.json$/);
    await removeExisting(/^relationship_property_has_company_.*\.json$/);
    await removeExisting(/^relationship_sales_history_.*_has_person_.*\.json$/); 
    await removeExisting(/^relationship_sales_history_.*_has_company_.*\.json$/); 
    await removeExisting(/^relationship_person_.*_has_mailing_address\.json$/); 

    const getRecordFallbackName = (record) => {
      if (record.displayName && record.displayName.trim()) {
        return record.displayName.trim();
      }
      if (record.aliases && record.aliases.size) {
        for (const alias of record.aliases) {
          if (alias && alias.trim()) {
            return alias.trim();
          }
        }
      }
      if (record.person) {
        const built = buildPersonDisplayName(record.person);
        if (built) return built;
      }
      return null;
    };

    for (const record of ownerRecords.values()) {
      if (record.type !== "person") continue;
      const fallbackName = getRecordFallbackName(record);
      const baseRawPerson = {
        birth_date: record.person?.birth_date ?? null,
        first_name: record.person?.first_name ?? null,
        last_name: record.person?.last_name ?? null,
        middle_name: record.person?.middle_name ?? null,
        prefix_name: record.person?.prefix_name ?? null,
        suffix_name: record.person?.suffix_name ?? null,
        us_citizenship_status: record.person?.us_citizenship_status ?? null,
        veteran_status: record.person?.veteran_status ?? null,
        request_identifier: record.person?.request_identifier ?? null,
      };

      let sanitizedForOutput =
        sanitizePersonData(baseRawPerson, fallbackName) || null;

      if (!sanitizedForOutput && fallbackName) {
        const parsedFallback = parsePersonNameTokens(fallbackName);
        if (parsedFallback) {
          sanitizedForOutput =
            sanitizePersonData(
              {
                ...baseRawPerson,
                first_name:
                  parsedFallback.first_name ?? baseRawPerson.first_name ?? null,
                last_name:
                  parsedFallback.last_name ?? baseRawPerson.last_name ?? null,
                middle_name:
                  parsedFallback.middle_name ?? baseRawPerson.middle_name ?? null,
              },
              fallbackName,
            ) || null;
        }
      }

      if (!sanitizedForOutput) {
        const companyName =
          fallbackName || buildPersonDisplayName(record.person) || null;
        record.type = "company";
        record.company = {
          name: companyName,
          request_identifier: record.person?.request_identifier ?? null,
        };
        record.person = undefined;
        if (!record.displayName && companyName) {
          record.displayName = companyName;
        }
        continue;
      }

      record.person = {
        ...record.person,
        ...sanitizedForOutput,
      };
      if (!record.displayName) {
        record.displayName =
          buildPersonDisplayName(record.person) || fallbackName || null;
      }
    }

    const ownerToFileMap = new Map();
    let personIdx = 0;
    let companyIdx = 0;

    for (const record of ownerRecords.values()) {
      if (record.type === "person") {
        const fallbackName = getRecordFallbackName(record);
        const requestIdForPerson = record.person?.request_identifier ?? null;
        let sanitizedFirst = normalizePersonNameValue(record.person?.first_name);
        let sanitizedLast = normalizePersonNameValue(record.person?.last_name);
        let sanitizedMiddle = normalizePersonNameValue(
          record.person?.middle_name,
          PERSON_MIDDLE_NAME_PATTERN,
        );

        if (!sanitizedLast && fallbackName) {
          const parsed = parsePersonNameTokens(fallbackName);
          if (parsed) {
            if (!sanitizedFirst && parsed.first_name) {
              sanitizedFirst = normalizePersonNameValue(parsed.first_name);
            }
            if (!sanitizedMiddle && parsed.middle_name) {
              sanitizedMiddle = normalizePersonNameValue(
                parsed.middle_name,
                PERSON_MIDDLE_NAME_PATTERN,
              );
            }
            if (parsed.last_name) {
              sanitizedLast = normalizePersonNameValue(parsed.last_name);
            }
          }
        }

        if (!sanitizedLast) {
          const companyName =
            fallbackName ||
            buildPersonDisplayName(record.person) ||
            record.displayName ||
            null;
          record.type = "company";
          record.company = {
            name: companyName,
            request_identifier: requestIdForPerson,
          };
          record.person = undefined;
          if (!record.displayName && companyName) {
          record.displayName = companyName;
        }
        companyIdx += 1;
        const companyOut = {
            name: companyName,
            request_identifier: requestIdForPerson,
          };
          const fileName = `company_${companyIdx}.json`;
          await fsp.writeFile(
            path.join("data", fileName),
            JSON.stringify(companyOut, null, 2),
          );
          ownerToFileMap.set(record.id, {
            fileName,
            type: "company",
            index: companyIdx,
          });
          continue;
        }

        const promoteToCompany = async (nameOverride = null) => {
          const companyName =
            nameOverride ||
            fallbackName ||
            buildPersonDisplayName(record.person) ||
            record.displayName ||
            sanitizedLast ||
            null;
          record.type = "company";
          record.company = {
            name: companyName,
            request_identifier: requestIdForPerson,
          };
          record.person = undefined;
          if (!record.displayName && companyName) {
            record.displayName = companyName;
          }
          companyIdx += 1;
          const companyFileName = `company_${companyIdx}.json`;
          const companyOut = {
            name: companyName,
            request_identifier: requestIdForPerson,
          };
          await fsp.writeFile(
            path.join("data", companyFileName),
            JSON.stringify(companyOut, null, 2),
          );
          ownerToFileMap.set(record.id, {
            fileName: companyFileName,
            type: "company",
            index: companyIdx,
          });
        };

        if (!sanitizedLast) {
          await promoteToCompany();
          continue;
        }

        const validationFallback =
          fallbackName ||
          buildPersonDisplayName(record.person) ||
          record.displayName ||
          null;

        const validationInput = {
          birth_date: record.person?.birth_date ?? null,
          first_name: sanitizedFirst ?? null,
          last_name: sanitizedLast,
          middle_name: sanitizedMiddle ?? null,
          prefix_name: record.person?.prefix_name ?? null,
          suffix_name: record.person?.suffix_name ?? null,
          us_citizenship_status: record.person?.us_citizenship_status ?? null,
          veteran_status: record.person?.veteran_status ?? null,
          request_identifier: requestIdForPerson,
        };

        const validatedOutput =
          sanitizePersonData(validationInput, validationFallback) || null;

        const safeLast = ensurePersonNamePattern(
          validatedOutput?.last_name,
          PERSON_NAME_PATTERN,
        );
        const safeFirst = ensurePersonNamePattern(
          validatedOutput?.first_name,
          PERSON_NAME_PATTERN,
        );
        const safeMiddle = ensurePersonNamePattern(
          validatedOutput?.middle_name,
          PERSON_MIDDLE_NAME_PATTERN,
        );

        if (!validatedOutput || !safeLast || !safeFirst) {
          await promoteToCompany();
          continue;
        }

        validatedOutput.last_name = safeLast;
        validatedOutput.first_name = safeFirst;
        validatedOutput.middle_name = safeMiddle ?? null;

        record.person = {
          ...record.person,
          ...validatedOutput,
        };

        const finalLast = ensurePersonNamePattern(
          record.person.last_name,
          PERSON_NAME_PATTERN,
        );
        const finalFirst = ensurePersonNamePattern(
          record.person.first_name,
          PERSON_NAME_PATTERN,
        );
        const finalMiddle = ensurePersonNamePattern(
          record.person.middle_name,
          PERSON_MIDDLE_NAME_PATTERN,
        );

        if (!finalLast || !finalFirst) {
          await promoteToCompany(validationFallback);
          continue;
        }

        record.person.last_name = finalLast;
        record.person.first_name = finalFirst;
        record.person.middle_name = finalMiddle ?? null;
        validatedOutput.last_name = finalLast;
        validatedOutput.first_name = finalFirst;
        validatedOutput.middle_name = finalMiddle ?? null;

        let personOut = preparePersonForWrite({
          birth_date: validatedOutput.birth_date ?? null,
          first_name: validatedOutput.first_name ?? null,
          last_name: validatedOutput.last_name ?? null,
          middle_name: validatedOutput.middle_name ?? null,
          prefix_name: validatedOutput.prefix_name ?? null,
          suffix_name: validatedOutput.suffix_name ?? null,
          us_citizenship_status:
            validatedOutput.us_citizenship_status ?? null,
          veteran_status: validatedOutput.veteran_status ?? null,
          request_identifier: validatedOutput.request_identifier ?? null,
        });

        if (!personOut) {
          await promoteToCompany(validationFallback);
          continue;
        }

        const normalizedFirstOut = normalizePersonNameValue(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const normalizedLastOut = normalizePersonNameValue(
        personOut.last_name,
          PERSON_NAME_PATTERN,
        );
        const normalizedMiddleOut = normalizePersonNameValue(
        personOut.middle_name,
        PERSON_MIDDLE_NAME_PATTERN,
      );

      if (!normalizedFirstOut || !normalizedLastOut) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.first_name = normalizedFirstOut;
      personOut.last_name = normalizedLastOut;
      personOut.middle_name = normalizedMiddleOut ?? null;

      const safeLastOut = normalizeNameToPattern(
        personOut.last_name,
        PERSON_NAME_PATTERN,
      );
      const safeFirstOut = normalizeNameToPattern(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const safeMiddleOut =
        personOut.middle_name != null
          ? normalizeNameToPattern(
              personOut.middle_name,
              PERSON_MIDDLE_NAME_PATTERN,
            )
          : null;

      if (!safeLastOut || !safeFirstOut) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.last_name = safeLastOut;
      personOut.first_name = safeFirstOut;
      personOut.middle_name = safeMiddleOut ?? null;

      const schemaSafePerson = enforcePersonSchema(personOut);
      if (!schemaSafePerson) {
        await promoteToCompany(validationFallback);
        continue;
      }
      personOut = schemaSafePerson;

      const finalLastName = normalizeNameToPattern(
        personOut.last_name,
        PERSON_NAME_PATTERN,
      );
      const finalFirstName = normalizeNameToPattern(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const finalMiddleName =
        personOut.middle_name != null
          ? normalizeNameToPattern(
              personOut.middle_name,
              PERSON_MIDDLE_NAME_PATTERN,
            )
          : null;

      if (!finalLastName || !finalFirstName) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.last_name = finalLastName;
      personOut.first_name = finalFirstName;
      personOut.middle_name = finalMiddleName ?? null;

      const schemaValidatedFinal = enforcePersonSchema(personOut);
      if (!schemaValidatedFinal) {
        await promoteToCompany(validationFallback);
        continue;
      }
      personOut = schemaValidatedFinal;

      record.person = {
        ...record.person,
        ...personOut,
      };
      validatedOutput.last_name = personOut.last_name;
      validatedOutput.first_name = personOut.first_name;
      validatedOutput.middle_name = personOut.middle_name;

      const finalNormalizedLastCheck = normalizeNameToPattern(
        personOut.last_name,
        PERSON_NAME_PATTERN,
      );
      const finalNormalizedFirstCheck = normalizeNameToPattern(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const finalNormalizedMiddleCheck =
        personOut.middle_name != null
          ? normalizeNameToPattern(
              personOut.middle_name,
              PERSON_MIDDLE_NAME_PATTERN,
            )
          : null;

      if (!finalNormalizedLastCheck || !finalNormalizedFirstCheck) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.last_name = finalNormalizedLastCheck;
      personOut.first_name = finalNormalizedFirstCheck;
      personOut.middle_name = finalNormalizedMiddleCheck ?? null;

      const patternSafeLast = PERSON_NAME_PATTERN.test(personOut.last_name);
      const patternSafeFirst = PERSON_NAME_PATTERN.test(personOut.first_name);
      const patternSafeMiddle =
        personOut.middle_name == null ||
        PERSON_MIDDLE_NAME_PATTERN.test(personOut.middle_name);
      if (!patternSafeLast || !patternSafeFirst || !patternSafeMiddle) {
        await promoteToCompany(validationFallback);
        continue;
      }

      const finalizedPersonOut = finalizePersonNamesForSchema(personOut);
      if (!finalizedPersonOut) {
        await promoteToCompany(validationFallback);
        continue;
      }
      personOut = finalizedPersonOut;

      const finalLastForWrite = normalizeNameToPattern(
        personOut.last_name,
        PERSON_NAME_PATTERN,
      );
      const finalFirstForWrite = normalizeNameToPattern(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const finalMiddleForWrite =
        personOut.middle_name != null
          ? normalizeNameToPattern(
              personOut.middle_name,
              PERSON_MIDDLE_NAME_PATTERN,
            )
          : null;

      if (!finalLastForWrite || !finalFirstForWrite) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.last_name = finalLastForWrite;
      personOut.first_name = finalFirstForWrite;
      personOut.middle_name = finalMiddleForWrite ?? null;

      const failSafeLast = enforceNamePattern(
        personOut.last_name,
        PERSON_NAME_PATTERN,
      );
      const failSafeFirst = enforceNamePattern(
        personOut.first_name,
        PERSON_NAME_PATTERN,
      );
      const failSafeMiddle =
        personOut.middle_name != null
          ? enforceNamePattern(
              personOut.middle_name,
              PERSON_MIDDLE_NAME_PATTERN,
            )
          : null;

      if (!failSafeLast || !failSafeFirst) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personOut.last_name = failSafeLast;
      personOut.first_name = failSafeFirst;
      personOut.middle_name = failSafeMiddle ?? null;

      const patternEnforcedPerson = enforcePersonNamePatterns(personOut);
      if (!patternEnforcedPerson) {
        await promoteToCompany(validationFallback);
        continue;
      }
      personOut = patternEnforcedPerson;
      if (
        personOut.middle_name != null &&
        !PERSON_MIDDLE_NAME_PATTERN.test(personOut.middle_name)
      ) {
        personOut.middle_name = null;
      }

      if (
        !PERSON_NAME_PATTERN.test(personOut.last_name) ||
        !PERSON_NAME_PATTERN.test(personOut.first_name)
      ) {
        await promoteToCompany(validationFallback);
        continue;
      }

      personIdx += 1;
      const fileName = `person_${personIdx}.json`;

      await fsp.writeFile(
        path.join("data", fileName),
        JSON.stringify(personOut, null, 2),
      );
      ownerToFileMap.set(record.id, {
        fileName,
        type: "person",
        index: personIdx,
      });
      } else {
        companyIdx += 1;
        const companyOut = {
          name: record.company?.name ?? record.displayName ?? null,
          request_identifier: record.company?.request_identifier ?? null,
        };
        const fileName = `company_${companyIdx}.json`;
        await fsp.writeFile(
          path.join("data", fileName),
          JSON.stringify(companyOut, null, 2),
        );
        ownerToFileMap.set(record.id, {
          fileName,
          type: "company",
          index: companyIdx,
        });
      }
    }

    // --- Create relationship between latest owner (if person) and mailing address ---
    // This relationship should only be created if mailingAddressOut was successfully created
    // and ownerToFileMap is now fully populated.
    if (currentOwnerRecord  && mailingAddressOut) {
      const latestOwnerMeta = ownerToFileMap.get(currentOwnerRecord.id);
      if (latestOwnerMeta) { // Ensure it's a person for this relationship
        const relFileName = `relationship_${latestOwnerMeta.type}_${latestOwnerMeta.index}_has_mailing_address.json`;
        const wroteRelationship = await writeRelationshipFile(
          relFileName,
          `./${latestOwnerMeta.fileName}`,
          "./mailing_address.json",
        );
        if (wroteRelationship) {
          console.log(`Created mailing address relationship: ${relFileName}`);
        } else {
          console.log(
            `Skipped mailing address relationship ${relFileName} due to unresolved reference.`,
          );
        }
      } else {
        console.log("Warning: Could not find metadata for currentOwnerRecord (or it's not a person) to create mailing address relationship.");
      }
    } else {
      console.log("Mailing address relationship not created. Conditions not met:", {
        currentOwnerRecord: !!currentOwnerRecord,
        isPerson: currentOwnerRecord?.type === "person",
        mailingAddressOut: !!mailingAddressOut
      });
    }


    const propertyRelCounters = { person: 0, company: 0 };
    for (const [recordId, roles] of ownerPropertyRoles.entries()) {
      const meta = ownerToFileMap.get(recordId);
      if (!meta || !roles || roles.size === 0) continue;
      // Only create property_has_company relationships, not property_has_person
      if (meta.type === "company") {
        for (const role of roles) {
          propertyRelCounters[meta.type] += 1;
          const relFileName = `relationship_property_has_${meta.type}_${propertyRelCounters[meta.type]}_${slugify(role)}.json`;
          await writeRelationshipFile(
            relFileName,
            propertyRef,
            `./${meta.fileName}`,
          );
        }
      } else if (meta.type === "person") {
        const hasCurrentRole = Array.from(roles).some(
          (role) => typeof role === "string" && role.toLowerCase() === "current",
        );
        if (hasCurrentRole) {
          const relFileName = `relationship_person_${meta.index}_has_fact_sheet.json`;
          await writeRelationshipFile(
            relFileName,
            `./${meta.fileName}`,
            propertyRef,
          );
        }
      }
    }

    await removeExisting(/^sales_.*\.json$/);
    await removeExisting(/^deed_.*\.json$/);
    await removeExisting(/^file_.*\.json$/);
    await removeExisting(/^relationship_sales_history_.*_to_deed_.*\.json$/);
    await removeExisting(/^relationship_deed_.*_to_file_.*\.json$/);
    // await removeExisting(/^relationship_property_has_sales_history_.*\.json$/); // Removed this line

    const ALLOWED_DEED_TYPES = [
      "Warranty Deed",
      "Special Warranty Deed",
      "Quitclaim Deed",
      "Grant Deed",
      "Bargain and Sale Deed",
      "Lady Bird Deed",
      "Transfer on Death Deed",
      "Sheriff's Deed",
      "Tax Deed",
      "Trustee's Deed",
      "Personal Representative Deed",
      "Correction Deed",
      "Deed in Lieu of Foreclosure",
      "Life Estate Deed",
      "Joint Tenancy Deed",
      "Tenancy in Common Deed",
      "Community Property Deed",
      "Gift Deed",
      "Interspousal Transfer Deed",
      "Wild Deed",
      "Special Master's Deed",
      "Court Order Deed",
      "Contract for Deed",
      "Quiet Title Deed",
      "Administrator's Deed",
      "Guardian's Deed",
      "Receiver's Deed",
      "Right of Way Deed",
      "Vacation of Plat Deed",
      "Assignment of Contract",
      "Release of Contract",
      "Miscellaneous",
    ];

    const ALLOWED_DOCUMENT_TYPES = [
      "Title",
      "ConveyanceDeed",
      "ConveyanceDeedWarrantyDeed",
      "ConveyanceDeedQuitClaimDeed",
      "ConveyanceDeedBargainAndSaleDeed",
    ];

    function validateEnum(value, allowedValues, entityName, propertyName) {
      if (value == null) return null;
      if (allowedValues.includes(value)) return value;
      console.warn(`Unsupported ${entityName}.${propertyName} value: ${value}`);
      return null;
    }

    const DEED_CODE_TO_TYPE = {
      AA: "Contract for Deed",
      AC: "Assignment of Contract",
      AF: "Miscellaneous",
      CD: "Correction Deed",
      CJ: "Personal Representative Deed",
      CP: "Community Property Deed",
      CT: "Quiet Title Deed",
      CV: "Miscellaneous",
      DE: "Warranty Deed",
      FJ: "Court Order Deed",
      GD: "Grant Deed",
      GP: "Gift Deed",
      IL: "Deed in Lieu of Foreclosure",
      IT: "Interspousal Transfer Deed",
      JT: "Joint Tenancy Deed",
      LE: "Life Estate Deed",
      MS: "Assignment of Contract",
      OA: "Administrator's Deed",
      OJ: "Court Order Deed",
      OT: "Transfer on Death Deed",
      PB: "Administrator's Deed",
      PR: "Personal Representative Deed",
      PRDEED: "Personal Representative Deed",
      QC: "Quitclaim Deed",
      RC: "Release of Contract",
      RW: "Right of Way Deed",
      SC: "Bargain and Sale Deed",
      SD: "Sheriff's Deed",
      SH: "Sheriff's Deed",
      SP: "Special Warranty Deed",
      SW: "Special Warranty Deed",
      TD: "Tax Deed",
      TR: "Trustee's Deed",
      TRUST: "Trustee's Deed",
      WD: "Warranty Deed",
      WI: "Gift Deed",
    };

    function mapDeedCodeToType(code) {
      const normalized = (code || "").toUpperCase();
      if (!normalized) return null;
      const mapped =
        DEED_CODE_TO_TYPE[normalized] ||
        (ALLOWED_DEED_TYPES.includes(textClean(code))
          ? textClean(code)
          : null);
      return validateEnum(mapped, ALLOWED_DEED_TYPES, "Deed", "deed_type");
    }

    const DOCUMENT_TYPE_BY_DEED = {
      "Warranty Deed": "ConveyanceDeedWarrantyDeed",
      "Quitclaim Deed": "ConveyanceDeedQuitClaimDeed",
      "Bargain and Sale Deed": "ConveyanceDeedBargainAndSaleDeed",
    };

    const GENERIC_CONVEYANCE_DOCUMENT_TYPE = validateEnum(
      "ConveyanceDeed",
      ALLOWED_DOCUMENT_TYPES,
      "File",
      "document_type",
    );

    const GENERIC_TITLE_DOCUMENT_TYPE = validateEnum(
      "Title",
      ALLOWED_DOCUMENT_TYPES,
      "File",
      "document_type",
    );

    function mapDocumentTypeFromDeed(deedType) {
      if (!deedType) return GENERIC_CONVEYANCE_DOCUMENT_TYPE;
      const mapped = DOCUMENT_TYPE_BY_DEED[deedType] || null;
      if (mapped) {
        const validated = validateEnum(
          mapped,
          ALLOWED_DOCUMENT_TYPES,
          "File",
          "document_type",
        );
        if (validated) return validated;
      }
      return GENERIC_CONVEYANCE_DOCUMENT_TYPE;
    }

    function mapSupplementalDocumentType(url, format) {
      const targetUrl = url || "";
      const normalizedFormat = (format || "").toLowerCase();
      if (/TrimPrint/i.test(targetUrl)) return GENERIC_TITLE_DOCUMENT_TYPE;
      if (/mapbook/i.test(targetUrl)) return GENERIC_TITLE_DOCUMENT_TYPE;
      if (/ImageSketches/i.test(targetUrl)) return GENERIC_TITLE_DOCUMENT_TYPE;
      if (normalizedFormat === "jpeg" || normalizedFormat === "png") {
        return GENERIC_TITLE_DOCUMENT_TYPE;
      }
      return GENERIC_TITLE_DOCUMENT_TYPE;
    }

    for (let i = 0; i < sales.length; i++) {
      const sale = sales[i];
      const saleFileName = `sales_history_${i + 1}.json`;
      const saleOut = {
        request_identifier: baseRequestData.request_identifier || null,
        ownership_transfer_date: sale.ownership_transfer_date,
        purchase_price_amount: sale.purchase_price_amount,
      };
      await fsp.writeFile(
        path.join("data", saleFileName),
        JSON.stringify(saleOut, null, 2),
      );

      const deedType = mapDeedCodeToType(sale._deed_code);

      // Only create deed.json and related files/relationships if deedType is not null
      if (deedType !== null) {
        const deedFileName = `deed_${i + 1}.json`;
        const deedOut = {
          deed_type: deedType,
        };
        await fsp.writeFile(
          path.join("data", deedFileName),
          JSON.stringify(deedOut, null, 2),
        );

        await writeRelationshipFile(
          `relationship_sales_history_${i + 1}_to_deed_${i + 1}.json`,
          `./${saleFileName}`,
          `./${deedFileName}`,
        );

        // --- Create sales_history_has_person/company relationships ---
        // if (sale._grantor_record_id) {
        //   const grantorMeta = ownerToFileMap.get(sale._grantor_record_id);
        //   if (grantorMeta) {
        //     const relFileName = `relationship_sales_history_${i + 1}_has_${grantorMeta.type}_${grantorMeta.index}.json`; // Removed _grantor from filename
        //     const relOut = {
        //       from: { "/": `./${saleFileName}` },
        //       to: { "/": `./${grantorMeta.fileName}` },
        //       // type: `sales_history_has_${grantorMeta.type}`, // Removed 'type' property
        //     };
        //     await fsp.writeFile(
        //       path.join("data", relFileName),
        //       JSON.stringify(relOut, null, 2),
        //     );
        //   }
        // }

        if (sale._grantee_record_id) {
          const granteeMeta = ownerToFileMap.get(sale._grantee_record_id);
          if (granteeMeta) {
            const relFileName = `relationship_sales_history_${i + 1}_has_${granteeMeta.type}_${granteeMeta.index}.json`;
            await writeRelationshipFile(
              relFileName,
              `./${saleFileName}`,
              `./${granteeMeta.fileName}`,
            );
          }
        }
        // --- End of sales_history_has_person/company relationships ---


        if (sale._book_page_url) {
          fileIdx += 1;
          const fileFileName = `file_${fileIdx}.json`;
          const fileOut = {
            request_identifier: baseRequestData.request_identifier || null,
            file_format: getFileFormatFromUrl(sale._book_page_url),
            name: path.basename(sale._book_page_url) || null,
            document_type: "ConveyanceDeed",
          };
          await fsp.writeFile(
            path.join("data", fileFileName),
            JSON.stringify(fileOut, null, 2),
          );

          await writeRelationshipFile(
            `relationship_deed_${i + 1}_to_file_${fileIdx}.json`,
            `./${deedFileName}`,
            `./${fileFileName}`,
          );
        }
      } // End of if (deedType !== null)
    }
  }


  // Removed propertyKeyCandidates and resolvedUtilityKey/resolvedLayoutKey
  // as they are no longer needed for direct processing of structure_data.json

  const utilityIndexToFile = new Map();
  const structureIndexToFile = new Map();
  const layoutIndexToFile = new Map();

  // Tax extraction: clear old and create one file per year option present
  await removeExisting(/^tax_.*\.json$/);
  if (!isMulti) {
    const targetTaxYear = 2025; // Only include tax for 2025

    let buildingVal = null,
      landVal = null,
      justVal = null,
      assessedVal = null,
      taxableVal = null;
    $("article#property-values table.container tr").each((i, tr) => {
      const th = textClean($(tr).find("th").text());
      const td = textClean($(tr).find("td").text());
      const amt = parseCurrencyToNumber(td);
      if (/^Building$/i.test(th)) buildingVal = amt;
      if (/^SFYI$/i.test(th)) { /* SFYI is not directly mapped to building or land, ignore for now */ }
      if (/^Land$/i.test(th)) landVal = amt;
      if (/^Just\/Market$/i.test(th)) justVal = amt;
      if (/^Assessed$/i.test(th)) assessedVal = amt;
      if (/^Taxable$/i.test(th)) taxableVal = amt;
    });

    // Check if the targetTaxYear is present in the dropdown (optional, but good for robustness)
    let foundTargetYear = false;
    $("article#property-values select option").each((i, opt) => {
      const yr = parseInt(textClean($(opt).text()), 10);
      if (yr === targetTaxYear) {
        foundTargetYear = true;
        return false; // Break .each loop
      }
    });

    if (foundTargetYear) { // Only write tax data if 2025 is found
      const taxFileName = `tax_${targetTaxYear}.json`;
      const taxOut = {
        request_identifier: baseRequestData.request_identifier || null,
        tax_year: targetTaxYear,
        property_assessed_value_amount:
          assessedVal && assessedVal > 0 ? assessedVal : null,
        property_market_value_amount: justVal && justVal > 0 ? justVal : null,
        property_building_amount:
          buildingVal && buildingVal > 0 ? buildingVal : null,
        property_land_amount: landVal && landVal > 0 ? landVal : null,
        property_taxable_value_amount:
          taxableVal && taxableVal > 0 ? taxableVal : null,
        monthly_tax_amount: null,
        period_end_date: null,
        period_start_date: null,
        first_year_building_on_tax_roll: null,
        first_year_on_tax_roll: null,
        yearly_tax_amount: null,
      };
      await fsp.writeFile(
        path.join("data", taxFileName),
        JSON.stringify(taxOut, null, 2),
      );
    }
  }

  // Utilities from owners/utilities_data.json (use best available key)
  await removeExisting(/^utility_.*\.json$/);
  await removeExisting(/^utility\.json$/);
  await removeExisting(/^relationship_property_has_utility_.*\.json$/); // Remove this relationship

  const utilityEntries = [];
  const utilityRecords = [];
  let utilitiesTotalBuildings = null;
  if (utilitiesData && typeof utilitiesData === "object") {
    for (const key of Object.keys(utilitiesData)) {
      if (!Object.prototype.hasOwnProperty.call(utilitiesData, key)) continue;
      const entry = utilitiesData[key];
      if (!entry) continue;

      if (Array.isArray(entry.building_utilities)) {
        for (const util of entry.building_utilities) {
          if (util && typeof util === "object") utilityEntries.push({ ...util });
        }
      } else if (entry.building_utilities && typeof entry.building_utilities === "object") {
        utilityEntries.push({ ...entry.building_utilities });
      } else if (Array.isArray(entry)) {
        for (const util of entry) {
          if (util && typeof util === "object") utilityEntries.push({ ...util });
        }
      } else if (
        entry &&
        typeof entry === "object" &&
        (
          "cooling_system_type" in entry ||
          "heating_system_type" in entry ||
          "public_utility_type" in entry ||
          "water_source_type" in entry ||
          "sewer_type" in entry
        )
      ) {
        utilityEntries.push({ ...entry });
      }

      if (
        utilitiesTotalBuildings == null &&
        entry &&
        typeof entry === "object" &&
        entry.total_buildings != null
      ) {
        const tb = Number(entry.total_buildings);
        if (!Number.isNaN(tb)) utilitiesTotalBuildings = tb;
      }
    }
  }

  for (let i = 0; i < utilityEntries.length; i++) {
    const util = utilityEntries[i] || {};
    const fileName = `utility_${i + 1}.json`;

    const utilityOut = { ...util };
    if (Object.prototype.hasOwnProperty.call(utilityOut, "source_http_request")) {
      delete utilityOut.source_http_request;
    }
    const utilityBuildingNumber =
      Object.prototype.hasOwnProperty.call(utilityOut, "building_number")
        ? utilityOut.building_number
        : null;
    if (Object.prototype.hasOwnProperty.call(utilityOut, "building_number")) {
      delete utilityOut.building_number;
    }
    if (Object.prototype.hasOwnProperty.call(utilityOut, "number_of_buildings")) {
      delete utilityOut.number_of_buildings;
    }

    if (Object.prototype.hasOwnProperty.call(utilityOut, "url")) {
      delete utilityOut.url;
    }
    utilityOut.request_identifier = baseRequestData.request_identifier || null;

    await fsp.writeFile(
      path.join("data", fileName),
      JSON.stringify(utilityOut, null, 2),
    );
    utilityIndexToFile.set(i + 1, fileName);
    utilityRecords.push({
      index: i + 1,
      file: fileName,
      building_number: utilityBuildingNumber,
    });
  }

  // Structure extraction (prefer owners/structure_data.json)
  await removeExisting(/^structure_.*\.json$/);
  await removeExisting(/^structure\.json$/); // Ensure this is removed if it exists
  await removeExisting(/^relationship_property_has_structure_.*\.json$/); // Remove this relationship

  const structureEntries = [];
  const structureRecords = [];
  let structuresTotalBuildings = null;
  if (structureData && typeof structureData === "object") {
    for (const key of Object.keys(structureData)) {
      if (!Object.prototype.hasOwnProperty.call(structureData, key)) continue;
      const entry = structureData[key];
      if (!entry) continue;

      if (Array.isArray(entry.building_structures)) {
        for (const structure of entry.building_structures) {
          if (structure && typeof structure === "object") {
            structureEntries.push({ ...structure });
          }
        }
      } else if (entry.building_structures && typeof entry.building_structures === "object") {
        structureEntries.push({ ...entry.building_structures });
      } else if (Array.isArray(entry)) {
        for (const structure of entry) {
          if (structure && typeof structure === "object") structureEntries.push({ ...structure });
        }
      } else if (
        entry &&
        typeof entry === "object" &&
        (
          "roof_covering_material" in entry ||
          "exterior_wall_material_primary" in entry ||
          "flooring_material_primary" in entry ||
          "number_of_buildings" in entry
        )
      ) {
        structureEntries.push({ ...entry });
      }

      if (
        structuresTotalBuildings == null &&
        entry &&
        typeof entry === "object" &&
        entry.total_buildings != null
      ) {
        const tb = Number(entry.total_buildings);
        if (!Number.isNaN(tb)) structuresTotalBuildings = tb;
      }
    }
  }

  for (let i = 0; i < structureEntries.length; i++) {
    const structure = structureEntries[i] || {};
    const fileName = `structure_${i + 1}.json`;

    const structureOut = { ...structure };
    if (Object.prototype.hasOwnProperty.call(structureOut, "source_http_request")) {
      delete structureOut.source_http_request;
    }
    const structureBuildingNumber =
      Object.prototype.hasOwnProperty.call(structureOut, "building_number")
        ? structureOut.building_number
        : null;
    if (Object.prototype.hasOwnProperty.call(structureOut, "building_number")) {
      delete structureOut.building_number;
    }
    if (Object.prototype.hasOwnProperty.call(structureOut, "number_of_buildings")) {
      delete structureOut.number_of_buildings;
    }

    if (Object.prototype.hasOwnProperty.call(structureOut, "url")) {
      delete structureOut.url;
    }
    structureOut.request_identifier = baseRequestData.request_identifier || null;

    await fsp.writeFile(
      path.join("data", fileName),
      JSON.stringify(structureOut, null, 2),
    );
    structureIndexToFile.set(i + 1, fileName);
    structureRecords.push({
      index: i + 1,
      file: fileName,
      building_number: structureBuildingNumber,
    });
  }

  // Layouts from owners/layout_data.json
  await removeExisting(/^layout_.*\.json$/);
  await removeExisting(/^relationship_property_has_layout_.*\.json$/);
  await removeExisting(/^relationship_layout_.*_has_layout_.*\.json$/);
  await removeExisting(/^relationship_layout_.*_has_structure_.*\.json$/);
  await removeExisting(/^relationship_layout_.*_has_utility_.*\.json$/);
  await removeExisting(/^relationship_layout_.*\.json$/);

  const layoutEntries = [];
  if (layoutData && typeof layoutData === "object") {
    for (const key of Object.keys(layoutData)) {
      if (!Object.prototype.hasOwnProperty.call(layoutData, key)) continue;
      const entry = layoutData[key];
      if (!entry) continue;
      if (Array.isArray(entry.layouts)) {
        layoutEntries.push(...entry.layouts.filter((e) => e && typeof e === "object"));
      } else if (Array.isArray(entry)) {
        layoutEntries.push(...entry.filter((e) => e && typeof e === "object"));
      } else if (entry && typeof entry === "object" && !entry.layouts) {
        layoutEntries.push(entry);
      }
    }
  }

  const layoutRecords = [];
  const buildingLayoutIndexByNumber = new Map();
  const buildingLayoutIndices = [];

  for (let i = 0; i < layoutEntries.length; i++) {
    const layout = layoutEntries[i] || {};
    const fileName = `layout_${i + 1}.json`;

    const layoutOut = { ...layout };
    if (Object.prototype.hasOwnProperty.call(layoutOut, "source_http_request")) {
      delete layoutOut.source_http_request;
    }
    if (Object.prototype.hasOwnProperty.call(layoutOut, "url")) {
      delete layoutOut.url;
    }
    layoutOut.request_identifier = baseRequestData.request_identifier || null;

    if (layoutOut.space_type === "Building") {
      if (layoutOut.building_number == null) {
        layoutOut.building_number = buildingLayoutIndices.length + 1;
      }
      if (!buildingLayoutIndexByNumber.has(layoutOut.building_number)) {
        buildingLayoutIndexByNumber.set(layoutOut.building_number, i + 1);
      }
      buildingLayoutIndices.push(i + 1);
    } else if (layoutOut.building_number === undefined) {
      layoutOut.building_number = null;
    }

    await fsp.writeFile(
      path.join("data", fileName),
      JSON.stringify(layoutOut, null, 2),
    );
    layoutIndexToFile.set(i + 1, fileName);
    layoutRecords.push({
      index: i + 1,
      file: fileName,
      space_type: layoutOut.space_type || null,
      building_number: layoutOut.building_number ?? null,
    });
  }

  const derivedTotalBuildings =
    buildingLayoutIndices.length > 0
      ? buildingLayoutIndices.length
      : Math.max(
          utilitiesTotalBuildings || 0,
          structuresTotalBuildings || 0,
        );
  const hasSingleBuildingLayout = buildingLayoutIndices.length === 1;
  const multiBuilding =
    buildingLayoutIndices.length > 1 ||
    (buildingLayoutIndices.length === 0 && derivedTotalBuildings > 1);
  const primaryBuildingIndex = hasSingleBuildingLayout
    ? buildingLayoutIndices[0]
    : null;

  // if (propertyOut) {
  //   for (const record of layoutRecords) {
  //     if (multiBuilding || record.space_type === "Building") {
  //       const relFile = `relationship_property_has_layout_${record.index}.json`;
  //       const relOut = {
  //         from: { "/": "./property.json" },
  //         to: { "/": `./${record.file}` },
  //       };
  //       await fsp.writeFile(
  //         path.join("data", relFile),
  //         JSON.stringify(relOut, null, 2),
  //       );
  //     }
  //   }
  // }

  for (const record of layoutRecords) {
    if (record.space_type === "Building") continue;
    let parentIndex = null;
    if (
      record.building_number != null &&
      buildingLayoutIndexByNumber.has(record.building_number)
    ) {
      parentIndex = buildingLayoutIndexByNumber.get(record.building_number);
    } else if (!multiBuilding && primaryBuildingIndex != null) {
      parentIndex = primaryBuildingIndex;
    }
    if (
      parentIndex != null &&
      parentIndex !== record.index &&
      layoutIndexToFile.has(parentIndex)
    ) {
      const relFile = `relationship_layout_${parentIndex}_has_layout_${record.index}.json`;
      await writeRelationshipFile(
        relFile,
        `./${layoutIndexToFile.get(parentIndex)}`,
        `./${record.file}`,
      );
    }
  }

  // if (propertyOut) {
  //   for (const record of propertyImprovementRecords) {
  //     const relFile = `relationship_property_has_property_improvement_${record.index}.json`;
  //     const relOut = {
  //       from: propertyRef,
  //       to: { "/": `./${record.file}` },
  //     };
  //     await fsp.writeFile(
  //       path.join("data", relFile),
  //       JSON.stringify(relOut, null, 2),
  //     );
  //   }
  // }

  for (const record of utilityRecords) {
    const utilityRef = `./${record.file}`;
    let linkedToLayout = false;

    if (multiBuilding) {
      if (
        record.building_number != null &&
        buildingLayoutIndexByNumber.has(record.building_number)
      ) {
        const parentIndex = buildingLayoutIndexByNumber.get(record.building_number);
        const layoutFile = layoutIndexToFile.get(parentIndex);
        if (layoutFile) {
          const relFile = `relationship_layout_${parentIndex}_has_utility_${record.index}.json`;
          const wroteRel = await writeRelationshipFile(
            relFile,
            `./${layoutFile}`,
            utilityRef,
          );
          if (wroteRel) {
            linkedToLayout = true;
          }
        }
      }
    } else if (hasSingleBuildingLayout && primaryBuildingIndex != null) {
      const layoutFile = layoutIndexToFile.get(primaryBuildingIndex);
      if (layoutFile) {
        const relFile = `relationship_layout_${primaryBuildingIndex}_has_utility_${record.index}.json`;
        const wroteRel = await writeRelationshipFile(
          relFile,
          `./${layoutFile}`,
          utilityRef,
        );
        if (wroteRel) {
          linkedToLayout = true;
        }
      }
    }

    if (!linkedToLayout && propertyOut) {
      const relFile = `relationship_property_has_utility_${record.index}.json`;
      await writeRelationshipFile(relFile, propertyRef, utilityRef);
    }
  }

  for (const record of structureRecords) {
    const structureRef = `./${record.file}`;
    let linkedToLayout = false;

    if (multiBuilding) {
      if (
        record.building_number != null &&
        buildingLayoutIndexByNumber.has(record.building_number)
      ) {
        const parentIndex = buildingLayoutIndexByNumber.get(record.building_number);
        const layoutFile = layoutIndexToFile.get(parentIndex);
        if (layoutFile) {
          const relFile = `relationship_layout_${parentIndex}_has_structure_${record.index}.json`;
          const wroteRel = await writeRelationshipFile(
            relFile,
            `./${layoutFile}`,
            structureRef,
          );
          if (wroteRel) {
            linkedToLayout = true;
          }
        }
      }
    } else if (hasSingleBuildingLayout && primaryBuildingIndex != null) {
      const layoutFile = layoutIndexToFile.get(primaryBuildingIndex);
      if (layoutFile) {
        const relFile = `relationship_layout_${primaryBuildingIndex}_has_structure_${record.index}.json`;
        const wroteRel = await writeRelationshipFile(
          relFile,
          `./${layoutFile}`,
          structureRef,
        );
        if (wroteRel) {
          linkedToLayout = true;
        }
      }
    }

    if (!linkedToLayout && propertyOut) {
      const relFile = `relationship_property_has_structure_${record.index}.json`;
      await writeRelationshipFile(relFile, propertyRef, structureRef);
    }
  }

  // Files: collect key document/media links (excluding deed-related files now handled above)
  if (!isMulti) {
    const urls = new Set();
    $('a[href*="TrimPrint"]').each((i, a) => urls.add($(a).attr("href")));
    $('a[href*="/downloads/mapbook/"]').each((i, a) =>
      urls.add($(a).attr("href")),
    );
    $('a[href*="ImageSketches"], a[href*="imagesketches"]').each((i, a) =>
      urls.add($(a).attr("href")),
    );

    // Filter out URLs that were already processed as deed files (if any overlap)
    const processedDeedUrls = new Set(sales.map(s => s._book_page_url).filter(Boolean));
    const uniqueNonDeedUrls = [...urls].filter(u => !processedDeedUrls.has(u));

    let currentFileIdx = fileIdx; // Continue numbering from where deed files left off
      for (const u of uniqueNonDeedUrls) {
        currentFileIdx += 1;
        const fileFileName = `file_${currentFileIdx}.json`;
        const rec = {
          request_identifier: baseRequestData.request_identifier || null,
          file_format: getFileFormatFromUrl(u),
          name: path.basename(u || "") || null,
          document_type: null,
        };
      // Map document_type to schema-compliant values
      // Changed "Miscellaneous" to null as "Miscellaneous" is not in the schema's enum.
      // If "TaxDocument" and "MapDocument" are truly, the schema must be updated.
      if (u.includes("TrimPrint")) rec.document_type = null; // Changed from "Miscellaneous" to null
      else if (u.includes("mapbook")) rec.document_type = null; // Changed from "Miscellaneous" to null
      else if (rec.file_format === "jpeg" || rec.file_format === "png") rec.document_type = "PropertyImage";
      else rec.document_type = null; // Default for other links, using null for schema compliance

      await fsp.writeFile(
        path.join("data", fileFileName),
        JSON.stringify(rec, null, 2),
      );
    }
  }

}

}

}

main().catch(async (err) => {
  const errMsg = {
    type: "error",
    message: err && err.message ? err.message : String(err),
    path: "scripts/data_extractor",
  };
  try {
    ensureDirSync("data");
    await fsp.writeFile(
      path.join("data", "error.json"),
      JSON.stringify(errMsg, null, 2),
    );
  } catch {}
  console.error(err);
  process.exit(1);
});
