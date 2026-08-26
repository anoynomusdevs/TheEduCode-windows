# JavaScript Obfuscator Toolkit

A dual-mode JavaScript obfuscation toolkit supporting both **cloud** (ByteHide) and **local** (javascript-obfuscator) engines.

## Quick Start

```bash
# Node.js version (recommended)
node /home/anon/obfuscate.js --bytehide 'const hello = () => console.log("test");'
node /home/anon/obfuscate.js --local  'const hello = () => console.log("test");'

# Shell wrapper (requires jq for ByteHide mode)
/home/anon/obfuscate.sh --bytehide 'const hello = () => console.log("test");'
/home/anon/obfuscate.sh --local  'const hello = () => console.log("test");'

# Read from stdin
echo 'const hello = () => console.log("test");' | node /home/anon/obfuscate.js --local
echo 'const hello = () => console.log("test");' | /home/anon/obfuscate.sh --bytehide
```

## Modes Comparison

| Feature | `--bytehide` (Cloud) | `--local` (Offline) |
|---------|---------------------|---------------------|
| **Engine** | ByteHide Shield API | `javascript-obfuscator` npm package |
| **Network** | Required | None |
| **Speed** | ~500-2000ms | ~50-200ms |
| **Options** | Fixed (server-side) | Fully configurable |
| **Output** | Strong, unique per call | Deterministic with same options |
| **Rate Limits** | Unknown (free tier) | None |
| **Privacy** | Code sent to ByteHide | Never leaves machine |

## ByteHide API Details

- **Endpoint**: `https://node.shield.bytehide.com/obfuscate`
- **Origin**: `https://bytehide.com`
- **Referer**: `https://bytehide.com/`
- **Playground**: https://bytehide.com/platform/shield/obfuscation/free-javascript-obfuscator

The API returns heavily obfuscated code with:
- Control flow flattening
- String array encoding (RC4)
- Dead code injection
- Self-defending wrappers
- Hexadecimal identifier names

## Local Obfuscator Options

Based on [obfuscator.io legacy playground](https://obfuscator.io/legacy-playground) defaults:

```javascript
{
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: true,
  identifierNamesGenerator: "hexadecimal",
  log: false,
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ["rc4"],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
}
```

### Customizing Local Options

```javascript
const { obfuscateLocal } = require('./obfuscate.js');

const customOptions = {
  controlFlowFlatteningThreshold: 1,
  deadCodeInjectionThreshold: 1,
  stringArrayEncoding: ['base64', 'rc4'],
  identifierNamesGenerator: 'mangled',
};

const result = await obfuscateLocal(code, customOptions);
```

## File Structure

```
/home/anon/
├── obfuscate.js          # Node.js dual-mode client (ESM)
├── obfuscate.sh          # Shell wrapper (requires jq + node)
├── package.json          # npm dependencies
└── node_modules/         # javascript-obfuscator installed here
```

## Dependencies

```bash
# Node.js (for both modes)
node >= 18  (for native fetch)

# Shell wrapper only
jq          # JSON parsing
curl        # HTTP requests

# Local mode only (installed via npm)
npm install javascript-obfuscator
```

## Examples

### Obfuscate a file
```bash
node /home/anon/obfuscate.js --local < input.js > output.js
```

### Batch obfuscate
```bash
for f in *.js; do
  node /home/anon/obfuscate.js --local < "$f" > "dist/$f"
done
```

### Use in CI/CD
```yaml
# .github/workflows/obfuscate.yml
- name: Obfuscate JS
  run: |
    npm install javascript-obfuscator
    node obfuscate.js --local < src/app.js > dist/app.js
```

## API Reference

### Node.js Module Usage

```javascript
import { obfuscateBytehide, obfuscateLocal } from './obfuscate.js';

// ByteHide (async)
const cloudResult = await obfuscateBytehide(sourceCode);

// Local (async)
const localResult = await obfuscateLocal(sourceCode, {
  controlFlowFlattening: true,
  stringArrayEncoding: ['rc4'],
});
```

### Shell Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (no input, network, or obfuscation failure) |

## Notes

- **ByteHide mode**: Each request produces different output (non-deterministic). Good for avoiding pattern detection.
- **Local mode**: Deterministic with same options. Better for reproducible builds.
- **Self-defending**: Both modes include anti-tampering. Obfuscated code breaks if modified.
- **Source maps**: Neither mode generates source maps (intentional).

## References

- [ByteHide Free Obfuscator](https://bytehide.com/platform/shield/obfuscation/free-javascript-obfuscator)
- [javascript-obfuscator GitHub](https://github.com/javascript-obfuscator/javascript-obfuscator)
- [obfuscator.io Legacy Playground](https://obfuscator.io/legacy-playground)