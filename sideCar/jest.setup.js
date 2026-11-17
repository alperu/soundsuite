const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.SIDECAR_SECRET_DIR) {
  process.env.SIDECAR_SECRET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-secret-'));
}
