import https from "https";

const CHECKIN_URL = "https://up.x666.me/api/checkin/spin";
const PUSHPLUS_API = "https://www.pushplus.plus/send";

interface CheckinResponseData {
  success?: boolean;
  code?: number;
  message?: string;
  msg?: string;
  error?: string;
  level?: number;
  times?: number;
  quota?: number;
  label?: string;
  new_balance?: number;
}

function normalizeToken(token: string): string {
  const trimmed = token.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return "";
  // Reason: strip "Bearer " prefix if user accidentally includes it in the env var
  if (/^bearer\s+/i.test(trimmed)) return trimmed.replace(/^bearer\s+/i, "").trim();
  return trimmed;
}

async function checkin(): Promise<void> {
  const token = normalizeToken(process.env.X666_TOKEN ?? "");
  if (!token) {
    console.error("ERROR: X666_TOKEN is not set.");
    process.exit(1);
  }

  console.log("=== x666 Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const checkinRes = await fetch(CHECKIN_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://up.x666.me",
      Referer: "https://up.x666.me/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
  });

  const checkinText = await checkinRes.text();
  console.log(`HTTP Status: ${checkinRes.status}`);
  console.log(`Response: ${checkinText}`);

  let title: string;
  const contentLines: string[] = [];
  let failed = false;

  // Reason: this API returns JSON body even on 400 (e.g. "今日已签到"),
  // so always try to parse the body before deciding success/failure
  let data: CheckinResponseData | null = null;
  try {
    data = JSON.parse(checkinText) as CheckinResponseData;
  } catch {
    // non-JSON response
  }

  const rawMsg =
    data?.message ?? data?.msg ?? data?.error ?? (typeof data === "string" ? data : "");
  const checkinMessage = typeof rawMsg === "string" ? rawMsg : "";
  const alreadyCheckedIn =
    checkinMessage.includes("已签到") || checkinMessage.includes("already");

  if (checkinRes.status === 401) {
    title = "x666签到失败: 凭证失效(401)";
    contentLines.push(`Check-in HTTP: 401`);
    contentLines.push(checkinText);
    contentLines.push("");
    contentLines.push("Hint: 401 indicates token is invalid or expired. Refresh X666_TOKEN.");
    failed = true;
  } else if (data && alreadyCheckedIn) {
    // Reason: "今日已签到" returns 400 + success:false, treat as soft success
    title = `x666签到: ${checkinMessage}`;
    contentLines.push(`Check-in: ${checkinMessage}`);
    if (typeof data.new_balance === "number") {
      contentLines.push(`Balance: ${data.new_balance}`);
    }
  } else if (data?.success) {
    title = `x666签到成功${checkinMessage ? `: ${checkinMessage}` : ""}`;
    contentLines.push(`Check-in: ${checkinMessage || "success"}`);
    if (typeof data.quota === "number") contentLines.push(`Quota: ${data.quota}`);
    if (typeof data.new_balance === "number") contentLines.push(`Balance: ${data.new_balance}`);
    if (data.label) contentLines.push(`Label: ${data.label}`);
    if (typeof data.times === "number") contentLines.push(`Times: ${data.times}`);
    if (typeof data.level === "number") contentLines.push(`Level: ${data.level}`);
  } else if (!checkinRes.ok) {
    title = `x666签到失败: HTTP ${checkinRes.status}`;
    contentLines.push(`Check-in HTTP: ${checkinRes.status}`);
    contentLines.push(checkinText);
    failed = true;
  } else {
    title = `x666签到: ${checkinMessage || "未知响应"}`;
    contentLines.push(`Check-in: ${checkinMessage || checkinText}`);
    if (data && typeof data.success === "boolean" && !data.success) {
      failed = true;
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
  await notify(`x666签到异常: ${err.message}`, err.stack ?? "");
  process.exit(1);
});
