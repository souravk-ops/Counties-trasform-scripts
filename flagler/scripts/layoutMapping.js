// Layout mapping script
// Reads input.html, parses buildings bedroom/bath counts and generates layout entries per room type

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

function readHtml(filepath) {
  const html = fs.readFileSync(filepath, "utf8");
  return cheerio.load(html);
}

// Updated selectors based on the provided HTML
const PARCEL_SELECTOR = "#ctlBodyPane_ctl02_ctl01_dynamicSummary_rptrDynamicColumns_ctl00_pnlSingleValue span";
const BUILDING_SECTION_TITLE = "Residential Buildings"; // Corrected title from HTML

function textTrim(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function getParcelId($) {
  let parcelIdText = $(PARCEL_SELECTOR).text().trim();
  if (parcelIdText) {
    return parcelIdText;
  }
  return null;
}

function normalizePointerPath(ref) {
  if (typeof ref !== "string") return null;
  let trimmed = ref.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/\\/g, "/");
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  trimmed = trimmed.replace(/^\/+/, "");
  if (!trimmed) return null;
  return `./${trimmed}`;
}

function normalizePointerOutput(pointerString) {
  if (!pointerString || typeof pointerString !== "string") return null;
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
    const p = pointer["/"].trim();
    if (p) sanitized["/"] = p;
  }
  return Object.keys(sanitized).length ? sanitized : null;
}

function makeRelationshipPointer(ref) {
  if (ref == null) return null;
  const normalizePointerString = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = normalizePointerOutput(trimmed);
    return sanitizePointerObject(normalized);
  };
  if (typeof ref === "string") {
    return normalizePointerString(ref);
  }
  if (typeof ref !== "object") return null;
  if (typeof ref.cid === "string" && ref.cid.trim()) {
    const cidPointer = normalizePointerOutput(ref.cid);
    return sanitizePointerObject(cidPointer);
  }
  if (typeof ref.uri === "string" && ref.uri.trim()) {
    const uriPointer = normalizePointerOutput(ref.uri);
    return sanitizePointerObject(uriPointer);
  }
  const pathCandidate =
    (typeof ref["/"] === "string" && ref["/"]) ||
    (typeof ref.path === "string" && ref.path) ||
    (typeof ref["@ref"] === "string" && ref["@ref"]) ||
    (typeof ref.filename === "string" && ref.filename) ||
    (typeof ref.file === "string" && ref.file);
  if (pathCandidate) {
    return normalizePointerString(pathCandidate);
  }
  return null;
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
          const label = textTrim($(tr).find("th strong").first().text());
          const value = textTrim($(tr).find("td div span").first().text()); // Adjusted selector for value
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
          const label = textTrim($(tr).find("th strong").first().text());
          const value = textTrim($(tr).find("td div span").first().text()); // Adjusted selector for value
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

function defaultLayout(space_type, idx) {
  return {
    space_type,
    space_type_index: String(idx),
    flooring_material_type: null,
    size_square_feet: null,
    floor_level: null,
    has_windows: null,
    window_design_type: null,
    window_material_type: null,
    window_treatment_type: null,
    is_finished: true,
    furnished: null,
    paint_condition: null,
    flooring_wear: null,
    clutter_level: null,
    visible_damage: null,
    countertop_material: null,
    cabinet_style: null,
    fixture_finish_quality: null,
    design_style: null,
    natural_light_quality: null,
    decor_elements: null,
    pool_type: null,
    pool_equipment: null,
    spa_type: null,
    safety_features: null,
    view_type: null,
    lighting_features: null,
    condition_issues: null,
    is_exterior: false,
    pool_condition: null,
    pool_surface_type: null,
    pool_water_quality: null,
    bathroom_renovation_date: null,
    kitchen_renovation_date: null,
    flooring_installation_date: null,
  };
}

function buildLayoutsFromBuildings(buildings) {
  // Sum across all buildings
  let totalBeds = 0;
  let totalBaths = 0;
  buildings.forEach((b) => {
    // The provided HTML does not contain "Bedrooms" or "Bathrooms" directly in the building summary.
    // We need to infer or skip these if they are not present.
    // For this example, I'll assume "Baths" from the right column corresponds to bathrooms.
    // If bedrooms are not explicitly listed, we might need to make an assumption or leave it as 0.
    // For now, let's use "Bedrooms" and "Bathrooms" as they appear in the HTML.
    totalBeds += toInt(b["Bedrooms"]);
    totalBaths += toInt(b["Bathrooms"]); // Changed from "Baths" to "Bathrooms"
  });

  const layouts = [];
  let idx = 1;
  for (let i = 0; i < totalBeds; i++) {
    layouts.push(defaultLayout("Bedroom", idx++));
  }
  for (let i = 0; i < totalBaths; i++) {
    layouts.push(defaultLayout("Full Bathroom", idx++));
  }
  return layouts;
}

function main() {
  const inputPath = path.resolve("input.html");
  const $ = readHtml(inputPath);
  const parcelId = getParcelId($);
  if (!parcelId) throw new Error("Parcel ID not found");

  const buildings = collectBuildings($);
  const layouts = buildLayoutsFromBuildings(buildings);
  const normalizedLayouts = layouts.map((layout, idx) => {
    const indexFromSource =
      layout && layout.space_type_index != null
        ? String(layout.space_type_index).trim()
        : "";
    const ensuredIndex = indexFromSource || String(idx + 1);
    return {
      ...layout,
      space_type_index: ensuredIndex,
    };
  });

  const outDir = path.resolve("owners");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "layout_data.json");
  const outObj = {};
  outObj[`property_${parcelId}`] = { layouts: normalizedLayouts };
  fs.writeFileSync(outPath, JSON.stringify(outObj, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);

  const dataDir = path.resolve("data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.readdirSync(dataDir).forEach((fileName) => {
      if (/^layout_\d+\.json$/i.test(fileName)) {
        fs.unlinkSync(path.join(dataDir, fileName));
      }
      if (/^relationship_property_has_layout_\d+\.json$/i.test(fileName)) {
        fs.unlinkSync(path.join(dataDir, fileName));
      }
      if (/^relationship_layout_has_fact_sheet(?:_\d+)?\.json$/i.test(fileName)) {
        fs.unlinkSync(path.join(dataDir, fileName));
      }
      if (/^fact_sheet(?:_\d+)?\.json$/i.test(fileName)) {
        fs.unlinkSync(path.join(dataDir, fileName));
      }
    });
  } catch (err) {}

  const propertyPath = path.join(dataDir, "property.json");
  const propertyRelationshipFrom = fs.existsSync(propertyPath)
    ? "./property.json"
    : null;

  normalizedLayouts.forEach((layout, index) => {
    const layoutIdx = index + 1;
    const layoutFile = `layout_${layoutIdx}.json`;
    fs.writeFileSync(
      path.join(dataDir, layoutFile),
      JSON.stringify(layout, null, 2),
      "utf8",
    );

    if (propertyRelationshipFrom) {
      const fromPointer = makeRelationshipPointer(propertyRelationshipFrom);
      const toPointer = makeRelationshipPointer(`./${layoutFile}`);
      if (!fromPointer || !toPointer) return;
      const rel = {
        type: "property_has_layout",
        from: fromPointer,
        to: toPointer,
      };
      fs.writeFileSync(
        path.join(
          dataDir,
          `relationship_property_has_layout_${layoutIdx}.json`,
        ),
        JSON.stringify(rel, null, 2),
        "utf8",
      );
    }
  });
}

if (require.main === module) {
  main();
}
