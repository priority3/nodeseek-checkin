const https = require("https");

const CHECKIN_URL = "https://hotaruapi.com/api/user/checkin";
const REFERER_URL = "https://hotaruapi.com/console/personal";
const PUSHPLUS_API = "https://www.pushplus.plus/send";

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
  });

  const text = await res.text();

  console.log(`HTTP Status: ${res.status}`);
  console.log(`Response: ${text}`);

  let title;
  let body;
  let failed = false;

  if (!res.ok) {
    title = `HotaruAPI签到失败: HTTP ${res.status}`;
    body = text;
    failed = true;
  } else {
    try {
      const data = JSON.parse(text);
      const msg =
        data?.message ||
        data?.msg ||
        data?.error ||
        (typeof data === "string" ? data : "");

      if (typeof data?.success === "boolean" && !data.success) {
        const alreadyCheckedIn =
          typeof msg === "string" && (msg.includes("已签到") || msg.includes("already"));
        title = `HotaruAPI签到: ${msg || "失败"}`;
        body = text;
        failed = !alreadyCheckedIn;
      } else if (typeof data?.code === "number" && data.code !== 0) {
        const alreadyCheckedIn =
          typeof msg === "string" && (msg.includes("已签到") || msg.includes("already"));
        title = `HotaruAPI签到: ${msg || `code=${data.code}`}`;
        body = text;
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

        title = `HotaruAPI签到成功${
          award === null ? "" : ` +${award}`
        }${date ? ` (${date})` : ""}${msg ? `: ${msg}` : ""}`;
        body = text;
      }
    } catch {
      // Some APIs return plain text even on 200
      title = "HotaruAPI签到成功";
      body = text;
    }
  }

  await notify(title, body);
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
