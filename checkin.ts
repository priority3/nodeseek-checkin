import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import https from "https";
import path from "path";
import type { Page } from "puppeteer";

// Reason: stealth 插件修补了多个浏览器指纹特征，降低被 Cloudflare 检测为自动化的概率
puppeteer.use(StealthPlugin());

const CHECKIN_URL = "https://www.nodeseek.com/api/attendance?random=true";
const SITE_URL = "https://www.nodeseek.com/board";
const PUSHPLUS_API = "https://www.pushplus.plus/send";
const CF_MAX_WAIT_MS = 45000;
const CF_POLL_INTERVAL_MS = 3000;
const CF_RELOAD_AFTER_MS = 18000;
const BOOTSTRAP_MAX_WAIT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS = 2;
const NAV_TIMEOUT_MS = 60000;
const PUSHPLUS_TITLE_MAX_LEN = 96;
const DEFAULT_USER_DATA_DIR = path.resolve(__dirname, ".profiles", "nodeseek-browser-profile");

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

interface WaitForCloudflareOptions {
  maxWaitMs?: number;
  manualMode?: boolean;
}

interface SessionState {
  challengeState: ChallengeState;
  hasReusableSession: boolean;
  usedEnvCookies: boolean;
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
      // Reason: 旧的 cf_clearance 很容易过期，直接注入浏览器会让 Cloudflare 持续卡在挑战页。
      // 让浏览器在当前会话里重新拿一张新的 clearance 更稳定。
      if (name === "cf_clearance") return null;
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBrowserProxyServer(): string {
  const explicitProxy = (process.env.NS_PROXY_SERVER ?? "").trim();
  if (explicitProxy) return explicitProxy;

  const fallbackProxy = (
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy ??
    ""
  ).trim();

  return fallbackProxy;
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

function isCloudflareCookieName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "cf_clearance" || normalized === "__cf_bm" || normalized === "_cfuvid";
}

function hasReusableSessionCookies(cookies: Array<{ name: string }>): boolean {
  if (cookies.length === 0) return false;

  return cookies.some((cookie) => !isCloudflareCookieName(cookie.name));
}

function shouldRefreshProfileFromEnv(
  pageCookies: Array<{ name: string; value: string }>,
  envCookies: CookieParam[]
): boolean {
  if (envCookies.length === 0) return false;

  const pageCookieMap = new Map(pageCookies.map((cookie) => [cookie.name, cookie.value]));
  const envCookieMap = new Map(envCookies.map((cookie) => [cookie.name, cookie.value]));

  const expectedSession = envCookieMap.get("session");
  if (expectedSession) {
    return pageCookieMap.get("session") !== expectedSession;
  }

  return envCookies.some((cookie) => pageCookieMap.get(cookie.name) !== cookie.value);
}

function getManualBootstrapHint(userDataDir: string): string {
  return (
    `Run \`npm run checkin:init\` once to complete Cloudflare/login in a visible browser, ` +
    `then keep using the same profile at ${userDataDir}.`
  );
}

async function waitForReusableSessionCookie(
  page: Page,
  envCookies: CookieParam[],
  maxWaitMs: number
): Promise<boolean> {
  const startTime = Date.now();
  let loginHintShown = false;

  while (Date.now() - startTime < maxWaitMs) {
    const cookies = await page.cookies();
    if (hasReusableSessionCookies(cookies) && !shouldRefreshProfileFromEnv(cookies, envCookies)) {
      return true;
    }

    if (!loginHintShown) {
      console.log(
        "No authenticated NodeSeek session is present yet. If the login page is open, sign in manually in the visible browser window; this script will keep polling."
      );
      loginHintShown = true;
    }

    await sleep(CF_POLL_INTERVAL_MS);
  }

  return false;
}

function looksLikeAuthFailure(status: number, body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    status === 401 ||
    normalized.includes("unauthorized") ||
    normalized.includes("please login") ||
    normalized.includes("please log in") ||
    normalized.includes("sign in") ||
    normalized.includes("登录")
  );
}

function isTransientPageStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("detached frame") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id")
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

async function waitForCloudflareClear(
  page: Page,
  options: WaitForCloudflareOptions = {}
): Promise<ChallengeState> {
  const startTime = Date.now();
  const maxWaitMs = options.maxWaitMs ?? CF_MAX_WAIT_MS;
  let reloaded = false;
  let manualHintShown = false;

  while (Date.now() - startTime < maxWaitMs) {
    let state: ChallengeState;
    try {
      state = await getChallengeState(page);
    } catch (error) {
      if (isTransientPageStateError(error)) {
        console.log(
          `Cloudflare page state changed during polling (${error instanceof Error ? error.message : String(error)}), retrying...`
        );
        await sleep(1000);
        continue;
      }
      throw error;
    }
    console.log(
      `[CF] title="${state.title}" cf_clearance=${state.hasCfClearance} url=${state.url}`
    );

    const combinedText = `${state.title}\n${state.bodySnippet}\n${state.url}`;
    if (!includesChallengeText(combinedText)) {
      return state;
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

    if (options.manualMode && !manualHintShown && elapsedMs >= CF_MAX_WAIT_MS) {
      const remainingSeconds = Math.max(1, Math.ceil((maxWaitMs - elapsedMs) / 1000));
      console.log(
        `Cloudflare challenge is still active. Complete it manually in the opened browser window; the script will keep polling for ${remainingSeconds}s more.`
      );
      manualHintShown = true;
    }

    await sleep(CF_POLL_INTERVAL_MS);
  }

  const finalState = await getChallengeState(page);
  throw new Error(
    `Cloudflare challenge did not clear within ${Math.ceil(maxWaitMs / 1000)}s ` +
      `(title="${finalState.title}", cf_clearance=${finalState.hasCfClearance}, elapsed=${Date.now() - startTime}ms, url=${finalState.url}, ` +
      `snippet="${finalState.bodySnippet}")`
  );
}

async function sendCheckinRequest(page: Page): Promise<PageEvalResult> {
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
  return result;
}

async function applyEnvCookiesToPage(page: Page, cookies: CookieParam[]): Promise<void> {
  if (cookies.length === 0) return;

  console.log("Applying NS_COOKIE to the browser session...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.setCookie(...(cookies as any[]));
}

async function ensureNodeSeekSession(
  page: Page,
  cookies: CookieParam[],
  userDataDir: string,
  allowManualMode: boolean
): Promise<SessionState> {
  const maxWaitMs = allowManualMode
    ? parsePositiveInt(process.env.NS_BOOTSTRAP_WAIT_MS, BOOTSTRAP_MAX_WAIT_MS)
    : CF_MAX_WAIT_MS;
  let usedEnvCookies = false;

  console.log("Navigating to NodeSeek...");
  await page.goto(SITE_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });

  console.log(`Waiting up to ${Math.ceil(maxWaitMs / 1000)}s for Cloudflare to clear...`);
  let challengeState = await waitForCloudflareClear(page, {
    maxWaitMs,
    manualMode: allowManualMode,
  });

  let pageCookies = await page.cookies();
  let hasSession =
    hasReusableSessionCookies(pageCookies) && !shouldRefreshProfileFromEnv(pageCookies, cookies);

  if (shouldRefreshProfileFromEnv(pageCookies, cookies)) {
    console.log(
      "The persistent browser profile does not match the provided NS_COOKIE. Refreshing the profile from NS_COOKIE..."
    );
    await applyEnvCookiesToPage(page, cookies);
    usedEnvCookies = true;
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    challengeState = await waitForCloudflareClear(page, {
      maxWaitMs,
      manualMode: allowManualMode,
    });
    pageCookies = await page.cookies();
    hasSession =
      hasReusableSessionCookies(pageCookies) && !shouldRefreshProfileFromEnv(pageCookies, cookies);
  } else if (!hasSession && cookies.length > 0) {
    console.log(
      "No reusable NodeSeek session was found in the persistent browser profile. Seeding the profile from NS_COOKIE..."
    );
    await applyEnvCookiesToPage(page, cookies);
    usedEnvCookies = true;
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    challengeState = await waitForCloudflareClear(page, {
      maxWaitMs,
      manualMode: allowManualMode,
    });
    pageCookies = await page.cookies();
    hasSession =
      hasReusableSessionCookies(pageCookies) && !shouldRefreshProfileFromEnv(pageCookies, cookies);
  }

  if (!hasSession && allowManualMode) {
    const remainingWaitMs = Math.max(0, maxWaitMs - CF_MAX_WAIT_MS);
    if (remainingWaitMs > 0) {
      hasSession = await waitForReusableSessionCookie(page, cookies, remainingWaitMs);
      if (hasSession) {
        challengeState = await getChallengeState(page);
      }
    }
  }

  if (!hasSession) {
    throw new Error(
      `No reusable NodeSeek session is available in ${userDataDir}. ${getManualBootstrapHint(
        userDataDir
      )}`
    );
  }

  console.log(
    `Page state before API request: title="${challengeState.title}" cf_clearance=${challengeState.hasCfClearance} url=${challengeState.url}`
  );

  return {
    challengeState,
    hasReusableSession: hasSession,
    usedEnvCookies,
  };
}

async function runCheckinAttempt(cookies: CookieParam[]): Promise<CheckinResult> {
  const runHeadful = isTruthyEnv(process.env.NS_HEADFUL);
  const allowManualMode = runHeadful && isTruthyEnv(process.env.NS_MANUAL_CF);
  const proxyServer = getBrowserProxyServer();
  const userDataDir = (process.env.NS_USER_DATA_DIR ?? "").trim() || DEFAULT_USER_DATA_DIR;
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--window-size=1365,900",
  ];

  if (proxyServer) {
    console.log(`Using browser proxy: ${proxyServer}`);
    launchArgs.push(`--proxy-server=${proxyServer}`);
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`Using browser profile: ${userDataDir}`);
  const browser = await puppeteer.launch({
    headless: runHeadful ? false : true,
    args: launchArgs,
    userDataDir,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.setBypassCSP(true);
    await ensureNodeSeekSession(page, cookies, userDataDir, allowManualMode);

    // Reason: 在已通过 Cloudflare 验证的浏览器上下文中发起 fetch，
    // 这样请求会自动携带浏览器里现有的验证/登录态 cookie
    let result = await sendCheckinRequest(page);

    if (looksLikeAuthFailure(result.status, result.body) && cookies.length > 0) {
      console.log(
        "The persisted browser session looks expired. Refreshing the profile from NS_COOKIE and retrying once..."
      );
      await applyEnvCookiesToPage(page, cookies);
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await waitForCloudflareClear(page, {
        maxWaitMs: allowManualMode ? BOOTSTRAP_MAX_WAIT_MS : CF_MAX_WAIT_MS,
        manualMode: allowManualMode,
      });
      result = await sendCheckinRequest(page);
    }

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

    if (looksLikeAuthFailure(result.status, result.body)) {
      throw new Error(
        `NodeSeek session is no longer authenticated. Refresh NS_COOKIE or ${getManualBootstrapHint(
          userDataDir
        )}`
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

async function bootstrapSession(cookies: CookieParam[]): Promise<void> {
  const proxyServer = getBrowserProxyServer();
  const userDataDir = (process.env.NS_USER_DATA_DIR ?? "").trim() || DEFAULT_USER_DATA_DIR;
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--window-size=1365,900",
  ];

  if (proxyServer) {
    console.log(`Using browser proxy: ${proxyServer}`);
    launchArgs.push(`--proxy-server=${proxyServer}`);
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`Using browser profile: ${userDataDir}`);
  console.log(
    "A visible browser window will open. If Cloudflare or the login page appears, finish it manually once; the saved profile will be reused later."
  );

  const browser = await puppeteer.launch({
    headless: false,
    args: launchArgs,
    userDataDir,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.setBypassCSP(true);
    await ensureNodeSeekSession(page, cookies, userDataDir, true);
    console.log("Bootstrap completed. The browser profile is warmed up for future check-ins.");
  } finally {
    await browser.close();
  }
}

async function checkin(): Promise<void> {
  console.log("=== NodeSeek Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const cookieStr = process.env.NS_COOKIE ?? "";
  const cookies = cookieStr ? parseCookies(cookieStr) : [];
  console.log(`Parsed ${cookies.length} cookies`);

  if (isTruthyEnv(process.env.NS_BOOTSTRAP)) {
    console.log(
      "Bootstrap mode enabled. A visible browser session will be opened so you can finish Cloudflare/login once and reuse the saved profile later."
    );
    await bootstrapSession(cookies);
    return;
  }

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
