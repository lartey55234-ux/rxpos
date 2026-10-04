import { openMigratedDatabase } from "../src/storage/index.ts";
import { seedDemoPharmacy } from "../src/demo.ts";
import { startServer } from "../src/server.ts";
import { FakeGateway, type Channel } from "../src/payments.ts";

/**
 * The local demo. `npm run demo` serves the counter with the sample pharmacy.
 *
 * PAYMENTS_FAKE=1 swaps in a gateway that approves every charge, so the card and
 * mobile money screens can be exercised without a Paystack account and without
 * anybody's money. It never reaches a payment provider: the authorization URL
 * points at an address that does not resolve.
 */
class DemoGateway extends FakeGateway {
  private readonly amounts = new Map<string, number>();
  private readonly checks = new Map<string, number>();

  async initialize(input: { email: string; amountPesewas: number; reference: string; channels: Channel[] }) {
    this.amounts.set(input.reference, input.amountPesewas);
    return super.initialize(input);
  }

  /**
   * Says "pending" the first time it is asked and approves the second, because a
   * customer takes a moment to pay. Approving instantly would close the payment
   * screen before anyone could see it, which is not what the counter looks like.
   */
  async verify(reference: string) {
    const amount = this.amounts.get(reference) ?? 0;
    const seen = (this.checks.get(reference) ?? 0) + 1;
    this.checks.set(reference, seen);
    if (amount > 0 && seen > 1) {
      return {
        reference,
        status: "success" as const,
        amountPesewas: amount,
        channel: "mobile_money",
        currency: "GHS",
      };
    }
    return super.verify(reference);
  }
}

const db = await openMigratedDatabase(":memory:");
const demo = await seedDemoPharmacy(db);
const port = Number(process.env.PORT ?? 4173);
const payments = process.env.PAYMENTS_FAKE === "1";
const server = await startServer(db, port, undefined, "0.0.0.0", {
  ...(payments ? { gateway: new DemoGateway() } : {}),
});

console.log(`\nrxpos counter UI running at http://localhost:${port}`);
console.log(`  owner        ${demo.credentials.owner} / ${demo.credentials.password}`);
console.log(`  salesperson  ${demo.credentials.salesperson} / ${demo.credentials.password}`);
if (payments) console.log("  payments     fake gateway: every charge approves\n");
else console.log("  payments     off (set PAYMENTS_FAKE=1 to try card and mobile money)\n");

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
