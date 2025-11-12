// Structure mapping script
// Reads input.html, parses with cheerio, builds per-building structure records,
// writes owners/structure_data.json

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

function readHtml() {
  const p = path.resolve("input.html");
  if (!fs.existsSync(p)) {
    throw new Error("input.html not found");
  }
  return fs.readFileSync(p, "utf8");
}

function text(val) {
  if (val == null) return null;
  const t = String(val).trim();
  return t.length ? t : null;
}

function parseIntSafe(str) {
  if (!str) return null;
  const num = parseInt(String(str).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(num) ? num : null;
}

function parseFloatSafe(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function getPropId($) {
  let propId = null;
  $("#ctlBodyPane_ctl03_ctl01_dynamicSummaryData_divSummary table tr").each(
    (_, el) => {
      const label = text($(el).find("th strong").first().text());
      if (label && label.toLowerCase().includes("prop id")) {
        const val = text($(el).find("td span").first().text());
        if (val) propId = val;
      }
    },
  );
  return propId || "unknown";
}

function findModuleByTitle($, title) {
  const wanted = title ? String(title).toLowerCase() : null;
  if (!wanted) return null;
  let found = null;
  $("section[id^='ctlBodyPane_']").each((_, section) => {
    if (found) return;
    const $section = $(section);
    const headerTitle = text(
      $section.find("> header .title, > header div.title").first().text(),
    );
    if (headerTitle && headerTitle.toLowerCase() === wanted) {
      found = $section;
    }
  });
  return found;
}

function extractTableMap($container) {
  const map = {};
  if (!$container || !$container.length) return map;
  $container.find("tr").each((_, tr) => {
    const $row = cheerio.load(tr);
    const label = text($row("th strong").first().text());
    if (!label) return;
    let value = text($row("td span").first().text());
    if (value == null) {
      value = text($row("td").first().text());
    }
    map[label.toLowerCase()] = value;
  });
  return map;
}

function splitTokens(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;\/,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mapExteriorMaterial(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (upper.includes("BRICK")) return "Brick";
  if (upper.includes("NATURAL STONE") || upper.includes("STONE")) {
    return "Natural Stone";
  }
  if (upper.includes("STUCCO")) return "Stucco";
  if (upper.includes("VINYL")) return "Vinyl Siding";
  if (
    upper.includes("CONCRETE BLOCK") ||
    upper.includes("CBS") ||
    upper.startsWith("CB")
  ) {
    return "Concrete Block";
  }
  if (upper.includes("HARDI") || upper.includes("FIBER")) {
    return "Fiber Cement Siding";
  }
  if (upper.includes("EIFS")) return "EIFS";
  if (upper.includes("LOG")) return "Log";
  if (upper.includes("ALUMIN") || upper.includes("METAL")) {
    return "Metal Siding";
  }
  if (upper.includes("PRECAST")) return "Precast Concrete";
  if (upper.includes("WOOD") || upper.includes("SIDING")) {
    return "Wood Siding";
  }
  return null;
}

function mapInteriorMaterial(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (upper.includes("DRYWALL")) return "Drywall";
  if (upper.includes("PLASTER")) return "Plaster";
  if (upper.includes("WOOD") || upper.includes("PANEL")) {
    return "Wood Paneling";
  }
  if (upper.includes("BRICK")) return "Exposed Brick";
  if (upper.includes("BLOCK") || upper.includes("MASON")) {
    return "Exposed Block";
  }
  if (upper.includes("STONE")) return "Stone Veneer";
  if (upper.includes("TILE")) return "Tile";
  if (upper.includes("METAL")) return "Metal Panels";
  if (upper.includes("GLASS")) return "Glass Panels";
  if (upper.includes("CONC")) return "Concrete";
  if (upper.includes("N/A") || upper.includes("NONE")) return null;
  return null;
}

function mapRoofCover(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (upper.includes("ASPHALT") || upper.includes("SHINGLE")) {
    return "Architectural Asphalt Shingle";
  }
  if (upper.includes("TAR") && upper.includes("GRAVEL")) {
    return "Built-Up Roof";
  }
  if (upper.includes("BUILT") && upper.includes("UP")) {
    return "Built-Up Roof";
  }
  if (upper.includes("MINIMUM") || upper.includes("N/A")) return null;
  return null;
}

function mapRoofDesign(val) {
  if (!val) return null;
  const upper = val.toUpperCase();
  if (upper.includes("FLAT")) return "Flat";
  if (upper.includes("GABLE") && upper.includes("HIP")) return "Combination";
  if (upper.includes("GABLE")) return "Gable";
  if (upper.includes("HIP")) return "Hip";
  if (upper.includes("REINF")) return "Flat";
  if (upper.includes("N/A")) return null;
  return null;
}

function mapFrameMaterial(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (upper.includes("WOOD")) return "Wood Frame";
  if (upper.includes("STEEL")) return "Steel Frame";
  if (
    upper.includes("CONCRETE BLOCK") ||
    upper.includes("CBS") ||
    upper.includes("BLOCK")
  ) {
    return "Concrete Block";
  }
  if (upper.includes("REINFORCED") || upper.includes("POURED")) {
    return "Poured Concrete";
  }
  if (upper.includes("MASONRY")) return "Masonry";
  if (upper.includes("PRECAST")) return "Concrete Block";
  return null;
}

function mapFloorMaterial(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (upper.includes("CARPET")) return "Carpet";
  if (upper.includes("ENGINEERED") && upper.includes("HARDWOOD")) {
    return "Engineered Hardwood";
  }
  if (upper.includes("SOLID") && upper.includes("HARDWOOD")) {
    return "Solid Hardwood";
  }
  if (upper.includes("HARDWOOD")) return "Solid Hardwood";
  if (upper.includes("LAMINATE")) return "Laminate";
  if (upper.includes("VINYL") && upper.includes("PLANK")) {
    return "Luxury Vinyl Plank";
  }
  if (upper.includes("VINYL")) return "Sheet Vinyl";
  if (upper.includes("CERAMIC")) return "Ceramic Tile";
  if (upper.includes("PORCELAIN")) return "Porcelain Tile";
  if (upper.includes("STONE")) return "Natural Stone Tile";
  if (upper.includes("TERRAZZO")) return "Terrazzo";
  if (upper.includes("CONCRETE") && upper.includes("POLISH")) {
    return "Polished Concrete";
  }
  if (upper.includes("CONCRETE")) return "Polished Concrete";
  return null;
}

function dedupe(values) {
  const out = [];
  values.forEach((val) => {
    if (val && !out.includes(val)) out.push(val);
  });
  return out;
}

function parseBuildingSummaries($) {
  const module = findModuleByTitle($, "Building Information");
  if (!module) return [];
  const leftSelector =
    "div[id$='dynamicBuildingDataLeftColumn_divSummary']";
  const results = [];

  module.find(leftSelector).each((idx, leftEl) => {
    const $left = $(leftEl);
    const leftId = $left.attr("id") || "";
    const prefix = leftId.replace(
      "_dynamicBuildingDataLeftColumn_divSummary",
      "",
    );
    const rightId = `${prefix}_dynamicBuildingDataRightColumn_divSummary`;
    const $right = module.find(`[id='${rightId}']`);

    const leftMap = extractTableMap($left);
    const rightMap = extractTableMap($right);

    const identifierMatch = prefix.match(/lstBuildings_(ctl\d+)/i);
    results.push({
      building_index: idx + 1,
      building_identifier: identifierMatch ? identifierMatch[1] : null,
      left: leftMap,
      right: rightMap,
    });
  });

  return results;
}

function buildStructureForBuilding(building, requestIdentifier) {
  const { left, right } = building;

  const exteriorVals = dedupe(
    splitTokens(left["exterior walls"]).map(mapExteriorMaterial),
  );
  const interiorVals = dedupe(
    splitTokens(left["interior walls"]).map(mapInteriorMaterial),
  );
  const floorVals = dedupe(
    splitTokens(left["floor cover"]).map(mapFloorMaterial),
  );
  const frameVals = dedupe(
    splitTokens(left["frame"]).map(mapFrameMaterial),
  );
  const roofCover = mapRoofCover(left["roofing"]);
  let roofMaterialType = null;
  if (roofCover === "Architectural Asphalt Shingle") {
    roofMaterialType = "Shingle";
  } else if (roofCover === "Built-Up Roof") {
    roofMaterialType = "Composition";
  }
  const roofDesign = mapRoofDesign(left["roof type"]);

  const heatedArea = parseIntSafe(left["heated area"]);
  const stories = parseFloatSafe(right["stories"]);

  return {
    exterior_wall_material_primary: exteriorVals[0] || null,
    exterior_wall_material_secondary: exteriorVals[1] || null,
    interior_wall_surface_material_primary: interiorVals[0] || null,
    interior_wall_surface_material_secondary: interiorVals[1] || null,
    flooring_material_primary: floorVals[0] || null,
    flooring_material_secondary: floorVals[1] || null,
    roof_covering_material: roofCover,
    roof_material_type: roofMaterialType,
    roof_design_type: roofDesign,
    primary_framing_material: frameVals[0] || null,
    secondary_framing_material: frameVals[1] || null,
    number_of_stories: stories != null ? stories : null,
    finished_base_area: heatedArea,
    request_identifier: requestIdentifier || null,
  };
}

function buildStructureData($, requestIdentifier) {
  const buildings = parseBuildingSummaries($);
  return buildings.map((building) => ({
    building_index: building.building_index,
    building_identifier: building.building_identifier,
    structure: buildStructureForBuilding(building, requestIdentifier),
  }));
}

function main() {
  const html = readHtml();
  const $ = cheerio.load(html);
  const propId = getPropId($);
  const requestIdentifier = propId || null;
  const structures = buildStructureData($, requestIdentifier);

  const outDir = path.resolve("owners");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "structure_data.json");

  const data = {};
  data[`property_${propId}`] = { buildings: structures };
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
