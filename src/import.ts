/**
 * Importing a pharmacy's existing catalogue.
 *
 * No pharmacy will hand-type eight hundred products, so this is the difference
 * between a product someone adopts and a demo someone admires.
 *
 * Real spreadsheets are messy: prices written "GHS 5.00", barcodes with leading
 * zeros, dates as 30/06/2027 or 2027-06-30 or "Jun 2027", blank rows, a column
 * called "Item" rather than "Name". So the reader is tolerant, the mapping is
 * guessed from the headers and can be corrected, and nothing is imported until
 * the person has seen a preview of what each row will become. Every row that
 * cannot be used comes back with a reason they can act on.
 */

import type { Actor } from "./actor.ts";
import { TenantScope } from "./tenant.ts";
import { createCategory, createProduct, createSupplier, receiveBatch } from "./catalog.ts";
import { planFor, usageFor } from "./plans.ts";
import { ValidationError, todayIso } from "./util.ts";

/** The fields a row can fill. Anything else in the file is ignored. */
export const IMPORT_FIELDS = [
  "name", "brand", "form", "strength", "unit", "barcode", "category",
  "price", "cost", "reorder", "prescription", "controlled", "perishable",
  "quantity", "batch", "expiry", "supplier",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** What a person is likely to call each column. Matched case- and space-insensitively. */
const SYNONYMS: Record<ImportField, string[]> = {
  name: ["name", "product name", "product", "item name", "item", "description", "drug", "medicine", "particulars"],
  brand: ["brand", "manufacturer", "mfr", "company", "make"],
  form: ["form", "dosage form", "presentation", "type"],
  strength: ["strength", "dose", "mg", "size"],
  unit: ["unit", "pack", "pack size", "uom", "unit of measure"],
  barcode: ["barcode", "bar code", "sku", "product code", "code", "ean", "item code"],
  category: ["category", "group", "department", "drug class", "therapeutic class"],
  price: ["price", "selling price", "retail price", "unit price", "srp", "sp", "amount", "rate"],
  cost: ["cost", "cost price", "buying price", "purchase price", "cp", "wholesale"],
  reorder: ["reorder", "reorder level", "reorder point", "minimum", "min", "min stock", "min qty"],
  prescription: ["prescription", "prescription only", "rx", "rx only", "pom", "pom/rx"],
  controlled: ["controlled", "controlled class", "narcotic", "dangerous", "schedule"],
  perishable: ["perishable", "has expiry", "expires", "track expiry"],
  quantity: ["quantity", "qty", "stock", "opening stock", "on hand", "balance", "units", "stock qty"],
  batch: ["batch", "batch number", "batch no", "lot", "lot number", "lot no"],
  expiry: ["expiry", "expiry date", "exp date", "expires", "exp", "expiry dt"],
  supplier: ["supplier", "vendor", "distributor", "source"],
};

export type CsvTable = { headers: string[]; rows: string[][] };

/** A tolerant CSV reader: quoted fields, embedded commas and newlines, CRLF, and a BOM. */
export function parseCsv(text: string): CsvTable {
  const source = text.replace(/^\uFEFF/, "");
  const grid: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); grid.push(row); row = []; field = ""; continue; }
    if (char === "\r") continue;
    field += char;
  }
  if (field !== "" || row.length) { row.push(field); grid.push(row); }

  const filled = grid.filter((r) => r.some((c) => c.trim() !== ""));
  if (!filled.length) throw new ValidationError("That file has no rows in it");
  const [headers, ...rows] = filled;
  return { headers: headers.map((h) => h.trim()), rows };
}

const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess which column holds which field. Exact synonym matches win over partial
 * ones, and a field is claimed once, so "Product code" cannot also become the name.
 */
export function detectMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  const taken = new Set<number>();
  const normalisedHeaders = headers.map(normalise);

  for (const pass of ["exact", "partial"] as const) {
    for (const field of IMPORT_FIELDS) {
      if (mapping[field] !== undefined) continue;
      for (const synonym of SYNONYMS[field]) {
        const wanted = normalise(synonym);
        const index = normalisedHeaders.findIndex((h, i) => {
          if (taken.has(i) || h === "") return false;
          return pass === "exact" ? h === wanted : h.includes(wanted);
        });
        if (index !== -1) {
          mapping[field] = index;
          taken.add(index);
          break;
        }
      }
    }
  }
  return mapping;
}

/** "GHS 5.00", "5", "5.00", " 1,200.50 " → pesewas. Blank means zero. */
export function parseMoney(value: string): number | null {
  const cleaned = (value ?? "").replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "-") return 0;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

const TRUTHY = new Set(["y", "yes", "true", "1", "rx", "pom", "prescription", "controlled", "x"]);

export function parseBool(value: string): boolean {
  return TRUTHY.has(normalise(value ?? ""));
}

export function parseControlledClass(value: string): "none" | "B" | "A" | null {
  const text = normalise(value ?? "");
  if (text === "" || text === "0" || text === "no" || text === "n" || text === "none") return "none";
  if (text === "a" || text === "classa" || text === "1" || text === "schedule1" || text === "s1") return "A";
  if (text === "b" || text === "classb" || text === "2" || text === "schedule2" || text === "s2") return "B";
  if (TRUTHY.has(text)) return "B";
  return null;
}

/**
 * Dates arrive as 30/06/2027, 2027-06-30, 06/30/2027, "Jun 2027" or "06/2027".
 * Where day and month could swap, day-first wins — that is the local convention —
 * and the preview shows the result so a wrong guess is visible before it is saved.
 */
export function parseDate(value: string): string | null {
  const text = (value ?? "").trim();
  if (text === "" || normalise(text) === "na" || normalise(text) === "none") return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) { day = second; month = first; }
    const year = Number(slash[3]) < 100 ? 2000 + Number(slash[3]) : Number(slash[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // month and year only: an expiry of "06/2027" means the end of June.
  const monthYear = /^(\d{1,2})[/-](\d{4})$/.exec(text);
  if (monthYear) {
    const month = Number(monthYear[1]);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(Number(monthYear[2]), month, 0)).getUTCDate();
    return `${monthYear[2]}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

export type ImportRowResult = {
  line: number;
  name: string;
  status: "ok" | "error" | "skipped";
  message: string;
  /** What the row will become, so a wrong guess is visible before it is saved. */
  preview?: { price: number; cost: number; quantity: number; expiry: string | null };
  notes?: string[];
};

export type ImportReport = {
  dryRun: boolean;
  headers: string[];
  mapping: Partial<Record<ImportField, string>>;
  total: number;
  ok: number;
  errors: number;
  skipped: number;
  rows: ImportRowResult[];
};

export type ImportOptions = {
  csv: string;
  branchId: string;
  /** Field to header name, to correct what was guessed. */
  mapping?: Partial<Record<ImportField, string>>;
  dryRun?: boolean;
};

type PlannedRow = {
  name: string;
  brand: string | null;
  form: string | null;
  strength: string | null;
  unit: string | null;
  barcode: string | null;
  categoryName: string;
  price: number;
  cost: number;
  reorder: number;
  prescription: boolean;
  controlled: "none" | "B" | "A";
  perishable: boolean;
  quantity: number;
  batch: string;
  expiry: string | null;
  supplierName: string;
};

export async function importCatalogue(actor: Actor, options: ImportOptions): Promise<ImportReport> {
  const { headers, rows } = parseCsv(options.csv);
  const guessed = detectMapping(headers);

  const columns: Partial<Record<ImportField, number>> = {};
  for (const field of IMPORT_FIELDS) {
    const override = options.mapping?.[field];
    if (override !== undefined && override !== null && override !== "") {
      const index = headers.indexOf(override);
      if (index === -1) throw new ValidationError(`The file has no column called "${override}"`);
      columns[field] = index;
    } else if (guessed[field] !== undefined) {
      columns[field] = guessed[field];
    }
  }

  if (columns.name === undefined) {
    throw new ValidationError(
      `Could not find a product name column. The file has: ${headers.join(", ")}. Pick one in the mapping.`,
    );
  }

  const hasExpiryColumn = columns.expiry !== undefined;

  const cell = (row: string[], field: ImportField): string => {
    const index = columns[field];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const scope = actor.scope;
  const existingBarcodes = new Set(
    (await scope.all<{ barcode: string | null }>(
      "SELECT barcode FROM products WHERE tenant_id = {{tenant}} AND barcode IS NOT NULL",
    )).map((r) => (r.barcode ?? "").toLowerCase()),
  );
  const seenInFile = new Set<string>();

  const plan = await planFor(scope);
  const used = await usageFor(scope, "products");
  let allowance = plan.max_products === null ? Number.POSITIVE_INFINITY : Math.max(0, plan.max_products - used);

  const results: ImportRowResult[] = [];
  const planned: PlannedRow[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 2; // 1-based, counting the header row a person sees
    const name = cell(row, "name");
    const fail = (message: string): void => {
      results.push({ line, name: name || "(no name)", status: "error", message });
    };

    if (!name) {
      fail("No product name in this row");
      continue;
    }

    const priceText = cell(row, "price");
    if (priceText === "") {
      fail("No selling price in this row");
      continue;
    }
    const price = parseMoney(priceText);
    if (price === null) {
      fail(`Could not read the price "${priceText}"`);
      continue;
    }
    const cost = parseMoney(cell(row, "cost"));
    if (cost === null) {
      fail(`Could not read the cost price "${cell(row, "cost")}"`);
      continue;
    }

    const reorderText = cell(row, "reorder");
    const reorder = reorderText === "" ? 0 : Number(reorderText.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(reorder) || reorder < 0) {
      fail(`Could not read the reorder level "${reorderText}"`);
      continue;
    }

    const controlled = parseControlledClass(cell(row, "controlled"));
    if (controlled === null) {
      fail(`Could not read the controlled class "${cell(row, "controlled")}". Use A, B, or leave it blank.`);
      continue;
    }
    const prescription = parseBool(cell(row, "prescription")) || controlled !== "none";

    const quantityText = cell(row, "quantity");
    const quantity = quantityText === "" ? 0 : Number(quantityText.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(quantity) || quantity < 0) {
      fail(`Could not read the quantity "${quantityText}"`);
      continue;
    }

    const expiryText = cell(row, "expiry");
    const expiry = parseDate(expiryText);
    if (expiryText !== "" && expiry === null) {
      fail(`Could not read the expiry date "${expiryText}"`);
      continue;
    }

    const perishableText = cell(row, "perishable");
    let perishable = perishableText === "" ? true : parseBool(perishableText);
    const notes: string[] = [];
    if (quantity > 0 && perishable && !expiry) {
      if (hasExpiryColumn) {
        // The file has an expiry column and this row's is blank, so the pharmacy is
        // saying this item does not expire. Say so in the preview rather than
        // refusing the row — a thermometer should not block an import.
        perishable = false;
        notes.push("No expiry date, so recorded as non-perishable");
      } else {
        fail("This row has opening stock but no expiry date. Add an expiry column, or a column marking it as not perishable.");
        continue;
      }
    }

    const barcode = cell(row, "barcode");
    if (barcode) {
      const key = barcode.toLowerCase();
      if (seenInFile.has(key)) {
        fail(`The barcode ${barcode} appears more than once in this file`);
        continue;
      }
      if (existingBarcodes.has(key)) {
        results.push({ line, name, status: "skipped", message: `Barcode ${barcode} is already in your catalogue` });
        continue;
      }
      seenInFile.add(key);
    }

    if (allowance <= 0) {
      results.push({
        line,
        name,
        status: "skipped",
        message: `The ${plan.name} plan allows ${plan.max_products} products and you have reached it`,
      });
      continue;
    }
    allowance -= 1;

    if (controlled !== "none" && parseControlledClass(cell(row, "controlled")) === "B" && !/[abAB]|class/i.test(cell(row, "controlled"))) {
      notes.push("Marked as a controlled drug, so recorded as Class B");
    }

    results.push({
      line,
      name,
      status: "ok",
      message: quantity > 0 ? `Add, with ${quantity} in stock` : "Add to the catalogue",
      preview: { price, cost, quantity, expiry },
      ...(notes.length ? { notes } : {}),
    });

    planned.push({
      name,
      brand: cell(row, "brand") || null,
      form: cell(row, "form") || null,
      strength: cell(row, "strength") || null,
      unit: cell(row, "unit") || null,
      barcode: barcode || null,
      categoryName: cell(row, "category"),
      price,
      cost,
      reorder: Math.round(reorder),
      prescription,
      controlled,
      perishable,
      quantity: Math.round(quantity),
      batch: cell(row, "batch") || "OPENING",
      expiry,
      supplierName: cell(row, "supplier"),
    });
  }

  // Nothing is written until the whole file has been read, and then it all goes in
  // together: a failure part-way through an eight-hundred row import must not
  // leave a half-filled catalogue behind.
  if (!options.dryRun && planned.length) {
    await actor.scope.db.transaction(async (trx) => {
      const writer: Actor = { ...actor, scope: new TenantScope(trx, actor.scope.tenantId) };
      for (const item of planned) {
        const categoryId = item.categoryName ? await ensureCategory(writer, item.categoryName) : null;
        const productId = await createProduct(writer, {
          name: item.name,
          brand: item.brand,
          form: item.form,
          strength: item.strength,
          unit: item.unit,
          barcode: item.barcode,
          categoryId,
          defaultPricePesewas: item.price,
          costPricePesewas: item.cost,
          reorderLevel: item.reorder,
          prescriptionRequired: item.prescription,
          controlledClass: item.controlled,
          perishable: item.perishable,
        });
        if (item.quantity > 0) {
          await receiveBatch(writer, {
            branchId: options.branchId,
            productId,
            batchNumber: item.batch,
            expiryDate: item.perishable ? item.expiry : null,
            quantity: item.quantity,
            costPricePesewas: item.cost,
            sellingPricePesewas: item.price,
            supplierId: item.supplierName ? await ensureSupplier(writer, item.supplierName) : null,
          });
        }
      }
    });
  }

  return {
    dryRun: Boolean(options.dryRun),
    headers,
    mapping: Object.fromEntries(
      Object.entries(columns).map(([field, index]) => [field, headers[index as number]]),
    ) as Partial<Record<ImportField, string>>,
    total: rows.length,
    ok: planned.length,
    errors: results.filter((r) => r.status === "error").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    rows: results,
  };
}

async function ensureCategory(actor: Actor, name: string): Promise<string> {
  const existing = await actor.scope.get<{ category_id: string }>(
    "SELECT category_id FROM categories WHERE tenant_id = {{tenant}} AND LOWER(name) = LOWER(?)",
    name,
  );
  if (existing) return existing.category_id;
  return createCategory(actor, name);
}

async function ensureSupplier(actor: Actor, name: string): Promise<string> {
  const existing = await actor.scope.get<{ supplier_id: string }>(
    "SELECT supplier_id FROM suppliers WHERE tenant_id = {{tenant}} AND LOWER(name) = LOWER(?)",
    name,
  );
  if (existing) return existing.supplier_id;
  return createSupplier(actor, { name });
}
