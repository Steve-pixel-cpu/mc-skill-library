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
import { Thinker } from './thinker.mjs';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = process.env.MC_SKILLS_DIR ||
  path.join(__dirname, '..', 'skills');

// ── 进程级异常保护: bot 常驻, 任何异常都不能杀进程 ──
process.on('uncaughtException', (e) =>
  console.error('[mcbridge] uncaught:', e.message));
process.on('unhandledRejection', (e) =>
  console.error('[mcbridge] unhandled:', e?.message || e));

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
          // 自发行程: 按时段挑活动(40% 概率)
          //   夜间: stargaze / 回家待着
          //   傍晚: watch_sunset
          //   白天: wander / visit_torii / 看农田
          if (Math.random() < 0.4 && !wanderBusy) {
            wanderBusy = true;
            const t = bot.time ? bot.time.timeOfDay : 0;
            const pick = [];
            if (t >= 13000 && t < 23000) pick.push('stargaze', 'go_home');
            else if (t >= 11000 && t < 13000) pick.push('watch_sunset', 'wander');
            else pick.push('wander', 'visit_torii', 'check_crops', 'wander');
            const act = pick[Math.floor(Math.random() * pick.length)];
            await runSkill(act, 60000, false).catch(() => {});
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
  if (chatLog.length > 10) chatLog.shift();
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

// ── 内置规则(示例: 天黑回家 / 低血逃跑 / 定期农活)──
addRule({
  type: 'poll',
  when: async (b) => {
    // 白天 + 随机散步到农田附近时才检查(自然化)
    const t = b.time ? b.time.timeOfDay : 0;
    if (t >= 13000) return false;
    const p = b.entity.position;
    return Math.abs(p.x - 86) < 20 && Math.abs(p.z - 0) < 25;  // 在农田附近
  },
  skill: 'harvest_wheat', cooldownMs: 5 * 60 * 1000,
});
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
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    delete require.cache[f];
    const mod = require(f);
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
  let mod;
  if (reload) {
    // CJS 模块的 ?t= query 不生效(CJS 加载器忽略 query) → 用 require cache 清除
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    delete require.cache[file];
    mod = require(file);
  } else {
    mod = await import(pathToFileURL(file).href);
  }
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

server.tool('place_block', '在指定坐标放置方块(bot 需在附近, 走放式建造用)', {
  x: z.number(), y: z.number(), z: z.number(), block: z.string(),
}, async ({ x, y, z, block }) => {
  const { Vec3 } = await import('vec3');
  const pos = new Vec3(x, y, z);
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below) return { content: [{ type: 'text', text: '目标处未加载' }] };
  const item = bot.inventory.items().find(i => i.name === block.split('[')[0]);
  if (item) await bot.equip(item, 'hand');
  const ref = below;
  await bot.placeBlock(ref, pos.offset(-ref.position.x, -ref.position.y, -ref.position.z));
  return { content: [{ type: 'text', text: `已放置 ${block} @${x},${y},${z}` }] };
});

server.tool('dig_block', '挖掉指定坐标方块', {
  x: z.number(), y: z.number(), z: z.number(),
}, async ({ x, y, z }) => {
  const { Vec3 } = await import('vec3');
  const b = bot.blockAt(new Vec3(x, y, z));
  if (!b || b.name === 'air') return { content: [{ type: 'text', text: '无方块' }] };
  await bot.dig(b);
  return { content: [{ type: 'text', text: `已挖 ${b.name}` }] };
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

// ── Thinker: bot 的大脑(感知→GLM思考→行动) ──
// key 来源: GLMT_KEY 环境变量, 或 x-code providers.json(智谱 Coding Plan)
function loadGlmKey() {
  if (process.env.GLMT_KEY) return process.env.GLMT_KEY;
  try {
    const xcode = JSON.parse(fs.readFileSync(
      path.join(process.env.USERPROFILE || process.env.HOME,
                '.x-code', 'providers.json'), 'utf8'));
    const prov = xcode.providers?.find(p => p.base_url?.includes('bigmodel'));
    if (prov?.api_key) return prov.api_key;
  } catch {}
  return null;
}
const glmKey = loadGlmKey();
if (glmKey) {
  const thinker = new Thinker(bot, runSkill, {
    skillsDir: SKILLS_DIR,
    apiKey: glmKey,
    model: 'glm-5.3-flash',
    intervalMs: 45000,
  });
  // 感知注入: 最近聊天
  Object.defineProperty(thinker, 'recentChat', { get: () => chatLog });
  // skillActive 联动: thinker 模块内部用全局, 这里桥接
  setInterval(() => {
    // nothing — thinker reads skillActiveGlobal
  }, 1000);
  globalThis.skillActiveGlobal = () => {
    try { return skillActive; } catch { return false; }
  };
  // thinker.js 里 skillActiveGlobal 是变量不是函数 — 改为直接暴露对象
  globalThis.__mcbridge = { get skillActive() { return skillActive; } };
  thinker.start();
  console.error('[mcbridge] thinker started (GLM)');
} else {
  console.error('[mcbridge] thinker disabled: no GLM key');
}
