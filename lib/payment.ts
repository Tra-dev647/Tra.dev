import crypto from "crypto";

// Bakong KHQR payments.
// We build a dynamic KHQR string ourselves (EMV QR + CRC16) and confirm
// payment by polling Bakong's check_transaction_by_md5 API (no webhooks exist).
// MANUAL is kept as an admin override method.
export type PaymentMethod = "BAKONG" | "MANUAL";

export interface InitiatePaymentArgs {
  orderNumber: string;
  amountUsd: number;
  method: PaymentMethod;
  returnUrl: string;
  cancelUrl: string;
  note?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

export interface PaymentInitResult {
  paymentRef: string;
  redirectUrl: string;
  qrString?: string;
  expiresAt: Date;
}

const BAKONG_API = (
  process.env.BAKONG_API_URL || "https://api-bakong.nbc.gov.kh/v1"
).trim().replace(/\/$/, "");
const BAKONG_TOKEN = (process.env.BAKONG_API_TOKEN || "").trim();
const BAKONG_ACCOUNT = (process.env.BAKONG_ACCOUNT_ID || "").trim(); // e.g. name@bank
const BAKONG_MERCHANT_NAME = (process.env.BAKONG_MERCHANT_NAME || "TRATOPUP").trim();
const BAKONG_CITY = (process.env.BAKONG_MERCHANT_CITY || "Phnom Penh").trim();
// Optional: set both for a merchant account (tag 30) instead of an individual one (tag 29)
const BAKONG_MERCHANT_ID = (process.env.BAKONG_MERCHANT_ID || "").trim();
const BAKONG_ACQUIRING_BANK = (process.env.BAKONG_ACQUIRING_BANK || "").trim();
const QR_EXPIRE_MIN = Number(process.env.BAKONG_QR_EXPIRE_MINUTES) || 10;
const SIM_MODE = process.env.PAYMENT_SIMULATION_MODE === "true";

export async function initiatePayment(
  args: InitiatePaymentArgs
): Promise<PaymentInitResult> {
  if (SIM_MODE) return simulatePayment(args);
  if (args.method === "BAKONG") return initiateBakong(args);
  throw new Error(`Unsupported payment method: ${args.method}`);
}

function simulatePayment(args: InitiatePaymentArgs): PaymentInitResult {
  const ref = `SIM-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  const isPublicHttpUrl = (value?: string): value is string =>
    !!value &&
    /^https?:\/\//i.test(value) &&
    !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(value);

  const returnOrigin = (() => {
    try {
      return new URL(args.returnUrl).origin;
    } catch {
      return "";
    }
  })();
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  const base = (isPublicHttpUrl(envBase) ? envBase : returnOrigin).replace(/\/$/, "");

  return {
    paymentRef: ref,
    redirectUrl: `${base || ""}/api/payment/simulate?order=${args.orderNumber}&ref=${ref}&method=${args.method}`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  };
}

// ─── KHQR (EMV) builder ───────────────────────────────────────────────

function tlv(tag: string, value: string): string {
  return tag + String(value.length).padStart(2, "0") + value;
}

function crc16(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function buildKhqr(opts: {
  amountUsd: number;
  billNumber: string;
  createdMs: number;
  expiresMs: number;
}): string {
  const account = BAKONG_MERCHANT_ID && BAKONG_ACQUIRING_BANK
    ? tlv(
        "30",
        tlv("00", BAKONG_ACCOUNT) +
          tlv("01", BAKONG_MERCHANT_ID) +
          tlv("02", BAKONG_ACQUIRING_BANK)
      )
    : tlv("29", tlv("00", BAKONG_ACCOUNT));

  const body =
    tlv("00", "01") +
    tlv("01", "12") + // 12 = dynamic QR (amount fixed, expires)
    account +
    tlv("52", "5999") +
    tlv("53", "840") + // USD
    tlv("54", opts.amountUsd.toFixed(2)) +
    tlv("58", "KH") +
    tlv("59", BAKONG_MERCHANT_NAME.slice(0, 25)) +
    tlv("60", BAKONG_CITY.slice(0, 15)) +
    tlv("62", tlv("01", opts.billNumber.slice(0, 25))) +
    tlv("99", tlv("00", String(opts.createdMs)) + tlv("01", String(opts.expiresMs)));

  const withCrcTag = body + "6304";
  return withCrcTag + crc16(withCrcTag);
}

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

async function initiateBakong(args: InitiatePaymentArgs): Promise<PaymentInitResult> {
  if (!BAKONG_ACCOUNT) {
    throw new Error("BAKONG_ACCOUNT_ID is not configured");
  }
  const now = Date.now();
  const expiresMs = now + QR_EXPIRE_MIN * 60 * 1000;
  const qrString = buildKhqr({
    amountUsd: args.amountUsd,
    billNumber: args.orderNumber,
    createdMs: now,
    expiresMs,
  });
  return {
    paymentRef: md5(qrString), // Bakong looks transactions up by the QR's md5
    redirectUrl: `/checkout/${args.orderNumber}`,
    qrString,
    expiresAt: new Date(expiresMs),
  };
}

/**
 * Ask Bakong whether the QR with this md5 has been paid.
 * Returns null when the status can't be determined (no token, network error).
 */
export async function fetchPaymentStatus(
  md5Hash: string,
  expected?: { amountUsd: number }
): Promise<{ status: string; paid: boolean; amount?: number; currency?: string } | null> {
  if (SIM_MODE || !BAKONG_TOKEN) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  let res: Response;
  try {
    res = await fetch(`${BAKONG_API}/check_transaction_by_md5`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BAKONG_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ md5: md5Hash }),
      cache: "no-store",
      signal: ac.signal,
    });
  } catch (err) {
    console.warn("[bakong] check failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(t);
  }

  const json: any = await res.json().catch(() => null);
  if (!json) {
    console.warn(`[bakong] check ${md5Hash}: HTTP ${res.status}, no JSON`);
    return null;
  }

  // responseCode 0 + data => transaction found (paid). Otherwise still pending.
  if (json.responseCode === 0 && json.data) {
    const amount = Number(json.data.amount);
    const currency = String(json.data.currency || "");
    const toAccount = String(json.data.toAccountId || "");

    if (toAccount && BAKONG_ACCOUNT && toAccount !== BAKONG_ACCOUNT) {
      console.warn(`[bakong] ${md5Hash}: wrong recipient ${toAccount}`);
      return { status: "pending", paid: false };
    }
    if (
      expected &&
      (currency !== "USD" || !(amount + 0.005 >= expected.amountUsd))
    ) {
      console.warn(
        `[bakong] ${md5Hash}: amount/currency mismatch (${amount} ${currency} vs ${expected.amountUsd} USD)`
      );
      return { status: "pending", paid: false, amount, currency };
    }
    return { status: "paid", paid: true, amount, currency };
  }

  return { status: "pending", paid: false };
}
