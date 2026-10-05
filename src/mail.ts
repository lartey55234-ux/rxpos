/**
 * Sending email.
 *
 * Behind an interface for the same reason the payment gateway is: the flow can be
 * built and tested without a provider being reachable, and swapping providers does
 * not touch the logic. A deployment with no provider configured logs the message
 * instead of sending it, which is honest — the link still works, it just arrives
 * on the server's console rather than in an inbox.
 */

export type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface Mailer {
  readonly name: string;
  /** True when messages really leave the building. */
  readonly delivers: boolean;
  send(message: Message): Promise<void>;
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}

/**
 * Writes the message to the log. Used in development, and by any deployment that
 * has not been given a provider yet — the reset link still works.
 */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  readonly delivers = false;

  async send(message: Message): Promise<void> {
    console.log(
      `\n[mail] to ${message.to}\n[mail] subject: ${message.subject}\n${message.text
        .split("\n")
        .map((line) => `[mail] ${line}`)
        .join("\n")}\n`,
    );
  }
}

/** Resend, which is one HTTP call and no dependency. */
export class ResendMailer implements Mailer {
  readonly name = "resend";
  readonly delivers = true;
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: Message): Promise<void> {
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (err) {
      throw new MailError(`Could not reach the mail provider: ${err instanceof Error ? err.message : "network error"}`);
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new MailError(body.message ?? `The mail provider refused the message (${response.status})`);
    }
  }
}

/** Used by the tests: keeps what it was asked to send. */
export class RecordingMailer implements Mailer {
  readonly name = "recording";
  readonly delivers = false;
  readonly sent: Message[] = [];

  async send(message: Message): Promise<void> {
    this.sent.push(message);
  }

  /** The link out of the most recent message, so a test can follow it. */
  lastLink(): string {
    return /(https?:\/\/\S+\?reset=\S+)/.exec(this.sent.at(-1)?.text ?? "")?.[1] ?? "";
  }

  tokenFromLastLink(): string {
    const link = this.lastLink();
    return link ? decodeURIComponent(link.split("reset=")[1] ?? "") : "";
  }
}

/** What a password reset email says. Kept here so the wording can be reviewed. */
export function passwordResetEmail(input: { pharmacyName: string; ownerName: string; link: string; minutes: number }): Message & { to: string } {
  return {
    to: "",
    subject: `Reset your rxpos password`,
    text: [
      `Hello ${input.ownerName},`,
      ``,
      `Someone asked to reset the password for the rxpos account of ${input.pharmacyName}.`,
      ``,
      `Open this link to choose a new password. It works once and expires in ${input.minutes} minutes:`,
      ``,
      input.link,
      ``,
      `If this was not you, nothing has changed and you can ignore this message. Your current password still works.`,
    ].join("\n"),
    html: `<p>Hello ${input.ownerName},</p>
<p>Someone asked to reset the password for the rxpos account of <b>${input.pharmacyName}</b>.</p>
<p><a href="${input.link}">Choose a new password</a> — the link works once and expires in ${input.minutes} minutes.</p>
<p>If this was not you, nothing has changed and you can ignore this message. Your current password still works.</p>`,
  };
}
