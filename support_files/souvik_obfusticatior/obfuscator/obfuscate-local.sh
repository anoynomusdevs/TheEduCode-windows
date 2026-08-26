#!/usr/bin/env bash
# Local JavaScript Obfuscator - Offline Mode
# Uses javascript-obfuscator npm package
#
# Usage: 
#   obfuscate-local.sh "code here"
#   echo "code" | obfuscate-local.sh

set -euo pipefail

# Read code from arg or stdin
if [[ $# -gt 0 ]]; then
    CODE="$1"
else
    CODE=$(cat)
fi

if [[ -z "${CODE// }" ]]; then
    echo "Error: No code provided" >&2
    echo "Usage: $0 \"code here\"" >&2
    exit 1
fi

# Use local javascript-obfuscator via node (run from package dir)
node -e "
const JavaScriptObfuscator = require('/home/anon/obfuscator/node_modules/javascript-obfuscator');
const options = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: true,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};
const code = process.argv[1];
const result = JavaScriptObfuscator.obfuscate(code, options);
console.log(result.getObfuscatedCode());
" "$CODE"