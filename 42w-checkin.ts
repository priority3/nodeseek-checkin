import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import https from "https";

// Reason: stealth 插件修补了多个浏览器指纹特征，降低被 Cloudflare 检测为自动化的概率
puppeteer.use(StealthPlugin());

const BASE_URL = "https://api.42w.shop";
const CHECKIN_URL = `${BASE_URL}/api/user/checkin`;
const SELF_URL = `${BASE_URL}/api/user/self`;
const SITE_URL = `${BASE_URL}/console`;
const PUSHPLUS_API = "https://www.pushplus.plus/send";
const CF_WAIT_MS = 15000;
const NAV_TIMEOUT_MS = 60000;

// Reason: same quota-to-USD ratio observed on New API platforms
const QUOTA_PER_USD = 500000;

interface CookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
}

interface PageEvalResult {
  status: number;
  body: string;
}

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

function parseCookies(cookieStr: string, domain: string): CookieParam[] {
  return cookieStr
    .split(";")
    .map((c) => {
      const idx = c.indexOf("=");
      if (idx === -1) return null;
      const name = c.substring(0, idx).trim();
      const value = c.substring(idx + 1).trim();
      if (!name) return null;
      return { name, value, domain, path: "/" };
    })
    .filter((c): c is CookieParam => c !== null);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function quotaToUsd(quota: number): string {
  return (quota / QUOTA_PER_USD).toFixed(6);
}

async function checkin(): Promise<void> {
  const cookieStr = process.env.W42_COOKIE;
  if (!cookieStr) {
    console.error("ERROR: W42_COOKIE is not set.");
    process.exit(1);
  }

  const userId = (process.env.W42_USER ?? "").trim();
  if (!userId) {
    console.error("ERROR: W42_USER is not set.");
    process.exit(1);
  }

  console.log("=== 42w Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`User: ${userId}`);

  const cookies = parseCookies(cookieStr, ".42w.shop");
  cookies.push({ name: "new-api-user", value: userId, domain: ".42w.shop", path: "/" });
  console.log(`Parsed ${cookies.length} cookies`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    );

    // Reason: 先设置 cookie 再导航，这样 session cookie 会随首次请求一起发送
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.setCookie(...(cookies as any[]));

    console.log("Navigating to 42w.shop...");
    await page.goto(SITE_URL, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });

    // Reason: Cloudflare managed challenge 需要时间执行 JS 并完成验证
    console.log(`Waiting ${CF_WAIT_MS / 1000}s for Cloudflare to clear...`);
    await new Promise((r) => setTimeout(r, CF_WAIT_MS));

    const pageTitle = await page.title();
    console.log(`Page title: ${pageTitle}`);

    if (pageTitle.includes("Just a moment")) {
      console.error("Failed to pass Cloudflare challenge.");
      process.exit(1);
    }

    // Reason: 在已通过 Cloudflare 验证的浏览器上下文中发起 fetch，
    // 这样请求会自动携带 cf_clearance cookie 和正确的浏览器指纹
    console.log("Sending check-in request...");
    const result: PageEvalResult = await page.evaluate(
      async (url: string, uid: string) => {
        try {
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "New-API-User": uid,
            },
          });
          return { status: res.status, body: await res.text() };
        } catch (err) {
          return { status: 0, body: (err as Error).message };
        }
      },
      CHECKIN_URL,
      userId
    );

    console.log(`HTTP Status: ${result.status}`);
    console.log(`Response: ${result.body}`);

    let title: string;
    const contentLines: string[] = [];
    let failed = false;

    try {
      const data = JSON.parse(result.body) as CheckinResponseData;
      const rawMsg =
        data?.message ?? data?.msg ?? data?.error ?? (typeof data === "string" ? data : "");
      const checkinMessage = typeof rawMsg === "string" ? rawMsg : "";

      if (typeof data?.success === "boolean" && !data.success) {
        // Reason: treat "已签到"/"already" as a soft success, not a real failure
        const alreadyCheckedIn =
          checkinMessage.includes("已签到") || checkinMessage.includes("already");
        title = `42w签到: ${checkinMessage || "失败"}`;
        contentLines.push(`Check-in: ${checkinMessage || "failed"}`);
        contentLines.push(result.body);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        const alreadyCheckedIn =
          checkinMessage.includes("已签到") || checkinMessage.includes("already");
        title = `42w签到: ${checkinMessage || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${checkinMessage || `code=${data.code}`}`);
        contentLines.push(result.body);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number" ? data.data.quota_awarded : null;
        const date =
          typeof data?.data?.checkin_date === "string" ? data.data.checkin_date : "";
        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `42w签到成功${
          award === null ? "" : ` +${formatNumber(award)} ($${awardUsd})`
        }${date ? ` (${date})` : ""}${checkinMessage ? `: ${checkinMessage}` : ""}`;

        contentLines.push(`Check-in: ${checkinMessage || "success"}`);
        if (award !== null) {
          contentLines.push(`Awarded: ${formatNumber(award)} quota ($${awardUsd})`);
        }
        if (date) contentLines.push(`Date: ${date}`);
      }
    } catch {
      if (result.status >= 200 && result.status < 300) {
        title = "42w签到成功";
        contentLines.push("Check-in: success");
      } else {
        title = `42w签到失败: HTTP ${result.status}`;
        failed = true;
      }
      contentLines.push(result.body);
    }

    // Fetch balance info
    console.log("Fetching balance...");
    const selfResult: PageEvalResult = await page.evaluate(
      async (url: string, uid: string) => {
        try {
          const res = await fetch(url, {
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "New-API-User": uid,
            },
          });
          return { status: res.status, body: await res.text() };
        } catch (err) {
          return { status: 0, body: (err as Error).message };
        }
      },
      SELF_URL,
      userId
    );

    let selfData: SelfResponseData | null = null;
    try {
      selfData = JSON.parse(selfResult.body) as SelfResponseData;
    } catch {
      // ignore
    }

    const selfQuota = selfData?.data?.quota;
    const selfUsedQuota = selfData?.data?.used_quota;

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
      contentLines.push(`Balance fetch failed: HTTP ${selfResult.status}`);
      if (selfResult.body) contentLines.push(selfResult.body);
    }

    console.log(`Notify title: ${title}`);
    await notify(title, contentLines.join("\n"));
    if (failed) process.exit(1);
  } finally {
    await browser.close();
  }
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
  await notify(`42w签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
