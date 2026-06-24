import https from "https";

const BASE_URL = "https://elysiver.h-e.top";
const CHECKIN_URL = `${BASE_URL}/api/user/checkin`;
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
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "New-API-User": userId,
    Cookie: cookie,
  };
}

async function checkin(): Promise<void> {
  const userId = (process.env.ELYSIVER_USER ?? "").trim();
  if (!userId) {
    console.error("ERROR: ELYSIVER_USER is not set.");
    process.exit(1);
  }

  const session = (process.env.ELYSIVER_SESSION ?? "").trim();
  if (!session) {
    console.error("ERROR: ELYSIVER_SESSION is not set.");
    process.exit(1);
  }

  const cookie = buildCookieHeader(session);
  if (!cookie) {
    console.error("ERROR: ELYSIVER_SESSION is invalid.");
    process.exit(1);
  }

  console.log("=== Elysiver Check-in ===");
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
    title = `Elysiver签到失败: HTTP ${checkinRes.status}`;
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
        title = `Elysiver签到: ${checkinMessage || "失败"}`;
        contentLines.push(`Check-in: ${checkinMessage || "failed"}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        title = `Elysiver签到: ${checkinMessage || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${checkinMessage || `code=${data.code}`}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number" ? data.data.quota_awarded : null;
        const date =
          typeof data?.data?.checkin_date === "string" ? data.data.checkin_date : "";
        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `Elysiver签到成功${
          award === null ? "" : ` +${formatNumber(award)} ($${awardUsd})`
        }${date ? ` (${date})` : ""}${checkinMessage ? `: ${checkinMessage}` : ""}`;

        contentLines.push(`Check-in: ${checkinMessage || "success"}`);
        if (award !== null) {
          contentLines.push(`Awarded: ${formatNumber(award)} quota ($${awardUsd})`);
        }
        if (date) contentLines.push(`Date: ${date}`);
      }
    } catch {
      title = "Elysiver签到成功";
      contentLines.push("Check-in: success");
      contentLines.push(checkinText);
    }
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
  await notify(`Elysiver签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
