// 冒烟: 起 mcbridge 子进程, MCP 客户端调 run_skill(patrol_area_v2)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['mcbridge/index.mjs', '--host', 'localhost', '--port', '25565',
         '--username', 'BridgeBot'],
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

let state = await client.callTool({ name: 'bot_state', arguments: {} });
console.log('bot_state:', state.content[0].text);
await new Promise(r => setTimeout(r, 3000));   // 等 spawn 稳定

const t0 = Date.now();
state = await client.callTool({ name: 'run_skill',
  arguments: { name: 'patrol_area_v2', timeout: 60 } });
console.log('run_skill:', state.content[0].text, `(${Date.now() - t0}ms)`);
state = await client.callTool({ name: 'bot_state', arguments: {} });
console.log('final:', state.content[0].text);
await client.close();
