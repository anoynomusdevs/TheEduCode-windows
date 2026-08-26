#!/usr/bin/env node
/**
 * ByteHide JavaScript Obfuscator - Cloud API
 * Directly calls https://node.shield.bytehide.com/obfuscate
 * 
 * Usage: 
 *   node obfuscate-bytehide.js "code here"
 *   echo "code" | node obfuscate-bytehide.js
 */

const API_URL = "https://node.shield.bytehide.com/obfuscate";

const HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  "origin": "https://bytehide.com",
  "referer": "https://bytehide.com/",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
};

async function obfuscateBytehide(code) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error(`ByteHide API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.output;
}

async function main() {
  const args = process.argv.slice(2);

  let code;
  if (args.length > 0) {
    code = args.join(" ");
  } else {
    code = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (chunk) => data += chunk);
      process.stdin.on("end", () => resolve(data));
    });
  }

  if (!code.trim()) {
    console.error("Error: No code provided");
    console.error("Usage: node obfuscate-bytehide.js \"code here\"");
    process.exit(1);
  }

  try {
    const result = await obfuscateBytehide(code);
    console.log(result);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();