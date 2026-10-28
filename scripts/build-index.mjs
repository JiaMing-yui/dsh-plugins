// 生成插件市场索引（format 1）。
//
// 用法:
//   node scripts/build-index.mjs --url https://github.com/<you>/dsh-plugins [--commit <sha>] [--out index.json]
//
// 规则：安装源是 git+https，必须 pin 到一个 40 位 commit；索引里的 icon 用相对路径，
// 解析时以内索引 URL 的 origin 为基准（同一 host 的 https）。
// 顺序：先提交 packages/ 拿到 commit，再用这个 commit 生成 index.json，最后提交 index.json。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const repoUrl = arg('url', '').replace(/\.git$/, '');
if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(repoUrl)) {
    console.error('need --url https://github.com/<owner>/<repo>');
    process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, arg('out', 'index.json'));
const commit = arg('commit', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim());

const pluginsDir = path.join(root, 'packages');
const names = fs.readdirSync(pluginsDir).filter((name) => fs.statSync(path.join(pluginsDir, name)).isDirectory()).sort();

const zh = {
    'dsh-session-push': ['跨会话推送', '把一条消息推送到另一个 DSH 会话，并能读回对方的回复。', ['会话', '推送', '多 agent', '跨工作区']],
    'dsh-vision': ['识图代理', '让读不了图的模型调用能读图的多模态模型看图片。', ['识图', '多模态', '视觉']],
};

const plugins = names.map((name) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, name, 'package.json'), 'utf8'));
    const [titleZh, descZh, keywords] = zh[name] ?? [name, manifest.description ?? name, []];
    return {
        name: manifest.name,
        title: { en: manifest.name, zh: titleZh },
        description: { en: manifest.description ?? name, zh: descZh },
        icon: `packages/${name}/icon.svg`,
        author: '大肥鱼',
        repository: { url: repoUrl, directory: `packages/${name}` },
        metadata: { category: 'tools', keywords },
        versions: [
            {
                version: manifest.version,
                publishTimestamp: Math.floor(Date.now() / 1000),
                source: { type: 'git', url: repoUrl, commit, path: `packages/${name}` },
            },
        ],
    };
});

const index = {
    format: 1,
    title: { en: 'Da Feiyu DSH plugins', zh: '大肥鱼的 DSH 插件' },
    description: {
        en: 'Bundles built for DeepSeek Harness: push messages across sessions, read images through a vision model.',
        zh: '给 DeepSeek Harness 用的两个组合包：跨会话推送、借多模态模型识图。',
    },
    metadata: {
        categories: { tools: { title: { en: 'Tools', zh: '工具' } } },
        labels: { experimental: { title: { en: 'Experimental', zh: '实验性' } } },
        sortKeys: { added: { title: { en: 'Added', zh: '添加时间' }, order: 'desc' } },
    },
    plugins,
};

fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log('wrote ' + out + ' (commit ' + commit + ', ' + plugins.length + ' plugins)');
