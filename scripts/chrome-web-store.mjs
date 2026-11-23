import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { zipDist } from './package-extension.mjs';

const scriptRoot = dirname(import.meta.dirname);
const scope = 'https://www.googleapis.com/auth/chromewebstore';
const usage = 'yarn store:status               查询线上及送审版本\nyarn store:submit <版本号>      测试、打包并送审，通过审核后自动发布';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
}

function mainCheckout() {
  // Git 首条记录是主工作树，即使当前脚本位于另一棵工作树
  const [first] = git(scriptRoot, 'worktree', 'list', '--porcelain', '-z').split('\0');
  if (!first.startsWith('worktree ')) throw new Error('无法定位主工作树');
  return first.slice('worktree '.length);
}

function releaseCheckout() {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel');
  if (root === scriptRoot) return root;
  const common = cwd => realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (common(root) !== common(scriptRoot)) throw new Error('请在本仓的发布工作树内送审');
  return root;
}

function checkPrivateFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new Error(`未找到${label}，请参见 docs/release.md`);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label}必须是当前用户的普通文件，且不对组或其他用户开放`);
  }
}

function readConfig(home) {
  const file = join(home, '.env');
  checkPrivateFile(file, '主工作树的 .env');
  const { CWS_PUBLISHER_ID: publisher, CWS_EXTENSION_ID: item, CWS_PROJECT_ID: project, CWS_SERVICE_ACCOUNT: account } = parseEnv(readFileSync(file, 'utf8'));
  const id = /^[a-z][a-z\d-]{4,28}[a-z\d]$/;
  const [accountName] = (account ?? '').split('@', 1);
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(publisher) || !/^[a-p]{32}$/.test(item) ||
      !id.test(project ?? '') || !id.test(accountName) || account !== `${accountName}@${project}.iam.gserviceaccount.com`) {
    throw new Error('.env 中的发布者、扩展、云项目或服务账号无效');
  }
  return { resource: `publishers/${publisher}/items/${item}`, item, account };
}

function accessToken(home, account) {
  const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cws-publisher', 'browser-toolkit');
  const adc = join(config, 'application_default_credentials.json');
  checkPrivateFile(adc, '本机 Google Cloud 授权文件');
  const localSdk = join(home, 'tools', 'google-cloud-sdk', 'bin', 'gcloud');
  const env = { ...process.env, CLOUDSDK_CONFIG: config, GOOGLE_APPLICATION_CREDENTIALS: adc,
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true' };
  try {
    const token = execFileSync(existsSync(localSdk) ? localSdk : 'gcloud', [
      'auth', 'application-default', 'print-access-token', `--impersonate-service-account=${account}`, `--scopes=${scope}`, '--lifetime=900s', '--quiet',
    ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000 }).trim();
    if (token && !/\s/.test(token)) return token;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 gcloud，请安装 Google Cloud CLI');
  }
  throw new Error('无法签发短期令牌，请检查本机 Google 登录和该服务账号的 Token Creator 权限');
}

function storeApi({ resource, item }, token) {
  return async (operation, body) => {
    const upload = operation === 'upload';
    const url = `https://chromewebstore.googleapis.com${upload ? '/upload' : ''}/v2/${resource}:${operation}`;
    let response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', body, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': upload ? 'application/zip' : 'application/json' }) },
      });
    } catch {
      throw new Error('连接商店失败。若已发出上传或送审请求，请先查状态，不要直接重传');
    }
    if (!response.ok) throw new Error(`商店 API 返回 HTTP ${response.status}，请先核实状态`);
    const data = await response.json();
    if ((data.name && data.name !== resource) || (data.itemId && data.itemId !== item) ||
        (operation === 'fetchStatus' && !data.name && !data.itemId)) throw new Error('商店返回的条目标识不匹配');
    return data;
  };
}

function versionsOf(revision) {
  return (revision?.distributionChannels ?? []).map(channel => channel.crxVersion).filter(Boolean);
}

function printStatus(s) {
  const describe = r => ({ 状态: r?.state ?? null, 版本: versionsOf(r) });
  console.log(JSON.stringify({ 线上: describe(s.publishedItemRevisionStatus), 已提交: describe(s.submittedItemRevisionStatus), 最近异步上传: s.lastAsyncUploadState ?? null }, null, 2));
}

function versionNumber(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(value)) throw new Error('无效的 Chrome 版本号');
  const parts = value.split('.').map(Number);
  if (parts.some(n => n > 65535)) throw new Error('版本号超出 Chrome 支持的范围');
  // 每一段占 16 位，缺少的末段按 0 比较
  return parts.reduce((number, part, i) => number + (BigInt(part) << BigInt((3 - i) * 16)), 0n);
}

function checkUploadAllowed(status, version) {
  const live = status.publishedItemRevisionStatus;
  const versions = versionsOf(live);
  if (status.takenDown || status.warned || live?.state !== 'PUBLISHED' || !versions.length) throw new Error('线上状态异常或版本未知，未上传');
  const pending = status.submittedItemRevisionStatus;
  if (pending && !['CANCELLED', 'REJECTED'].includes(pending.state)) throw new Error('已有提交或暂存版本，未覆盖或撤回');
  if (status.lastAsyncUploadState === 'IN_PROGRESS') throw new Error('商店正在处理已有上传，请稍后查询状态');
  if (versions.some(v => versionNumber(version) <= versionNumber(v))) throw new Error('待发布版本必须高于全部线上版本');
}

function checkClean(root) {
  if (git(root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('工作树有未提交改动，未上传');
}

function buildPackage(root, manifest) {
  execFileSync('yarn', ['test'], { cwd: root, stdio: 'inherit' });
  const zip = zipDist(root, manifest);
  checkClean(root);
  return readFileSync(zip);
}

async function main([action, version, ...extra]) {
  if (!action || ['help', '--help'].includes(action)) { console.log(usage); return; }
  if (extra.length || !(action === 'status' && !version || action === 'submit' && version)) throw new Error(usage);
  const home = mainCheckout();
  const config = readConfig(home);
  let root, manifest;
  if (action === 'submit') {
    root = releaseCheckout();
    const { chromeWebStoreId } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (config.item !== chromeWebStoreId) throw new Error('配置的商店条目不匹配本扩展');
    versionNumber(version);
    manifest = readFileSync(join(root, 'manifest.json'), 'utf8');
    if (JSON.parse(manifest).version !== version) throw new Error('指定版本必须与当前工作树的 manifest.json 一致');
    checkClean(root);
  }
  const api = storeApi(config, accessToken(home, config.account));
  const status = await api('fetchStatus');
  printStatus(status);
  if (action === 'status') return;

  checkUploadAllowed(status, version);
  const zip = buildPackage(root, manifest);
  checkUploadAllowed(await api('fetchStatus'), version);
  const uploaded = await api('upload', zip);
  if (uploaded.crxVersion && uploaded.crxVersion !== version) throw new Error('商店返回的上传版本不匹配，未送审');
  let state = uploaded.uploadState;
  for (let i = 0; i < 20 && state === 'IN_PROGRESS'; i++) {
    await delay(3000);
    state = (await api('fetchStatus')).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error('未确认上传成功，未送审');
  const result = await api('publish', JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }));
  console.log('已发出送审请求，商店返回：', result.state || '未提供状态');
  printStatus(await api('fetchStatus'));
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
