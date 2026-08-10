const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Get file path from command line argument
const filePath = process.argv[2];

if (!filePath) {
  console.error('❌ Please provide the file path as an argument.');
  console.error('Usage: node hashgen.js "./filename.js"');
  process.exit(1);
}

// Resolve the absolute path
const resolvedPath = path.resolve(filePath);

// Check if the file exists
if (!fs.existsSync(resolvedPath)) {
  console.error(`❌ File not found: ${resolvedPath}`);
  process.exit(1);
}

// Read the file and generate hash
const fileBuffer = fs.readFileSync(resolvedPath);
const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

console.log(`✅ SHA-256 hash of ${filePath}:\n${hash}`);
