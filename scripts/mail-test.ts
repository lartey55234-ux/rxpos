/**
 * Send one message, to prove the mail setup works before a pharmacy depends on it.
 *
 *   node scripts/mail-test.ts --to you@example.com
 *
 * Reads RESEND_API_KEY and MAIL_FROM. With no key it uses the console mailer, so
 * you can see what the message looks like without an account.
 */

import { parseArgs } from "node:util";
import { ConsoleMailer, ResendMailer, passwordResetEmail } from "../src/mail.ts";
import { loadConfig } from "../src/config.ts";

const { values } = parseArgs({ options: { to: { type: "string" } } });

const config = loadConfig();
const to = values.to ?? process.env.MAIL_TEST_TO;

if (!to) {
  console.error("[mail-test] --to <address> is required.");
  process.exit(2);
}

const mailer = config.resendApiKey
  ? new ResendMailer(config.resendApiKey, config.mailFrom)
  : new ConsoleMailer();

console.log(`[mail-test] sending as  ${config.mailFrom}`);
console.log(`[mail-test] delivery     ${mailer.delivers ? "real" : "printed to this log (no RESEND_API_KEY)"}`);
console.log(`[mail-test] links point  ${config.publicUrl}`);

const message = passwordResetEmail({
  pharmacyName: "Osu Community Pharmacy",
  ownerName: "Emmanuel Lartey",
  link: `${config.publicUrl}/?reset=this-is-only-a-sample-token`,
  minutes: 60,
});

try {
  await mailer.send({ ...message, to });
  console.log(`[mail-test] sent to ${to}`);
  if (!mailer.delivers) {
    console.log("[mail-test] nothing left the building. Set RESEND_API_KEY to send for real.");
  }
} catch (err) {
  console.error(`[mail-test] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
