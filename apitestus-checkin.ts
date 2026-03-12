import https from "https";

const BASE_URL = "https://openai.api-test.us.ci";
const CHECKIN_URL = `${BASE_URL}/api/user/checkin`;
const SELF_URL = `${BASE_URL}/api/user/self`;
const REFERER_URL = `${BASE_URL}/console/personal`;
const CONSOLE_URL = `${BASE_URL}/console`;
const PUSHPLUS_API = "https://www.pushplus.plus/send";

// Reason: same quota-to-USD ratio observed on this platform as HotaruAPI
const QUOTA_PER_USD = 500000;

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

function buildCookieHeader(opts: {
  session?: string;
  userId?: string;
}): string {
  const sessionRaw = (opts.session ?? "").trim();
  const userRaw = (opts.userId ?? "").trim();
  const sessionValue = sessionRaw.startsWith("session=")
    ? sessionRaw.slice("session=".length)
    : sessionRaw;
  const userValue = userRaw.startsWith("new-api-user=")
    ? userRaw.slice("new-api-user=".length)
    : userRaw;

  if (!sessionValue || !userValue) return "";
  return `session=${sessionValue}; new-api-user=${userValue}`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function quotaToUsd(quota: number): string {
  return (quota / QUOTA_PER_USD).toFixed(6);
}

function normalizeAccessToken(token: string): string {
  const trimmed = token.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return "";
  if (/^bearer\s+/i.test(trimmed)) return trimmed.replace(/^bearer\s+/i, "").trim();
  return trimmed;
}

function resolveAccessToken(envToken?: string): string {
  return normalizeAccessToken(envToken ?? "");
}

async function fetchSelf(
  cookieHeader: string,
  userId: string,
  accessToken: string
): Promise<SelfResult> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store",
    Referer: CONSOLE_URL,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    Cookie: cookieHeader,
    "New-API-User": userId,
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    headers["access-token"] = accessToken;
  }

  const res = await fetch(SELF_URL, {
    headers,
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
  const session = (process.env.APITESTUS_SESSION ?? "").trim();
  const userId = (process.env.APITESTUS_USER ?? "").trim();
  if (!session) {
    console.error("ERROR: APITESTUS_SESSION is not set.");
    process.exit(1);
  }
  if (!userId) {
    console.error("ERROR: APITESTUS_USER is not set.");
    process.exit(1);
  }

  const cookieHeader = buildCookieHeader({ session, userId });
  if (!cookieHeader) {
    console.error("ERROR: Failed to build session cookie from APITESTUS_SESSION/APITESTUS_USER.");
    process.exit(1);
  }

  console.log("=== api-test.us Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`User: ${userId}`);
  const accessToken = resolveAccessToken(process.env.APITESTUS_ACCESS_TOKEN);
  console.log(`Auth: ${accessToken ? "session + access-token" : "session only"}`);

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store",
    Referer: REFERER_URL,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    Cookie: cookieHeader,
    "New-API-User": userId,
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    headers["access-token"] = accessToken;
  }

  const checkinRes = await fetch(CHECKIN_URL, {
    method: "POST",
    headers,
  });

  const checkinText = await checkinRes.text();
  console.log(`HTTP Status: ${checkinRes.status}`);
  console.log(`Response: ${checkinText}`);

  let title: string;
  const contentLines: string[] = [];
  let failed = false;

  if (!checkinRes.ok) {
    const isUnauthorized = checkinRes.status === 401;
    title = isUnauthorized
      ? "api-test.us签到失败: 凭证失效(401)"
      : `api-test.us签到失败: HTTP ${checkinRes.status}`;
    contentLines.push(`Check-in HTTP: ${checkinRes.status}`);
    contentLines.push(checkinText);
    if (isUnauthorized) {
      contentLines.push("");
      contentLines.push(
        "Hint: 401 indicates auth is invalid. Refresh APITESTUS_SESSION or set APITESTUS_ACCESS_TOKEN."
      );
    }
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
        title = `api-test.us签到: ${checkinMessage || "失败"}`;
        contentLines.push(`Check-in: ${checkinMessage || "failed"}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        const alreadyCheckedIn =
          checkinMessage.includes("已签到") || checkinMessage.includes("already");
        title = `api-test.us签到: ${checkinMessage || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${checkinMessage || `code=${data.code}`}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number" ? data.data.quota_awarded : null;
        const date =
          typeof data?.data?.checkin_date === "string" ? data.data.checkin_date : "";
        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `api-test.us签到成功${
          award === null ? "" : ` +${formatNumber(award)} ($${awardUsd})`
        }${date ? ` (${date})` : ""}${checkinMessage ? `: ${checkinMessage}` : ""}`;

        contentLines.push(`Check-in: ${checkinMessage || "success"}`);
        if (award !== null) {
          contentLines.push(`Awarded: ${formatNumber(award)} quota ($${awardUsd})`);
        }
        if (date) contentLines.push(`Date: ${date}`);
      }
    } catch {
      // Some APIs return plain text on 200
      title = "api-test.us签到成功";
      contentLines.push("Check-in: success");
      contentLines.push(checkinText);
    }
  }

  let selfInfo: SelfResult | null = null;
  try {
    selfInfo = await fetchSelf(cookieHeader, userId, accessToken);
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
    contentLines.push(
      `Balance fetch failed: HTTP ${selfInfo?.status ?? "unknown"}`
    );
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
  await notify(`api-test.us签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
