import https from "https";

const CHECKIN_URL = "https://hotaruapi.com/api/user/checkin";
const SELF_URL = "https://hotaruapi.com/api/user/self";
const REFERER_URL = "https://hotaruapi.com/console/personal";
const CONSOLE_URL = "https://hotaruapi.com/console";
const PUSHPLUS_API = "https://www.pushplus.plus/send";

// Reason: observed mapping from console display: quota / 500000 = USD (6 decimals)
const QUOTA_PER_USD = 500000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

interface CheckinResponseData {
  success?: boolean;
  code?: number;
  message?: string;
  msg?: string;
  error?: string;
  data?: {
    quota_awarded?: number;
    checkin_date?: string;
  };
}

interface SelfResponseData {
  data?: {
    quota?: number;
    used_quota?: number;
  };
}

interface SelfResult {
  status: number;
  text: string;
  data: SelfResponseData | null;
}

interface CheckinResult {
  status: number;
  ok: boolean;
  text: string;
  attempt: number;
  totalAttempts: number;
  error?: string;
}

function parseCookieValue(cookieStr: string, key: string): string {
  if (!cookieStr) return "";
  const parts = cookieStr.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== key) continue;
    return p.slice(idx + 1).trim();
  }
  return "";
}

function buildCookieHeader(opts: {
  cookie?: string;
  session?: string;
  userId?: string;
}): string {
  const baseCookie = (opts.cookie ?? "").trim();
  const sessionRaw = (opts.session ?? "").trim();
  const userRaw = (opts.userId ?? "").trim();
  const sessionValue = sessionRaw.startsWith("session=")
    ? sessionRaw.slice("session=".length)
    : sessionRaw;
  const userValue = userRaw.startsWith("new-api-user=")
    ? userRaw.slice("new-api-user=".length)
    : userRaw;

  if (baseCookie) {
    const pairs = baseCookie
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean);

    const replacePair = (key: string, value: string): void => {
      if (!value) return;
      const keyPrefix = `${key}=`;
      const filtered = pairs.filter((p) => !p.startsWith(keyPrefix));
      filtered.push(`${key}=${value}`);
      pairs.length = 0;
      pairs.push(...filtered);
    };

    replacePair("session", sessionValue);
    replacePair("new-api-user", userValue);
    return pairs.join("; ");
  }

  if (!sessionValue || !userValue) return "";
  return `session=${sessionValue}; new-api-user=${userValue}`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function quotaToUsd(quota: number): string {
  return (quota / QUOTA_PER_USD).toFixed(6);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function shouldRetryByBody(status: number, body: string): boolean {
  if (!body) return false;
  if (status < 200 || status >= 300) return false;

  try {
    const data = JSON.parse(body) as CheckinResponseData;
    const rawMsg = data?.message ?? data?.msg ?? data?.error ?? "";
    const msg = typeof rawMsg === "string" ? rawMsg : "";

    const wantsRetryByMessage =
      msg.includes("稍后重试") ||
      msg.includes("请稍后") ||
      msg.includes("连接过多") ||
      /too many connections/i.test(msg) ||
      /error\s*1040/i.test(msg) ||
      /try again/i.test(msg) ||
      /temporar/i.test(msg) ||
      /busy/i.test(msg) ||
      /rate limit/i.test(msg);

    if (!wantsRetryByMessage) return false;

    // Do not retry if API says already checked in.
    if (msg.includes("已签到") || msg.toLowerCase().includes("already")) return false;

    if (typeof data?.success === "boolean" && !data.success) return true;
    if (typeof data?.code === "number" && data.code !== 0) return true;
  } catch {
    // non-JSON responses do not trigger business-level retries
  }

  return false;
}

function isConnectionSaturatedBody(body: string): boolean {
  if (!body) return false;

  let message = body;
  try {
    const data = JSON.parse(body) as CheckinResponseData;
    const rawMsg = data?.message ?? data?.msg ?? data?.error ?? "";
    if (typeof rawMsg === "string" && rawMsg) message = rawMsg;
  } catch {
    // ignore parse failure and fallback to raw body text matching
  }

  return (
    message.includes("连接过多") ||
    /too many connections/i.test(message) ||
    /error\s*1040/i.test(message)
  );
}

async function postCheckinWithRetry(cookieHeader: string, userId: string): Promise<CheckinResult> {
  const maxAttempts = parsePositiveInt(process.env.HOTARU_CHECKIN_MAX_ATTEMPTS, 3);
  // Keep timeout slightly above common proxy timeout windows to avoid aborting too early.
  const timeoutMs = parsePositiveInt(process.env.HOTARU_CHECKIN_TIMEOUT_MS, 135000);
  const retryDelayMs = parsePositiveInt(process.env.HOTARU_CHECKIN_RETRY_DELAY_MS, 3000);
  const connectionRetryDelayMs = parsePositiveInt(
    process.env.HOTARU_CHECKIN_CONNECTION_RETRY_DELAY_MS,
    30000
  );

  let lastStatus = 0;
  let lastText = "";
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(CHECKIN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Cache-Control": "no-store",
          Referer: REFERER_URL,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          Cookie: cookieHeader,
          "New-API-User": userId,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      const retryable = RETRYABLE_STATUSES.has(res.status);
      const retryableByBody = shouldRetryByBody(res.status, text);
      const connectionSaturated = isConnectionSaturatedBody(text);
      console.log(`Check-in attempt ${attempt}/${maxAttempts}: HTTP ${res.status}`);

      if ((res.ok && !retryableByBody) || (!retryable && !retryableByBody) || attempt === maxAttempts) {
        return {
          status: res.status,
          ok: res.ok,
          text,
          attempt,
          totalAttempts: maxAttempts,
        };
      }

      lastStatus = res.status;
      lastText = text;
      const delay =
        retryableByBody && connectionSaturated
          ? connectionRetryDelayMs * attempt
          : retryDelayMs * attempt;
      if (retryableByBody && connectionSaturated) {
        console.log(`Retrying in ${delay}ms due to connection saturation (Error 1040)...`);
      } else if (retryableByBody) {
        console.log(`Retrying in ${delay}ms due to retryable API response body...`);
      } else {
        console.log(`Retrying in ${delay}ms due to retryable HTTP ${res.status}...`);
      }
      await sleep(delay);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      console.warn(`Check-in attempt ${attempt}/${maxAttempts} failed: ${message}`);

      if (attempt === maxAttempts) break;

      const delay = retryDelayMs * attempt;
      console.log(`Retrying in ${delay}ms due to network/timeout error...`);
      await sleep(delay);
    }
  }

  return {
    status: lastStatus,
    ok: false,
    text: lastText || `Request failed after retries: ${lastError || "unknown error"}`,
    attempt: maxAttempts,
    totalAttempts: maxAttempts,
    error: lastError || undefined,
  };
}

async function fetchSelf(cookieHeader: string, userId: string): Promise<SelfResult> {
  const res = await fetch(SELF_URL, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Cache-Control": "no-store",
      Referer: CONSOLE_URL,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Cookie: cookieHeader,
      "New-API-User": userId,
    },
  });

  const text = await res.text();
  let data: SelfResponseData | null = null;
  try {
    data = JSON.parse(text) as SelfResponseData;
  } catch {
    // ignore parse errors; data stays null
  }
  return { status: res.status, text, data };
}

async function checkin(): Promise<void> {
  const userIdFromEnv = (process.env.HOTARU_USER ?? "").trim();

  const cookieHeader = buildCookieHeader({
    cookie: process.env.HOTARU_COOKIE,
    session: process.env.HOTARU_SESSION,
    userId: userIdFromEnv,
  });

  if (!cookieHeader) {
    console.error(
      "ERROR: HOTARU_COOKIE is not set (or HOTARU_SESSION + HOTARU_USER)."
    );
    process.exit(1);
  }

  const userId = userIdFromEnv || parseCookieValue(cookieHeader, "new-api-user");
  if (!userId) {
    console.error(
      "ERROR: HOTARU_USER is not set and cookie does not contain new-api-user."
    );
    process.exit(1);
  }

  console.log("=== HotaruAPI Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`User: ${userId}`);

  const checkinRes = await postCheckinWithRetry(cookieHeader, userId);
  const checkinText = checkinRes.text;
  const finalStatus = checkinRes.status;
  console.log(`HTTP Status: ${finalStatus || "N/A"}`);
  console.log(`Attempts used: ${checkinRes.attempt}/${checkinRes.totalAttempts}`);
  console.log(`Response: ${checkinText}`);

  let title: string;
  const contentLines: string[] = [];
  let failed = false;
  contentLines.push(`Attempts: ${checkinRes.attempt}/${checkinRes.totalAttempts}`);

  if (!checkinRes.ok) {
    title = `HotaruAPI签到失败: HTTP ${finalStatus || "N/A"}`;
    contentLines.push(`Check-in HTTP: ${finalStatus || "N/A"}`);
    if (checkinRes.error) contentLines.push(`Error: ${checkinRes.error}`);
    contentLines.push(checkinText);
    failed = true;
  } else {
    try {
      const data = JSON.parse(checkinText) as CheckinResponseData;
      const rawMsg =
        data?.message ?? data?.msg ?? data?.error ?? (typeof data === "string" ? data : "");
      const checkinMessage = typeof rawMsg === "string" ? rawMsg : "";

      if (typeof data?.success === "boolean" && !data.success) {
        // Reason: treat "已签到"/"already" as a soft success, not a real failure
        const alreadyCheckedIn =
          checkinMessage.includes("已签到") || checkinMessage.includes("already");
        title = `HotaruAPI签到: ${checkinMessage || "失败"}`;
        contentLines.push(`Check-in: ${checkinMessage || "failed"}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        const alreadyCheckedIn =
          checkinMessage.includes("已签到") || checkinMessage.includes("already");
        title = `HotaruAPI签到: ${checkinMessage || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${checkinMessage || `code=${data.code}`}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number" ? data.data.quota_awarded : null;
        const date =
          typeof data?.data?.checkin_date === "string" ? data.data.checkin_date : "";
        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `HotaruAPI签到成功${
          award === null ? "" : ` +${formatNumber(award)} ($${awardUsd})`
        }${date ? ` (${date})` : ""}${checkinMessage ? `: ${checkinMessage}` : ""}`;

        contentLines.push(`Check-in: ${checkinMessage || "success"}`);
        if (award !== null) {
          contentLines.push(`Awarded: ${formatNumber(award)} quota ($${awardUsd})`);
        }
        if (date) contentLines.push(`Date: ${date}`);
      }
    } catch {
      // Some APIs return plain text even on 200
      title = "HotaruAPI签到成功";
      contentLines.push("Check-in: success");
      contentLines.push(checkinText);
    }
  }

  let selfInfo: SelfResult | null = null;
  try {
    selfInfo = await fetchSelf(cookieHeader, userId);
  } catch (err) {
    selfInfo = { status: 0, text: (err as Error).message, data: null };
  }

  const selfQuota = selfInfo?.data?.data?.quota;
  const selfUsedQuota = selfInfo?.data?.data?.used_quota;

  if (typeof selfQuota === "number") {
    const balanceUsd = quotaToUsd(selfQuota);
    title = `${title} | 余额 $${balanceUsd}`;
    contentLines.push("");
    contentLines.push("Balance:");
    contentLines.push(`Quota: ${formatNumber(selfQuota)} ($${balanceUsd})`);
    if (typeof selfUsedQuota === "number") {
      const usedUsd = quotaToUsd(selfUsedQuota);
      contentLines.push(`Used: ${formatNumber(selfUsedQuota)} ($${usedUsd})`);
    }
  } else {
    contentLines.push("");
    contentLines.push(`Balance fetch failed: HTTP ${selfInfo?.status ?? "unknown"}`);
    if (selfInfo?.text) contentLines.push(selfInfo.text);
  }

  console.log(`Notify title: ${title}`);
  await notify(title, contentLines.join("\n"));
  if (failed) process.exit(1);
}

function notify(title: string, content: string): Promise<void> {
  const token = process.env.PUSHPLUS_TOKEN;
  if (!token) {
    console.log("PUSHPLUS_TOKEN not set, skipping notification.");
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    token,
    title,
    content: content || title,
    template: "txt",
  });

  return new Promise((resolve) => {
    const req = https.request(
      PUSHPLUS_API,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          console.log(`PushPlus response: ${data}`);
          resolve();
        });
      }
    );
    req.on("error", (err: Error) => {
      console.error(`PushPlus notify failed: ${err.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

checkin().catch(async (err: Error) => {
  console.error("Fatal error:", err.message);
  await notify(`HotaruAPI签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
