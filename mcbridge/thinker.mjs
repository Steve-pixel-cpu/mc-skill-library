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

const log2 = (...a) => console.error('[thinker]', ...a);

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
{"think": "...", "action": "idle"}
{"think": "我为什么要学这个", "action": "learn_skill",
 "skill": "小写蛇形命名的技能名",
 "description": "这个技能能干什么(检索用, 写清楚场景)",
 "code": "完整的 v2 技能代码"}

learn_skill 说明:
- 当你想做的事没有现成技能时, 自己写一个! 这是你的超能力
- 代码模板(必须遵守):
module.exports.run = async (bot, { log }) => {
  // const { goals: { GoalNear } } = require('mineflayer-pathfinder');
  // 你可以: bot.chat(cmd), bot.pathfinder.goto(GoalNear(x,y,z,1)),
  //          bot.lookAt(vec3), bot.dig(block), bot.placeBlock(ref, vec3),
  //          bot.inventory.items(), bot.blockAt(new (require('vec3').Vec3)(x,y,z))
  // 禁止: /fill /setblock(批量指令), 长循环无 sleep
  return '完成描述';
};
- 坐标用 bot.entity.position 相对值(别写死), 睡觉前 bot.quit() 不要写
- 写完会自动执行+验证, 失败会带着报错重新问你(最多 3 次)`;

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
    if (a === 'learn_skill') {
      if (!decision.skill || !decision.code)
        return 'learn_skill 缺 skill/code';
      return this.learnWithRetry(decision.skill, decision.code,
        decision.description || '');
    }
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

  // ── 自学习: 写技能→执行→失败看报错重写(最多3次) ──
  async learnWithRetry(skillName, code, description) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pathJoin = path.default.join;
    const file = pathJoin(this.skillsDir, `${skillName}.js`);
    const { goals } = await import('mineflayer-pathfinder');
    let feedback = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 代码安全护栏: 禁 quit/end(会杀死常驻bot), 禁 process.exit
      let safe = code.replace(/bot\.(quit|end)\s*\(/g, '/*bot.quit disabled*/(')
                     .replace(/process\.exit\s*\(/g, '/*process.exit disabled*/(');
      fs.writeFileSync(file, safe + '\n');
      log2(`[learn] ${skillName} 第${attempt}次尝试`);
      // 执行(复用 mcbridge 的 runSkillFn — 走 require cache busting)
      let report;
      try {
        report = await this.runSkillFn(skillName, 90000, true);
      } catch (e) {
        report = `技能执行异常: ${e.message}
${(e.stack || '').split('\n')[1] || ''}`;
      }
      if (report.includes('执行成功')) {
        log2(`[learn] ${skillName} 学会了!(${attempt}次尝试)`);
        this.catalog.push({ name: skillName, desc: description.slice(0, 60) });
        this._menuCache = null;                 // 技能菜单失效重算
        return `学会了新技能 ${skillName}: ${report.slice(0, 100)}`;
      }
      feedback = report;                        // 失败详情 → 回喂下一轮
      log2(`[learn] 失败: ${report.slice(0, 120)}`);
      // 让 LLM 看着报错重写
      const retry = await this.think(`你刚写了技能 ${skillName} 但执行失败:
${feedback.slice(0, 600)}

原代码:
${safe.slice(0, 1200)}

重新写完整代码修复问题。只回 JSON:
{"think":"问题在哪","action":"learn_skill","skill":"${skillName}","description":"${description}","code":"修复后的完整代码"}`);
      if (retry.action !== 'learn_skill' || !retry.code)
        return `学习放弃: ${retry.think || '模型未给出修复'}`;
      code = retry.code;
    }
    // 3次都失败: 删除废稿, 留言
    try { fs.unlinkSync(file); } catch {}
    return `学习失败(3次尝试), 已删除废稿。最后报错: ${feedback.slice(0, 150)}`;
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
