#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename, join, extname } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import chalk from "chalk";

// ─── ZIP extraction (.twbx) ──────────────────────────────────────────────────

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function extractTwbFromTwbx(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("Invalid ZIP archive: central directory not found.");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const entry =
    entries.find((e) => e.name.toLowerCase().endsWith(".twb") && !e.name.includes("/")) ||
    entries.find((e) => e.name.toLowerCase().endsWith(".twb"));

  if (!entry) throw new Error("No .twb file found inside this .twbx archive.");

  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("Corrupted ZIP local header.");
  const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const compressed = buf.slice(dataStart, dataStart + entry.compSize);
  const raw = entry.method === 8 ? inflateRawSync(compressed) : compressed;
  return raw.toString("utf8");
}

// ─── XML parsing ─────────────────────────────────────────────────────────────

const stripBrackets = (s) => (s || "").replace(/^\[|\]$/g, "");
const stripQuotes = (s) => (s || "").replace(/^"|"$/g, "");

function parseWorkbook(xmlText, fileName) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");

  const wbs = doc.getElementsByTagName("workbook");
  if (!wbs.length) throw new Error("<workbook> element not found.");
  const wb = wbs[0];

  const meta = {
    fileName,
    version: wb.getAttribute("version") || "?",
    build: wb.getAttribute("source-build") || null,
  };

  const datasources = [];
  const parameters = [];
  const calcs = [];

  for (const ds of Array.from(doc.getElementsByTagName("datasource"))) {
    if (ds.parentNode?.tagName !== "datasources") continue;

    const name = ds.getAttribute("name") || "";
    const caption = ds.getAttribute("caption") || stripBrackets(name);
    const isParams = name === "Parameters";

    const connections = [];
    for (const c of Array.from(ds.getElementsByTagName("connection"))) {
      const cls = c.getAttribute("class");
      if (!cls || cls === "federated") continue;
      connections.push({
        class: cls,
        server: c.getAttribute("server") || null,
        dbname: c.getAttribute("dbname") || c.getAttribute("filename") || null,
        warehouse: c.getAttribute("warehouse") || null,
      });
    }

    let fieldCount = 0;
    for (const col of Array.from(ds.childNodes)) {
      if (col.tagName !== "column") continue;

      const colCaption = col.getAttribute("caption") || stripBrackets(col.getAttribute("name"));
      const datatype = col.getAttribute("datatype") || "";

      let formula = null;
      for (const child of Array.from(col.childNodes)) {
        if (child.tagName === "calculation") { formula = child.getAttribute("formula"); break; }
      }

      if (isParams || col.getAttribute("param-domain-type")) {
        parameters.push({ name: colCaption, datatype, value: col.getAttribute("value") || "", domain: col.getAttribute("param-domain-type") || "" });
        continue;
      }

      fieldCount++;
      if (formula) calcs.push({ name: colCaption, datasource: caption, datatype, formula });
    }

    if (!isParams) datasources.push({ name, caption, connections, fieldCount });
  }

  const worksheets = [];
  for (const ws of Array.from(doc.getElementsByTagName("worksheet"))) {
    if (ws.parentNode?.tagName !== "worksheets") continue;
    const deps = [];
    for (const d of Array.from(ws.getElementsByTagName("datasource-dependencies"))) {
      const dn = d.getAttribute("datasource");
      if (dn && dn !== "Parameters") {
        const m = datasources.find((x) => x.name === dn);
        deps.push(m ? m.caption : stripBrackets(dn));
      }
    }
    worksheets.push({ name: ws.getAttribute("name") || "(unnamed)", datasources: [...new Set(deps)] });
  }

  const dashboards = [];
  const wsNames = new Set(worksheets.map((w) => w.name));
  for (const db of Array.from(doc.getElementsByTagName("dashboard"))) {
    if (db.parentNode?.tagName !== "dashboards") continue;
    const sheets = new Set();
    for (const z of Array.from(db.getElementsByTagName("zone"))) {
      const zn = z.getAttribute("name");
      if (zn && wsNames.has(zn)) sheets.add(zn);
    }
    dashboards.push({ name: db.getAttribute("name") || "(unnamed)", sheets: [...sheets] });
  }

  return { meta, datasources, worksheets, dashboards, calcs, parameters };
}

// ─── Output formatting ───────────────────────────────────────────────────────

const CONN_LABELS = {
  snowflake: "Snowflake",
  sqlserver: "SQL Server",
  postgres: "PostgreSQL",
  redshift: "Redshift",
  bigquery: "BigQuery",
  hyper: "Extract (.hyper)",
  excel: "Excel",
  "excel-direct": "Excel",
  textscan: "CSV / Text",
  oracle: "Oracle",
  mysql: "MySQL",
  databricks: "Databricks",
};

function connColor(cls) {
  if (cls === "snowflake") return chalk.cyan;
  if (cls === "hyper") return chalk.yellow;
  if (cls === "databricks") return chalk.magenta;
  if (["postgres", "redshift", "bigquery", "sqlserver", "mysql", "oracle"].includes(cls)) return chalk.green;
  return chalk.white;
}

function hr(char = "─", width = 64) {
  return chalk.dim(char.repeat(width));
}

function printWorkbook(data) {
  const { meta, datasources, worksheets, dashboards, calcs, parameters } = data;

  console.log("\n" + hr());
  console.log(
    "  " + chalk.bold(meta.fileName) +
    chalk.dim("  ·  v" + meta.version) +
    (meta.build ? chalk.dim("  ·  build " + meta.build) : "")
  );
  console.log(hr());

  // Data sources
  section("DATA SOURCES", datasources.length);
  if (!datasources.length) {
    empty();
  } else {
    for (const d of datasources) {
      console.log("\n    " + chalk.bold(d.caption) + "  " + chalk.dim(d.fieldCount + " fields"));
      for (const c of d.connections) {
        const label = (CONN_LABELS[c.class] || c.class).padEnd(18);
        const color = connColor(c.class);
        const parts = [c.server, c.warehouse, c.dbname].filter(Boolean);
        console.log("      " + color(label) + chalk.dim(parts.join("  /  ") || "local"));
      }
    }
  }

  // Worksheets
  section("WORKSHEETS", worksheets.length);
  if (!worksheets.length) {
    empty();
  } else {
    for (const w of worksheets) {
      const deps = w.datasources.length ? chalk.dim("  ←  " + w.datasources.join(", ")) : "";
      console.log("    " + w.name + deps);
    }
  }

  // Dashboards
  section("DASHBOARDS", dashboards.length);
  if (!dashboards.length) {
    empty();
  } else {
    for (const d of dashboards) {
      console.log("    " + chalk.bold(d.name));
      if (d.sheets.length) console.log("      " + chalk.dim(d.sheets.join("  ·  ")));
    }
  }

  // Calculated fields
  section("CALCULATED FIELDS", calcs.length);
  if (!calcs.length) {
    empty();
  } else {
    for (const c of calcs) {
      const meta2 = c.datasource + (c.datatype ? "  ·  " + c.datatype : "");
      console.log("\n    " + chalk.bold(c.name) + "  " + chalk.dim(meta2));
      for (const line of c.formula.split("\n")) {
        console.log("      " + chalk.dim(line));
      }
    }
  }

  // Parameters
  section("PARAMETERS", parameters.length);
  if (!parameters.length) {
    empty();
  } else {
    for (const p of parameters) {
      const val = stripQuotes(p.value);
      console.log(
        "    " + p.name +
        (p.datatype ? chalk.dim("  [" + p.datatype + "]") : "") +
        (val ? chalk.dim("  =  " + val) : "")
      );
    }
  }

  console.log();
}

function section(title, count) {
  console.log("\n  " + chalk.bold.cyan(title) + chalk.dim("  (" + count + ")"));
}

function empty() {
  console.log("    " + chalk.dim("none"));
}

// ─── Migration summary (shown when processing multiple files) ─────────────────

function printMigrationSummary(allData) {
  const snowflakeConns = new Map();
  const extracts = new Map();
  const allCalcs = new Map();
  const otherConns = new Map();

  for (const { meta, datasources, calcs } of allData) {
    for (const ds of datasources) {
      for (const c of ds.connections) {
        const parts = [c.server, c.warehouse, c.dbname].filter(Boolean);
        const key = c.class + "::" + parts.join("/");

        if (c.class === "snowflake") {
          if (!snowflakeConns.has(key)) snowflakeConns.set(key, { parts, workbooks: new Set() });
          snowflakeConns.get(key).workbooks.add(meta.fileName);
        } else if (c.class === "hyper") {
          const label = c.dbname || c.server || "(unknown extract)";
          if (!extracts.has(label)) extracts.set(label, new Set());
          extracts.get(label).add(meta.fileName);
        } else {
          const label = (CONN_LABELS[c.class] || c.class) + (parts.length ? "  " + parts.join(" / ") : "");
          if (!otherConns.has(label)) otherConns.set(label, new Set());
          otherConns.get(label).add(meta.fileName);
        }
      }
    }
    for (const c of calcs) {
      if (!allCalcs.has(c.name)) allCalcs.set(c.name, { formula: c.formula, datasource: c.datasource, workbooks: new Set() });
      allCalcs.get(c.name).workbooks.add(meta.fileName);
    }
  }

  const n = allData.length;
  const totalSheets = allData.reduce((s, d) => s + d.worksheets.length, 0);
  const totalDash = allData.reduce((s, d) => s + d.dashboards.length, 0);

  console.log("\n" + chalk.dim("═".repeat(64)));
  console.log("  " + chalk.bold.yellow("INVENTORY SUMMARY") + chalk.dim(`  ·  ${n} workbook${n !== 1 ? "s" : ""}  ·  ${totalSheets} sheets  ·  ${totalDash} dashboards`));
  console.log(chalk.dim("═".repeat(64)));

  // Snowflake connections
  console.log("\n  " + chalk.bold("Snowflake connections") + chalk.dim("  (" + snowflakeConns.size + " unique)"));
  if (!snowflakeConns.size) {
    console.log("    " + chalk.dim("none found"));
  } else {
    for (const [, info] of snowflakeConns) {
      const wbs = [...info.workbooks];
      console.log("    " + chalk.cyan("⬡") + "  " + chalk.cyan(info.parts.join("  /  ")));
      console.log("       " + chalk.dim("used in:  " + wbs.join(", ")));
    }
  }

  // Tableau Extracts
  console.log("\n  " + chalk.bold("Extracts to replace") + chalk.dim("  (" + extracts.size + ")"));
  if (!extracts.size) {
    console.log("    " + chalk.dim("none — no .hyper extracts found"));
  } else {
    for (const [label, wbs] of extracts) {
      const count = wbs.size;
      console.log("    " + chalk.yellow("△") + "  " + label + chalk.dim("  ·  " + count + " workbook" + (count !== 1 ? "s" : "")));
    }
  }

  // Other connections
  if (otherConns.size) {
    console.log("\n  " + chalk.bold("Other connections") + chalk.dim("  (" + otherConns.size + ")"));
    for (const [label, wbs] of otherConns) {
      console.log("    " + chalk.green("○") + "  " + label + chalk.dim("  ·  " + wbs.size + " workbook" + (wbs.size !== 1 ? "s" : "")));
    }
  }

  // Calculated fields
  console.log("\n  " + chalk.bold("Calculated fields") + chalk.dim("  (" + allCalcs.size + " unique)"));
  if (!allCalcs.size) {
    console.log("    " + chalk.dim("none"));
  } else {
    for (const [name, info] of allCalcs) {
      const wbs = info.workbooks.size;
      console.log(
        "    " + chalk.bold(name) +
        chalk.dim("  " + info.datasource) +
        (wbs > 1 ? chalk.dim("  ·  " + wbs + " workbooks") : "")
      );
    }
  }

  console.log();
}

// ─── File discovery ───────────────────────────────────────────────────────────

function collectFiles(pathArg) {
  let stat;
  try { stat = statSync(pathArg); } catch { return []; }
  if (stat.isFile()) {
    const ext = extname(pathArg).toLowerCase();
    return ext === ".twb" || ext === ".twbx" ? [pathArg] : [];
  }
  if (stat.isDirectory()) {
    return readdirSync(pathArg)
      .flatMap((name) => collectFiles(join(pathArg, name)));
  }
  return [];
}

function loadFile(filePath) {
  const buf = readFileSync(filePath);
  const xml = filePath.toLowerCase().endsWith(".twbx")
    ? extractTwbFromTwbx(buf)
    : buf.toString("utf8");
  return parseWorkbook(xml, basename(filePath));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const paths = args.filter((a) => !a.startsWith("-"));

if (!paths.length) {
  console.error(chalk.red("Usage:") + "  node cli.js <file.twb|file.twbx|directory> [--json]");
  process.exit(1);
}

const files = paths.flatMap(collectFiles);

if (!files.length) {
  console.error(chalk.red("No .twb or .twbx files found."));
  process.exit(1);
}

const results = [];
for (const f of files) {
  try {
    results.push(loadFile(f));
  } catch (e) {
    console.error(chalk.red("Error") + "  " + basename(f) + "  " + e.message);
  }
}

if (jsonFlag) {
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
} else {
  for (const data of results) printWorkbook(data);
  if (results.length > 1) printMigrationSummary(results);
}
