'use strict';
// PreToolUse hook: block tool calls that touch paths outside this repo.
// Self-resolving: repo root is derived from this script's own location.
const path = require('path');

let REPO;
try {
  REPO = path.resolve(__dirname, '..', '..');
} catch {
  process.exit(0);
}
const repoNorm = REPO.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

function resolveNorm(p) {
  if (!p || typeof p !== 'string' || !p.trim()) return null;
  p = p.trim().replace(/^["']|["']$/g, '');
  // MSYS: //c/foo -> c:/foo
  const msys = p.match(/^\/\/([a-zA-Z])\/(.*)/);
  if (msys) p = `${msys[1]}:/${msys[2]}`;
  if (!path.isAbsolute(p)) p = path.join(REPO, p);
  try { return path.resolve(p); } catch { return null; }
}

function isInside(full) {
  if (!full) return true;
  const f = full.toLowerCase().replace(/\\/g, '/');
  return f === repoNorm || f.startsWith(repoNorm + '/');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  if (!raw.trim()) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const tool = String(payload.tool_name || '');
  const inp = payload.tool_input || {};
  const bad = [];

  if (/^(Read|Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) {
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const r = resolveNorm(inp[key]);
      if (r && !isInside(r)) bad.push(r);
    }
  } else if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(inp.command || '');
    const rxWin = /([a-zA-Z]):[\\/][^\s'"`|;&<>()]*/g;
    const rxMsys = /\/\/([a-zA-Z])\/[^\s'"`|;&<>()]*/g;
    for (const rx of [rxWin, rxMsys]) {
      let m;
      while ((m = rx.exec(cmd)) !== null) {
        const r = resolveNorm(m[0]);
        if (r && !isInside(r)) bad.push(r);
      }
    }
  }

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    process.stderr.write(
      `repo-sandbox: blocked — path(s) outside ${REPO}:\n  ${unique.join('\n  ')}\n` +
      `(If this is intentional, edit .claude/hooks/repo-sandbox.js or bypass via user approval.)\n`
    );
    process.exit(2);
  }
  process.exit(0);
});
