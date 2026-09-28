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
  startIdleLoop();
});

// ── Idle 行为循环: 不干活时也有活人感 ──────────────────────
// 技能执行期间暂停(skillActive), 结束后恢复
let skillActive = false;
let wanderBusy = false;   // 溜达中(防叠)
function startIdleLoop() {
  const idleActs = [
    async () => { // 随机张望: 视角甩到随机方向
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.35) * 1.2;
      bot.look(yaw, pitch, false);
    },
    async () => { // 原地小踱步: 随机走 1-2 格
      const p = bot.entity.position;
      const dx = Math.round((Math.random() - 0.5) * 4);
      const dz = Math.round((Math.random() - 0.5) * 4);
      await bot.pathfinder.goto(new GoalNear(p.x + dx, p.y, p.z + dz, 0.5))
        .catch(() => {});
    },
    async () => { // 蹲一下(潜行切换)
      bot.setControlState('sneak', true);
      await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
      bot.setControlState('sneak', false);
    },
    async () => { // 就地转一圈
      for (let i = 0; i < 8; i++) {
        await bot.look(i * Math.PI / 4, 0.1, false);
        await new Promise(r => setTimeout(r, 90));
      }
    },
    async () => { // 仰头看天(呆望)
      bot.look(bot.entity.yaw, -1.2, false);
      await new Promise(r => setTimeout(r, 1500));
    },
  ];
  const loop = async () => {
    while (true) {
      if (!skillActive && bot.entity) {
        try {
          // 40% 概率去兴趣点溜达(wander 技能), 60% 原地小动作
          if (Math.random() < 0.4 && !wanderBusy) {
            wanderBusy = true;
            await runSkill('wander', 30000, false).catch(() => {});
            wanderBusy = false;
          } else {
            await idleActs[Math.floor(Math.random() * idleActs.length)]();
          }
        } catch { wanderBusy = false; }
      }
      await new Promise(r => setTimeout(r, 2500 + Math.random() * 4000));
    }
  };
  loop();
}
bot.on('kicked', r => console.error('[mcbridge] kicked:', r));
bot.on('error', e => console.error('[mcbridge] bot error:', e.message));
bot.on('end', () => console.error('[mcbridge] disconnected, retrying in 5s'));
bot.on('end', () => setTimeout(() => process.exit(1), 5000)); // x-code 会重启我们

const chatLog = [];
bot.on('chat', (user, msg) => {
  if (user !== USERNAME) chatLog.push({ user, msg, t: Date.now() });
});

// ── 事件桥: MC 事件/状态 → 自动触发技能(阶段 4 核心) ───────
// 两类扳机:
//   1. mineflayer 事件(chat/health 变化等) → 直接挂 bot.on
//   2. 状态轮询(天黑/位置等) → 500ms tick 检查条件谓词
// 设计: 事件只做"扳机", 行为全部复用技能库 —— 不在事件里写逻辑
const eventRules = [];       // {type, event?, when, skill, cooldownMs, lastFired}

function addRule({ type = 'poll', event = null, when, skill, cooldownMs = 60000 }) {
  const rule = { type, event, when, skill, cooldownMs, lastFired: 0 };
  eventRules.push(rule);
  if (type === 'event' && event) {
    bot.on(event, async (...args) => { await tryFire(rule, bot, args); });
  }
}

async function tryFire(rule, botRef, args = []) {
  const now = Date.now();
  if (skillActive) return;
  if (now - rule.lastFired < rule.cooldownMs) return;
  let ok = false;
  try { ok = rule.when ? await rule.when(botRef, ...args) : true; }
  catch { return; }
  if (!ok) return;
  rule.lastFired = now;
  console.error(`[event-bridge] fire: ${rule.skill}`);
  await runSkill(rule.skill, 120000, false).catch(() => {});
}

// 状态轮询: 500ms 一次, 条件谓词决定是否触发
setInterval(async () => {
  if (skillActive || !bot.entity) return;
  for (const rule of eventRules) {
    if (rule.type !== 'poll') continue;
    await tryFire(rule, bot);
  }
}, 500);

// ── 内置规则(示例: 天黑回家 / 低血逃跑)──
addRule({
  type: 'poll',
  when: (b) => b.time && b.time.timeOfDay >= 13000 && b.time.timeOfDay < 23000,
  skill: 'go_home', cooldownMs: 10 * 60 * 1000,      // 每晚最多一次
});
addRule({
  type: 'poll',
  when: (b) => b.health < 10,
  skill: 'go_home', cooldownMs: 30 * 1000,
});

// ── 事件规则热载: skills/event_rules.js 可选(用户自定义扩展) ──
async function loadEventRules() {
  const f = path.join(SKILLS_DIR, 'event_rules.js');
  if (!fs.existsSync(f)) return;
  try {
    const mod = await import(`${pathToFileURL(f)}?t=${Date.now()}`);
    if (typeof mod.register === 'function') mod.register(addRule);
    console.error(`[event-bridge] rules total: ${eventRules.length}`);
  } catch (e) { console.error('[event-bridge] rules load failed:', e.message); }
}
loadEventRules();

// ── 兜底技能: go_home(技能库可随时覆盖同名文件) ──
const goHomeSkill = path.join(SKILLS_DIR, 'go_home.js');
if (!fs.existsSync(goHomeSkill)) {
  fs.writeFileSync(goHomeSkill, `// 天黑/低血自动回家(事件桥内置兜底)
module.exports.run = async (bot, { log }) => {
  const { goals: { GoalNear } } = require('mineflayer-pathfinder');
  log('[go_home] 回家');
  await bot.pathfinder.goto(new GoalNear(55, -60, 20, 2));
  bot.look(0, -0.6, false);
  return '已回家(湖边)';
};
`);
}

// ── 技能执行 v2: 共享 bot, 不再新起进程 ────────────────────
async function runSkill(name, timeoutMs = 120000, reload = true) {
  const file = path.join(SKILLS_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return `技能 ${name} 不存在(${file})`;
  // reload: 每次带时间戳 query 绕过 ESM 缓存 —— 技能改完即生效, 无需重启
  const url = `${pathToFileURL(file)}${reload ? `?t=${Date.now()}` : ''}`;
  const mod = await import(url);
  if (typeof mod.run !== 'function')
    return `技能 ${name} 不是 v2 格式(缺 run(bot) 导出)`;
  const t0 = Date.now();
  skillActive = true;
  const timer = setTimeout(() => {
    bot.pathfinder.stop?.();
    bot.clearControlStates?.();
  }, timeoutMs);
  try {
    const out = await mod.run(bot, { log: console.error });
    return `技能 ${name} 执行成功(${Date.now() - t0}ms)\n${out ?? ''}`;
  } catch (e) {
    return `技能 ${name} 执行失败: ${e.message}\n${(e.stack ?? '').split('\n')[1] ?? ''}`;
  } finally { clearTimeout(timer); skillActive = false; }
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
