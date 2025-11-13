#!/usr/bin/env node
/*
  Data extractor for property package.
  - Reads: input.html, unnormalized_address.json, property_seed.json
           owners/owner_data.json, owners/utilities_data.json, owners/layout_data.json
  - Writes: JSON files in ./data per schemas (without performing schema validation)

  Notes:
  - Owners, utilities, and layout are sourced strictly from the owners/*.json inputs
  - All other data are parsed from input.html (with county assist from unnormalized_address)
  - Missing/unknown values are set to null where schema allows
  - Idempotent: clears ./data before writing
*/

const fs = require("fs");
const path = require("path");
let cheerio;
try {
  cheerio = require("cheerio");
} catch (e) {
  cheerio = null;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function clearDir(p) {
  if (!fs.existsSync(p)) return;
  for (const f of fs.readdirSync(p)) fs.unlinkSync(path.join(p, f));
}
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function readText(p) {
  return fs.readFileSync(p, "utf8");
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function parseCurrency(str) {
  if (str == null) return null;
  const s = String(str).replace(/[$,\s]/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? Number(n.toFixed(2)) : null;
}
function toISODate(mdY) {
  if (!mdY) return null;
  const m = mdY.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}
function properCaseName(s) {
  if (!s) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function mapLandUseToPropertyType(landUseDescription) {
  if (!landUseDescription) return null;

  const desc = landUseDescription.toUpperCase();

  if (
    /AGRIC|AG\s*\/|PASTURE|GROVE|CATTLE|HAY|FARM/.test(desc) ||
    desc.includes("HOMESITE")
  )
    return "LandParcel";
  if (desc.includes("VACANT")) return "VacantLand";
  if (desc.includes("SINGLE FAMILY")) return "SingleFamily";
  if (desc.includes("DETACHED CONDO")) return "DetachedCondominium";
  if (desc.includes("CONDOMINIUM") || desc.includes("CONDO"))
    return "Condominium";
  if (desc.includes("NON WARRANTABLE")) return "NonWarrantableCondo";
  if (desc.includes("CO-OP")) return "Cooperative";
  if (
    desc.includes("MANUFACTURED HOME SUB") ||
    desc.includes("MANUFACTURED SUB")
  )
    return "ManufacturedHousingMultiWide";
  if (desc.includes("MANUFACTURED HOME") && !desc.includes("SUB"))
    return "ManufacturedHome";
  if (desc.includes("MOBILE HOME")) return "MobileHome";
  if (desc.includes("MODULAR")) return "Modular";
  if (desc.includes("TIMESHARE")) return "Timeshare";
  if (desc.includes("TOWNHOUSE")) return "Townhouse";
  if (desc.includes("PUD")) return "Pud";
  if (desc.includes("RETIREMENT")) return "Retirement";
  if (desc.includes("MISC") || desc.includes("MIGRANT"))
    return "MiscellaneousResidential";
  if (
    desc.includes("RESIDENTIAL COMMON ELEMENTS") ||
    desc.includes("COMMON ELEMENTS")
  )
    return "ResidentialCommonElementsAreas";
  if (desc.includes("APARTMENT")) return "Apartment";
  if (desc.includes("DUPLEX") || desc.includes(" TWO FAMILY")) return "Duplex";
  if (desc.includes("TRIPLEX") || desc.includes("3 PLEX")) return "3Units";
  if (desc.includes("4PLEX") || desc.includes("4 PLEX")) return "4Units";
  if (desc.includes("2 UNIT")) return "2Units";
  if (
    (desc.includes("MULTI FAMILY") || desc.includes("MULTIFAMILY")) &&
    (desc.includes(">9") ||
      desc.includes(">=10") ||
      desc.includes(" 10 ") ||
      desc.includes("10+") ||
      desc.includes("APARTMENT"))
  )
    return "MultiFamilyMoreThan10";
  if (
    desc.includes("MULTI FAMILY") ||
    desc.includes("MULTIFAMILY") ||
    desc.includes("MULTI-FAMILY")
  ) {
    if (
      desc.includes("<5") ||
      desc.includes("<=9") ||
      desc.includes(">4 AND <10") ||
      desc.includes("<=4")
    )
      return "MultiFamilyLessThan10";
    return "MultipleFamily";
  }

  // Default to null for non-residential or unrecognized codes
  return null;
}

function getUnitsType(units) {
  if (!units || units === 1) return "One";
  if (units === 2) return "Two";
  if (units === 3) return "Three";
  if (units === 4) return "Four";
  if (units >= 2 && units <= 4) return "TwoToFour";
  if (units >= 1 && units <= 4) return "OneToFour";
  return null;
}

const PROPERTY_TYPE_VALUES = new Set([
  "Cooperative",
  "Condominium",
  "Modular",
  "ManufacturedHousingMultiWide",
  "Pud",
  "Timeshare",
  "2Units",
  "DetachedCondominium",
  "Duplex",
  "SingleFamily",
  "MultipleFamily",
  "3Units",
  "ManufacturedHousing",
  "ManufacturedHousingSingleWide",
  "4Units",
  "Townhouse",
  "NonWarrantableCondo",
  "VacantLand",
  "Retirement",
  "MiscellaneousResidential",
  "ResidentialCommonElementsAreas",
  "MobileHome",
  "Apartment",
  "MultiFamilyMoreThan10",
  "MultiFamilyLessThan10",
  "LandParcel",
  "Building",
  "Unit",
  "ManufacturedHome",
]);

function normalizePropertyType(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  return PROPERTY_TYPE_VALUES.has(normalized) ? normalized : null;
}

function mapInstrumentToDeedType(instrument) {
  if (!instrument) return null;
  const raw = instrument.trim().toLowerCase();
  if (!raw) return null;
  const simple = raw.replace(/\./g, "");
  if (/(^|\s)sw(d| deed)?\b/.test(simple) || simple.includes("special warranty"))
    return "Special Warranty Deed";
  if (/(^|\s)wd\b/.test(simple) || simple.includes("warranty deed"))
    return "Warranty Deed";
  if (/(^|\s)q(cd|uitclaim)?\b/.test(simple) || simple.includes("quit"))
    return "Quitclaim Deed";
  if (simple.includes("bargain") || simple.includes("sale deed"))
    return "Bargain and Sale Deed";
  if (simple.includes("grant deed")) return "Grant Deed";
  if (simple.includes("trustee")) return "Trustee's Deed";
  if (simple.includes("tax deed")) return "Tax Deed";
  if (simple.includes("sheriff")) return "Sheriff's Deed";
  if (simple.includes("personal representative") || /\bprd?\b/.test(simple))
    return "Personal Representative Deed";
  if (simple.includes("administrator")) return "Administrator's Deed";
  if (simple.includes("guardian")) return "Guardian's Deed";
  if (simple.includes("lady bird")) return "Lady Bird Deed";
  if (simple.includes("life estate")) return "Life Estate Deed";
  if (simple.includes("court order")) return "Court Order Deed";
  if (simple.includes("transfer on death")) return "Transfer on Death Deed";
  if (simple.includes("gift deed")) return "Gift Deed";
  if (simple.includes("interspousal")) return "Interspousal Transfer Deed";
  if (simple.includes("joint tenancy")) return "Joint Tenancy Deed";
  if (simple.includes("tenancy in common")) return "Tenancy in Common Deed";
  if (simple.includes("community property")) return "Community Property Deed";
  if (simple.includes("release")) return "Release of Contract";
  if (simple.includes("assignment")) return "Assignment of Contract";
  if (simple.includes("contract for deed")) return "Contract for Deed";
  if (simple.includes("quiet title")) return "Quiet Title Deed";
  return "Miscellaneous";
}

function mapFileDocumentTypeFromDeedType(deedType) {
  if (!deedType) return null;
  switch (deedType) {
    case "Warranty Deed":
      return "ConveyanceDeedWarrantyDeed";
    case "Special Warranty Deed":
      return "ConveyanceDeedSpecialWarrantyDeed";
    case "Quitclaim Deed":
      return "ConveyanceDeedQuitClaimDeed";
    case "Grant Deed":
      return "ConveyanceDeedGrantDeed";
    case "Bargain and Sale Deed":
      return "ConveyanceDeedBargainAndSaleDeed";
    case "Trustee's Deed":
      return "ConveyanceDeedTrusteesDeed";
    case "Sheriff's Deed":
      return "ConveyanceDeedSheriffsDeed";
    case "Tax Deed":
      return "ConveyanceDeedTaxDeed";
    default:
      return "ConveyanceDeed";
  }
}

function main() {
  const dataDir = path.join(".", "data");
  ensureDir(dataDir);
  clearDir(dataDir);

  // Inputs
  const inputHtml = readText("input.html");
  const addrSeed = readJSON("unnormalized_address.json");
  const propSeed = readJSON("property_seed.json");

  // Owner-related JSON sources
  const ownerPath = path.join("owners", "owner_data.json");
  const utilitiesPath = path.join("owners", "utilities_data.json");
  const layoutPath = path.join("owners", "layout_data.json");

  const ownerData = fs.existsSync(ownerPath) ? readJSON(ownerPath) : null;
  const utilitiesData = fs.existsSync(utilitiesPath)
    ? readJSON(utilitiesPath)
    : null;
  const layoutData = fs.existsSync(layoutPath) ? readJSON(layoutPath) : null;

  const altKey =
    (propSeed &&
      propSeed.source_http_request &&
      propSeed.source_http_request.multiValueQueryString &&
      propSeed.source_http_request.multiValueQueryString.AltKey &&
      propSeed.source_http_request.multiValueQueryString.AltKey[0]) ||
    (addrSeed &&
      addrSeed.source_http_request &&
      addrSeed.source_http_request.multiValueQueryString &&
      addrSeed.source_http_request.multiValueQueryString.AltKey &&
      addrSeed.source_http_request.multiValueQueryString.AltKey[0]) ||
    null;
  const ownerKey = altKey ? `property_${altKey}` : null;

  // HTML parsing
  let $ = null;
  if (cheerio) {
    $ = cheerio.load(inputHtml);
  }

  // Helper: find cell by label in General Information table
  function extractGeneral() {
    if (!$) return {};
    const result = {};
    // Parcel Number
    const rows = $("table.property_head").first().find("tr");
    rows.each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 4) {
        const label = $(tds[2]).text().trim();
        const val = $(tds[3]).text().trim();
        if (/Parcel Number/i.test(label)) result.parcelNumber = val || null;
      }
    });

    // Property Location block
    rows.each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 4) {
        const label = $(tds[0]).text().trim();
        if (/Property Location:/i.test(label)) {
          const addrHtml = $(tds[1]).html() || "";
          const addrText = addrHtml
            .replace(/<br\s*\/?>(?=\s*|$)/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .trim();
          result.propertyLocationRaw = addrText; // e.g., "31729 PARKDALE DR\nLEESBURG FL, 34748"
        }
      }
    });

    // Property Description
    rows.each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 2) {
        const label = $(tds[0]).text().trim();
        if (/Property Description:/i.test(label)) {
          result.legalDescription = $(tds[1]).text().trim() || null;
        }
      }
    });

    return result;
  }

  function extractPropertyTypeFromLandData() {
    if (!$) return { propertyType: null, units: null };

    let landUseDescription = null;
    let units = null;

    // Extract from Land Data table
    $("#cphMain_gvLandData tr.property_row").each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 2) {
        const landUseText = $(tds[1]).text().trim();
        if (landUseText) {
          landUseDescription = landUseText.toUpperCase();
        }
      }
    });

    // Also check for units in building summary if available
    $("table.property_building_summary td").each((i, td) => {
      const text = $(td).text().trim();
      const unitMatch = text.match(/Units:\s*(\d+)/i);
      if (unitMatch) {
        units = parseInt(unitMatch[1], 10);
      }
    });

    const propertyType = mapLandUseToPropertyType(landUseDescription);

    return { propertyType, units };
  }

  // Extract Living Area, Year Built, Building/Land Values, Sales, and derive structure hints
  function extractBuildingAndValues() {
    if (!$) return {};
    const out = {
      yearBuilt: null,
      livingArea: null,
      buildingValue: null,
      landValue: null,
      assessedValue: null,
      taxableValue: null,
      marketValue: null,
      taxYear: null,
      sales: [],
      deeds: [],
      files: [],
      structure: {
        number_of_stories: null,
        exterior_wall_material_primary: null,
        exterior_wall_material_secondary: null,
        primary_framing_material: null,
      },
    };

    // Summary table with Year Built and Total Living Area
    $("table.property_building_summary td").each((i, td) => {
      const t = $(td).text().replace(/\s+/g, " ").trim();
      let m;
      m = t.match(/Year Built:\s*(\d{4})/i);
      if (m) out.yearBuilt = parseInt(m[1], 10);
      m = t.match(/Total Living Area:\s*([0-9,\.]+)/i);
      if (m) out.livingArea = m[1].replace(/[,]/g, "").trim();
    });

    // Building Value
    $("div.property_building table")
      .first()
      .find("tr")
      .first()
      .find("td")
      .each((i, td) => {
        const text = $(td).text();
        const m = text.match(/Building Value:\s*\$([0-9,\.]+)/i);
        if (m) out.buildingValue = parseCurrency(m[0].split(":")[1]);
      });

    // Land Value (from Land Data table)
    $("#cphMain_gvLandData tr.property_row").each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 9) {
        const lv = $(tds[8]).text();
        const parsed = parseCurrency(lv);
        if (parsed != null) out.landValue = parsed;
      }
    });

    // Tax values
    const estRows = $("#cphMain_gvEstTax tr").toArray();
    if (estRows.length > 1) {
      // First data row after header
      const tds = $(estRows[1]).find("td");
      if (tds.length >= 6) {
        const market = $(tds[1]).text();
        const assessed = $(tds[2]).text();
        const taxable = $(tds[3]).text();
        out.marketValue = parseCurrency(market);
        out.assessedValue = parseCurrency(assessed);
        out.taxableValue = parseCurrency(taxable);
      }
    }

    // Tax year from the red note text or globally from HTML
    let noteText = "";
    $("div.red").each((i, el) => {
      noteText += $(el).text() + " ";
    });
    let mYear = noteText.match(
      /Values shown below are\s+(\d{4})\s+CERTIFIED VALUES/i,
    );
    if (!mYear)
      mYear = inputHtml.match(
        /Values shown below are\s+(\d{4})\s+CERTIFIED VALUES/i,
      );
    if (mYear) out.taxYear = parseInt(mYear[1], 10);

    // Sales History: Book/Page, Sale Date, Instrument, Sale Price
    $("#cphMain_gvSalesHistory tr").each((i, tr) => {
      if (i === 0) return; // header
      const tds = $(tr).find("td");
      if (tds.length < 6) return;
      const bookPageLink = $(tds[0]).find("a");
      const bookPageText = bookPageLink.text().trim(); // e.g., "3072 / 319"
      const saleDateRaw = $(tds[1]).text().trim(); // mm/dd/yyyy
      const instrument = $(tds[2]).text().trim();
      const salePriceRaw = $(tds[5]).text().trim();

      let book = null;
      let page = null;
      if (bookPageText) {
        const [bookRaw, pageRaw] = bookPageText.split("/");
        if (bookRaw && bookRaw.trim()) book = bookRaw.trim();
        if (pageRaw && pageRaw.trim()) page = pageRaw.trim();
      }

      const sale = {
        ownership_transfer_date: toISODate(saleDateRaw),
        purchase_price_amount: parseCurrency(salePriceRaw),
      };

      if (!sale.ownership_transfer_date) return;

      const saleEntry = {
        ownership_transfer_date: sale.ownership_transfer_date,
      };
      if (sale.purchase_price_amount != null)
        saleEntry.purchase_price_amount = sale.purchase_price_amount;
      out.sales.push(saleEntry);

      const deedType = mapInstrumentToDeedType(instrument);
      const deed = {};
      if (deedType) deed.deed_type = deedType;
      if (book) deed.book = book;
      if (page) deed.page = page;
      out.deeds.push(deed);

      const fileObj = {};
      const docType = mapFileDocumentTypeFromDeedType(deedType);
      if (docType) fileObj.document_type = docType;
      fileObj.name = bookPageText
        ? `Official Records ${bookPageText}`
        : "Recorded Deed";
      out.files.push(fileObj);
    });

    // Residential Building Characteristics (Sections) for stories and exterior wall types
    const secTable = $("table#cphMain_repResidential_gvBuildingSections_0");
    if (secTable && secTable.length) {
      const firstDataRow = secTable
        .find("tr")
        .not(".property_table_head")
        .first();
      const tds = firstDataRow.find("td");
      if (tds.length >= 4) {
        const extText = (tds.eq(1).text() || "").trim();
        const storiesText = (tds.eq(2).text() || "").trim();
        if (storiesText) {
          const sNum = parseFloat(storiesText);
          if (!isNaN(sNum)) out.structure.number_of_stories = Math.round(sNum);
        }
        if (extText) {
          const U = extText.toUpperCase();
          let primary = null;
          let secondary = null;
          let framing = null;

          const has = (kw) => U.indexOf(kw) !== -1;
          if (has("BLOCK") || has("CONCRETE BLOCK")) framing = "Concrete Block";

          if (has("STUCCO")) primary = "Stucco";
          if (!primary && has("VINYL") && has("SIDING"))
            primary = "Vinyl Siding";
          if (!primary && has("WOOD") && has("SIDING")) primary = "Wood Siding";
          if (!primary && has("FIBER") && has("CEMENT"))
            primary = "Fiber Cement Siding";
          if (!primary && has("BRICK")) primary = "Brick";
          if (!primary && (has("BLOCK") || has("CONCRETE BLOCK")))
            primary = "Concrete Block";

          if (has("BRICK") && primary !== "Brick") secondary = "Brick Accent";
          if (
            !secondary &&
            (has("BLOCK") || has("CONCRETE BLOCK")) &&
            primary !== "Concrete Block"
          )
            secondary = "Decorative Block";
          if (!secondary && has("STUCCO") && primary !== "Stucco")
            secondary = "Stucco Accent";

          out.structure.exterior_wall_material_primary = primary;
          out.structure.exterior_wall_material_secondary = secondary || null;
          out.structure.primary_framing_material = framing || null;
        }
      }
    }

    return out;
  }

  function buildPropertyJson() {
    const propertyInfo = extractPropertyTypeFromLandData();
    let propertyType = normalizePropertyType(propertyInfo.propertyType);
    if (!propertyType) {
      propertyType =
        bx.livingArea || bx.yearBuilt ? "SingleFamily" : "LandParcel";
    }
    propertyType = normalizePropertyType(propertyType) || "LandParcel";
    if (typeof propertyType !== "string" || propertyType.length === 0) {
      propertyType = "LandParcel";
    }

    const property = {
      parcel_identifier: general.parcelNumber || propSeed.parcel_id || null,
      property_legal_description_text: general.legalDescription || null,
      property_structure_built_year: bx.yearBuilt || null,
      property_type: propertyType,
      number_of_units:
        propertyInfo.units != null && Number.isFinite(propertyInfo.units)
          ? propertyInfo.units
          : null,
      subdivision: null,
      zoning: null,
      request_identifier:
        typeof propSeed.request_identifier === "string" &&
        propSeed.request_identifier.trim() !== ""
          ? propSeed.request_identifier.trim()
          : null,
    };

    if (
      !property.property_type ||
      typeof property.property_type !== "string" ||
      property.property_type.trim() === ""
    ) {
      property.property_type = "LandParcel";
    }

    Object.keys(property).forEach((k) => {
      if (property[k] === null || property[k] === undefined) {
        delete property[k];
      }
    });

    return property;
  }

  // Execute extractions in proper order
  const general = extractGeneral();
  const bx = extractBuildingAndValues();

  // Address parsing
  function parseAddress() {
    let raw = (general.propertyLocationRaw || addrSeed.full_address || "")
      .replace(/\r/g, "")
      .trim();
    raw = raw.replace(/\n/g, ", ").replace(/\s+/g, " ").trim();

    let street_number = null,
      street_name = null,
      street_suffix_type = null,
      city_name = null,
      state_code = null,
      postal_code = null;

    const m =
      raw.match(
        /^(\d+)\s+([^,]+?)\s+([A-Za-z]+)\s*,\s*([A-Z\s\-']+)\s*,?\s*([A-Z]{2})\s*,?\s*(\d{5})(?:-?(\d{4}))?$/i,
      ) ||
      raw.match(
        /^(\d+)\s+([^,]+?)\s+([A-Za-z]+),\s*([A-Z\s\-']+)\s*,\s*([A-Z]{2})\s*(\d{5})(?:-?(\d{4}))?$/i,
      ) ||
      raw.match(
        /^(\d+)\s+([^,]+?)\s+([A-Za-z]+),\s*([A-Z\s\-']+)\s*([A-Z]{2})\s*,\s*(\d{5})(?:-?(\d{4}))?$/i,
      );

    if (m) {
      street_number = m[1];
      street_name = (m[2] || "").trim().replace(/\s+/g, " ").toUpperCase();
      street_suffix_type = (m[3] || "").trim();
      city_name = (m[4] || "").trim().toUpperCase();
      state_code = (m[5] || "").trim().toUpperCase();
      postal_code = (m[6] || "").trim();
    } else {
      const fa = (addrSeed.full_address || "").trim();
      const parts = fa.split(",");
      if (parts.length >= 3) {
        const street = parts[0].trim();
        const city = parts[1].trim();
        const stZip = parts[2].trim();
        const st = stZip.match(/([A-Z]{2})/)?.[1] || null;
        const zip = stZip.match(/(\d{5})/)?.[1] || null;
        const streetParts = street.split(/\s+/);
        street_number = streetParts.shift();
        street_suffix_type = streetParts.pop() || null;
        street_name = streetParts.join(" ").toUpperCase();
        city_name = city.toUpperCase();
        state_code = st;
        postal_code = zip;
      }
    }

    const suffixMap = {
      STREET: "St",
      ST: "St",
      AVENUE: "Ave",
      AVE: "Ave",
      BOULEVARD: "Blvd",
      BLVD: "Blvd",
      ROAD: "Rd",
      RD: "Rd",
      LANE: "Ln",
      LN: "Ln",
      DRIVE: "Dr",
      DR: "Dr",
      COURT: "Ct",
      CT: "Ct",
      PLACE: "Pl",
      PL: "Pl",
      TERRACE: "Ter",
      TER: "Ter",
      CIRCLE: "Cir",
      CIR: "Cir",
      WAY: "Way",
      LOOP: "Loop",
      PARKWAY: "Pkwy",
      PKWY: "Pkwy",
      PLAZA: "Plz",
      PLZ: "Plz",
      TRAIL: "Trl",
      TRL: "Trl",
      BEND: "Bnd",
      BND: "Bnd",
      CRESCENT: "Cres",
      CRES: "Cres",
      MANOR: "Mnr",
      MNR: "Mnr",
      SQUARE: "Sq",
      SQ: "Sq",
      CROSSING: "Xing",
      XING: "Xing",
      PATH: "Path",
      RUN: "Run",
      WALK: "Walk",
      ROW: "Row",
      ALLEY: "Aly",
      ALY: "Aly",
      BEACH: "Bch",
      BCH: "Bch",
      BRIDGE: "Br",
      BRG: "Br",
      BROOK: "Brk",
      BRK: "Brk",
      BROOKS: "Brks",
      BRKS: "Brks",
      BUG: "Bg",
      BG: "Bg",
      BUGS: "Bgs",
      BGS: "Bgs",
      CLUB: "Clb",
      CLB: "Clb",
      CLIFF: "Clf",
      CLF: "Clf",
      CLIFFS: "Clfs",
      CLFS: "Clfs",
      COMMON: "Cmn",
      CMN: "Cmn",
      COMMONS: "Cmns",
      CMNS: "Cmns",
      CORNER: "Cor",
      COR: "Cor",
      CORNERS: "Cors",
      CORS: "Cors",
      CREEK: "Crk",
      CRK: "Crk",
      COURSE: "Crse",
      CRSE: "Crse",
      CREST: "Crst",
      CRST: "Crst",
      CAUSEWAY: "Cswy",
      CSWY: "Cswy",
      COVE: "Cv",
      CV: "Cv",
      CANYON: "Cyn",
      CYN: "Cyn",
      DALE: "Dl",
      DL: "Dl",
      DAM: "Dm",
      DM: "Dm",
      DRIVES: "Drs",
      DRS: "Drs",
      DIVIDE: "Dv",
      DV: "Dv",
      ESTATE: "Est",
      EST: "Est",
      ESTATES: "Ests",
      ESTS: "Ests",
      EXPRESSWAY: "Expy",
      EXPY: "Expy",
      EXTENSION: "Ext",
      EXT: "Ext",
      EXTENSIONS: "Exts",
      EXTS: "Exts",
      FALL: "Fall",
      FALL: "Fall",
      FALLS: "Fls",
      FLS: "Fls",
      FLAT: "Flt",
      FLT: "Flt",
      FLATS: "Flts",
      FLTS: "Flts",
      FORD: "Frd",
      FRD: "Frd",
      FORDS: "Frds",
      FRDS: "Frds",
      FORGE: "Frg",
      FRG: "Frg",
      FORGES: "Frgs",
      FRGS: "Frgs",
      FORK: "Frk",
      FRK: "Frk",
      FORKS: "Frks",
      FRKS: "Frks",
      FOREST: "Frst",
      FRST: "Frst",
      FREEWAY: "Fwy",
      FWY: "Fwy",
      FIELD: "Fld",
      FLD: "Fld",
      FIELDS: "Flds",
      FLDS: "Flds",
      GARDEN: "Gdn",
      GDN: "Gdn",
      GARDENS: "Gdns",
      GDNS: "Gdns",
      GLEN: "Gln",
      GLN: "Gln",
      GLENS: "Glns",
      GLNS: "Glns",
      GREEN: "Grn",
      GRN: "Grn",
      GREENS: "Grns",
      GRNS: "Grns",
      GROVE: "Grv",
      GRV: "Grv",
      GROVES: "Grvs",
      GRVS: "Grvs",
      GATEWAY: "Gtwy",
      GTWY: "Gtwy",
      HARBOR: "Hbr",
      HBR: "Hbr",
      HARBORS: "Hbrs",
      HBRS: "Hbrs",
      HILL: "Hl",
      HL: "Hl",
      HILLS: "Hls",
      HLS: "Hls",
      HOLLOW: "Holw",
      HOLW: "Holw",
      HEIGHTS: "Hts",
      HTS: "Hts",
      HAVEN: "Hvn",
      HVN: "Hvn",
      HIGHWAY: "Hwy",
      HWY: "Hwy",
      INLET: "Inlt",
      INLT: "Inlt",
      ISLAND: "Is",
      IS: "Is",
      ISLANDS: "Iss",
      ISS: "Iss",
      ISLE: "Isle",
      SPUR: "Spur",
      JUNCTION: "Jct",
      JCT: "Jct",
      JUNCTIONS: "Jcts",
      JCTS: "Jcts",
      KNOLL: "Knl",
      KNL: "Knl",
      KNOLLS: "Knls",
      KNLS: "Knls",
      LOCK: "Lck",
      LCK: "Lck",
      LOCKS: "Lcks",
      LCKS: "Lcks",
      LODGE: "Ldg",
      LDG: "Ldg",
      LIGHT: "Lgt",
      LGT: "Lgt",
      LIGHTS: "Lgts",
      LGTS: "Lgts",
      LAKE: "Lk",
      LK: "Lk",
      LAKES: "Lks",
      LKS: "Lks",
      LANDING: "Lndg",
      LNDG: "Lndg",
      MALL: "Mall",
      MEWS: "Mews",
      MEADOW: "Mdw",
      MDW: "Mdw",
      MEADOWS: "Mdws",
      MDWS: "Mdws",
      MILL: "Ml",
      ML: "Ml",
      MILLS: "Mls",
      MLS: "Mls",
      MANORS: "Mnrs",
      MNRS: "Mnrs",
      MOUNT: "Mt",
      MT: "Mt",
      MOUNTAIN: "Mtn",
      MTN: "Mtn",
      MOUNTAINS: "Mtns",
      MTNS: "Mtns",
      OVERPASS: "Opas",
      OPAS: "Opas",
      ORCHARD: "Orch",
      ORCH: "Orch",
      OVAL: "Oval",
      PARK: "Park",
      PASS: "Pass",
      PIKE: "Pike",
      PLAIN: "Pln",
      PLN: "Pln",
      PLAINS: "Plns",
      PLNS: "Plns",
      PINE: "Pne",
      PNE: "Pne",
      PINES: "Pnes",
      PNES: "Pnes",
      PRAIRIE: "Pr",
      PR: "Pr",
      PORT: "Prt",
      PRT: "Prt",
      PORTS: "Prts",
      PRTS: "Prts",
      PASSAGE: "Psge",
      PSGE: "Psge",
      POINT: "Pt",
      PT: "Pt",
      POINTS: "Pts",
      PTS: "Pts",
      RADIAL: "Radl",
      RADL: "Radl",
      RAMP: "Ramp",
      REST: "Rst",
      RIDGE: "Rdg",
      RDG: "Rdg",
      RIDGES: "Rdgs",
      RDGS: "Rdgs",
      ROADS: "Rds",
      RDS: "Rds",
      RANCH: "Rnch",
      RNCH: "Rnch",
      RAPID: "Rpd",
      RPD: "Rpd",
      RAPIDS: "Rpds",
      RPDS: "Rpds",
      ROUTE: "Rte",
      RTE: "Rte",
      SHOAL: "Shl",
      SHL: "Shl",
      SHOALS: "Shls",
      SHLS: "Shls",
      SHORE: "Shr",
      SHR: "Shr",
      SHORES: "Shrs",
      SHRS: "Shrs",
      SKYWAY: "Skwy",
      SKWY: "Skwy",
      SUMMIT: "Smt",
      SMT: "Smt",
      SPRING: "Spg",
      SPG: "Spg",
      SPRINGS: "Spgs",
      SPGS: "Spgs",
      SQUARES: "Sqs",
      SQS: "Sqs",
      STATION: "Sta",
      STA: "Sta",
      STRAVENUE: "Stra",
      STRA: "Stra",
      STREAM: "Strm",
      STRM: "Strm",
      STREETS: "Sts",
      STS: "Sts",
      THROUGHWAY: "Trwy",
      TRWY: "Trwy",
      TRACE: "Trce",
      TRCE: "Trce",
      TRAFFICWAY: "Trfy",
      TRFY: "Trfy",
      TRAILER: "Trlr",
      TRLR: "Trlr",
      TUNNEL: "Tunl",
      TUNL: "Tunl",
      UNION: "Un",
      UN: "Un",
      UNIONS: "Uns",
      UNS: "Uns",
      UNDERPASS: "Upas",
      UPAS: "Upas",
      VIEW: "Vw",
      VIEWS: "Vws",
      VILLAGE: "Vlg",
      VLG: "Vlg",
      VILLAGES: "Vlgs",
      VLGS: "Vlgs",
      VALLEY: "Vl",
      VLY: "Vl",
      VALLEYS: "Vlys",
      VLYS: "Vlys",
      WAYS: "Ways",
      VIA: "Via",
      WELL: "Wl",
      WL: "Wl",
      WELLS: "Wls",
      WLS: "Wls",
      CROSSROAD: "Xrd",
      XRD: "Xrd",
      CROSSROADS: "Xrds",
      XRDS: "Xrds",
    };
    if (street_suffix_type) {
      const key = street_suffix_type.toUpperCase();
      if (suffixMap[key]) street_suffix_type = suffixMap[key];
    }

    const countyName = addrSeed.county_jurisdiction || null;
    const unnormalizedAddress =
      addrSeed.full_address || general.propertyLocationRaw || null;

    const address = {};
    if (unnormalizedAddress) {
      address.unnormalized_address = unnormalizedAddress;
      if (countyName) address.county_name = countyName;
      if (state_code) address.state_code = state_code;
      if (postal_code) address.postal_code = postal_code;
      address.country_code = "US";
    } else {
      address.street_number = street_number || null;
      address.street_name = street_name || null;
      address.street_suffix_type = street_suffix_type || null;
      address.city_name = city_name || null;
      address.state_code = state_code || null;
      address.postal_code = postal_code || null;
      address.country_code = "US";
      if (countyName) address.county_name = countyName;
    }

    Object.keys(address).forEach((key) => {
      if (address[key] === null || address[key] === undefined) {
        delete address[key];
      }
    });

    return address;
  }

  const addr = parseAddress();

  // Write address.json
  writeJSON(path.join(dataDir, "address.json"), addr);

  // property.json
  const property = buildPropertyJson();
  Object.keys(property).forEach((k) => {
    if (property[k] === undefined) delete property[k];
  });
  writeJSON(path.join(dataDir, "property.json"), property);

  // lot.json
  const lot = {
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
  };
  writeJSON(path.join(dataDir, "lot.json"), lot);

  const propertyRef = { "/": "./property.json" };
  const taxFiles = [];

  // tax_*.json
  if (
    bx.taxYear ||
    bx.marketValue ||
    bx.assessedValue ||
    bx.taxableValue ||
    bx.buildingValue ||
    bx.landValue
  ) {
    const tax = {
      tax_year: bx.taxYear || null,
      property_assessed_value_amount:
        bx.assessedValue != null ? bx.assessedValue : null,
      property_market_value_amount:
        bx.marketValue != null ? bx.marketValue : null,
      property_building_amount:
        bx.buildingValue != null ? bx.buildingValue : null,
      property_land_amount: bx.landValue != null ? bx.landValue : null,
      property_taxable_value_amount:
        bx.taxableValue != null ? bx.taxableValue : null,
      monthly_tax_amount: null,
      period_end_date: null,
      period_start_date: null,
      yearly_tax_amount: null,
      first_year_on_tax_roll: null,
      first_year_building_on_tax_roll: null,
    };
    const taxName = `tax_${tax.tax_year || "1"}.json`;
    writeJSON(path.join(dataDir, taxName), tax);
    taxFiles.push(taxName);
    if (tax.tax_year && fs.existsSync(path.join(dataDir, "tax_1.json"))) {
      try {
        fs.unlinkSync(path.join(dataDir, "tax_1.json"));
        const placeholderIndex = taxFiles.indexOf("tax_1.json");
        if (placeholderIndex !== -1) taxFiles.splice(placeholderIndex, 1);
      } catch (e) {}
    }
  }

  // structure.json — include parsed stories and exterior wall mapping
  const structure = {
    architectural_style_type: null,
    attachment_type: null,
    exterior_wall_material_primary:
      bx.structure.exterior_wall_material_primary || null,
    exterior_wall_material_secondary:
      bx.structure.exterior_wall_material_secondary || null,
    exterior_wall_condition: null,
    exterior_wall_insulation_type: null,
    flooring_material_primary: null,
    flooring_material_secondary: null,
    subfloor_material: null,
    flooring_condition: null,
    interior_wall_structure_material: null,
    interior_wall_surface_material_primary: null,
    interior_wall_surface_material_secondary: null,
    interior_wall_finish_primary: null,
    interior_wall_finish_secondary: null,
    interior_wall_condition: null,
    roof_covering_material: null,
    roof_underlayment_type: null,
    roof_structure_material: null,
    roof_design_type: null,
    roof_condition: null,
    roof_age_years: null,
    gutters_material: null,
    gutters_condition: null,
    roof_material_type: null,
    foundation_type: null,
    foundation_material: null,
    foundation_waterproofing: null,
    foundation_condition: null,
    ceiling_structure_material: null,
    ceiling_surface_material: null,
    ceiling_insulation_type: null,
    ceiling_height_average: null,
    ceiling_condition: null,
    exterior_door_material: null,
    interior_door_material: null,
    window_frame_material: null,
    window_glazing_type: null,
    window_operation_type: null,
    window_screen_material: null,
    primary_framing_material: bx.structure.primary_framing_material || null,
    secondary_framing_material: null,
    structural_damage_indicators: null,
    number_of_stories: bx.structure.number_of_stories || null,
    finished_base_area: null,
    finished_basement_area: null,
    finished_upper_story_area: null,
    unfinished_base_area: null,
    unfinished_basement_area: null,
    unfinished_upper_story_area: null,
    roof_date: null,
  };
  writeJSON(path.join(dataDir, "structure.json"), structure);

  // utility.json from utilities_data
  if (utilitiesData && ownerKey && utilitiesData[ownerKey]) {
    writeJSON(path.join(dataDir, "utility.json"), utilitiesData[ownerKey]);
  }

  // layout_*.json from layout_data
  const layoutFiles = [];
  if (
    layoutData &&
    ownerKey &&
    layoutData[ownerKey] &&
    Array.isArray(layoutData[ownerKey].layouts)
  ) {
    const layouts = layoutData[ownerKey].layouts;
    layouts.forEach((lay, idx) => {
      const name = `layout_${idx + 1}.json`;
      const layoutObj = { ...lay };
      const indexValue =
        layoutObj.space_type_index != null &&
        String(layoutObj.space_type_index).trim() !== ""
          ? String(layoutObj.space_type_index).trim()
          : String(idx + 1);
      layoutObj.space_type_index = indexValue;
      writeJSON(path.join(dataDir, name), layoutObj);
      layoutFiles.push(name);
    });
  }

  // Owners: person_*.json or company_*.json
  let personFiles = [];
  if (
    ownerData &&
    ownerKey &&
    ownerData[ownerKey] &&
    ownerData[ownerKey].owners_by_date &&
    Array.isArray(ownerData[ownerKey].owners_by_date.current)
  ) {
    const owners = ownerData[ownerKey].owners_by_date.current;
    const hasCompany = owners.some((o) => o.type === "company");
    const hasPerson = owners.some((o) => o.type === "person");

    if (hasPerson && !hasCompany) {
      let personIndex = 1;
      owners.forEach((o) => {
        if (o.type !== "person") return;
        const first = properCaseName(o.first_name || null);
        const last = properCaseName(o.last_name || null);
        const middle = o.middle_name ? o.middle_name : null;
        const person = {
          birth_date: null,
          first_name: first,
          last_name: last,
          middle_name: middle,
          prefix_name: null,
          suffix_name: null,
          us_citizenship_status: null,
          veteran_status: null,
        };
        const file = `person_${personIndex}.json`;
        writeJSON(path.join(dataDir, file), person);
        personFiles.push(file);
        personIndex++;
      });
    } else if (hasCompany && !hasPerson) {
      let compIndex = 1;
      owners.forEach((o) => {
        if (o.type !== "company") return;
        const company = { name: o.name || null };
        const file = `company_${compIndex}.json`;
        writeJSON(path.join(dataDir, file), company);
        compIndex++;
      });
    }
  }

  // sales_history_*.json, deed_*.json, file_*.json + relationships
  const salesFiles = [];
  const deedFiles = [];
  const fileFiles = [];
  bx.sales.forEach((s, i) => {
    const idx = i + 1;
    const sName = `sales_history_${idx}.json`;
    const saleObj = {
      ownership_transfer_date: s.ownership_transfer_date || null,
    };
    if (s.purchase_price_amount != null)
      saleObj.purchase_price_amount = s.purchase_price_amount;
    writeJSON(path.join(dataDir, sName), saleObj);
    salesFiles.push(sName);
  });
  bx.deeds.forEach((d, i) => {
    const idx = i + 1;
    const dName = `deed_${idx}.json`;
    const deedObj = {};
    if (d.deed_type) deedObj.deed_type = d.deed_type;
    writeJSON(path.join(dataDir, dName), deedObj);
    deedFiles.push(dName);
  });
  bx.files.forEach((f, i) => {
    const idx = i + 1;
    const fName = `file_${idx}.json`;
    const obj = {};
    if (f.document_type) obj.document_type = f.document_type;
    if (f.name) obj.name = f.name;
    writeJSON(path.join(dataDir, fName), obj);
    fileFiles.push(fName);
  });

  // property relationships and additional linkage
  writeJSON(
    path.join(dataDir, "relationship_property_has_address.json"),
    {
      from: propertyRef,
      to: { "/": "./address.json" },
    },
  );
  writeJSON(
    path.join(dataDir, "relationship_property_has_lot.json"),
    {
      from: propertyRef,
      to: { "/": "./lot.json" },
    },
  );
  salesFiles.forEach((salesFile, idx) => {
    writeJSON(
      path.join(
        dataDir,
        `relationship_property_has_sales_history_${idx + 1}.json`,
      ),
      {
        from: propertyRef,
        to: { "/": `./${salesFile}` },
      },
    );
  });
  fileFiles.forEach((fileName, idx) => {
    writeJSON(
      path.join(dataDir, `relationship_property_has_file_${idx + 1}.json`),
      {
        from: propertyRef,
        to: { "/": `./${fileName}` },
      },
    );
  });
  layoutFiles.forEach((layoutFile, idx) => {
    writeJSON(
      path.join(dataDir, `relationship_property_has_layout_${idx + 1}.json`),
      {
        from: propertyRef,
        to: { "/": `./${layoutFile}` },
      },
    );
  });
  taxFiles.forEach((taxFile, idx) => {
    writeJSON(
      path.join(dataDir, `relationship_property_has_tax_${idx + 1}.json`),
      {
        from: propertyRef,
        to: { "/": `./${taxFile}` },
      },
    );
  });

  // relationship_deed_has_file_*.json (deed -> file)
  for (let i = 0; i < Math.min(deedFiles.length, fileFiles.length); i++) {
    const rel = {
      from: { "/": `./${fileFiles[i]}` },
      to: { "/": `./${deedFiles[i]}` },
    };
    const relName = `relationship_deed_has_file_${i + 1}.json`;
    writeJSON(path.join(dataDir, relName), rel);
  }

  // relationship_sales_history_has_deed_*.json (sale -> deed)
  for (let i = 0; i < Math.min(salesFiles.length, deedFiles.length); i++) {
    const rel = {
      from: { "/": `./${deedFiles[i]}` },
      to: { "/": `./${salesFiles[i]}` },
    };
    const relName = `relationship_sales_history_has_deed_${i + 1}.json`;
    writeJSON(path.join(dataDir, relName), rel);
  }

  // relationship_sales_history_has_person_*.json for current owners to most recent sale
  if (personFiles.length > 0 && salesFiles.length > 0) {
    const recentSalesFile = salesFiles[0];
    personFiles.forEach((pf, idx) => {
      const rel = {
        to: { "/": `./${pf}` },
        from: { "/": `./${recentSalesFile}` },
      };
      const relName = `relationship_sales_history_has_person_${idx + 1}.json`;
      writeJSON(path.join(dataDir, relName), rel);
    });
  }
}

main();
