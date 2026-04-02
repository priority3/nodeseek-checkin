import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import https from "https";
import type { Page } from "puppeteer";

// Reason: stealth 插件修补了多个浏览器指纹特征，降低被 Cloudflare 检测为自动化的概率
puppeteer.use(StealthPlugin());

const CHECKIN_URL = "https://www.nodeseek.com/api/attendance?random=true";
const SITE_URL = "https://www.nodeseek.com/board";
const PUSHPLUS_API = "https://www.pushplus.plus/send";
const CF_MAX_WAIT_MS = 45000;
const CF_POLL_INTERVAL_MS = 3000;
const CF_RELOAD_AFTER_MS = 18000;
const RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS = 2;
const NAV_TIMEOUT_MS = 60000;
const PUSHPLUS_TITLE_MAX_LEN = 96;

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
  gain?: number | string;
  current?: number | string;
  message?: string;
}

interface CheckinResult {
  title: string;
  body: string;
  failed: boolean;
}

interface ChallengeState {
  title: string;
  url: string;
  bodySnippet: string;
  hasCfClearance: boolean;
}

/**
 * 将 cookie 字符串解析为 Puppeteer 可用的 cookie 对象数组
 */
function parseCookies(cookieStr: string): CookieParam[] {
  return cookieStr
    .split(";")
    .map((c) => {
      const idx = c.indexOf("=");
      if (idx === -1) return null;
      const name = c.substring(0, idx).trim();
      const value = c.substring(idx + 1).trim();
      if (!name) return null;
      return { name, value, domain: ".nodeseek.com", path: "/" };
    })
    .filter((c): c is CookieParam => c !== null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function includesChallengeText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("just a moment") ||
    normalized.includes("checking your browser") ||
    normalized.includes("verify you are human") ||
    normalized.includes("enable javascript and cookies to continue")
  );
}

async function getChallengeState(page: Page): Promise<ChallengeState> {
  const [title, bodySnippet, cookies] = await Promise.all([
    page.title(),
    page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return text.replace(/\s+/g, " ").trim().slice(0, 240);
    }),
    page.cookies(),
  ]);

  return {
    title,
    url: page.url(),
    bodySnippet,
    hasCfClearance: cookies.some((cookie) => cookie.name === "cf_clearance"),
  };
}

async function waitForCloudflareClear(page: Page): Promise<void> {
  const startTime = Date.now();
  let reloaded = false;

  while (Date.now() - startTime < CF_MAX_WAIT_MS) {
    const state = await getChallengeState(page);
    console.log(
      `[CF] title="${state.title}" cf_clearance=${state.hasCfClearance} url=${state.url}`
    );

    const combinedText = `${state.title}\n${state.bodySnippet}\n${state.url}`;
    if (!includesChallengeText(combinedText)) {
      return;
    }

    const elapsedMs = Date.now() - startTime;
    if (!reloaded && elapsedMs >= CF_RELOAD_AFTER_MS) {
      console.log("Cloudflare challenge still active, reloading page once...");
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      reloaded = true;
      continue;
    }

    await sleep(CF_POLL_INTERVAL_MS);
  }

  const finalState = await getChallengeState(page);
  throw new Error(
    `Cloudflare challenge did not clear within ${CF_MAX_WAIT_MS / 1000}s ` +
      `(title="${finalState.title}", cf_clearance=${finalState.hasCfClearance}, url=${finalState.url}, ` +
      `snippet="${finalState.bodySnippet}")`
  );
}

async function runCheckinAttempt(cookies: CookieParam[]): Promise<CheckinResult> {
  const runHeadful = isTruthyEnv(process.env.NS_HEADFUL);
  const browser = await puppeteer.launch({
    headless: runHeadful ? false : true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1365,900",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });

    // Reason: 依赖 stealth 插件统一处理 UA / client hints，避免手动覆写后出现指纹不一致
    // Reason: 先设置 cookie 再导航，这样 session cookie 会随首次请求一起发送
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.setCookie(...(cookies as any[]));

    console.log("Navigating to NodeSeek...");
    await page.goto(SITE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Reason: Cloudflare managed challenge 的耗时不稳定，改为轮询等待并在超时前重载一次
    console.log(`Waiting up to ${CF_MAX_WAIT_MS / 1000}s for Cloudflare to clear...`);
    await waitForCloudflareClear(page);
    console.log(`Page title after challenge: ${await page.title()}`);

    // Reason: 在已通过 Cloudflare 验证的浏览器上下文中发起 fetch，
    // 这样请求会自动携带 cf_clearance cookie 和正确的浏览器指纹
    console.log("Sending check-in request...");
    const result: PageEvalResult = await page.evaluate(async (url: string) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json, text/plain, */*" },
        });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { status: 0, body: (err as Error).message };
      }
    }, CHECKIN_URL);

    console.log(`HTTP Status: ${result.status}`);
    console.log(`Response: ${result.body}`);

    const combinedResponseText = result.body.toLowerCase();
    if (
      result.status === 403 ||
      includesChallengeText(combinedResponseText) ||
      combinedResponseText.includes("cf-mitigated")
    ) {
      throw new Error(
        `Check-in request was still challenged by Cloudflare (HTTP ${result.status}): ${result.body
          .replace(/\s+/g, " ")
          .slice(0, 240)}`
      );
    }

    // 解析结果并构建通知标题
    let title: string;
    let body: string;
    let failed = false;

    try {
      const data = JSON.parse(result.body) as CheckinResponseData;
      if (data.success) {
        title = `[nodeseek-checkin] NodeSeek签到成功 +${data.gain}鸡腿 (总计${data.current})`;
        body = data.message ?? result.body;
        console.log("Check-in succeeded!");
      } else if (data.message) {
        title = `[nodeseek-checkin] NodeSeek签到: ${data.message}`;
        body = result.body;
        console.log(`Check-in result: ${data.message}`);
      } else {
        title = "[nodeseek-checkin] NodeSeek签到失败: 未知响应";
        body = result.body;
        failed = true;
      }
    } catch {
      title = `[nodeseek-checkin] NodeSeek签到失败: HTTP ${result.status}`;
      body = result.body;
      failed = true;
    }

    return { title, body, failed };
  } finally {
    await browser.close();
  }
}

async function checkin(): Promise<void> {
  const cookieStr = process.env.NS_COOKIE;
  if (!cookieStr) {
    console.error("ERROR: NS_COOKIE is not set.");
    process.exit(1);
  }

  console.log("=== NodeSeek Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const cookies = parseCookies(cookieStr);
  console.log(`Parsed ${cookies.length} cookies`);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}`);
      const result = await runCheckinAttempt(cookies);
      await notify(result.title, result.body);
      if (result.failed) process.exit(1);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError ?? new Error("NodeSeek check-in failed for an unknown reason.");
}

/**
 * 通过 PushPlus 发送微信通知
 * Reason: 将签到结果放在 title 中，微信通知可以直接看到结果无需点开
 */
function notify(title: string, content: string): Promise<void> {
  const token = process.env.PUSHPLUS_TOKEN;
  if (!token) {
    console.log("PUSHPLUS_TOKEN not set, skipping notification.");
    return Promise.resolve();
  }

  const safeTitle =
    title.length > PUSHPLUS_TITLE_MAX_LEN
      ? `${title.slice(0, PUSHPLUS_TITLE_MAX_LEN - 1)}...`
      : title;

  const payload = JSON.stringify({
    token,
    title: safeTitle,
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
  await notify(`[nodeseek-checkin] NodeSeek签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
