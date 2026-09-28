// mcbridge: 统一 bot 层 —— 一个常驻 mineflayer bot 同时服务两个通道
//   1) MCP 工具(手动挡): move_to / get_state / chat 等细粒度控制
//   2) 技能执行(自动挡): 共享 bot 实例给技能代码(v2 格式), 不再每次新起 bot
//
// 用法(x-code mcpServers):
//   "minecraft": { "command": "node",
//     "args": ["D:/.../mc-skill-library/mcbridge/index.js",
//              "--host", "localhost", "--port", "25565", "--username", "XBot"] }
// 环境变量: MC_SKILLS_DIR(默认 ../skills)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals: { GoalNear } } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = process.env.MC_SKILLS_DIR ||
  path.join(__dirname, '..', 'skills');

// ── 参数解析 ─────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const HOST = arg('host', 'localhost');
const PORT = parseInt(arg('port', '25565'), 10);
const USERNAME = arg('username', 'XBot');

// ── 常驻 bot ─────────────────────────────────────────────
console.error(`[mcbridge] connecting ${HOST}:${PORT} as ${USERNAME}`);
const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: USERNAME, version: '1.21.8',
});
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  console.error(`[mcbridge] spawned at ${bot.entity.position.floored()}`);
});
bot.on('kicked', r => console.error('[mcbridge] kicked:', r));
bot.on('error', e => console.error('[mcbridge] bot error:', e.message));
bot.on('end', () => console.error('[mcbridge] disconnected, retrying in 5s'));
bot.on('end', () => setTimeout(() => process.exit(1), 5000)); // x-code 会重启我们

const chatLog = [];
bot.on('chat', (user, msg) => {
  if (user !== USERNAME) chatLog.push({ user, msg, t: Date.now() });
});

// ── 技能执行 v2: 共享 bot, 不再新起进程 ────────────────────
async function runSkill(name, timeoutMs = 120000) {
  const file = path.join(SKILLS_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return `技能 ${name} 不存在(${file})`;
  const mod = await import(`${pathToFileURL(file)}?t=${Date.now()}`);
  if (typeof mod.run !== 'function')
    return `技能 ${name} 不是 v2 格式(缺 run(bot) 导出)`;
  const t0 = Date.now();
  const timer = setTimeout(() => {
    bot.pathfinder.stop?.();
    bot.clearControlStates?.();
  }, timeoutMs);
  try {
    const out = await mod.run(bot, { log: console.error });
    return `技能 ${name} 执行成功(${Date.now() - t0}ms)\n${out ?? ''}`;
  } catch (e) {
    return `技能 ${name} 执行失败: ${e.message}\n${(e.stack ?? '').split('\n')[1] ?? ''}`;
  } finally { clearTimeout(timer); }
}

// ── MCP 工具(手动挡) ─────────────────────────────────────
const server = new McpServer({ name: 'mcbridge', version: '0.1.0' });

server.tool('bot_state', 'bot 状态: 位置/血量/游戏模式/在线', {}, async () => ({
  content: [{ type: 'text', text: bot.entity
    ? `位置 ${bot.entity.position.floored()} | 血 ${bot.health} | 模式 ${bot.game.gameMode}`
    : '未出生(等待 spawn)' }],
}));

server.tool('move_to', '寻路走到指定坐标', {
  x: z.number(), y: z.number(), z: z.number(),
  range: z.number().default(1).describe('到点多近算到达'),
}, async ({ x, y, z, range }) => {
  await bot.pathfinder.goto(new GoalNear(x, y, z, range));
  return { content: [{ type: 'text', text: `到达 ${bot.entity.position.floored()}` }] };
});

server.tool('read_chat', '读最近聊天', {
  count: z.number().default(10),
}, async ({ count }) => ({
  content: [{ type: 'text',
    text: chatLog.slice(-count).map(c => `<${c.user}> ${c.msg}`).join('\n') || '(无)' }],
}));

server.tool('send_chat', 'bot 发聊天消息', { message: z.string() }, async ({ message }) => {
  bot.chat(message);
  return { content: [{ type: 'text', text: '已发送' }] };
});

server.tool('run_skill', '在共享 bot 上执行 v2 技能(自动挡, 零新进程)', {
  name: z.string(), timeout: z.number().default(120).describe('秒'),
}, async ({ name, timeout }) => ({
  content: [{ type: 'text', text: await runSkill(name, timeout * 1000) }],
}));

// stdio 挂载
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mcbridge] MCP ready on stdio');
