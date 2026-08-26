#!/usr/bin/env node
/**
 * Local JavaScript Obfuscator - Offline Mode
 * Uses javascript-obfuscator npm package
 * 
 * Usage: 
 *   node obfuscate-local.js "code here"
 *   echo "code" | node obfuscate-local.js
 */

// Default options matching obfuscator.io legacy playground
const LOCAL_OPTIONS = {
  compact: true,
  simplify: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.15,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.05,
  debugProtection: false,
  disableConsoleOutput: true,
  identifierNamesGenerator: "hexadecimal",
  log: false,
  renameGlobals: true,
  rotateStringArray: true,
  selfDefending: false,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 30,
  stringArray: true,
  stringArrayEncoding: [],
  stringArrayThreshold: 0.85,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: "variable",
  stringArrayWrappersChainedCalls: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

let JavaScriptObfuscator;

async function loadLocalObfuscator() {
  if (!JavaScriptObfuscator) {
    JavaScriptObfuscator = (await import("javascript-obfuscator")).default;
  }
  return JavaScriptObfuscator;
}

async function obfuscateLocal(code, options = {}) {
  const Obfuscator = await loadLocalObfuscator();
  const mergedOptions = { ...LOCAL_OPTIONS, ...options };
  const result = Obfuscator.obfuscate(code, mergedOptions);
  return result.getObfuscatedCode();
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
    console.error("Usage: node obfuscate-local.js \"code here\"");
    process.exit(1);
  }

  try {
    const result = await obfuscateLocal(code);
    console.log(result);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();