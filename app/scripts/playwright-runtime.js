const fs = require('fs');
const path = require('path');
function loadPlaywright() {
  const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs');
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(localPrograms, 'Antigravity IDE', 'resources', 'app', 'node_modules', 'playwright-core')
  ];
  const vscodeRoot = path.join(localPrograms, 'Microsoft VS Code');
  if (fs.existsSync(vscodeRoot)) {
    for (const version of fs.readdirSync(vscodeRoot)) {
      candidates.push(path.join(vscodeRoot, version, 'resources', 'app', 'node_modules', 'playwright-core'));
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('playwright-core is not installed in a supported local runtime.');
}

module.exports = { loadPlaywright };
