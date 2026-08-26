const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const bytenode = require('bytenode');
const { buildSync } = require('esbuild');

console.log("1. Bundling code with esbuild...");
buildSync({
  entryPoints: ['main.js'],
  bundle: true,
  platform: 'node',
  target: 'node16',
  external: ['electron', 'child_process', 'fs', 'path', 'os', 'crypto', 'bytenode'],
  outfile: 'bundle.js',
});

// Save original copy
fs.copyFileSync('bundle.js', 'bundle.original.js');
console.log("✅ Saved un-obfuscated bundle to bundle.original.js");

let code = fs.readFileSync('bundle.js', 'utf8');

function runObfuscator(scriptPath, inputCode) {
  try {
    const result = execSync(`node "${scriptPath}"`, {
      input: inputCode,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 100 // 100MB buffer
    });
    return result;
  } catch (err) {
    console.error("Obfuscation failed at", path.basename(scriptPath));
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

const bytehidePath = path.join(__dirname, 'souvik_obfusticatior', 'bytehide', 'obfuscate-bytehide.js');
const localPath = path.join(__dirname, 'souvik_obfusticatior', 'obfuscator', 'obfuscate-local.js');

console.log("2. Pass 1: Local Obfuscation (1/3)...");
code = runObfuscator(localPath, code);

console.log("3. Pass 2: Local Obfuscation (2/3)...");
code = runObfuscator(localPath, code);

console.log("4. Pass 3: ByteHide Obfuscation...");
code = runObfuscator(bytehidePath, code);

console.log("5. Pass 4: Local Obfuscation (3/3)...");
code = runObfuscator(localPath, code);

fs.writeFileSync('bundle.js', code);

console.log("7. Compiling with bytenode...");
bytenode.compileFile('bundle.js', 'main.jsc')
  .then(() => {
    console.log("✅ Build complete! main.jsc generated.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Compilation failed:", err);
    process.exit(1);
  });
