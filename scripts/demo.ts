import { openMigratedDatabase } from "../src/storage/index.ts";
import { seedDemoPharmacy } from "../src/demo.ts";
import { startServer } from "../src/server.ts";

const db = await openMigratedDatabase(":memory:");
const demo = await seedDemoPharmacy(db);
const port = Number(process.env.PORT ?? 4173);
const server = await startServer(db, port);

console.log(`\nrxpos counter UI running at http://localhost:${port}`);
console.log(`  owner        ${demo.credentials.owner} / ${demo.credentials.password}`);
console.log(`  salesperson  ${demo.credentials.salesperson} / ${demo.credentials.password}\n`);
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
