// thinker: bot 的"大脑" —— 感知→思考→行动 循环
// 感知: 打包世界状态为处境摘要(几百 token)
// 思考: x-code 的 GLM key(anthropic 兼容端点, Coding Plan 套餐)
// 行动: 白名单(run_skill/move_to/say/idle/learn_skill/remember_place/...), LLM 只能点菜
//
// v2 性能架构(治"LLM 慢导致的卡顿"):
//   1. plan 链: 一次思考返回多步计划, 本地连跑, 动作密度↑3-5x
//   2. 事件中断: 聊天/受击/玩家靠近 → 立刻打断 sleep/plan 现场思考(秒回)
//   3. 模型分流: 快脑(flash)做常规决策, 慢脑(5.3)只管 learn_skill
//   4. 感知瘦身: 菜单只发名字+短描述, 背包只报非空槽
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const log2 = (...a) => console.error('[thinker]', ...a);

export class Thinker {
  /**
   * @param bot mineflayer 实例
   * @param runSkill mcbridge 的技能执行器(name, timeoutMs) => report
   * @param opts { skillsDir, apiKey, model, fastModel, intervalMs, memoryPath, placesPath }
   */
  constructor(bot, runSkill, opts = {}) {
    this.bot = bot;
    this.runSkillFn = runSkill;
    this.skillsDir = opts.skillsDir;
    this.apiKey = opts.apiKey || process.env.GLMT_KEY;
    this.model = opts.model || 'glm-5.3';              // 慢脑: learn_skill/重写
    this.fastModel = opts.fastModel || 'glm-5.3-flash'; // 快脑: 常规决策
    this.intervalMs = opts.intervalMs || 45000;   // 空闲 45s 想一次
    this.memoryPath = opts.memoryPath || path.join(opts.skillsDir, 'bot_memory.json');
    this.placesPath = opts.placesPath || path.join(opts.skillsDir, 'places.json');
    this.memories = [];                            // 最近思考轨迹(连续性)
    this.busy = false;
    this.enabled = true;
    this.planAbort = null;         // 当前 plan 的中止信号
    this.wakeEvent = null;         // 事件中断: 'chat:Steve xxx' / 'hurt' / 'player_near'
    this.loadSkillCatalog();
    this.loadPlaces();
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
          desc: m ? m[1].slice(0, 40) : '',   // 瘦身: 40 字符足够点菜
        });
      }
    } catch {}
  }

  // ── 世界记忆: bot 自己探索并命名的地点(治硬编码失忆) ──
  loadPlaces() {
    try { this.places = JSON.parse(fs.readFileSync(this.placesPath, 'utf8')); }
    catch { this.places = {}; }
  }
  savePlaces() {
    try { fs.writeFileSync(this.placesPath, JSON.stringify(this.places, null, 1)); }
    catch {}
  }

  // ── 记忆: 带时间戳, perceive 时按新鲜度衰减(参考村民 Memory 过期机制) ──
  addMemory(text) {
    this.memories.push({ text, t: Date.now() });
    if (this.memories.length > 12) this.memories.shift();
  }
  // 新鲜度: <2h 原样, 2-6h 标(旧), >6h 丢弃 —— 近期事件权重高, 遗忘是特性
  freshMemories(n = 3) {
    const now = Date.now();
    return this.memories
      .filter(m => now - m.t < 6 * 3600e3)
      .slice(-n)
      .map(m => (now - m.t < 2 * 3600e3 ? m.text : `${m.text}(旧)`));
  }

  // ── 作息软提示(参考村民 Schedule, 但不强制): 只把常识喂给大脑, 决定权在 LLM ──
  scheduleHint(t) {
    if (t >= 13000 && t < 23000) return '\n(夜深了 — 除非有要事或玩家招呼, 考虑回家/歇息)';
    if (t >= 11000 && t < 13000) return '\n(傍晚 — 一天快结束了, 收尾手头的事或看个夕阳)';
    if (t < 1000) return '\n(清晨 — 新的一天)';
    return '';
  }

  // ── 感知: 世界状态 → 处境摘要(瘦身版) ──
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
    // 瘦身: 只报非空槽, 合并同类
    const inv = {};
    for (const it of b.inventory.items())
      inv[it.name] = (inv[it.name] || 0) + it.count;
    const invStr = Object.entries(inv).slice(0, 12)
      .map(([k, v]) => `${k}x${v}`).join(', ') || '空';
    const recentChat = (this.recentChat || []).slice(-3)
      .map(c => `${c.user}: ${c.msg}`).join(' | ') || '无';
    const placesStr = Object.entries(this.places)
      .map(([name, p]) => `${name}(${p.x},${p.y},${p.z})`).join(' ') || '还没探索过';

    return `时间: ${timeStr}(${t})${this.scheduleHint(t)}
位置: ${pos.x}, ${pos.y}, ${pos.z}
我记得的地点: ${placesStr}
血量: ${Math.round(b.health)}/20 饥饿: ${b.food ?? '?'}/20
背包: ${invStr}
附近玩家: ${players.join(',') || '没有'}
最近聊天: ${recentChat}
突发: ${this.wakeEvent || '无'}
最近思考: ${this.freshMemories(3).join(' → ') || '无'}`;
  }

  // ── 思考: 调 GLM(快慢脑分流) ──
  async think(perception, forceSlow = false) {
    const skillMenu = this.catalog
      .map(s => `- ${s.name}: ${s.desc}`).join('\n');
    const sys = `你是 Minecraft 里的 bot「XBot」。根据处境决定接下来的行动安排。
像真人玩家一样有生活节奏, 也响应玩家的搭话。别反复做同一件事。

一次可以给一个小计划(1-4步), 每步从这些动作里选:
run_skill(用现成技能) / move_to(走位) / say(说话) / inspect(看看周围) /
remember_place(给当前位置起名记住) / idle(歇着)

只回一个 JSON, 格式:
{"think": "一句内心想法",
 "plan": [{"action": "run_skill", "skill": "技能名"},
          {"action": "say", "text": "要说的话"},
          {"action": "move_to", "x": 0, "y": 64, "z": 0},
          {"action": "remember_place", "name": "樱花林"},
          {"action": "inspect"}, {"action": "idle"}]}

技能清单:
${skillMenu}

要求:
- plan 步数 1-4, 连贯的小安排(如: 走到农田→收麦→说句话)
- 想做的事没有现成技能时, 用一步 {"action": "learn_skill",
  "skill": "小写蛇形命名", "description": "这技能干什么", "code": "完整代码"}
- code 模板(必须遵守):
module.exports.run = async (bot, { log }) => {
  // 可用: bot.chat(cmd), bot.pathfinder.goto(GoalNear(x,y,z,1)),
  //       bot.lookAt(vec3), bot.dig(block), bot.placeBlock(ref, vec3),
  //       bot.inventory.items(), bot.blockAt(new (require('vec3').Vec3)(x,y,z))
  // 禁止: /fill /setblock 批量指令, 长循环无 sleep, bot.quit
  return '完成描述';
};
- 坐标用 bot.entity.position 相对值(别写死)`;

    const user = `当前状态:
${perception}

安排下一步?`;

    const useModel = forceSlow || String(this.thinkHasCode).includes('learn')
      ? this.model : this.fastModel;
    const resp = await fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel, max_tokens: 2000,
        ...(useModel.includes('flash')
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
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no json in reply: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(m[0]);
    // 兼容旧格式: 单 action → 单步 plan
    if (parsed.action && !parsed.plan)
      parsed.plan = [{ action: parsed.action,
        skill: parsed.skill, text: parsed.text,
        x: parsed.x, y: parsed.y, z: parsed.z, code: parsed.code,
        description: parsed.description }];
    return parsed;
  }

  // ── 行动执行(白名单, 单步) ──
  async act(step) {
    const b = this.bot;
    const a = step.action;
    if (a === 'run_skill') {
      if (!step.skill) return '缺 skill';
      return this.runSkillFn(step.skill, 120000, false);
    }
    if (a === 'say') {
      if (step.text) b.chat(String(step.text).slice(0, 80));
      return 'said';
    }
    if (a === 'move_to') {
      const { goals: { GoalNear } } = await import('mineflayer-pathfinder');
      await b.pathfinder.goto(new GoalNear(step.x ?? b.entity.position.x,
        step.y ?? b.entity.position.y, step.z ?? b.entity.position.z, 2));
      return 'moved';
    }
    if (a === 'inspect') {
      // 环顾四周: 简报视野内值得注意的东西(玩家/生物/特殊方块)
      const entities = Object.values(b.entities)
        .filter(e => e.type !== 'object' && e.type !== 'player'
          && e.username !== b.username)
        .slice(0, 5).map(e => e.name || e.type);
      const nearPlayers = Object.values(b.players)
        .filter(p => p.entity && p.username !== b.username)
        .map(p => p.username);
      return `周围: 玩家[${nearPlayers}] 生物[${entities}]`;
    }
    if (a === 'remember_place') {
      const p = b.entity.position.floored();
      const name = String(step.name || '未命名').slice(0, 20);
      this.places[name] = { x: p.x, y: p.y, z: p.z, t: Date.now() };
      this.savePlaces();
      return `记住了「${name}」(${p.x},${p.y},${p.z})`;
    }
    if (a === 'idle') return 'idled';
    if (a === 'learn_skill') {
      if (!step.skill || !step.code)
        return 'learn_skill 缺 skill/code';
      return this.learnWithRetry(step.skill, step.code,
        step.description || '');
    }
    return `未知行动 ${a}`;
  }

  // ── plan 链执行: 连跑多步, 中断信号随时可打断 ──
  async runPlan(plan) {
    const results = [];
    for (const step of plan) {
      if (this.planAbort?.aborted) {
        results.push('(被打断)');
        break;
      }
      let r;
      try { r = await this.act(step); }
      catch (e) { r = `失败: ${e.message}`; }
      results.push(`${step.action}→${String(r).slice(0, 60)}`);
      // 严重失败(技能不存在/学习失败)也继续后续步, 汇报里带出来
    }
    return results.join(' | ');
  }

  // ── 事件中断入口(mcbridge 挂事件时调用) ──
  wake(reason) {
    this.wakeEvent = String(reason).slice(0, 80);
    this.planAbort?.abort();
    // 主循环的 sleep 也会被 _wakeup resolve 掉
    if (this._wakeup) { this._wakeup(); this._wakeup = null; }
  }
  interruptableSleep(ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => { this._wakeup = null; resolve(); }, ms);
      this._wakeup = () => { clearTimeout(t); resolve(); };
    });
  }

  // ── 主循环 ──
  start() {
    const loop = async () => {
      let prefetched = null;
      while (this.enabled) {
        if (!prefetched && this.bot.entity && !globalThis.__mcbridge?.skillActive) {
          const perception = this.perceive();
          prefetched = this.think(perception).catch(() => null);
        }
        await this.interruptableSleep(this.intervalMs + Math.random() * 15000);
        if (this.busy || globalThis.__mcbridge?.skillActive) { prefetched = null; continue; }
        if (!this.bot.entity) { prefetched = null; continue; }
        this.busy = true;
        try {
          let decision = prefetched ? await prefetched : null;
          prefetched = null;
          const ev = this.wakeEvent;
          if (ev) {   // 被事件叫醒: 感知里已带突发事由, 现场重想(prefetch 可能是旧的)
            decision = await this.think(this.perceive());
          } else if (!decision) {
            decision = await this.think(this.perceive());
          }
          this.wakeEvent = null;
          this.planAbort = new AbortController();
          const plan = decision.plan || [];
          if (!plan.length) plan.push({ action: 'idle' });
          const result = await this.runPlan(plan);
          this.planAbort = null;
          const memo = `${decision.think || ''}[${result}]`.slice(0, 200);
          this.addMemory(memo);
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
    let feedback = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      let safe = code.replace(/bot\.(quit|end)\s*\(/g, '/*bot.quit disabled*/(')
                     .replace(/process\.exit\s*\(/g, '/*process.exit disabled*/(');
      fs.writeFileSync(path.join(this.skillsDir, `${skillName}.js`), safe + '\n');
      log2(`[learn] ${skillName} 第${attempt}次尝试`);
      let report;
      try {
        report = await this.runSkillFn(skillName, 90000, true);
      } catch (e) {
        report = `技能执行异常: ${e.message}`;
      }
      if (report.includes('执行成功')) {
        log2(`[learn] ${skillName} 学会了!(${attempt}次尝试)`);
        this.catalog.push({ name: skillName, desc: description.slice(0, 40) });
        this.reportLearned(skillName, description, safe);   // ← 上报语义库(检索可发现)
        return `学会了新技能 ${skillName}: ${report.slice(0, 100)}`;
      }
      feedback = report;
      log2(`[learn] 失败: ${report.slice(0, 120)}`);
      const retry = await this.think(`你刚写了技能 ${skillName} 但执行失败:
${feedback.slice(0, 600)}

原代码:
${safe.slice(0, 1200)}

重新写完整代码修复问题。只回 JSON:
{"think":"问题在哪","plan":[{"action":"learn_skill","skill":"${skillName}","description":"${description}","code":"修复后的完整代码"}]}`, true);   // 重写走慢脑
      const rstep = (retry.plan || [])[0];
      if (!rstep || rstep.action !== 'learn_skill' || !rstep.code)
        return `学习放弃: ${retry.think || '模型未给出修复'}`;
      code = rstep.code;
    }
    try { fs.unlinkSync(path.join(this.skillsDir, `${skillName}.js`)); } catch {}
    return `学习失败(3次尝试), 已删除废稿。最后报错: ${feedback.slice(0, 150)}`;
  }

  // ── 学习成果上报: 同步进 Python 语义检索库(x-code 的 skill_search 能搜到) ──
  reportLearned(name, description, code) {
    const { execFile } = require('node:child_process');
    const py = process.platform === 'win32' ? 'python' : 'python3';
    // 走 server 同目录的 CLI 入口(轻量, 不起 MCP 握手)
    const script = path.join(this.skillsDir, '..', 'mc_skill_library', 'ingest.py');
    execFile(py, [script, '--name', name, '--description', description,
      '--code-file', path.join(this.skillsDir, `${name}.js`)],
      { timeout: 30000 }, (err, stdout) => {
        if (err) log2('[learn] 语义库上报失败(不影响使用):', err.message.slice(0, 80));
        else log2('[learn] 已入语义库:', stdout.trim().slice(0, 60));
      });
  }

  saveMemory(decision, result) {
    try {
      const log = this.loadMemoryLog();
      log.push({ t: new Date().toISOString(),
        think: decision.think,
        plan: (decision.plan || []).map(s => s.action + (s.skill ? `:${s.skill}` : '')).join('>'),
        result: String(result).slice(0, 120) });
      fs.writeFileSync(this.memoryPath,
        JSON.stringify(log.slice(-200), null, 1));
    } catch {}
  }
  loadMemoryLog() {
    try { return JSON.parse(fs.readFileSync(this.memoryPath, 'utf8')); }
    catch { return []; }
  }
}
