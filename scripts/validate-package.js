const fs = require('fs');
try {
  JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log('package.json is valid JSON');
} catch (err) {
  console.error('package.json is invalid JSON:', err.message);
  process.exit(1);
}
