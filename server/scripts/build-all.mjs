import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.resolve(serverDir, '../web');
const webDistDir = path.join(webDir, 'dist');
const serverPublicDir = path.join(serverDir, 'public');

function run(cmd, args, cwd) {
  const isWin = process.platform === 'win32';
  const bin = isWin && (cmd === 'pnpm' || cmd === 'npm') ? `${cmd}.cmd` : cmd;
  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) {
    console.error(`Failed to run "${cmd} ${args.join(' ')}":`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(path.join(webDir, 'package.json'))) {
  console.error(`Frontend project not found at ${webDir}. Please create web/ before running build:all.`);
  process.exit(1);
}

console.log('[build:all] 1/3 Building frontend (web/)...');
run('pnpm', ['run', 'build'], webDir);

if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
  console.error(`Expected frontend build output at ${webDistDir}/index.html, but it was not found.`);
  process.exit(1);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('[build:all] 2/3 Copying web/dist -> server/public...');
fs.rmSync(serverPublicDir, { recursive: true, force: true });
copyDirSync(webDistDir, serverPublicDir);

console.log('[build:all] 3/3 Building backend (server/)...');
run('pnpm', ['run', 'build'], serverDir);

console.log('[build:all] Done! Start production server with: pnpm run start:prod');
