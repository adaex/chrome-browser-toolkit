import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('商店命令：查询只读，保护待审和线上版本，上传成功才送审', t => {
  const root = mkdtempSync(join(tmpdir(), 'store-cli-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, content, mode = 0o600) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
    return file;
  };
  execFileSync('git', ['init', '-q', root]);
  put('.git/info/exclude', '*\n');
  const item = 'a'.repeat(32);
  put('.env', `CWS_PUBLISHER_ID=00000000-0000-0000-0000-000000000000\nCWS_EXTENSION_ID=${item}\nCWS_PROJECT_ID=local-demo\nCWS_SERVICE_ACCOUNT=cws-demo@local-demo.iam.gserviceaccount.com\n`);
  put('config/cws-publisher/browser-toolkit/application_default_credentials.json', '{}');
  put('tools/google-cloud-sdk/bin/gcloud', '#!/bin/sh\nprintf fixture-token\n', 0o700);
  const version = '2.0';
  put('package.json', JSON.stringify({ chromeWebStoreId: item }));
  put('manifest.json', JSON.stringify({ version }));
  put('tsconfig.json', '{"include":[]}');
  put('bin/yarn', '#!/bin/sh\n[ "$1" = test ] || exit 1\nprintf "yarn test\\n" >> calls\nmkdir -p dist && cp manifest.json dist/manifest.json\n', 0o700);
  put('bin/zip', '#!/bin/sh\nprintf fixture > "$2"\n', 0o700);
  put('bin/unzip', `#!/bin/sh
case "$1" in
  -tq) exit 0;;
  -p) cat dist/manifest.json;;
  -Z1) printf 'manifest.json\\n'; if [ "$FIXTURE" = 'extra-file' ]; then printf '.env\\n'; fi;;
  *) exit 1;;
esac\n`, 0o700);
  cpSync(new URL('../scripts/', import.meta.url), join(root, 'scripts'), { recursive: true });
  const script = join(root, 'scripts/chrome-web-store.mjs');
  // 子进程只使用临时仓的配置和假令牌，不读取开发者的账号，也不连接商店
  const mock = put('mock.mjs', `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      const action = path.split(':').at(-1);
      const version = ${JSON.stringify(version)};
      appendFileSync('calls', options.method + ' ' + action + '\\n');
      if (options.headers.Authorization !== 'Bearer fixture-token') throw Error('意外的凭据');
      const rev = (state, crxVersion) => ({ state, distributionChannels: [{ crxVersion }] });
      const fixture = process.env.FIXTURE;
      if (action === 'fetchStatus') return Response.json({ itemId: '${item}', publishedItemRevisionStatus: rev('PUBLISHED', fixture === 'same' ? version : '1.0'), ...(fixture === 'pending' && { submittedItemRevisionStatus: rev('PENDING_REVIEW', '1.1') }) });
      if (action === 'upload' && path.startsWith('/upload/v2/') && options.headers['Content-Type'] === 'application/zip') return Response.json({ itemId: '${item}', uploadState: fixture === 'failed' ? 'FAILED' : 'SUCCEEDED', crxVersion: version });
      if (action === 'publish' && path.startsWith('/v2/') && JSON.parse(options.body).publishType === 'DEFAULT_PUBLISH') return Response.json({ itemId: '${item}', state: 'PENDING_REVIEW' });
      throw Error('未预期的请求');
    };`);
  function check(fixture, args, expectedExit, expectedCalls) {
    put('calls', '');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, script, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH, XDG_CONFIG_HOME: join(root, 'config'), FIXTURE: fixture },
    });
    assert.equal(r.status, expectedExit, r.stderr);
    assert.equal(readFileSync(join(root, 'calls'), 'utf8').trimEnd(), expectedCalls.join('\n'));
  }
  const get = 'GET fetchStatus';
  const submit = ['submit', version];
  check('pending', ['status'], 0, [get]);
  check('pending', submit, 1, [get]);
  check('same', submit, 1, [get]);
  check('extra-file', submit, 1, [get, 'yarn test']);
  check('failed', submit, 1, [get, 'yarn test', get, 'POST upload']);
  check('ready', submit, 0, [get, 'yarn test', get, 'POST upload', 'POST publish', get]);
  put('package.json', JSON.stringify({ chromeWebStoreId: 'b'.repeat(32) }));
  check('ready', submit, 1, []);
});
