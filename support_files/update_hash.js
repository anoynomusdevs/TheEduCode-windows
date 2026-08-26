// Run with: node update_hash.js
// Computes the SHA-256 of bin/process_killer.exe and prints the hash to update in main.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'bin', 'process_killer.exe');

if (!fs.existsSync(filePath)) {
    console.error('ERROR: bin/process_killer.exe not found. Did you copy the new build?');
    process.exit(1);
}

const content = fs.readFileSync(filePath);
const hash = crypto.createHash('sha256').update(content).digest('hex');

console.log('\n=== New process_killer.exe SHA-256 ===');
console.log(hash);
console.log('\n=== Line to update in main.js verifyFileIntegrity() ===');
console.log(`        'bin/process_killer.exe': '${hash}',`);
console.log('');
