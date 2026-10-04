/**
 * Importing an existing catalogue. The parsing has to survive real pharmacy
 * spreadsheets, and nothing may be written until the whole file has been read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newPharmacy } from "../src/testing.ts";
import {
  detectMapping,
  importCatalogue,
  parseControlledClass,
  parseCsv,
  parseDate,
  parseMoney,
} from "../src/import.ts";
import { searchProducts } from "../src/catalog.ts";

test("the CSV reader handles quotes, embedded commas, CRLF and a BOM", () => {
  const csv = '\uFEFFName,Price,Note\r\n"Paracetamol, 500mg",5.00,"He said ""ok"""\r\nORS,2.50,\r\n';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ["Name", "Price", "Note"]);
  assert.equal(rows.length, 2, "blank trailing lines are dropped");
  assert.equal(rows[0][0], "Paracetamol, 500mg");
  assert.equal(rows[0][2], 'He said "ok"');
});

test("a file with no usable rows is refused", () => {
  assert.throws(() => parseCsv("\n\n  \n"), /no rows/i);
});

test("columns are guessed from whatever the pharmacy called them", () => {
  const mapping = detectMapping(["Item", "Qty", "Selling Price", "Batch No", "Expiry Date", "POM"]);
  assert.equal(mapping.name, 0);
  assert.equal(mapping.quantity, 1);
  assert.equal(mapping.price, 2);
  assert.equal(mapping.batch, 3);
  assert.equal(mapping.expiry, 4);
  assert.equal(mapping.prescription, 5);
});

test("a field is claimed by one column only", () => {
  const mapping = detectMapping(["Product Code", "Product Name"]);
  assert.equal(mapping.name, 1, "the name column is not stolen by the code column");
});

test("money is read however it was written", () => {
  assert.equal(parseMoney("GHS 5.00"), 500);
  assert.equal(parseMoney("5"), 500);
  assert.equal(parseMoney(" 1,200.50 "), 120050);
  assert.equal(parseMoney(""), 0);
  assert.equal(parseMoney("free"), 0);
});

test("dates are read day-first, and swapped when the numbers force it", () => {
  assert.equal(parseDate("30/06/2027"), "2027-06-30");
  assert.equal(parseDate("06/30/2027"), "2027-06-30", "30 cannot be a month");
  assert.equal(parseDate("2027-06-30"), "2027-06-30");
  assert.equal(parseDate("6/2027"), "2027-06-30", "a month means the end of it");
  assert.equal(parseDate(""), null);
  assert.equal(parseDate("whenever"), null);
});

test("a controlled drug is recognised however it is labelled", () => {
  assert.equal(parseControlledClass(""), "none");
  assert.equal(parseControlledClass("No"), "none");
  assert.equal(parseControlledClass("Class A"), "A");
  assert.equal(parseControlledClass("Schedule 2"), "B");
  assert.equal(parseControlledClass("Yes"), "B");
  assert.equal(parseControlledClass("sometimes"), null);
});

const MESSY = `Item,Qty,SP,CP,Reorder,Barcode,Batch,Expiry,POM
"Paracetamol, 500mg",240,GHS 5.00,2.50,40,PCM500,OPEN-1,30/06/2027,No
Amoxicillin 250mg,120,15.00,8.00,30,AMX250,OPEN-2,2027-12-31,Yes
Oral Rehydration Salts,18,2.50,1.20,60,ORS001,OPEN-3,06/2027,No
Cetirizine,42,7.00,3.50,24,CET010,OPEN-4,2027-03-15,No
Digital Thermometer,6,45.00,25.00,8,DTH001,OPEN-5,,No
`;

test("the preview says what each row will become, and writes nothing", async () => {
  const f = await newPharmacy("pro", "importpreview");
  const report = await importCatalogue(f.owner, { csv: MESSY, branchId: f.branchId, dryRun: true });

  assert.equal(report.dryRun, true);
  assert.equal(report.total, 5);
  assert.equal(report.ok, 5);
  assert.equal(report.errors, 0);

  const paracetamol = report.rows[0];
  assert.equal(paracetamol.name, "Paracetamol, 500mg");
  assert.deepEqual(paracetamol.preview, { price: 500, cost: 250, quantity: 240, expiry: "2027-06-30" });
  assert.equal(report.rows[2].preview?.expiry, "2027-06-30", "a month-only expiry lands on the last day");

  const nothing = await searchProducts(f.owner, f.branchId, "", 500);
  assert.equal(nothing.length, 0, "a preview must not write anything");
});

test("importing writes the products and their opening stock", async () => {
  const f = await newPharmacy("pro", "importrun");
  const report = await importCatalogue(f.owner, { csv: MESSY, branchId: f.branchId });

  assert.equal(report.ok, 5);
  assert.equal(report.dryRun, false);

  const products = await searchProducts(f.owner, f.branchId, "", 500);
  assert.equal(products.length, 5);

  const paracetamol = products.find((p) => p.name.startsWith("Paracetamol"));
  assert.ok(paracetamol, "the quoted name with a comma survived");
  assert.equal(paracetamol.price_pesewas, 500);
  assert.equal(paracetamol.on_hand, 240, "opening stock was received");
  assert.equal(paracetamol.sellable, 240);
  assert.equal(paracetamol.nearest_expiry, "2027-06-30");

  const amoxicillin = products.find((p) => p.name.startsWith("Amoxicillin"));
  assert.equal(amoxicillin?.prescription_required, 1, "POM was read as prescription-only");

  const thermometer = products.find((p) => p.name.startsWith("Digital"));
  assert.equal(thermometer?.on_hand, 6, "a blank expiry in an expiry column means it does not expire");
  const thermometerRow = report.rows.find((r) => r.name.startsWith("Digital"));
  assert.ok(thermometerRow?.notes?.some((n) => /non-perishable/i.test(n)), "and the preview says so");
});

test("one bad row does not stop the others, and says why", async () => {
  const f = await newPharmacy("pro", "importbad");
  const csv = `Name,Price,Qty,Expiry
Good One,5.00,10,2027-01-31
,6.00,10,2027-01-31
No Price,,10,2027-01-31
Bad Date,6.00,10,not-a-date
Good Two,7.00,5,2027-02-28
`;
  const report = await importCatalogue(f.owner, { csv, branchId: f.branchId });

  assert.equal(report.ok, 2);
  assert.equal(report.errors, 3);
  const messages = report.rows.filter((r) => r.status === "error").map((r) => r.message);
  assert.ok(messages.some((m) => /price/i.test(m)));
  assert.ok(messages.some((m) => /expiry/i.test(m)));
  assert.ok(messages.some((m) => /name/i.test(m)));

  const products = await searchProducts(f.owner, f.branchId, "", 500);
  assert.deepEqual(products.map((p) => p.name).sort(), ["Good One", "Good Two"]);
});

test("a barcode repeated in the file is refused, and one already in the catalogue is skipped", async () => {
  const f = await newPharmacy("pro", "importdupe");
  const first = `Name,Price,Barcode,Expiry
Already Here,5.00,DUP1,2027-01-31
`;
  await importCatalogue(f.owner, { csv: first, branchId: f.branchId });

  const csv = `Name,Price,Barcode,Expiry
Twice A,5.00,TWICE,2027-01-31
Twice B,6.00,TWICE,2027-01-31
Already Here Again,7.00,DUP1,2027-01-31
Fine,8.00,FINE1,2027-01-31
`;
  const report = await importCatalogue(f.owner, { csv, branchId: f.branchId });

  assert.equal(report.ok, 2, "the two rows with usable barcodes import");
  assert.equal(report.errors, 1);
  assert.equal(report.skipped, 1);
  assert.match(report.rows.find((r) => r.status === "error")!.message, /more than once/i);
  assert.match(report.rows.find((r) => r.status === "skipped")!.message, /already in your catalogue/i);
});

test("opening stock with no expiry is refused when the product is perishable", async () => {
  const f = await newPharmacy("pro", "importexpiry");
  const csv = `Name,Price,Qty
Perishable With Stock,5.00,10
`;
  const report = await importCatalogue(f.owner, { csv, branchId: f.branchId });
  assert.equal(report.ok, 0);
  assert.equal(report.errors, 1);
  assert.match(report.rows[0].message, /no expiry date/i);
});

test("the plan limit stops the import rather than failing it", async () => {
  const f = await newPharmacy("free", "importlimit");
  const lines = ["Name,Price"];
  for (let i = 0; i < 25; i += 1) lines.push(`Product ${i},5.00`);
  const report = await importCatalogue(f.owner, { csv: lines.join("\n"), branchId: f.branchId });

  assert.equal(report.ok, 20, "the free plan allows twenty products");
  assert.equal(report.skipped, 5);
  assert.match(report.rows.find((r) => r.status === "skipped")!.message, /Free plan allows 20/i);

  const products = await searchProducts(f.owner, f.branchId, "", 500);
  assert.equal(products.length, 20);
});

test("a category named in the file is created once, not once per row", async () => {
  const f = await newPharmacy("pro", "importcat");
  const csv = `Name,Price,Category
Alpha,5.00,Analgesics
Beta,6.00,Analgesics
Gamma,7.00,Antimalarials
`;
  const report = await importCatalogue(f.owner, { csv, branchId: f.branchId });
  assert.equal(report.ok, 3);

  const categories = await f.owner.scope.all<{ name: string }>(
    "SELECT name FROM categories WHERE tenant_id = {{tenant}} ORDER BY name",
  );
  assert.deepEqual(categories.map((c) => c.name), ["Analgesics", "Antimalarials"]);
});
