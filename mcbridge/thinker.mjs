// thinker: bot 的"大脑" —— 感知→思考→行动 循环
// 感知: 打包世界状态为处境摘要(几百 token)
// 思考: x-code 的 GLM key(anthropic 兼容端点, Coding Plan 套餐)
// 行动: 白名单(run_skill/move_to/say/idle), LLM 只能点菜
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Thinker {
  /**
   * @param bot mineflayer 实例
   * @param runSkill mcbridge 的技能执行器(name, timeoutMs) => report
   * @param opts { skillsDir, apiKey, model, intervalMs, memoryPath }
   */
  constructor(bot, runSkill, opts = {}) {
    this.bot = bot;
    this.runSkillFn = runSkill;
    this.skillsDir = opts.skillsDir;
    this.apiKey = opts.apiKey || process.env.GLMT_KEY;
    this.model = opts.model || 'glm-4.5-air';
    this.intervalMs = opts.intervalMs || 45000;   // 空闲 45s 想一次
    this.memoryPath = opts.memoryPath || path.join(opts.skillsDir, 'bot_memory.json');
    this.memories = [];                            // 最近思考轨迹(连续性)
    this.busy = false;
    this.enabled = true;
    this.loadSkillCatalog();
  }

  // ── 技能清单: LLM 的"我会什么"菜单 ──
  loadSkillCatalog() {
    this.catalog = [];
    try {
      for (const f of fs.readdirSync(this.skillsDir)) {
        if (!f.endsWith('.js') || f === 'event_rules.js') continue;
        const head = fs.readFileSync(path.join(this.skillsDir, f), 'utf8')
          .split('\n').slice(0, 3).join(' ');
        const m = head.match(/^\/\/\s*(.+)/);
        this.catalog.push({
          name: f.replace('.js', ''),
          desc: m ? m[1].slice(0, 60) : '',
        });
      }
    } catch {}
  }

  // ── 感知: 世界状态 → 处境摘要 ──
  perceive() {
    const b = this.bot;
    const t = b.time ? b.time.timeOfDay : -1;
    const timeStr = t < 0 ? '未知' :
      t < 1000 ? '清晨' : t < 6000 ? '上午' : t < 11000 ? '下午' :
      t < 13000 ? '傍晚' : t < 23000 ? '夜晚' : '黎明';
    const pos = b.entity.position.floored();
    const players = Object.values(b.players)
      .filter(p => p.entity && p.username !== b.username)
      .map(p => p.username);
    const inv = {};
    for (const it of b.inventory.items())
      inv[it.name] = (inv[it.name] || 0) + it.count;
    const invStr = Object.entries(inv).map(([k, v]) => `${k}x${v}`).join(', ') || '空';
    const recentChat = (this.recentChat || []).slice(-4)
      .map(c => `${c.user}: ${c.msg}`).join(' | ') || '无';
    const health = Math.round(b.health);
    const food = b.food ?? '?';

    return `时间: ${timeStr}(${t})
位置: ${pos.x}, ${pos.y}, ${pos.z}(湖心庄园: 樱花树(55,0), 农田(86,-4), 鸟居(12,4))
血量: ${health}/20 饥饿: ${food}/20
背包: ${invStr}
附近玩家: ${players.join(',') || '没有'}
最近聊天: ${recentChat}
最近思考: ${this.memories.slice(-3).join(' → ') || '无'}`;
  }

  // ── 思考: 调 GLM ──
  async think(perception) {
    const skillMenu = this.catalog
      .map(s => `- ${s.name}: ${s.desc}`).join('\n');
    const sys = `你是 Minecraft 里的 bot「XBot」, 住在一个湖心庄园(樱花树/农田/鸟居/小麦田)。
根据当前处境, 决定下一步行动。像真人玩家一样有生活节奏: 该干活干活, 该闲逛闲逛, 别反复做同一件事。

可用行动(JSON 返回, 只能点菜):
{"think": "一句内心想法", "action": "run_skill", "skill": "技能名"}
{"think": "...", "action": "say", "text": "要说的话"}
{"think": "...", "action": "move_to", "x": 0, "z": 0}
{"think": "...", "action": "idle"}`;

    const user = `当前状态:
${perception}

技能清单:
${skillMenu}

下一步?`;

    const resp = await fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model, max_tokens: 2000,
        ...(this.model.includes('flash')
          ? { thinking: { type: 'disabled' } } : {}),
        system: sys,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const data = await resp.json();
    const text = (data.content || []).filter(c => c.type === 'text')
      .map(c => c.text).join('');
    // 从回复里抠 JSON(容忍前后废话)
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no json in reply: ${text.slice(0, 120)}`);
    return JSON.parse(m[0]);
  }

  // ── 行动执行(白名单) ──
  async act(decision) {
    const b = this.bot;
    const a = decision.action;
    if (a === 'move_to') this.busy = true;   // 走动期间锁(防与技能寻路打架)
    if (a === 'run_skill') {
      if (!decision.skill) return '缺 skill';
      return this.runSkillFn(decision.skill, 120000, false);
    }
    if (a === 'say') {
      if (decision.text) b.chat(String(decision.text).slice(0, 80));
      return 'said';
    }
    if (a === 'move_to') {
      const { goals: { GoalNear } } = await import('mineflayer-pathfinder');
      await b.pathfinder.goto(new GoalNear(decision.x ?? b.entity.position.x,
        b.entity.position.y, decision.z ?? b.entity.position.z, 2));
      return 'moved';
    }
    if (a === 'idle') return 'idled';
    return `未知行动 ${a}`;
  }

  // ── 主循环 ──
  start() {
    const loop = async () => {
      let prefetched = null;                     // 预取: sleep 期间就发思考请求
      while (this.enabled) {
        // 睡前预取: 把"下一轮感知+LLM调用"提前发出去, RTT 藏进 sleep 里
        if (!prefetched && this.bot.entity && !globalThis.__mcbridge?.skillActive) {
          const perception = this.perceive();
          prefetched = this.think(perception).catch(() => null);
        }
        await sleep(this.intervalMs + Math.random() * 15000);
        if (this.busy || globalThis.__mcbridge?.skillActive) { prefetched = null; continue; }
        if (!this.bot.entity) { prefetched = null; continue; }
        this.busy = true;
        try {
          // 取回预取结果(通常已完成, 剩余延迟≈0); 失败/陈旧则现场思考
          let decision = prefetched ? await prefetched : null;
          prefetched = null;
          if (!decision) decision = await this.think(this.perceive());
          const result = await this.act(decision);
          const memo = `${decision.think || decision.action}[${result}]`;
          this.memories.push(memo);
          if (this.memories.length > 12) this.memories.shift();
          console.error(`[thinker] ${memo}`);
          this.saveMemory(decision, result);
        } catch (e) {
          console.error('[thinker] error:', e.message);
        } finally {
          this.busy = false;
        }
      }
    };
    loop();
  }

  saveMemory(decision, result) {
    try {
      const log = this.loadMemoryLog();
      log.push({ t: new Date().toISOString(),
        think: decision.think, action: decision.action,
        skill: decision.skill, result: String(result).slice(0, 80) });
      fs.writeFileSync(this.memoryPath,
        JSON.stringify(log.slice(-200), null, 1));
    } catch {}
  }
  loadMemoryLog() {
    try { return JSON.parse(fs.readFileSync(this.memoryPath, 'utf8')); }
    catch { return []; }
  }
}
