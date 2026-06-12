# twb-inspector

CLI tool to inspect `.twb` and `.twbx` workbook files without opening a BI tool.

Surfaces every data source connection, extract, and calculated field across an entire
workbook library in one pass — useful for audits and migrations.

## Install

```bash
npm install
```

Or install globally to use as `twb-inspector` anywhere:

```bash
npm install -g .
```

## Usage

```bash
# single file
node cli.js workbook.twb
node cli.js workbook.twbx

# multiple files
node cli.js sales.twb marketing.twbx

# entire folder (recursive)
node cli.js ./workbooks/

# JSON output (pipe to jq, save to file, etc.)
node cli.js ./workbooks/ --json > inventory.json
```

## What it shows

### Per workbook

| Section | What's extracted |
|---|---|
| **Data sources** | Name, connection type (Snowflake, Extract, PostgreSQL…), server / warehouse / database, field count |
| **Worksheets** | Name + which data sources each sheet uses |
| **Dashboards** | Name + list of worksheets included |
| **Calculated fields** | Name, source, data type, full formula |
| **Parameters** | Name, type, current default value |

### Inventory Summary (multi-file mode)

When you point the tool at a folder, a summary is printed after all workbooks:

- **Snowflake connections** — unique server / warehouse / database combinations, with which workbooks use each
- **Extracts to replace** — `.hyper` files that need a live data source counterpart
- **Other connections** — Excel, PostgreSQL, etc.
- **Calculated fields** — deduplicated list across all workbooks, noting fields shared across multiple workbooks

## Typical workflow

```
1. node cli.js ./workbooks/                   audit the full library
2. node cli.js ./workbooks/ --json > inv.json save structured inventory
3. Use inv.json to:
   - map connections to their source tables
   - port calculated fields to a semantic layer
   - identify extracts that need to be replaced with live connections
   - track which sheets / dashboards are affected per data source
```

## Output example

```
────────────────────────────────────────────────────────────────
  Revenue Dashboard.twb  ·  v18.1  ·  build 20231.23.1010.0912
────────────────────────────────────────────────────────────────

  DATA SOURCES  (2)

    Sales                 47 fields
      Snowflake           prod.acme.com  /  COMPUTE_WH  /  SALES_DB
    Customers             12 fields
      Extract (.hyper)    Customers_extract.hyper

  WORKSHEETS  (8)
    Revenue by Region   ←  Sales
    Top Customers       ←  Customers
    ...

  CALCULATED FIELDS  (3)
    Gross Margin   Sales  ·  float
      ([Revenue] - [Cost]) / [Revenue]
    ...

════════════════════════════════════════════════════════════════
  INVENTORY SUMMARY  ·  4 workbooks  ·  32 sheets  ·  9 dashboards
════════════════════════════════════════════════════════════════

  Snowflake connections  (2 unique)
    ⬡  prod.acme.com  /  COMPUTE_WH  /  SALES_DB
       used in:  Revenue Dashboard.twb, Pipeline.twb

  Extracts to replace  (1)
    △  Customers_extract.hyper  ·  2 workbooks

  Calculated fields  (14 unique)
    Gross Margin      Sales
    MoM Growth        Sales  ·  3 workbooks
    ...
```

Everything runs locally — no data leaves your machine.
