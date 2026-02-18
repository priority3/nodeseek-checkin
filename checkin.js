const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Reason: stealth 插件修补了多个浏览器指纹特征，降低被 Cloudflare 检测为自动化的概率
puppeteer.use(StealthPlugin());

const https = require("https");

const CHECKIN_URL = "https://www.nodeseek.com/api/attendance?random=true";
const SITE_URL = "https://www.nodeseek.com/board";
const PUSHPLUS_API = "https://www.pushplus.plus/send";
const CF_WAIT_MS = 15000;
const NAV_TIMEOUT_MS = 60000;

/**
 * 将 cookie 字符串解析为 Puppeteer 可用的 cookie 对象数组
 */
function parseCookies(cookieStr) {
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
    .filter(Boolean);
}

async function checkin() {
  const cookieStr = process.env.NS_COOKIE;
  if (!cookieStr) {
    console.error("ERROR: NS_COOKIE is not set.");
    process.exit(1);
  }

  console.log("=== NodeSeek Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const cookies = parseCookies(cookieStr);
  console.log(`Parsed ${cookies.length} cookies`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    );

    // Reason: 先设置 cookie 再导航，这样 session cookie 会随首次请求一起发送
    await page.setCookie(...cookies);

    console.log("Navigating to NodeSeek...");
    await page.goto(SITE_URL, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });

    // Reason: Cloudflare managed challenge 需要时间执行 JS 并完成验证
    console.log(`Waiting ${CF_WAIT_MS / 1000}s for Cloudflare to clear...`);
    await new Promise((r) => setTimeout(r, CF_WAIT_MS));

    // 检查是否仍在 Cloudflare challenge 页面
    const pageTitle = await page.title();
    console.log(`Page title: ${pageTitle}`);

    if (pageTitle.includes("Just a moment")) {
      console.error("Failed to pass Cloudflare challenge.");
      process.exit(1);
    }

    // Reason: 在已通过 Cloudflare 验证的浏览器上下文中发起 fetch，
    // 这样请求会自动携带 cf_clearance cookie 和正确的浏览器指纹
    console.log("Sending check-in request...");
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json, text/plain, */*" },
        });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { status: 0, body: err.message };
      }
    }, CHECKIN_URL);

    console.log(`HTTP Status: ${result.status}`);
    console.log(`Response: ${result.body}`);

    // 解析结果并构建通知标题
    let title;
    let body;
    let failed = false;

    try {
      const data = JSON.parse(result.body);
      if (data.success) {
        title = `[nodeseek-checkin] NodeSeek签到成功 +${data.gain}鸡腿 (总计${data.current})`;
        body = data.message;
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

    await notify(title, body);
    if (failed) process.exit(1);
  } finally {
    await browser.close();
  }
}

/**
 * 通过 PushPlus 发送微信通知
 * Reason: 将签到结果放在 title 中，微信通知可以直接看到结果无需点开
 */
function notify(title, content) {
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          console.log(`PushPlus response: ${data}`);
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      console.error(`PushPlus notify failed: ${err.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

checkin().catch(async (err) => {
  console.error("Fatal error:", err.message);
  await notify(`[nodeseek-checkin] NodeSeek签到异常: ${err.message}`, err.stack);
  process.exit(1);
});
