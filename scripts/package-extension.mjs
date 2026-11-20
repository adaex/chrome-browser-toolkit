import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const assets = ['manifest.json', 'options.html', 'popup.html', 'switch.html', 'ui.css'];
const moduleOrIcon = /^(?:worker\/[a-zA-Z]+\.js|icon\/[a-zA-Z0-9_]+\.(?:png|svg))$/;

// dist 已由构建生成。送审时直接打包刚通过测试的那一份
export function zipDist(root, manifest = readFileSync(join(root, 'manifest.json'), 'utf8')) {
  const zip = join(root, 'extension.zip');
  rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '../extension.zip', '.'], { cwd: join(root, 'dist'), stdio: 'inherit' });

  const unzip = (...args) => execFileSync('unzip', args, { encoding: 'utf8' });
  unzip('-tq', zip);
  if (unzip('-p', zip, 'manifest.json') !== manifest) throw new Error('包内清单与待发布清单不一致');
  const { include } = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  const rootScripts = include.filter(entry => /^[\w-]+\.ts$/.test(entry)).map(entry => entry.replace(/\.ts$/, '.js'));
  const allowed = new Set([...assets, ...rootScripts, 'worker/', 'icon/']);
  if (unzip('-Z1', zip).trimEnd().split('\n').some(name => !allowed.has(name) && !moduleOrIcon.test(name))) {
    throw new Error('包中含有不应上传的文件');
  }
  return zip;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv[2] === 'copy') {
    mkdirSync('dist', { recursive: true });
    for (const name of [...assets, 'icon']) cpSync(name, join('dist', name), { recursive: true });
  } else if (process.argv[2] === 'zip') {
    zipDist(process.cwd());
  } else {
    throw new Error('请选择 copy 或 zip');
  }
}
