// Hooks do Cursor no Prisma: tornam determinística a fronteira de .cursor/rules/interactive-boundary.mdc.
// - preToolUse (edição de arquivo): nega escrita em estado operacional (memory/runs, state.json, approvals).
// - beforeShellExecution: nega writers oficiais e push em main; pede confirmação para commit/push/PR,
//   para chamadas que mudam estado no dashboard e para leitura de .env.
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
const reply = (out) => process.stdout.write(JSON.stringify(out));
const deny = (why) =>
  reply({
    permission: 'deny',
    user_message: `Bloqueado pela fronteira interativa: ${why}.`,
    agent_message: `Ação bloqueada: ${why}. Estado operacional só muda pelo ciclo oficial do Prisma; não tente contornar.`,
  });

const STATE_PATH = /(^|[\\/])memory[\\/](runs|archive|approvals)[\\/]|(^|[\\/])state\.json$/;
const isFixture = (p) => /(^|[\\/])(fixtures|__fixtures__)[\\/]|\.test\./.test(p);

if (event === 'preToolUse') {
  const t = input.tool_input ?? {};
  const path = String(t.file_path ?? t.path ?? t.target_file ?? '');
  if (path && STATE_PATH.test(path) && !isFixture(path)) {
    deny(`escrita em estado operacional (${path})`);
  } else {
    reply({ permission: 'allow' });
  }
} else {
  const command = String(input.command ?? '');
  const denyRules = [
    [/\bstate-writer\.js\b/, 'state-writer.js é writer oficial do ciclo'],
    [/\binvalidate\.js\b/, 'invalidate.js é writer oficial do ciclo'],
    [/\bgit\s+push\b[^\n;&|]*\bmain\b/, 'push direto em main (use PR)'],
  ];
  const askRules = [
    [/\bgit\s+(commit|push|merge|rebase)\b/, 'commit/push/merge/rebase'],
    [/\bgh\s+pr\s+(create|merge)\b/, 'abrir ou mergear PR'],
    [/\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)[^\n]*(localhost|127\.0\.0\.1):3333/, 'chamada que muda estado no dashboard/watcher'],
    [/(^|[\s'"/])\.env(?!\.example)(\.[\w.-]+)?\b/, 'comando acessa .env com segredos'],
  ];
  const d = denyRules.find(([re]) => re.test(command));
  const a = !d && askRules.find(([re]) => re.test(command));
  if (d) deny(d[1]);
  else if (a) reply({ permission: 'ask', user_message: `Confirme: ${a[1]}.` });
  else reply({ permission: 'allow' });
}
