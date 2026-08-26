# ByteHide JavaScript Obfuscator

Cloud-based obfuscation via ByteHide Shield API.

## Endpoint
```
https://node.shield.bytehide.com/obfuscate
```

## Usage

```bash
# Node.js version
node /home/anon/bytehide/obfuscate-bytehide.js 'const hello = () => console.log("test");'

# Shell wrapper (requires jq)
/home/anon/bytehide/obfuscate-bytehide.sh 'const hello = () => console.log("test");'

# Stdin
echo 'const hello = () => console.log("test");' | node /home/anon/bytehide/obfuscate-bytehide.js
```

## Files
- `obfuscate-bytehide.js` - Node.js client (native fetch)
- `obfuscate-bytehide.sh` - Shell wrapper (curl + jq)

## Playground
https://bytehide.com/platform/shield/obfuscation/free-javascript-obfuscator