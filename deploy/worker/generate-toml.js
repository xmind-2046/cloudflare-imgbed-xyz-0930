/**
 * 根据环境变量生成 deploy/worker/wrangler.toml
 * 用于 GitHub Actions 部署，从 Secrets/Variables 读取配置
 * 
 * 环境变量：
 *   WORKER_NAME           - Worker 名称（默认 cloudflare-imgbed）
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare 账户 ID（写入 account_id，避免部署时交互式选择账户）
 *   D1_DATABASE_ID        - D1 数据库 ID
 *   KV_NAMESPACE_ID       - KV 命名空间 ID（与 D1 二选一，留空则不生成绑定）
 *   R2_BUCKET_NAME        - R2 存储桶名称（默认 img-r2）
 *   WORKER_VARS           - JSON 格式的业务环境变量
 *   SKIP_IMAGES           - 为 1 时不生成 [images] 绑定（账户未订阅 Cloudflare Images 时使用）
 *   OBSERVABILITY         - 设为 0 关闭 [observability]（默认开启日志）
 *   OBSERVABILITY_LOGS_SAMPLING - 日志采样率 0~1（默认 1，高流量站点建议 0.1 降本）
 *   OBSERVABILITY_PERSIST - 设为 0 关闭日志持久化（持久化需 Workers 付费计划）
 *   WORKER_CUSTOM_DOMAIN  - Worker 自定义域（如 maxs-zxtk.204680.xyz），写入 routes
 *                           并关闭 workers.dev / 预览 URL，避免部署覆盖控制台路由设置
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, 'wrangler.toml');

const env = process.env;
const name = env.WORKER_NAME || 'cloudflare-imgbed';

// account_id 显式写入，避免多账户场景下 wrangler 部署时交互式询问账户
const accountIdLine = env.CLOUDFLARE_ACCOUNT_ID
    ? `account_id = "${env.CLOUDFLARE_ACCOUNT_ID}"\n`
    : '';

// 账户未订阅 Cloudflare Images 时剥离 [images] 绑定（本项目默认剥离）
const imagesBlock = env.SKIP_IMAGES === '1' ? '' : `\n[images]\nbinding = "IMAGES"\n`;

// 自定义域：固化到配置里，否则每次 deploy 都会把控制台上配的路由覆盖掉。
// TOPML 顶层键必须写在任何 [table] 之前，否则会被解析成上一个表的子字段。
const customDomain = (env.WORKER_CUSTOM_DOMAIN || '').trim();
const routesBlock = customDomain
    ? `\nworkers_dev = false\npreview_urls = false\n\nroutes = [\n  { pattern = "${customDomain}", custom_domain = true }\n]\n`
    : '';

let toml = `name = "${name}"
main = "index.js"
${accountIdLine}compatibility_date = "2024-08-21"
compatibility_flags = ["global_fetch_strictly_public"]
${routesBlock}
[assets]
directory = "../../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
${imagesBlock}`;

// 可观测性：默认只开日志，与控制台「Observability」页保持一致
if (env.OBSERVABILITY !== '0') {
    const sampling = env.OBSERVABILITY_LOGS_SAMPLING || '1';
    const persist = env.OBSERVABILITY_PERSIST === '0' ? 'false' : 'true';
    toml += `
[observability.logs]
enabled = true
head_sampling_rate = ${sampling}
invocation_logs = true
persist = ${persist}

[observability.traces]
enabled = false
head_sampling_rate = 1
persist = ${persist}
`;
}

// D1 数据库
if (env.D1_DATABASE_ID) {
    toml += `
[[d1_databases]]
binding = "img_d1"
database_name = "img_d1"
database_id = "${env.D1_DATABASE_ID}"
`;
}

// KV 命名空间
if (env.KV_NAMESPACE_ID) {
    toml += `
[[kv_namespaces]]
binding = "img_url"
id = "${env.KV_NAMESPACE_ID}"
`;
}

// R2 存储桶（未指定时回落到项目默认的 img-r2）
const r2Bucket = env.R2_BUCKET_NAME || 'img-r2';
toml += `
[[r2_buckets]]
binding = "img_r2"
bucket_name = "${r2Bucket}"
`;

// 业务环境变量（从 JSON 解析）
if (env.WORKER_VARS) {
    try {
        const vars = JSON.parse(env.WORKER_VARS);
        const entries = Object.entries(vars);
        if (entries.length > 0) {
            toml += '\n[vars]\n';
            for (const [key, value] of entries) {
                toml += `${key} = "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
            }
        }
    } catch (e) {
        console.error('Warning: WORKER_VARS is not valid JSON, skipping:', e.message);
    }
}

// 数据库必须二选一，否则运行时所有接口都会报 Database not configured
if (!env.D1_DATABASE_ID && !env.KV_NAMESPACE_ID) {
    console.warn('Warning: neither D1_DATABASE_ID nor KV_NAMESPACE_ID is set; the worker will fail at runtime.');
}
if (!env.CLOUDFLARE_ACCOUNT_ID) {
    console.warn('Warning: CLOUDFLARE_ACCOUNT_ID is not set; wrangler may prompt for an account during deploy.');
}

writeFileSync(outputPath, toml, 'utf8');

// 打印配置（隐藏敏感值）
const safeToml = toml
    .replace(/database_id = ".*"/g, 'database_id = "***"')
    .replace(/(id = )".*"/g, '$1"***"')
    .replace(/(TOKEN.*= )".*"/gi, '$1"***"')
    .replace(/(KEY.*= )".*"/gi, '$1"***"')
    .replace(/(SECRET.*= )".*"/gi, '$1"***"');

console.log('Generated deploy/worker/wrangler.toml:');
console.log(safeToml);
