/**
 * dsh-vision — 给纯文本模型配一双眼睛。
 *
 * 提供工具：
 *   describe_image  把本地图片交给一个支持图片输入的模型（默认走火山方舟的豆包视觉），
 *                   让那个模型用中文描述/回答关于这张图的问题。
 *
 * 自己（deepseek-v4.1-flash）读不了图，所以这里不猜图：图片字节交给 llm 服务的
 * prepareCall → stream，模型名从 config.models 里挑第一个 inputModalities 含 image 的。
 *
 * @module dsh-vision
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const name = 'dsh-vision';

/** 挂载痕迹：排查「插件到底有没有被加载」时看这个文件。 */
const MOUNT_LOG = 'D:/BOT/ops/vision.log';

function mountLog(message) {
    try {
        appendFileSync(MOUNT_LOG, new Date().toISOString() + ' ' + message + '\n');
    } catch {
        /* 写不了日志不影响主流程 */
    }
}

/** 单张图上限：跟表情包插件保持一致，8MB 开外基本是原图，模型也吃不消。 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 默认候选模型：都挂在 arkcli 这个 provider 上，按顺序试第一个能读图的。
 *  lite 排第一：pro 会先吐一大段思考、正文经常为空；lite 直接给结论。
 *  要更准的话，调用时用 model 参数点名 pro。 */
const DEFAULT_MODELS = [
    'doubao-seed-2.1-lite',
    'doubao-seed-2.1-pro',
    'kimi-k3.1-pro',
    'doubao-seed-evolving',
];

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
};

/** 只硬依赖 tools；llm / attachments 按需取，缺了就把工具报错而不是整个插件挂掉。 */
export const inject = ['tools', 'llm', 'attachments'];

function mimeOf(file) {
    const ext = extname(file).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

function humanBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function apply(ctx, config) {
    mountLog('apply() called');
    const disposers = [];

    const log = (level, message) => {
        try {
            ctx.log?.(level, '[vision] ' + message);
        } catch {
            /* 日志挂了不影响主流程 */
        }
    };

    const service = (name) => {
        try {
            return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
        } catch {
            return undefined;
        }
    };

    /** provider：跟当前默认模型保持一致（现在就是 arkcli-agent-plan）。 */
    function providerName() {
        if (typeof config?.provider === 'string' && config.provider !== '') return config.provider;
        try {
            const selection = ctx.agentDefaultModel?.currentSelection?.();
            if (typeof selection?.provider === 'string' && selection.provider !== '') return selection.provider;
        } catch {
            /* 拿不到就往下走默认值 */
        }
        return 'arkcli-agent-plan';
    }

    /** 候选模型列表：config.models 优先，否则用内置的。 */
    function candidateModels() {
        const fromConfig = Array.isArray(config?.models) ? config.models.filter((item) => typeof item === 'string') : [];
        return fromConfig.length > 0 ? fromConfig : DEFAULT_MODELS;
    }

    function textOutput(textOf) {
        return {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: textOf(value) }],
        };
    }

    /** 把一张图交给指定模型，拿到中文回答。 */
    async function askModel(llm, attachments, provider, model, files, question) {
        const info = await llm.resolveModelInfo(provider, model);
        const modalities = info?.inputModalities;
        if (!Array.isArray(modalities) || !modalities.includes('image')) {
            const error = new Error('模型「' + model + '」不能读图');
            error.notVision = true;
            throw error;
        }
        const base = await llm.resolveCallConfig({ provider, model, maxTokens: 2048 });
        const prepared = await llm.prepareCall(base);

        const content = [];
        const prompt = question !== undefined && question.trim() !== ''
            ? question.trim()
            : '这张图里是什么？把画面、文字、布局都说清楚，能看出是什么界面/截图就说明是什么界面。';
        content.push({
            type: 'text',
            text: '你在替一个看不见图的助手看图片。用中文回答，直接给结论，不要客套、不要复述问题。\n\n' + prompt,
        });
        for (const file of files) {
            const bytes = readFileSync(file);
            const attachment = await attachments.saveImage({
                data: bytes,
                mediaType: mimeOf(file),
                name: basename(file),
            });
            content.push({ type: 'image', attachment });
        }

        let out = '';
        let reason = '';
        for await (const chunk of prepared.stream({ ...base, messages: [{ role: 'user', content }] })) {
            if (chunk.type === 'text-delta') out += chunk.text;
            else if (chunk.type === 'reasoning-delta') reason += chunk.text;
            else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
                const failure = chunk.reason.failure;
                throw new Error('模型调用失败: ' + (failure?.message ?? JSON.stringify(failure)));
            }
        }
        // 只认正文：思考型模型有时把话全说在 reasoning 里，那种结果又长又绕，
        // 与其把自言自语吐给用户，不如当失败，让上层换下一个模型。
        const answer = out.trim();
        if (answer === '') {
            throw new Error('模型只返回了思考过程，没有正文' + (reason.trim() !== '' ? '（思考 ' + reason.trim().length + ' 字）' : ''));
        }
        return answer;
    }

    disposers.push(ctx.tools.register(defineTool({
        name: 'describe_image',
        description: '让一个能读图的模型（豆包视觉等）看一张或多张本地图片，并回答关于它的问题。用于自己模型不支持图片输入的时候：给一个图片路径和想问的话，返回那个模型的中文描述。',
        parameters: {
            path: {
                type: 'string',
                description: '图片路径；多张图时也可以用 paths',
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：一次给多张图（顺序即模型看到的顺序）',
            },
            question: {
                type: 'string',
                description: '可选：想问这张图什么；不填就让它整体描述画面、文字和布局',
            },
            model: {
                type: 'string',
                description: '可选：指定模型 id（默认按 config.models 顺序挑第一个能读图的）',
            },
        },
        output: textOutput((value) => {
            if (value?.ok !== true) return value?.message ?? '看不了这张图';
            return (value.answer ?? '').trim();
        }),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const llm = service('llm');
            const attachments = service('attachments');
            if (llm === undefined || llm === null) return { ok: false, message: '宿主没有 llm 服务，看不了图' };
            if (attachments === undefined || attachments === null) return { ok: false, message: '宿主没有 attachments 服务，看不了图' };

            const files = [];
            if (typeof args.path === 'string' && args.path.trim() !== '') files.push(args.path.trim());
            if (Array.isArray(args.paths)) {
                for (const item of args.paths) {
                    if (typeof item === 'string' && item.trim() !== '') files.push(item.trim());
                }
            }
            if (files.length === 0) return { ok: false, message: '没给图片路径' };
            if (files.length > 6) return { ok: false, message: '一次最多 6 张图' };

            for (const file of files) {
                let size;
                try {
                    size = statSync(file).size;
                } catch {
                    return { ok: false, message: '图片读不到: ' + file };
                }
                if (size > MAX_BYTES) return { ok: false, message: '图片太大（' + humanBytes(size) + '，上限 8 MB）: ' + file };
            }

            const provider = providerName();
            const forced = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined;
            const models = forced !== undefined ? [forced] : candidateModels();
            const attempts = [];
            for (const model of models) {
                try {
                    const answer = await askModel(llm, attachments, provider, model, files, typeof args.question === 'string' ? args.question : '');
                    return {
                        ok: true,
                        model: provider + '/' + model,
                        files: files.map((file) => basename(file)),
                        answer,
                        attempts,
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    attempts.push(model + ': ' + message);
                    log('warn', 'model ' + model + ' failed: ' + message);
                }
            }
            return {
                ok: false,
                message: '所有候选模型都读不了图：' + attempts.join(' | '),
                attempts,
            };
        },
    })));

    return () => {
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            } catch {
                /* 卸载失败不影响主流程 */
            }
        }
        mountLog('disposed');
    };
}
