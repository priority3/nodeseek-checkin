import https from "https";

const BASE_URL = "https://kfc-api.sxxe.net";
const CHECKIN_URL = `${BASE_URL}/api/user/checkin`;
const CHECKIN_STATS_URL = `${BASE_URL}/api/user/checkin`;
const REFERER_URL = `${BASE_URL}/console/personal`;
const PUSHPLUS_API = "https://www.pushplus.plus/send";

// Reason: same quota-to-USD ratio observed on New API platforms
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

interface CheckinStatsResponseData {
  success?: boolean;
  data?: {
    enabled?: boolean;
    max_quota?: number;
    min_quota?: number;
    stats?: {
      checked_in_today?: boolean;
      checkin_count?: number;
      records?: Array<{
        checkin_date?: string;
        quota_awarded?: number;
      }>;
      total_checkins?: number;
      total_quota?: number;
    };
  };
}

interface CheckinStatsResult {
  status: number;
  text: string;
  data: CheckinStatsResponseData | null;
}

function getShanghaiDateParts(date = new Date()): { day: string; month: string } {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const day = formatter.format(date);
  return {
    day,
    month: day.slice(0, 7),
  };
}

function buildCookieHeader(session: string): string {
  const sessionValue = session.startsWith("session=")
    ? session.slice("session=".length)
    : session;
  return sessionValue ? `session=${sessionValue}` : "";
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function quotaToUsd(quota: number): string {
  return (quota / QUOTA_PER_USD).toFixed(6);
}

function buildHeaders(
  userId: string,
  cookie: string,
  referer: string
): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store",
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "New-API-User": userId,
    Cookie: cookie,
  };
}

async function fetchCheckinStats(userId: string, cookie: string): Promise<CheckinStatsResult> {
  const { month } = getShanghaiDateParts();
  const url = `${CHECKIN_STATS_URL}?month=${month}`;
  const res = await fetch(url, {
    headers: buildHeaders(userId, cookie, REFERER_URL),
  });

  const text = await res.text();
  let data: CheckinStatsResponseData | null = null;
  try {
    data = JSON.parse(text) as CheckinStatsResponseData;
  } catch {
    // ignore parse errors; data stays null
  }

  return { status: res.status, text, data };
}

async function checkin(): Promise<void> {
  const userId = (process.env.KFC_USER ?? "").trim();
  if (!userId) {
    console.error("ERROR: KFC_USER is not set.");
    process.exit(1);
  }

  const session = (process.env.KFC_SESSION ?? "").trim();
  if (!session) {
    console.error("ERROR: KFC_SESSION is not set.");
    process.exit(1);
  }

  const cookie = buildCookieHeader(session);
  if (!cookie) {
    console.error("ERROR: KFC_SESSION is invalid.");
    process.exit(1);
  }

  console.log("=== KFC API Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`User: ${userId}`);

  const checkinRes = await fetch(CHECKIN_URL, {
    method: "POST",
    headers: buildHeaders(userId, cookie, REFERER_URL),
  });

  const checkinText = await checkinRes.text();
  console.log(`HTTP Status: ${checkinRes.status}`);
  console.log(`Response: ${checkinText}`);

  let title: string;
  const contentLines: string[] = [];
  let failed = false;

  if (!checkinRes.ok) {
    title = `KFC API签到失败: HTTP ${checkinRes.status}`;
    contentLines.push(`Check-in HTTP: ${checkinRes.status}`);
    contentLines.push(checkinText);
    failed = true;
  } else {
    try {
      const data = JSON.parse(checkinText) as CheckinResponseData;
      const rawMsg =
        data?.message ?? data?.msg ?? data?.error ?? (typeof data === "string" ? data : "");
      const checkinMessage = typeof rawMsg === "string" ? rawMsg : "";
      const alreadyCheckedIn =
        checkinMessage.includes("已签到") || checkinMessage.toLowerCase().includes("already");

      if (typeof data?.success === "boolean" && !data.success) {
        title = `KFC API签到: ${checkinMessage || "失败"}`;
        contentLines.push(`Check-in: ${checkinMessage || "failed"}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        title = `KFC API签到: ${checkinMessage || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${checkinMessage || `code=${data.code}`}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number" ? data.data.quota_awarded : null;
        const date =
          typeof data?.data?.checkin_date === "string" ? data.data.checkin_date : "";
        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `KFC API签到成功${
          award === null ? "" : ` +${formatNumber(award)} ($${awardUsd})`
        }${date ? ` (${date})` : ""}${checkinMessage ? `: ${checkinMessage}` : ""}`;

        contentLines.push(`Check-in: ${checkinMessage || "success"}`);
        if (award !== null) {
          contentLines.push(`Awarded: ${formatNumber(award)} quota ($${awardUsd})`);
        }
        if (date) contentLines.push(`Date: ${date}`);
      }
    } catch {
      title = "KFC API签到成功";
      contentLines.push("Check-in: success");
      contentLines.push(checkinText);
    }
  }

  let statsInfo: CheckinStatsResult | null = null;
  try {
    statsInfo = await fetchCheckinStats(userId, cookie);
  } catch (err) {
    statsInfo = { status: 0, text: (err as Error).message, data: null };
  }

  const { day } = getShanghaiDateParts();
  const stats = statsInfo?.data?.data?.stats;
  const todayRecord = stats?.records?.find((record) => record.checkin_date === day);
  const todayQuota =
    typeof todayRecord?.quota_awarded === "number" ? todayRecord.quota_awarded : null;
  const totalQuota =
    typeof stats?.total_quota === "number" ? stats.total_quota : null;
  const totalCheckins =
    typeof stats?.total_checkins === "number" ? stats.total_checkins : null;

  if (todayQuota !== null) {
    const todayUsd = quotaToUsd(todayQuota);
    title = `${title} | 今日 +${formatNumber(todayQuota)} ($${todayUsd})`;
    contentLines.push("");
    contentLines.push("Today:");
    contentLines.push(`Awarded: ${formatNumber(todayQuota)} quota ($${todayUsd})`);
    contentLines.push(`Date: ${day}`);
  }

  if (totalQuota !== null || totalCheckins !== null) {
    contentLines.push("");
    contentLines.push("Stats:");
    if (totalCheckins !== null) contentLines.push(`Total check-ins: ${totalCheckins}`);
    if (totalQuota !== null) {
      const totalUsd = quotaToUsd(totalQuota);
      contentLines.push(`Total quota: ${formatNumber(totalQuota)} ($${totalUsd})`);
    }
  } else {
    contentLines.push("");
    contentLines.push(`Stats fetch failed: HTTP ${statsInfo?.status ?? "unknown"}`);
    if (statsInfo?.text) contentLines.push(statsInfo.text);
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
  await notify(`KFC API签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
