#!/usr/bin/env python3
"""Token analysis of watcher-dispatched claude -p transcripts (plan/review nodes)."""
import json, glob, os, re, sys
from collections import defaultdict

PROJ = os.path.expanduser('~/.claude/projects')
DIRS = [d for d in glob.glob(os.path.join(PROJ, '*' + os.path.basename(os.environ.get('REPO_PATH', os.getcwd())) + '--claude-worktrees-*')) if not os.environ.get('TK') or d.rsplit('-',1)[-1] in os.environ['TK'].split(',')]


def load(f):
    out = []
    for l in open(f):
        try:
            out.append(json.loads(l))
        except Exception:
            pass
    return out


def first_prompt(recs):
    for o in recs:
        if o.get('type') == 'user':
            c = o['message']['content']
            if isinstance(c, list):
                c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict))
            return c
    return ''


def classify(p):
    m = re.search(r'Rode, nesta ordem: ([^\n]*?)(\.|$)', p)
    cmds = re.findall(r'/(fetch-ticket|plan|implement|review|test|verify|commit)\b', m.group(1) if m else p[:400])
    return cmds


def usage_turns(recs):
    """dedupe by message.id (streamed chunks repeat usage)."""
    seen = {}
    order = []
    for o in recs:
        if o.get('type') != 'assistant':
            continue
        m = o['message']
        mid = m.get('id') or o.get('uuid')
        u = m.get('usage') or {}
        tot = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
        if mid not in seen:
            order.append(mid)
        seen[mid] = (tot, m.get('model'), u)
    return [seen[k] for k in order]


def tool_calls(recs):
    uses = {}
    for o in recs:
        if o.get('type') == 'assistant':
            for c in o['message'].get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'tool_use':
                    uses[c['id']] = (c['name'], c.get('input', {}))
    res = []
    for o in recs:
        if o.get('type') == 'user':
            c = o['message']['content']
            if isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get('type') == 'tool_result':
                        cont = x.get('content')
                        if isinstance(cont, list):
                            size = sum(len(y.get('text', '')) for y in cont if isinstance(y, dict))
                        else:
                            size = len(str(cont or ''))
                        name, inp = uses.get(x.get('tool_use_id'), ('?', {}))
                        res.append((size, name, describe(name, inp)))
    return res


def describe(name, inp):
    if name == 'Read':
        p = inp.get('file_path', '')
        p = re.sub(r'.*/worktrees/[^/]+/', '', p)
        extra = ''
        if inp.get('offset') or inp.get('limit'):
            extra = f" [{inp.get('offset')}+{inp.get('limit')}]"
        return p + extra
    if name == 'Bash':
        return inp.get('command', '')[:110].replace('\n', ' ')
    if name in ('Agent', 'Task'):
        return f"{inp.get('subagent_type')}: {inp.get('description')}"
    if name == 'Grep':
        return f"{inp.get('pattern')} in {inp.get('path', '')}"[:110]
    if name == 'Skill':
        return inp.get('skill', '')
    return json.dumps(inp)[:110]


def kind(name, d):
    if name == 'Read':
        if d.endswith('.java') or '.java [' in d: return 'Read java'
        for k in ('spec/', 'context.md', 'handoff', 'project.yaml', 'status.yaml', 'templates/', 'state.json', 'graph.yaml', 'decisions/', '.claude/commands', 'AGENTS', 'CLAUDE'):
            if k in d: return 'Read ' + k
        return 'Read other'
    if name == 'Bash':
        for k in ('git diff', 'git log', 'git show', 'mvn', 'grep', 'rg ', 'cat ', 'sed ', 'find ', 'curl'):
            if k in d: return 'Bash ' + k.strip()
        return 'Bash other'
    return name


def sub_total(f):
    d = f[:-6]
    tot = 0; n = 0; models = set()
    for sf in glob.glob(os.path.join(d, 'subagents', '*.jsonl')):
        t = usage_turns(load(sf))
        tot += sum(x[0] for x in t); n += len(t)
        models |= {x[1] for x in t}
    return tot, n, models


def main():
    rows = []
    for d in DIRS:
        tk = d.rsplit('-', 1)[-1]
        for f in glob.glob(os.path.join(d, '*.jsonl')):
            recs = load(f)
            cmds = classify(first_prompt(recs))
            t = usage_turns(recs)
            if not t:
                continue
            tot = sum(x[0] for x in t)
            rows.append(dict(f=f, tk=tk, cmds=cmds, turns=len(t), tot=tot, peak=max(x[0] for x in t),
                             first=t[0][0], models={x[1] for x in t}, recs=recs, turnsl=t))
    mode = sys.argv[1] if len(sys.argv) > 1 else 'summary'
    for node in ('plan', 'review'):
        sel = sorted([r for r in rows if node in r['cmds'] and ('implement' not in r['cmds'] or node == 'review')],
                     key=lambda r: -r['tot'])
        print(f'\n######## {node}: {len(sel)} transcripts; top:')
        for r in sel[:int(sys.argv[2]) if len(sys.argv) > 2 else 3]:
            st, sn, sm = sub_total(r['f'])
            print(f"\n== {r['tk']} {os.path.basename(r['f'])[:8]} cmds={r['cmds']} turns={r['turns']} total={r['tot']:,} "
                  f"peak={r['peak']:,} first={r['first']:,} last={r['turnsl'][-1][0]:,} models={r['models']} | subagents: {sn} turns {st:,} {sm}")
            u0 = r['turnsl'][0][2]
            print(f"   first turn usage: in={u0.get('input_tokens')} cr={u0.get('cache_read_input_tokens')} cc={u0.get('cache_creation_input_tokens')}")
            tc = tool_calls(r['recs'])
            agg = defaultdict(lambda: [0, 0])
            for s, n, dd in tc:
                k = kind(n, dd); agg[k][0] += s; agg[k][1] += 1
            print('   by kind (chars, count):', ', '.join(f"{k}={v[0]:,}/{v[1]}" for k, v in sorted(agg.items(), key=lambda kv: -kv[1][0])[:10]))
            print(f'   tool calls: {len(tc)}, total result chars {sum(x[0] for x in tc):,}')
            for s, n, dd in sorted(tc, key=lambda x: -x[0])[:15]:
                print(f'     {s:>8,}  {n:<6} {dd}')


main()
