import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import https from "https";
import os from "os";
import path from "path";
import { promisify } from "util";

const BASE_URL = "https://signv.ice.v.ua";
const CHECKIN_URL = `${BASE_URL}/checkin?next=/embed`;
const DEFAULT_REFERER_URL = `${BASE_URL}/embed`;
const PUSHPLUS_API = "https://www.pushplus.plus/send";
const PUSHPLUS_TITLE_MAX_LEN = 96;
const CURL_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const execFileAsync = promisify(execFile);

interface ParsedResponse {
  summary: string;
  bodySnippet: string;
}

interface CurlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface EmbedStatus {
  ok: boolean;
  title: string;
  summary: string;
  bodySnippet: string;
  alreadyCheckedIn: boolean;
}

function normalizeSession(raw: string): string {
  const trimmed = raw.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return "";
  return trimmed.startsWith("session=") ? trimmed.slice("session=".length) : trimmed;
}

function buildCookieHeader(): string {
  const rawCookie = (process.env.ICEVUA_COOKIE ?? "").trim();
  if (rawCookie) return rawCookie.replace(/^cookie:\s*/i, "");

  const session = normalizeSession(process.env.ICEVUA_SESSION ?? "");
  return session ? `session=${session}` : "";
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  return cleanText(decodeHtmlEntities(withoutTags));
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(decodeHtmlEntities(match[1])) : "";
}

function extractSummaryFromJson(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const candidates = [
      data.message,
      data.msg,
      data.error,
      typeof data.data === "string" ? data.data : "",
      typeof data.detail === "string" ? data.detail : "",
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && cleanText(candidate)) {
        return cleanText(candidate);
      }
    }
  } catch {
    // ignore parse errors
  }

  return "";
}

function parseResponse(text: string, contentType: string): ParsedResponse {
  const bodySnippet = cleanText(
    (contentType.includes("html") ? stripHtml(text) : text).slice(0, 500)
  );
  const jsonSummary = extractSummaryFromJson(text);
  if (jsonSummary) {
    return { summary: jsonSummary, bodySnippet };
  }

  if (contentType.includes("html")) {
    const title = extractHtmlTitle(text);
    if (title && title.toLowerCase() !== "redirecting...") {
      return { summary: title, bodySnippet };
    }
  }

  return { summary: bodySnippet, bodySnippet };
}

function includesAny(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

function isAlreadyCheckedIn(text: string): boolean {
  return includesAny(text, ["已签到", "already checked", "already signed", "already claimed"]);
}

function isSuccessLike(text: string): boolean {
  return includesAny(text, ["签到成功", "check-in successful", "check in successful", "success"]);
}

function isAuthFailureText(text: string): boolean {
  return includesAny(text, [
    "登录",
    "log in",
    "login",
    "sign in",
    "unauthorized",
    "forbidden",
    "expired",
    "csrf",
    "invalid session",
  ]);
}

function isLoginRedirect(location: string): boolean {
  return includesAny(location, ["/login", "/signin", "/auth"]);
}

function shortenTitle(title: string): string {
  return title.length > PUSHPLUS_TITLE_MAX_LEN
    ? `${title.slice(0, PUSHPLUS_TITLE_MAX_LEN - 3)}...`
    : title;
}

function parseHeaderBlocks(rawHeaders: string): CurlResponse["headers"][] {
  const normalized = rawHeaders.replace(/\r\n/g, "\n");
  const blocks = normalized
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("HTTP/"));

  return blocks.map((block) => {
    const lines = block.split("\n").filter(Boolean);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      headers[key] = value;
    }
    return headers;
  });
}

function parseStatus(rawHeaders: string): number {
  const normalized = rawHeaders.replace(/\r\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^HTTP\/\d(?:\.\d)? \d{3}\b/.test(line));

  const last = lines[lines.length - 1] ?? "";
  const match = last.match(/^HTTP\/\d(?:\.\d)? (\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

async function runCurl(args: string[]): Promise<CurlResponse> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "icevua-"));
  const headersPath = path.join(tempDir, "headers.txt");
  const bodyPath = path.join(tempDir, "body.txt");

  try {
    await execFileAsync("curl", ["-sS", "-D", headersPath, "-o", bodyPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  try {
    const [rawHeaders, body] = await Promise.all([
      readFile(headersPath, "utf8"),
      readFile(bodyPath, "utf8"),
    ]);
    const headerBlocks = parseHeaderBlocks(rawHeaders);
    return {
      status: parseStatus(rawHeaders),
      headers: headerBlocks[headerBlocks.length - 1] ?? {},
      body,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildBaseCurlHeaders(cookieHeader: string, referer: string): string[] {
  return [
    "-H",
    "accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "-H",
    "accept-language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "-H",
    "cache-control: no-cache",
    "-H",
    "pragma: no-cache",
    "-H",
    "priority: u=0, i",
    "-H",
    `referer: ${referer}`,
    "-H",
    'sec-ch-ua: "Not-A.Brand";v="24", "Chromium";v="146"',
    "-H",
    "sec-ch-ua-mobile: ?0",
    "-H",
    'sec-ch-ua-platform: "macOS"',
    "-H",
    "upgrade-insecure-requests: 1",
    "-H",
    `user-agent: ${CURL_USER_AGENT}`,
    "-b",
    cookieHeader,
  ];
}

async function runCheckinCurl(cookieHeader: string, referer: string): Promise<CurlResponse> {
  return runCurl([
    CHECKIN_URL,
    "-X",
    "POST",
    "-H",
    "content-length: 0",
    "-H",
    "content-type: application/x-www-form-urlencoded",
    "-H",
    `origin: ${BASE_URL}`,
    "-H",
    "sec-fetch-dest: iframe",
    "-H",
    "sec-fetch-mode: navigate",
    "-H",
    "sec-fetch-site: same-origin",
    "-H",
    "sec-fetch-user: ?1",
    ...buildBaseCurlHeaders(cookieHeader, referer),
  ]);
}

async function fetchEmbedStatus(cookieHeader: string, referer: string): Promise<EmbedStatus> {
  const response = await runCurl([
    referer,
    "-H",
    "sec-fetch-dest: iframe",
    "-H",
    "sec-fetch-mode: navigate",
    "-H",
    "sec-fetch-site: same-origin",
    ...buildBaseCurlHeaders(cookieHeader, referer),
  ]);

  const title = extractHtmlTitle(response.body);
  const plainText = stripHtml(response.body);
  const summary = cleanText(title || plainText.slice(0, 200));

  return {
    ok: response.status >= 200 && response.status < 300,
    title,
    summary,
    bodySnippet: cleanText(plainText.slice(0, 500)),
    alreadyCheckedIn: plainText.includes("今日已签到") || isAlreadyCheckedIn(plainText),
  };
}

async function checkin(): Promise<void> {
  const cookieHeader = buildCookieHeader();
  if (!cookieHeader) {
    console.error("ERROR: ICEVUA_COOKIE or ICEVUA_SESSION is not set.");
    process.exit(1);
  }

  const referer = (process.env.ICEVUA_REFERER ?? DEFAULT_REFERER_URL).trim() || DEFAULT_REFERER_URL;

  console.log("=== ice.v.ua Check-in ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Auth: ${process.env.ICEVUA_COOKIE ? "cookie" : "session"}`);
  console.log(`Referer: ${referer}`);

  const initialEmbed = await fetchEmbedStatus(cookieHeader, referer);
  if (initialEmbed.ok && initialEmbed.alreadyCheckedIn) {
    const title = `ice.v.ua签到: 今日已签到`;
    const contentLines = [
      "Check-in: already checked in",
      initialEmbed.summary,
      initialEmbed.bodySnippet,
    ].filter(Boolean);

    console.log(`Notify title: ${title}`);
    await notify(shortenTitle(title), contentLines.join("\n"));
    return;
  }

  const res = await runCheckinCurl(cookieHeader, referer);
  const responseText = res.body;
  const location = res.headers.location ?? "";
  const contentType = res.headers["content-type"] ?? "";
  const parsed = parseResponse(responseText, contentType);

  console.log(`HTTP Status: ${res.status}`);
  if (location) console.log(`Location: ${location}`);
  if (parsed.summary) console.log(`Summary: ${parsed.summary}`);
  if (parsed.bodySnippet) console.log(`Body: ${parsed.bodySnippet}`);

  const signalText = `${location}\n${parsed.summary}\n${parsed.bodySnippet}`;

  let title: string;
  const contentLines: string[] = [];
  let failed = false;

  let embedFallback: EmbedStatus | null = null;
  if (res.status >= 400) {
    try {
      embedFallback = await fetchEmbedStatus(cookieHeader, referer);
    } catch {
      embedFallback = null;
    }
  }

  if (res.status === 401 || res.status === 403 || isLoginRedirect(location) || isAuthFailureText(signalText)) {
    title = `ice.v.ua签到失败: 凭证失效${res.status ? ` (HTTP ${res.status})` : ""}`;
    failed = true;
  } else if (embedFallback?.alreadyCheckedIn) {
    title = "ice.v.ua签到: 今日已签到";
  } else if (isAlreadyCheckedIn(signalText)) {
    title = `ice.v.ua签到: ${parsed.summary || "今日已签到"}`;
  } else if ((res.status >= 200 && res.status < 400) || isSuccessLike(signalText)) {
    title = `ice.v.ua签到成功${parsed.summary ? `: ${parsed.summary}` : ""}`;
  } else {
    title = `ice.v.ua签到失败: HTTP ${res.status}`;
    failed = true;
  }

  contentLines.push(`Check-in HTTP: ${res.status}`);
  if (location) contentLines.push(`Location: ${location}`);
  if (parsed.summary) contentLines.push(`Summary: ${parsed.summary}`);
  if (parsed.bodySnippet) contentLines.push(parsed.bodySnippet);
  if (embedFallback) {
    contentLines.push("");
    contentLines.push(`Embed HTTP: ${embedFallback.ok ? 200 : "non-200"}`);
    if (embedFallback.summary) contentLines.push(`Embed Summary: ${embedFallback.summary}`);
    if (embedFallback.bodySnippet) contentLines.push(embedFallback.bodySnippet);
  }

  console.log(`Notify title: ${title}`);
  await notify(shortenTitle(title), contentLines.join("\n"));
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
  await notify(shortenTitle(`ice.v.ua签到异常: ${err.message}`), err.stack ?? "");
  process.exit(1);
});
