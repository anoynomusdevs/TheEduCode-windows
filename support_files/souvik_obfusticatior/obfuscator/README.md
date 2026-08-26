# Local JavaScript Obfuscator

Offline obfuscation using [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) npm package.
Options match [obfuscator.io legacy playground](https://obfuscator.io/legacy-playground).

## Usage

```bash
# Node.js version
node /home/anon/obfuscator/obfuscate-local.js 'const hello = () => console.log("test");'

# Shell wrapper
/home/anon/obfuscator/obfuscate-local.sh 'const hello = () => console.log("test");'

# Stdin
echo 'const hello = () => console.log("test");' | node /home/anon/obfuscator/obfuscate-local.js
```

## Files
- `obfuscate-local.js` - Node.js client (ESM, requires `javascript-obfuscator` package)
- `obfuscate-local.sh` - Shell wrapper (requires node + npm package)
- `package.json` / `node_modules/` - npm dependencies

## Default Options
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

## Custom Options (Node.js)
```javascript
import { obfuscateLocal } from './obfuscate-local.js';

const result = await obfuscateLocal(code, {
  controlFlowFlatteningThreshold: 1,
  stringArrayEncoding: ['base64', 'rc4'],
  identifierNamesGenerator: 'mangled',
});
```

## References
- [javascript-obfuscator GitHub](https://github.com/javascript-obfuscator/javascript-obfuscator)
- [obfuscator.io Legacy Playground](https://obfuscator.io/legacy-playground)