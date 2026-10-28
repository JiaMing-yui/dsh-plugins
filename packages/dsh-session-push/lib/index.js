/**
 * dsh-session-push — 跨会话推送。
 *
 * 给模型两个工具：
 *   session_list  列出 DSH 里的会话（按工作区分组，带标题和 id），用来挑目标。
 *   session_push  把一段话塞进指定的会话，让它那边接着跑一轮。
 *
 * 目标会话可以是同一工作区的，也可以是别的工作区的。实现方式是复用
 * dsh-agent 的 resume + followup：先 resume 出那个会话的 agent，再 followup
 * 一条 plugin 来源的用户消息，最后 flush 会话日志。
 *
 * @module dsh-session-push
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from 'node:fs';

export const name = 'dsh-session-push';

/** 挂载痕迹：排查「插件到底有没有被加载」时看这个文件。 */
const MOUNT_LOG = 'D:/BOT/ops/session-push.log';

function mountLog(message) {
    try {
        appendFileSync(MOUNT_LOG, new Date().toISOString() + ' ' + message + '\n');
    } catch {
        /* 写不了日志不影响主流程 */
    }
}

/** 只硬依赖 tools；其余服务按需取，缺了就把对应工具报错而不是整个插件挂掉。 */
export const inject = ['tools', 'agents', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

/** 会话太多时列表截断，避免一次吐几百条。 */
const LIST_LIMIT = 80;

/** 从一条会话事件里抠出可读的标题（第一条用户消息的文本）。 */
function titleOfEvent(event) {
    if (event === null || typeof event !== 'object') return '';
    const type = event.type;
    if (type !== 'user/message' && type !== 'user_message') return '';
    const content = event.data?.content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const part of content) {
        if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
            parts.push(part.text);
        }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** 一把剪刀：太长就留前面一段。 */
function clip(text, max) {
    if (typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
}

export function apply(ctx) {
    mountLog('apply() called');
    /** sessionId → agents.resume 拿到的 handle（保活，插件卸载时统一释放）。 */
    const handles = new Map();

    const log = (level, message) => {
        try {
            ctx.log?.(level, '[session-push] ' + message);
        } catch {
            /* 日志挂了不影响主流程 */
        }
    };

    /** 默认模型选择：新会话/恢复会话时带上，尽量跟工作区默认保持一致。 */
    function agentOptions() {
        const options = {};
        try {
            const selection = ctx.agentDefaultModel?.currentSelection?.();
            if (selection !== undefined && selection !== null) {
                if (typeof selection.provider === 'string') options.provider = selection.provider;
                if (typeof selection.model === 'string') options.model = selection.model;
            }
        } catch {
            /* 拿不到就用宿主默认 */
        }
        return options;
    }

    /** 恢复出来的 agent 需要重新挂上 preset，否则没有工具链。 */
    function makeSetup() {
        return async (agentCtx) => {
            try {
                if (ctx.agentPresets !== undefined) {
                    await ctx.agentPresets.mount(agentCtx);
                }
            } catch (error) {
                log('warn', 'preset mount failed: ' + String(error));
            }
        };
    }

    /** 读一条会话的浅层信息：id、工作区、创建时间、标题。 */
    async function describeSession(sessionId, workspacePath) {
        const info = { id: sessionId, workspace: workspacePath ?? '', createdAt: undefined, title: '' };
        try {
            const handle = await ctx.sessionPersistence.open(sessionId, 'read');
            try {
                info.createdAt = handle.header?.createdAt;
                const { events } = await handle.read(0, 60);
                for (const event of events ?? []) {
                    const title = titleOfEvent(event);
                    if (title !== '') {
                        info.title = clip(title, 80);
                        break;
                    }
                }
            } finally {
                await handle.close();
            }
        } catch {
            /* 读不到就留空，列表照样能用 */
        }
        return info;
    }

    /** 枚举全部工作区里的会话。 */
    async function listAllSessions() {
        const registry = ctx.workspaceRegistry;
        if (registry === undefined) {
            throw new Error('session_list: 宿主没有 workspaceRegistry 服务，列不了会话');
        }
        const out = [];
        for (const workspace of registry.list()) {
            const path = workspace.path ?? '';
            for (const sessionId of workspace.sessionIds ?? []) {
                out.push(await describeSession(String(sessionId), path));
            }
        }
        return out;
    }

    /** 按「完整 id / id 片段 / 标题片段」找目标会话。 */
    function matchSessions(all, spec) {
        const needle = spec.toLowerCase();
        const byId = all.find((item) => item.id === spec);
        if (byId !== undefined) return [byId];
        const hits = all.filter((item) => {
            return item.id.toLowerCase().includes(needle) || (item.title ?? '').toLowerCase().includes(needle);
        });
        return hits;
    }

    /** 候选会话的渲染格式统一成一行一个。 */
    function renderCandidates(candidates) {
        return candidates.map((item) => {
            const when = item.createdAt !== undefined ? new Date(item.createdAt).toLocaleString('zh-CN') : '时间未知';
            return item.id + ' | ' + item.workspace + ' | ' + when + ' | ' + (item.title === '' ? '（无标题）' : item.title);
        });
    }

    function jsonOutput(textOf) {
        return {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: textOf(value) }],
        };
    }

    /** 从一条会话事件里抠出文字；不是 user/assistant 的消息一律返回 null。 */
    function spokenOf(event) {
        const type = typeof event?.type === 'string' ? event.type : '';
        let who;
        if (type.startsWith('user/')) who = '对方';
        else if (type.startsWith('assistant/')) who = '她';
        else return null;
        const payload = event?.data ?? event;
        const parts = Array.isArray(payload?.content) ? payload.content : [];
        const text = parts
            .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' ')
            .trim();
        if (text === '') return null;
        return { who, text };
    }

    /** 读会话末尾 limit 条发言：只读句柄，不抢写权，读完就关。 */
    async function readTail(spec, limit) {
        const service = ctx.sessionPersistence;
        if (service === undefined) throw new Error('宿主没有 sessionPersistence 服务，读不了会话');
        const all = await listAllSessions();
        let hits = matchSessions(all, spec);
        if (hits.length === 0 && /^(session|onebot)-[A-Za-z0-9-]{6,}$/.test(spec)) {
            hits = [{ id: spec, workspace: '', createdAt: undefined, title: '' }];
        }
        if (hits.length === 0) throw new Error('没找到匹配「' + spec + '」的会话');
        if (hits.length > 1) return { ok: false, candidates: hits.slice(0, 10) };
        const target = hits[0];
        const want = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 12, 1), 40);

        const handle = await service.open(target.id, 'read');
        try {
            const kept = [];
            let offset = 0;
            const CHUNK = 400;
            for (;;) {
                const slice = await handle.read(offset, CHUNK);
                const events = Array.isArray(slice?.events) ? slice.events : [];
                for (const event of events) {
                    const spoken = spokenOf(event);
                    if (spoken !== null) {
                        kept.push(spoken);
                        if (kept.length > want) kept.shift();
                    }
                }
                if (events.length === 0) break;
                offset += events.length;
                if (offset > 200000) break;
            }
            return { ok: true, sessionId: target.id, title: target.title ?? '', messages: kept };
        } finally {
            try {
                await handle.close?.();
            } catch {
                /* 关不掉也不影响读到的内容 */
            }
        }
    }

    /** 真正的推送：找会话 → resume → followup。工具和文件投递口共用这一份逻辑。 */
    async function doPush(spec, text, requestedMode) {
        if (spec === '') throw new Error('session 不能为空');
        if (text.trim() === '') throw new Error('text 不能为空');
        if (ctx.agents === undefined) throw new Error('宿主没有 agents 服务');

        const all = await listAllSessions();
        let hits = matchSessions(all, spec);
        /* 注册表里没有、但看起来是完整会话 id 的：直接按 id resume。
           有些会话不在本进程的 workspaceRegistry 里（比如别的 profile 建的），按 id 直连还能试一把。 */
        if (hits.length === 0 && /^(session|onebot)-[A-Za-z0-9-]{6,}$/.test(spec)) {
            hits = [{ id: spec, workspace: '', createdAt: undefined, title: '' }];
        }
        if (hits.length === 0) {
            throw new Error('没找到匹配「' + spec + '」的会话，先列出会话看看');
        }
        if (hits.length > 1) {
            return { ok: false, candidates: hits.slice(0, 10) };
        }
        const target = hits[0];

        let handle = handles.get(target.id);
        if (handle === undefined) {
            /* 会话可能正被别的窗口/驱动器占着（"already owned by an active write handle"）。
               那种情况不再新开，直接复用进程里活着的那个 agent，等于对她插话。 */
            const live = ctx.agents.get?.(target.id);
            if (live !== undefined && live !== null) {
                /* get() 有时给 AgentHandle、有时直接给 Agent，两种都认。 */
                handle = live.agent !== undefined ? live : { agent: live };
                log('info', 'reusing live agent for ' + target.id);
            }
        }
        if (handle === undefined) {
            handle = await ctx.agents.resume({
                resumeSessionId: target.id,
                agentOptions: agentOptions(),
                setup: makeSetup(),
            });
            handles.set(target.id, handle);
            log('info', 'resumed ' + target.id + ' for push');
        }

        const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin:dsh-session-push' },
        });
        const mode = requestedMode === 'steer' ? 'steer' : 'followup';
        if (mode === 'steer') {
            handle.agent.steer(message);
        } else {
            handle.agent.followup(message);
        }
        try {
            await ctx.sessions?.flush?.(handle.agent.session);
        } catch (error) {
            log('warn', 'flush failed after push: ' + String(error));
        }
        log('info', 'pushed ' + text.length + ' chars to ' + target.id + ' (' + mode + ')');
        return { ok: true, sessionId: target.id, title: target.title, mode };
    }

    const disposers = [];

    disposers.push(ctx.tools.register(defineTool({
        name: 'session_list',
        description: '列出 DSH 里的会话（跨工作区），返回 id、工作区、创建时间和标题。用来挑跨会话推送的目标。',
        parameters: {
            query: {
                type: 'string',
                description: '可选：按 id 或标题片段过滤',
            },
            workspace: {
                type: 'string',
                description: '可选：只列某个工作区（路径片段即可）',
            },
        },
        output: jsonOutput((value) => {
            const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
            if (sessions.length === 0) return '没有匹配的会话';
            return renderCandidates(sessions).join('\n');
        }),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
            const workspace = typeof args.workspace === 'string' ? args.workspace.trim().toLowerCase() : '';
            let sessions = await listAllSessions();
            if (workspace !== '') {
                sessions = sessions.filter((item) => item.workspace.toLowerCase().includes(workspace));
            }
            if (query !== '') {
                sessions = sessions.filter((item) => {
                    return item.id.toLowerCase().includes(query) || (item.title ?? '').toLowerCase().includes(query);
                });
            }
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            const truncated = sessions.length > LIST_LIMIT;
            return {
                total: sessions.length,
                truncated,
                sessions: sessions.slice(0, LIST_LIMIT),
            };
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'session_push',
        description: '把一段话推送到另一个 DSH 会话（同一或不同工作区都行），让那边接着跑一轮。目标会话可以用完整 id，也可以用 id 或标题的片段；匹配到多个会返回候选。',
        parameters: {
            session: {
                type: 'string',
                required: true,
                description: '目标会话：完整 session id，或 id / 标题里的片段',
            },
            text: {
                type: 'string',
                required: true,
                description: '要塞进目标会话的内容',
            },
            mode: {
                type: 'string',
                description: '可选：followup（默认，排一轮新的）或 steer（目标正在跑时插话）',
            },
        },
        output: jsonOutput((value) => {
            if (value?.ok === true) {
                return '已推送 → ' + value.sessionId + '（' + (value.title || '无标题') + '，' + value.mode + '）';
            }
            if (Array.isArray(value?.candidates)) {
                return '匹配到多个会话，请指定更精确的 id：\n' + renderCandidates(value.candidates).join('\n');
            }
            return JSON.stringify(value ?? null);
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const spec = typeof args.session === 'string' ? args.session.trim() : '';
            const text = typeof args.text === 'string' ? args.text : '';
            if (spec === '') throw new Error('session_push: session 不能为空');
            if (text.trim() === '') throw new Error('session_push: text 不能为空');
            return doPush(spec, text, args.mode);
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'session_read',
        description: '读另一个 DSH 会话末尾的几条对话（谁说了什么），用来查看推送过去之后对方回了什么。只读，不改那边任何状态。',
        parameters: {
            session: {
                type: 'string',
                required: true,
                description: '目标会话：完整 session id，或 id / 标题里的片段',
            },
            limit: {
                type: 'number',
                description: '可选：读最后几条发言，默认 12，最多 40',
            },
        },
        output: jsonOutput((value) => {
            if (value?.ok === true) {
                const messages = Array.isArray(value.messages) ? value.messages : [];
                if (messages.length === 0) return '这个会话里没有可读的文字发言';
                return messages.map((item) => item.who + '：' + item.text).join('\n');
            }
            if (Array.isArray(value?.candidates)) {
                return '匹配到多个会话，请指定更精确的 id：\n' + renderCandidates(value.candidates).join('\n');
            }
            return JSON.stringify(value ?? null);
        }),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const spec = typeof args.session === 'string' ? args.session.trim() : '';
            if (spec === '') throw new Error('session_read: session 不能为空');
            return readTail(spec, args.limit);
        },
    })));

    /**
     * 文件投递口：老会话的工具列表刷不出新工具，但进程里这个插件是活的。
     * 往 PUSH_DIR 丢一个 <名字>.req.json（{session, text, mode}），2 秒内被扫到并推送，
     * 结果写成同名的 .res.json，请求文件移到 .done.json。这样没有工具调用的会话也能用。
     */
    const PUSH_DIR = 'D:/BOT/bridge/push';
    let watcherTimer;

    function writeResult(name, value) {
        try {
            const target = PUSH_DIR + '/' + name.replace(/\.req\.json$/, '.res.json');
            writeFileSync(target, JSON.stringify(value) + '\n', 'utf8');
        } catch (error) {
            log('warn', 'write result failed: ' + String(error));
        }
    }

    function markDone(file) {
        try {
            renameSync(file, file.replace(/\.req\.json$/, '.done.json'));
        } catch {
            /* 已经挪走就算了 */
        }
    }

    function scanPushDir() {
        let names;
        try {
            mkdirSync(PUSH_DIR, { recursive: true });
            names = readdirSync(PUSH_DIR);
        } catch (error) {
            log('warn', 'push dir scan failed: ' + String(error));
            return;
        }
        for (const name of names) {
            if (!name.endsWith('.req.json')) continue;
            const file = PUSH_DIR + '/' + name;
            let request;
            try {
                request = JSON.parse(readFileSync(file, 'utf8'));
            } catch (error) {
                writeResult(name, { ok: false, error: 'request 不是合法 JSON: ' + String(error) });
                markDone(file);
                continue;
            }
            /* 先挪走再推：避免这次推送还没结束、下一轮扫描又把它当成新请求推第二遍。 */
            markDone(file);
            /* 支持列会话：{"op":"list"} → .res.json 里带 sessions，省得没工具的会话两眼一抹黑。 */
            if (request?.op === 'list') {
                void listAllSessions()
                    .then((sessions) => {
                        sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
                        writeResult(name, {
                            ok: true,
                            total: sessions.length,
                            sessions: sessions.slice(0, LIST_LIMIT),
                        });
                    })
                    .catch((error) => {
                        writeResult(name, { ok: false, error: String(error?.message ?? error) });
                    });
                continue;
            }
            /* 支持读回：{"op":"read","session":...,"limit":12} */
            if (request?.op === 'read') {
                void readTail(typeof request?.session === 'string' ? request.session.trim() : '', request?.limit)
                    .then((value) => {
                        writeResult(name, value);
                    })
                    .catch((error) => {
                        writeResult(name, { ok: false, error: String(error?.message ?? error) });
                    });
                continue;
            }
            const spec = typeof request?.session === 'string' ? request.session.trim() : '';
            const text = typeof request?.text === 'string' ? request.text : '';
            void doPush(spec, text, request?.mode)
                .then((value) => {
                    writeResult(name, value);
                })
                .catch((error) => {
                    writeResult(name, { ok: false, error: String(error?.message ?? error) });
                });
        }
    }

    try {
        mkdirSync(PUSH_DIR, { recursive: true });
        watcherTimer = setInterval(scanPushDir, 2000);
        watcherTimer.unref?.();
        scanPushDir();
        log('info', 'file drop active at ' + PUSH_DIR);
        mountLog('file drop active');
    } catch (error) {
        log('warn', 'file drop disabled: ' + String(error));
    }

    return () => {
        if (watcherTimer !== undefined) {
            clearInterval(watcherTimer);
            watcherTimer = undefined;
        }
        for (const dispose of disposers) {
            try {
                dispose?.();
            } catch {
                /* 卸载阶段的失败不往上抛 */
            }
        }
        disposers.length = 0;
        for (const handle of handles.values()) {
            try {
                void handle.dispose?.();
            } catch {
                /* 同上 */
            }
        }
        handles.clear();
    };
}
