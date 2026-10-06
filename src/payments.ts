/**
 * Taking money.
 *
 * Until now a payment was a row recording what the cashier said the customer
 * paid. This is the part that actually charges, and the important word is
 * *confirms*: the browser is never the authority on whether money arrived. A
 * charge is initialised on the server, the customer pays in Paystack's own
 * window, and the sale is only written once Paystack itself says the money is
 * there — by the browser asking, or by a webhook when the browser never comes
 * back, which is what happens with mobile money.
 *
 * The gateway is an interface with two implementations, so the tests do not need
 * a payment provider to be reachable, and the shape of Paystack's API does not
 * leak into the checkout logic.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Channel = "card" | "mobile_money";

export type InitialisedTransaction = {
  reference: string;
  accessCode: string;
  authorizationUrl: string;
};

export type TransactionStatus = "success" | "failed" | "abandoned" | "pending" | "reversed";

export type VerifiedTransaction = {
  reference: string;
  status: TransactionStatus;
  /** What Paystack says was paid, in the smallest unit — pesewas, same as ours. */
  amountPesewas: number;
  channel: string | null;
  currency: string;
  customerCode?: string | null;
};

export type SubscriptionPlan = { planCode: string };

export interface PaymentGateway {
  readonly name: string;
  initialize(input: {
    email: string;
    amountPesewas: number;
    reference: string;
    channels: Channel[];
  }): Promise<InitialisedTransaction>;
  verify(reference: string): Promise<VerifiedTransaction>;
  createSubscriptionPlan(input: { name: string; amountPesewas: number; interval: "monthly" }): Promise<SubscriptionPlan>;
  initializeSubscription(input: {
    email: string;
    planCode: string;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<InitialisedTransaction>;
  manageSubscription(subscriptionCode: string): Promise<string>;
  disableSubscription(subscriptionCode: string, emailToken: string): Promise<void>;
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

/** A reference the pharmacy can read out over the phone if a payment is disputed. */
export function newPaymentReference(): string {
  return `rxpos_${randomBytes(8).toString("hex")}`;
}

export class PaystackGateway implements PaymentGateway {
  readonly name = "paystack";
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  private async call<T>(path: string, init: RequestInit = {}, requireData = true): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new PaymentError(`Could not reach Paystack: ${err instanceof Error ? err.message : "network error"}`);
    }

    const body = (await response.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!response.ok || body.status === false) {
      throw new PaymentError(body.message ?? `Paystack refused the request (${response.status})`);
    }
    if (body.data === undefined && requireData) throw new PaymentError("Paystack returned no data");
    return body.data as T;
  }

  async initialize(input: {
    email: string;
    amountPesewas: number;
    reference: string;
    channels: Channel[];
  }): Promise<InitialisedTransaction> {
    const data = await this.call<{ reference: string; access_code: string; authorization_url: string }>(
      "/transaction/initialize",
      {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          amount: input.amountPesewas,
          reference: input.reference,
          currency: "GHS",
          channels: input.channels,
        }),
      },
    );
    return { reference: data.reference, accessCode: data.access_code, authorizationUrl: data.authorization_url };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const data = await this.call<{
      reference: string;
      status: string;
      amount: number;
      channel: string | null;
      currency: string;
      customer?: { customer_code?: string };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);

    return {
      reference: data.reference,
      status: data.status as TransactionStatus,
      amountPesewas: Number(data.amount),
      channel: data.channel ?? null,
      currency: data.currency,
      customerCode: data.customer?.customer_code ?? null,
    };
  }

  async createSubscriptionPlan(input: { name: string; amountPesewas: number; interval: "monthly" }): Promise<SubscriptionPlan> {
    const data = await this.call<{ plan_code: string }>("/plan", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        amount: input.amountPesewas,
        interval: input.interval,
        currency: "GHS",
        send_invoices: true,
      }),
    });
    return { planCode: data.plan_code };
  }

  async initializeSubscription(input: {
    email: string;
    planCode: string;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<InitialisedTransaction> {
    const data = await this.call<{ reference: string; access_code: string; authorization_url: string }>(
      "/transaction/initialize",
      {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          reference: input.reference,
          plan: input.planCode,
          channels: ["card"],
          metadata: JSON.stringify(input.metadata),
        }),
      },
    );
    return { reference: data.reference, accessCode: data.access_code, authorizationUrl: data.authorization_url };
  }

  async manageSubscription(subscriptionCode: string): Promise<string> {
    const data = await this.call<{ link: string }>(
      `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`,
    );
    return data.link;
  }

  async disableSubscription(subscriptionCode: string, emailToken: string): Promise<void> {
    await this.call<unknown>(
      "/subscription/disable",
      {
        method: "POST",
        body: JSON.stringify({ code: subscriptionCode, token: emailToken }),
      },
      false,
    );
  }
}

/**
 * Paystack signs the raw request body with the secret key. The body must be the
 * bytes as sent, not a re-serialised object, or the signature will not match.
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secretKey: string): boolean {
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"), "utf8");
  const received = Buffer.from(signature ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Used by the tests, and by a deployment that has no keys yet. */
export class FakeGateway implements PaymentGateway {
  readonly name = "fake";
  private readonly transactions = new Map<string, VerifiedTransaction>();
  /** What initialize was called with, so tests can assert on it. */
  readonly initialised: { email: string; amountPesewas: number; reference: string }[] = [];
  readonly subscriptionPlans: { name: string; amountPesewas: number; planCode: string }[] = [];
  readonly initialisedSubscriptions: { email: string; planCode: string; reference: string; metadata: Record<string, string> }[] = [];
  readonly disabledSubscriptions: string[] = [];

  /** Pretend the customer paid. */
  succeed(reference: string, amountPesewas: number, channel = "card"): void {
    this.transactions.set(reference, {
      reference,
      status: "success",
      amountPesewas,
      channel,
      currency: "GHS",
    });
  }

  fail(reference: string): void {
    this.transactions.set(reference, {
      reference,
      status: "failed",
      amountPesewas: 0,
      channel: null,
      currency: "GHS",
    });
  }

  async initialize(input: {
    email: string;
    amountPesewas: number;
    reference: string;
    channels: Channel[];
  }): Promise<InitialisedTransaction> {
    this.initialised.push({
      email: input.email,
      amountPesewas: input.amountPesewas,
      reference: input.reference,
    });
    return {
      reference: input.reference,
      accessCode: `fake_${input.reference}`,
      authorizationUrl: `https://example.invalid/pay/${input.reference}`,
    };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    return (
      this.transactions.get(reference) ?? {
        reference,
        status: "pending",
        amountPesewas: 0,
        channel: null,
        currency: "GHS",
      }
    );
  }

  async createSubscriptionPlan(input: { name: string; amountPesewas: number; interval: "monthly" }): Promise<SubscriptionPlan> {
    const planCode = `PLN_fake_${this.subscriptionPlans.length + 1}`;
    this.subscriptionPlans.push({ name: input.name, amountPesewas: input.amountPesewas, planCode });
    return { planCode };
  }

  async initializeSubscription(input: {
    email: string;
    planCode: string;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<InitialisedTransaction> {
    this.initialisedSubscriptions.push(input);
    return {
      reference: input.reference,
      accessCode: `fake_${input.reference}`,
      authorizationUrl: `https://example.invalid/subscribe/${input.reference}`,
    };
  }

  async manageSubscription(subscriptionCode: string): Promise<string> {
    return `https://example.invalid/manage/${encodeURIComponent(subscriptionCode)}`;
  }

  async disableSubscription(subscriptionCode: string, _emailToken: string): Promise<void> {
    this.disabledSubscriptions.push(subscriptionCode);
  }
}
