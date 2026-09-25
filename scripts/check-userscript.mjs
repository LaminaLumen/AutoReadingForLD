import { readFile } from 'node:fs/promises';
import process from 'node:process';

const scriptUrl = new URL('../Lanyue.user.js', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const [source, packageText] = await Promise.all([
    readFile(scriptUrl, 'utf8'),
    readFile(packageUrl, 'utf8')
]);

const packageJson = JSON.parse(packageText);
const failures = [];

function requireMatch(pattern, message) {
    if (!pattern.test(source)) {
        failures.push(message);
    }
}

function rejectMatch(pattern, message) {
    if (pattern.test(source)) {
        failures.push(message);
    }
}

function metadataValue(key) {
    const match = source.match(new RegExp(`^//\\s+@${key}\\s+(.+)$`, 'm'));
    return match?.[1]?.trim() || '';
}

requireMatch(/^\/\/ ==UserScript==$/m, '缺少用户脚本元数据起始标记');
requireMatch(/^\/\/ ==\/UserScript==$/m, '缺少用户脚本元数据结束标记');
requireMatch(/^\/\/\s+@name\s+澜阅$/m, '@name 与项目名称不一致');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/t\/\*$/m, '缺少 /t/ 帖子匹配规则');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/n\/\*$/m, '缺少 /n/ 帖子匹配规则');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/new\*$/m, '缺少 /new 列表匹配规则');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/unread\*$/m, '缺少 /unread 列表匹配规则');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/unseen\*$/m, '缺少 /unseen 列表匹配规则');
requireMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/latest\*$/m, '缺少 /latest 列表匹配规则');
requireMatch(/^\/\/\s+@grant\s+none$/m, '脚本必须保持 @grant none');
requireMatch(/^\/\/\s+@license\s+MIT$/m, '缺少 MIT 许可元数据');
requireMatch(/^\/\/\s+@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/LaminaLumen\/Lanyue\/main\/Lanyue\.user\.js$/m, '下载地址不正确');
requireMatch(/^\/\/\s+@updateURL\s+https:\/\/raw\.githubusercontent\.com\/LaminaLumen\/Lanyue\/main\/Lanyue\.user\.js$/m, '更新地址不正确');
requireMatch(/\.read-state:not\(\.read\)/, '缺少 Discourse 未读楼层识别');
requireMatch(/bottomReportTimeoutMs/, '缺少离帖前阅读记录确认闸门');
requireMatch(/ReadRecovery\.requestReload/, '缺少连续未确认时的有界重载恢复');

const metadataVersion = metadataValue('version');
const runtimeVersion = source.match(/version:\s*'([^']+)'/)?.[1] || '';
if (!metadataVersion || metadataVersion !== runtimeVersion || metadataVersion !== packageJson.version) {
    failures.push(`版本不一致：metadata=${metadataVersion || '缺失'}，runtime=${runtimeVersion || '缺失'}，package=${packageJson.version}`);
}

rejectMatch(/^\/\/\s+@match\s+https:\/\/linux\.do\/\*$/m, '禁止使用覆盖全站的宽泛 @match');
rejectMatch(/^\/\/\s+@(?:connect|require|resource)\b/m, '禁止声明跨域连接或远程资源权限');
rejectMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, '发现网络请求 API，请确认是否超出项目边界');
requireMatch(/PerformanceObserver/, '缺少原生阅读请求状态的被动观察');
requireMatch(/NativeTimingStatus\.isRateLimited\(\)/, '缺少 429 限流时的滚动保护');
rejectMatch(/\bGM(?:\.|_)[A-Za-z]/, '发现 GM 特权 API，与 @grant none 约束不符');
rejectMatch(/\b(?:eval|Function)\s*\(/, '禁止动态执行代码');
rejectMatch(/localStorage\.clear\s*\(/, '禁止清空整个站点的 localStorage');

if (failures.length > 0) {
    console.error('澜阅检查失败：');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
} else {
    console.log(`澜阅 v${metadataVersion} 检查通过。`);
}
