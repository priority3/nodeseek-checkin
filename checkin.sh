#!/usr/bin/env bash
# NodeSeek 每日自动签到脚本
# 通过 GitHub Secrets 中的 NS_COOKIE 进行身份认证

set -euo pipefail

if [ -z "${NS_COOKIE:-}" ]; then
  echo "ERROR: NS_COOKIE is not set. Please configure it in GitHub Secrets."
  exit 1
fi

CHECKIN_URL="https://www.nodeseek.com/api/attendance?random=true"

echo "=== NodeSeek Check-in ==="
echo "Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Reason: random=true 表示使用随机签到方式（NodeSeek 支持 random 和固定两种模式）
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  "$CHECKIN_URL" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" \
  -H "Accept: application/json, text/plain, */*" \
  -H "Origin: https://www.nodeseek.com" \
  -H "Referer: https://www.nodeseek.com/board" \
  -H "Cookie: $NS_COOKIE")

# Reason: curl -w 将 HTTP 状态码追加到最后一行，需要分别提取
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"

# 判断签到结果
if echo "$BODY" | grep -q '"success"'; then
  echo "Check-in succeeded!"
elif echo "$BODY" | grep -q '"message"'; then
  # Reason: 已签到的情况下接口也会返回 message 字段，提取具体信息
  MSG=$(echo "$BODY" | grep -o '"message":"[^"]*"' | head -1)
  echo "Check-in result: $MSG"
else
  echo "Check-in may have failed. Please verify manually."
  exit 1
fi
