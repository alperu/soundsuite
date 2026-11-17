import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { tarOneFile } from '../docker';

test('tarOneFile makes a tar the system tar can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar1-'));
  const content = 'FROM caddy:2\nRUN echo hi\n';
  fs.writeFileSync(path.join(dir, 'ctx.tar'), tarOneFile('Dockerfile', content));
  execFileSync('tar', ['-xf', 'ctx.tar'], { cwd: dir });
  expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8')).toBe(content);
});
