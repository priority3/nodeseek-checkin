const https = require("https");

const CHECKIN_URL = "https://hotaruapi.com/api/user/checkin";
const SELF_URL = "https://hotaruapi.com/api/user/self";
const REFERER_URL = "https://hotaruapi.com/console/personal";
const CONSOLE_URL = "https://hotaruapi.com/console";
const PUSHPLUS_API = "https://www.pushplus.plus/send";

// Observed mapping from console display: quota / 500000 = USD (6 decimals)
const QUOTA_PER_USD = 500000;

function parseCookieValue(cookieStr, key) {
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

function buildCookieHeader({ cookie, session, userId }) {
  if (cookie) return cookie.trim();

  const s = (session || "").trim();
  const u = (userId || "").trim();
  if (!s || !u) return "";

  const sessionPair = s.startsWith("session=") ? s : `session=${s}`;
  const userPair = u.startsWith("new-api-user=") ? u : `new-api-user=${u}`;
  return `${sessionPair}; ${userPair}`;
}

function formatNumber(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function quotaToUsd(quota) {
  if (typeof quota !== "number" || Number.isNaN(quota)) return "";
  return (quota / QUOTA_PER_USD).toFixed(6);
}

async function fetchSelf({ cookieHeader, userId }) {
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
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // ignore
  }

  return { status: res.status, text, data };
}

async function checkin() {
  const userIdFromEnv = (process.env.HOTARU_USER || "").trim();

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

  const checkinRes = await fetch(CHECKIN_URL, {
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
  });

  const checkinText = await checkinRes.text();

  console.log(`HTTP Status: ${checkinRes.status}`);
  console.log(`Response: ${checkinText}`);

  let title;
  const contentLines = [];
  let failed = false;
  let awardQuota = null;
  let checkinDate = "";
  let checkinMessage = "";

  if (!checkinRes.ok) {
    title = `HotaruAPI签到失败: HTTP ${checkinRes.status}`;
    contentLines.push(`Check-in HTTP: ${checkinRes.status}`);
    contentLines.push(checkinText);
    failed = true;
  } else {
    try {
      const data = JSON.parse(checkinText);
      const msg =
        data?.message ||
        data?.msg ||
        data?.error ||
        (typeof data === "string" ? data : "");
      checkinMessage = typeof msg === "string" ? msg : "";

      if (typeof data?.success === "boolean" && !data.success) {
        const alreadyCheckedIn =
          typeof msg === "string" &&
          (msg.includes("已签到") || msg.includes("already"));
        title = `HotaruAPI签到: ${msg || "失败"}`;
        contentLines.push(`Check-in: ${msg || "failed"}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        const alreadyCheckedIn =
          typeof msg === "string" &&
          (msg.includes("已签到") || msg.includes("already"));
        title = `HotaruAPI签到: ${msg || `code=${data.code}`}`;
        contentLines.push(`Check-in: ${msg || `code=${data.code}`}`);
        contentLines.push(checkinText);
        failed = !alreadyCheckedIn;
      } else {
        const award =
          typeof data?.data?.quota_awarded === "number"
            ? data.data.quota_awarded
            : null;
        const date =
          typeof data?.data?.checkin_date === "string"
            ? data.data.checkin_date
            : "";
        awardQuota = award;
        checkinDate = date;

        const awardUsd = award === null ? "" : quotaToUsd(award);

        title = `HotaruAPI签到成功${
          award === null
            ? ""
            : ` +${formatNumber(award)} (≈$${awardUsd})`
        }${date ? ` (${date})` : ""}${msg ? `: ${msg}` : ""}`;

        contentLines.push(`Check-in: ${msg || "success"}`);
        if (award !== null) {
          contentLines.push(
            `Awarded: ${formatNumber(award)} quota (≈$${awardUsd})`
          );
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

  let selfInfo = null;
  try {
    selfInfo = await fetchSelf({ cookieHeader, userId });
  } catch (err) {
    selfInfo = { status: 0, text: err.message, data: null };
  }

  const selfQuota = selfInfo?.data?.data?.quota;
  const selfUsedQuota = selfInfo?.data?.data?.used_quota;

  if (typeof selfQuota === "number") {
    const balanceUsd = quotaToUsd(selfQuota);
    title = `${title} | 余额≈$${balanceUsd}`;

    contentLines.push("");
    contentLines.push("Balance:");
    contentLines.push(
      `Quota: ${formatNumber(selfQuota)} (≈$${balanceUsd})`
    );
    if (typeof selfUsedQuota === "number") {
      const usedUsd = quotaToUsd(selfUsedQuota);
      contentLines.push(
        `Used: ${formatNumber(selfUsedQuota)} (≈$${usedUsd})`
      );
    }
  } else {
    contentLines.push("");
    contentLines.push(
      `Balance fetch failed: HTTP ${selfInfo?.status || "unknown"}`
    );
    if (selfInfo?.text) contentLines.push(selfInfo.text);
  }

  console.log(`Notify title: ${title}`);
  await notify(title, contentLines.join("\n"));
  if (failed) process.exit(1);
}

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
  await notify(`HotaruAPI签到异常: ${err.message}`, err.stack);
  process.exit(1);
});
