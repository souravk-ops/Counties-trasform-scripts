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

function relationshipRef(pathLike) {
  if (!pathLike || typeof pathLike !== "string") return null;
  const trimmed = pathLike.trim();
  return trimmed ? { "/": trimmed } : null;
}

function createRelationshipPayload(fromPath, toPath, extras = {}) {
  const payload = { ...extras };
  const fromRef = relationshipRef(fromPath);
  const toRef = relationshipRef(toPath);
  if (fromRef) payload.from = fromRef;
  if (toRef) payload.to = toRef;
  return payload;
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
    preferredMode === "structured"
      ? "structured"
      : preferredMode === "unnormalized"
        ? "unnormalized"
        : null;

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
    return keepStructured();
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
    source_http_request: address.source_http_request || null,
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

function parsePersonNameTokens(name) {
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
  const first = toTitleCaseName(tokens[0]);
  const last = toTitleCaseName(tokens[tokens.length - 1]);
  const middleRaw =
    tokens.length > 2 ? tokens.slice(1, -1).join(" ") || null : null;
  const middle = toTitleCaseName(middleRaw);

  // Validate middle name against the pattern if it exists
  const middleNamePattern = /^[A-Z][a-zA-Z\s\-',.]*$/;
  const validatedMiddle = (middle && middleNamePattern.test(middle)) ? middle : null;

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

function enforceNamePattern(value, pattern) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return pattern.test(trimmed) ? trimmed : null;
}

function normalizePersonNameValue(value, pattern = PERSON_NAME_PATTERN) {
  if (!value) return null;
  let cleaned = textClean(String(value));
  if (cleaned.normalize) {
    cleaned = cleaned.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  cleaned = cleaned
    .replace(/[^A-Za-z \-',.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  cleaned = cleaned.replace(/([ \-',.])+$/g, "").trim();
  if (!cleaned) return null;

  const titleCased = toTitleCaseName(cleaned);
  if (!titleCased) return null;

  let trimmed = titleCased.replace(/([ \-',.])+$/g, "").trim();
  if (!trimmed) return null;

  trimmed = trimmed
    .replace(/,/g, " ")
    .replace(/\.(?=[A-Za-z])/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/'+/g, "'")
    .trim();

  trimmed = trimmed.replace(/([ \-',])+$/g, "").trim();

  if (!trimmed) return null;
  if (!/[A-Za-z]$/.test(trimmed)) return null;

  return pattern.test(trimmed) ? trimmed : null;
}

function ensurePersonNamePattern(value, pattern = PERSON_NAME_PATTERN) {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (pattern.test(trimmed)) {
      return trimmed;
    }
  }
  const normalized = normalizePersonNameValue(value, pattern);
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
  const addressRef = "./address.json";
  let propertyExists = false;

  // Base data for address output, derived from property_seed or unnormalized_address
  // Ensure source_http_request is taken from property_seed if available, otherwise unnormalized_address
  const baseRequestData = propertySeedData || unnormalizedAddressData || {};
  const sourceHttpRequest = baseRequestData.source_http_request || null;
  const sourceHttpRequestUrl = sourceHttpRequest ? sourceHttpRequest.url : null;

  await removeExisting(/^property_improvement_.*\.json$/);
  await removeExisting(/^relationship_property_has_property_improvement_.*\.json$/);
  await removeExisting(/^relationship_property_has_address.*\.json$/);
  await removeExisting(/^relationship_address_has_fact_sheet.*\.json$/);
  await removeExisting(/^relationship_person_.*_has_fact_sheet.*\.json$/);
  await removeExisting(/^address\.json$/);
  const propertyImprovementRecords = [];


  // --- Address extraction ---
  let siteAddress = null;
  let secTownRange = null;
  let jurisdiction = null;
  let parcelIdentifierDashed = null;

  let township = null;
  let range = null;
  let section = null;
  let addressHasCoreData = false;

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

  const finalAddressOutput = {
    source_http_request: sourceHttpRequest || null,
    request_identifier: baseRequestData.request_identifier || null,
  };

  const countySource =
    (unnormalizedAddressData && unnormalizedAddressData.county_jurisdiction) ||
    jurisdiction ||
    null;
  const normalizedCounty = normalizeCountyName(countySource) || "St. Lucie";
  assignIfValue(finalAddressOutput, "county_name", normalizedCounty);

  assignIfValue(
    finalAddressOutput,
    "latitude",
    unnormalizedAddressData ? unnormalizedAddressData.latitude ?? null : null,
  );
  assignIfValue(
    finalAddressOutput,
    "longitude",
    unnormalizedAddressData ? unnormalizedAddressData.longitude ?? null : null,
  );

  const normalizedAddressSource =
    (baseRequestData && baseRequestData.normalized_address) ||
    (unnormalizedAddressData && unnormalizedAddressData.normalized_address) ||
    null;

  const structuredCandidate = normalizedAddressSource
    ? pickStructuredAddress(normalizedAddressSource)
    : null;
  let fallbackAddress = null;

  if (structuredCandidate) {
    Object.assign(finalAddressOutput, structuredCandidate);
  } else {
    if (unnormalizedAddressData && unnormalizedAddressData.full_address) {
      fallbackAddress = textClean(unnormalizedAddressData.full_address);
    }
    if (!fallbackAddress && siteAddress) {
      fallbackAddress = textClean(siteAddress);
    }
    if (fallbackAddress) {
      assignIfValue(finalAddressOutput, "unnormalized_address", fallbackAddress);
      for (const key of STRUCTURED_ADDRESS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(finalAddressOutput, key)) {
          delete finalAddressOutput[key];
        }
      }
    }
  }

  const preferredAddressMode = structuredCandidate
    ? "structured"
    : fallbackAddress
      ? "unnormalized"
      : null;

  if (secTownRange) {
    const strMatch = secTownRange.match(/^(\d+)\/(\d+[NS])\/(\d+[EW])$/i);
    if (strMatch) {
      section = strMatch[1];
      township = strMatch[2];
      range = strMatch[3];
    }
  }

  if (township) assignIfValue(finalAddressOutput, "township", township);
  if (range) assignIfValue(finalAddressOutput, "range", range);
  if (section) assignIfValue(finalAddressOutput, "section", section);

  const addressResolution = normalizeAddressForOutput(
    finalAddressOutput,
    preferredAddressMode,
  );

  let preparedAddressOutput = buildAddressPayload(
    finalAddressOutput,
    addressResolution.mode,
  );
  if (preparedAddressOutput) {
    preparedAddressOutput =
      sanitizeAddressPayloadForOneOf(preparedAddressOutput) || null;
  }

  addressHasCoreData = Boolean(preparedAddressOutput);

  if (addressHasCoreData) {
    await fsp.writeFile(
      path.join("data", "address.json"),
      JSON.stringify(preparedAddressOutput, null, 2),
    );
  }

  // --- Parcel extraction ---
  // parcelIdentifierDashed is already extracted from HTML
  const parcelOut = {
    source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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
      source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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
    propertyExists = true;

    if (addressHasCoreData) {
      const propertyHasAddressRel = createRelationshipPayload(
        propertyRef,
        addressRef,
      );
      await fsp.writeFile(
        path.join("data", "relationship_property_has_address.json"),
        JSON.stringify(propertyHasAddressRel, null, 2),
      );

      const addressHasFactSheetRel = createRelationshipPayload(
        addressRef,
        propertyRef,
      );
      await fsp.writeFile(
        path.join("data", "relationship_address_has_fact_sheet.json"),
        JSON.stringify(addressHasFactSheetRel, null, 2),
      );
    }
    // Lot data

    const lotOut = {
      source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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
        source_http_request: sourceHttpRequest,
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

    function ensureOwnerRecordFromName(name) {
      const cleaned = textClean(name);
      if (!cleaned) return null;
      const existing = getOwnerRecordByAlias(cleaned);
      if (existing) {
        registerAlias(existing, cleaned);
        return existing;
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
      const parsed = parsePersonNameTokens(cleaned) || null;
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
      mailingAddressOut = {
        source_http_request: sourceHttpRequest || null,
        request_identifier: baseRequestData.request_identifier || null,
      };
      assignIfValue(
        mailingAddressOut,
        "unnormalized_address",
        mailingAddressText,
      );

      console.log("Final Mailing Address Object (unnormalized):", mailingAddressOut);

      const mailingAddressResolution = normalizeAddressForOutput(
        mailingAddressOut,
        "unnormalized",
      );

      let preparedMailingAddress = buildAddressPayload(
        mailingAddressOut,
        mailingAddressResolution.mode,
      );
      if (preparedMailingAddress) {
        preparedMailingAddress =
          sanitizeAddressPayloadForOneOf(preparedMailingAddress) || null;
      }

      if (preparedMailingAddress) {
        await fsp.writeFile(
          path.join("data", "mailing_address.json"),
          JSON.stringify(preparedMailingAddress, null, 2),
        );
        mailingAddressOut = preparedMailingAddress;
        console.log("mailing_address.json created.");
      } else {
        mailingAddressOut = null;
      }
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
      let grantorRecord = sale._grantor_name ? ensureOwnerRecordFromName(sale._grantor_name) : null;
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
            source_http_request: sourceHttpRequest,
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
            source_http_request: sourceHttpRequest,
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

        personIdx += 1;
        const fileName = `person_${personIdx}.json`;
        const personOut = {
          source_http_request: sourceHttpRequest,
          birth_date: validatedOutput.birth_date ?? null,
          first_name: validatedOutput.first_name,
          last_name: validatedOutput.last_name,
          middle_name: validatedOutput.middle_name ?? null,
          prefix_name: validatedOutput.prefix_name ?? null,
          suffix_name: validatedOutput.suffix_name ?? null,
          us_citizenship_status: validatedOutput.us_citizenship_status ?? null,
          veteran_status: validatedOutput.veteran_status ?? null,
          request_identifier: validatedOutput.request_identifier ?? null,
        };

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
          source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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
    if (propertyExists && ownerToFileMap.size > 0) {
      const linkedPersonIndexes = new Set();
      for (const meta of ownerToFileMap.values()) {
        if (meta.type !== "person") continue;
        if (linkedPersonIndexes.has(meta.index)) continue;
        linkedPersonIndexes.add(meta.index);

        const relFileName = `relationship_person_${meta.index}_has_fact_sheet.json`;
        const relOut = createRelationshipPayload(
          `./${meta.fileName}`,
          propertyRef,
        );
        await fsp.writeFile(
          path.join("data", relFileName),
          JSON.stringify(relOut, null, 2),
        );
      }
    }

    if (currentOwnerRecord  && mailingAddressOut) {
      const latestOwnerMeta = ownerToFileMap.get(currentOwnerRecord.id);
      if (latestOwnerMeta) { // Ensure it's a person for this relationship
        const relFileName = `relationship_${latestOwnerMeta.type}_${latestOwnerMeta.index}_has_mailing_address.json`;
        const relOut = createRelationshipPayload(
          `./${latestOwnerMeta.fileName}`,
          "./mailing_address.json",
        );
        await fsp.writeFile(
          path.join("data", relFileName),
          JSON.stringify(relOut, null, 2),
        );
        console.log(`Created mailing address relationship: ${relFileName}`);
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
          const relOut = createRelationshipPayload(
            propertyRef,
            `./${meta.fileName}`,
          );
          await fsp.writeFile(
            path.join("data", relFileName),
            JSON.stringify(relOut, null, 2),
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
        source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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
          source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
          deed_type: deedType,
        };
        await fsp.writeFile(
          path.join("data", deedFileName),
          JSON.stringify(deedOut, null, 2),
        );

        const relSalesDeed = createRelationshipPayload(
          `./${saleFileName}`,
          `./${deedFileName}`,
        );
        await fsp.writeFile(
          path.join(
            "data",
            `relationship_sales_history_${i + 1}_to_deed_${i + 1}.json`,
          ),
          JSON.stringify(relSalesDeed, null, 2),
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
            const relOut = createRelationshipPayload(
              `./${saleFileName}`,
              `./${granteeMeta.fileName}`,
            );
            await fsp.writeFile(
              path.join("data", relFileName),
              JSON.stringify(relOut, null, 2),
            );
          }
        }
        // --- End of sales_history_has_person/company relationships ---


        if (sale._book_page_url) {
          fileIdx += 1;
          const fileFileName = `file_${fileIdx}.json`;
          const fileOut = {
            source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
            request_identifier: baseRequestData.request_identifier || null,
            file_format: getFileFormatFromUrl(sale._book_page_url),
            name: path.basename(sale._book_page_url) || null,
            original_url: sale._book_page_url,
            ipfs_url: null,
            document_type: "ConveyanceDeed",
          };
          await fsp.writeFile(
            path.join("data", fileFileName),
            JSON.stringify(fileOut, null, 2),
          );

          const relDeedFile = createRelationshipPayload(
            `./${deedFileName}`,
            `./${fileFileName}`,
          );
          await fsp.writeFile(
            path.join("data", `relationship_deed_${i + 1}_to_file_${fileIdx}.json`),
            JSON.stringify(relDeedFile, null, 2),
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
        source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
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

    if (utilityOut.url && utilityOut.url.includes("placeholder")) {
      utilityOut.url = sourceHttpRequestUrl;
    }
    utilityOut.source_http_request = sourceHttpRequest;
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

    if (structureOut.url && structureOut.url.includes("placeholder")) {
      structureOut.url = sourceHttpRequestUrl;
    }
    structureOut.source_http_request = sourceHttpRequest;
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
    if (layoutOut.url && layoutOut.url.includes("placeholder")) {
      layoutOut.url = sourceHttpRequestUrl;
    }
    layoutOut.source_http_request = sourceHttpRequest;
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
      const relOut = createRelationshipPayload(
        `./${layoutIndexToFile.get(parentIndex)}`,
        `./${record.file}`,
      );
      await fsp.writeFile(
        path.join("data", relFile),
        JSON.stringify(relOut, null, 2),
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
          const relOut = createRelationshipPayload(
            `./${layoutFile}`,
            utilityRef,
          );
          await fsp.writeFile(
            path.join("data", relFile),
            JSON.stringify(relOut, null, 2),
          );
          linkedToLayout = true;
        }
      }
    } else if (hasSingleBuildingLayout && primaryBuildingIndex != null) {
      const layoutFile = layoutIndexToFile.get(primaryBuildingIndex);
      if (layoutFile) {
        const relFile = `relationship_layout_${primaryBuildingIndex}_has_utility_${record.index}.json`;
        const relOut = createRelationshipPayload(
          `./${layoutFile}`,
          utilityRef,
        );
        await fsp.writeFile(
          path.join("data", relFile),
          JSON.stringify(relOut, null, 2),
        );
        linkedToLayout = true;
      }
    }

    if (!linkedToLayout && propertyOut) {
      const relFile = `relationship_property_has_utility_${record.index}.json`;
      const relOut = createRelationshipPayload(
        propertyRef,
        utilityRef,
      );
      await fsp.writeFile(
        path.join("data", relFile),
        JSON.stringify(relOut, null, 2),
      );
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
          const relOut = createRelationshipPayload(
            `./${layoutFile}`,
            structureRef,
          );
          await fsp.writeFile(
            path.join("data", relFile),
            JSON.stringify(relOut, null, 2),
          );
          linkedToLayout = true;
        }
      }
    } else if (hasSingleBuildingLayout && primaryBuildingIndex != null) {
      const layoutFile = layoutIndexToFile.get(primaryBuildingIndex);
      if (layoutFile) {
        const relFile = `relationship_layout_${primaryBuildingIndex}_has_structure_${record.index}.json`;
        const relOut = createRelationshipPayload(
          `./${layoutFile}`,
          structureRef,
        );
        await fsp.writeFile(
          path.join("data", relFile),
          JSON.stringify(relOut, null, 2),
        );
        linkedToLayout = true;
      }
    }

    if (!linkedToLayout && propertyOut) {
      const relFile = `relationship_property_has_structure_${record.index}.json`;
      const relOut = createRelationshipPayload(
        propertyRef,
        structureRef,
      );
      await fsp.writeFile(
        path.join("data", relFile),
        JSON.stringify(relOut, null, 2),
      );
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
        source_http_request: sourceHttpRequest, // Use the extracted sourceHttpRequest
        request_identifier: baseRequestData.request_identifier || null,
        file_format: getFileFormatFromUrl(u),
        name: path.basename(u || "") || null,
        original_url: u || null,
        ipfs_url: null,
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
