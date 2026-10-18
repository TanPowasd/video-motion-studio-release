// Keeps skills/vmotion (the Agent Skill for external AI agents) honest: every CLI command, repo path,
// JSX diagnostic code, SDK export and MCP capability it names must exist, and the starter project
// must validate and render deterministically.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sdk from '../src/sdk/index.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { Application } from '../src/service/application.js';

const repo = path.resolve(__dirname, '..');
const skill = path.join(repo, 'skills/vmotion');

async function skillFiles() {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(md|tsx?|json)$/.test(e.name))
        out[path.relative(skill, p)] = await readFile(p, 'utf8');
    }
  };
  await walk(skill);
  return out;
}
/** Markdown bodies (YAML frontmatter stripped). */
const markdown = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([f]) => f.endsWith('.md'))
    .map(([f, text]) => [f, text.replace(/^---\n[\s\S]*?\n---\n/, '')] as const);

/** Command names registered in src/cli/index.ts (top level and the image/glyphs/plugin groups). */
async function cliCommands() {
  const src = await readFile(path.join(repo, 'src/cli/index.ts'), 'utf8');
  const names = new Set<string>(['help']);
  for (const m of src.matchAll(/(?:\.command|projectCommand)\(\s*'([a-z][a-z0-9-]*)/g))
    names.add(m[1]);
  // Table-driven commands: ['captions-import', 'captionsImport'], ['precompose', 'scenePrecompose', …]
  for (const m of src.matchAll(/\[\s*'([a-z][a-z0-9-]*)',\s*'[a-zA-Z]+'/g)) names.add(m[1]);
  for (const m of src.matchAll(/for \(const method of \[([^\]]+)\]/g))
    for (const n of m[1].matchAll(/'([a-z-]+)'/g)) names.add(n[1]);
  return names;
}

describe('skills/vmotion', () => {
  it('has Agent Skills frontmatter and stays concise', async () => {
    const text = await readFile(path.join(skill, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front).toBeTruthy();
    expect(front![1]).toMatch(/^name: vmotion$/m);
    expect(front![1]).toMatch(/^description: .{80,1024}$/m);
    expect(text.split('\n').length).toBeLessThanOrEqual(500);
  });

  it('references only files that exist (skill-relative or repo-relative)', async () => {
    const files = await skillFiles();
    const missing: string[] = [];
    for (const [file, text] of markdown(files))
      for (const m of text.matchAll(
        /`?((?:references|examples|docs|schemas|scripts|src|tests)\/[\w./@-]*[\w/])`?/g,
      )) {
        const ref = m[1].replace(/\/$/, '');
        if (/[*<>]/.test(ref) || ref.includes('captions-') || ref.startsWith('src/cli/index.ts:'))
          continue;
        if (!existsSync(path.join(skill, ref)) && !existsSync(path.join(repo, ref)))
          missing.push(`${file}: ${ref}`);
      }
    expect(missing).toEqual([]);
  });

  it('names only real CLI commands', async () => {
    const commands = await cliCommands();
    const groups: Record<string, string[]> = {
      image: ['presets', 'inspect', 'new', 'export'],
      glyphs: ['inspect', 'preview', 'plan'],
      plugin: ['pack', 'install'],
    };
    const bad: string[] = [];
    for (const [file, text] of markdown(await skillFiles()))
      for (const m of text.matchAll(
        /(?:^|[\s`(|])(?:vmotion|vmotion\.cmd)\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/gm,
      )) {
        const [, cmd, sub] = m;
        if (!commands.has(cmd)) bad.push(`${file}: vmotion ${cmd}`);
        else if (groups[cmd] && sub && !groups[cmd].includes(sub) && !sub.startsWith('-'))
          bad.push(`${file}: vmotion ${cmd} ${sub}`);
      }
    expect(bad).toEqual([]);
  });

  it('names only JSX diagnostic codes the runtime or linter emits', async () => {
    const sources = (
      await Promise.all(
        [
          'src/sdk/jsx.ts',
          'src/sdk/jsx-style.ts',
          'src/sdk/jsx-layout.ts',
          'src/core/jsx-lint.ts',
          'src/core/jsx-writeback.ts',
        ].map((f) => readFile(path.join(repo, f), 'utf8')),
      )
    ).join('\n');
    const unknown = new Set<string>();
    for (const [, text] of markdown(await skillFiles()))
      for (const m of text.matchAll(/\bJSX_[A-Z_]+[A-Z]\b/g))
        if (!sources.includes(`'${m[0]}'`)) unknown.add(m[0]);
    expect([...unknown]).toEqual([]);
  });

  it('documents SDK exports and easing names that exist', () => {
    const api = sdk as Record<string, unknown>;
    for (const name of [
      'defineComponent',
      'useClock',
      'remap',
      'springTo',
      'springSettle',
      'beatClock',
      'mixColor',
      'cycle',
      'toFrames',
      'Stage',
      'LocalTime',
      'Steps',
      'Step',
      'Fragment',
      'random',
      'cubicEasing',
      'easings',
      'spring',
      'progress',
      'tween',
      'stagger',
      'interpolate',
    ])
      expect(api[name], name).toBeDefined();
    expect(Object.keys(sdk.easings).sort()).toEqual([
      'inCubic',
      'inOutCubic',
      'linear',
      'outBack',
      'outCubic',
    ]);
  });

  it('names only real MCP capabilities in mcp.md', async () => {
    const text = await readFile(path.join(skill, 'references/mcp.md'), 'utf8');
    const known = new Set([
      ...toolDefinitions().map((t) => t.name),
      'tools_search',
      'tool_schema',
      'tool_call',
      'tools_load',
    ]);
    const notTools = new Set(['schema_hash']);
    const unknown: string[] = [];
    for (const m of text.matchAll(/`([a-z0-9]+(?:_[a-z0-9]+)+)\b/g))
      if (!known.has(m[1]) && !notTools.has(m[1]) && !/^(tool|mode|effect)$/.test(m[1]))
        unknown.push(m[1]);
    for (const m of text.matchAll(/\b(TOOL_[A-Z_]+|AGENT_ON_HOLD)\b/g))
      expect(m[1]).toMatch(/^(TOOL_NOT_LOADED|TOOL_NOT_FOUND|TOOL_ARGUMENTS|AGENT_ON_HOLD)$/);
    expect(unknown).toEqual([]);
  });
});

describe('skills/vmotion/examples/starter', () => {
  let root: string, app: Application;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-skill-'));
    await cp(path.join(skill, 'examples/starter'), root, { recursive: true });
    app = await new Application(root).open(false);
  }, 120000);
  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }, 60000);

  it('validates with no diagnostics and renders deterministically', async () => {
    const validated = await app.dispatch('validate', {});
    expect(validated.valid).toBe(true);
    expect(validated.diagnostics).toEqual([]);
    const preview = await app.dispatch('projectPreflight', {
      samples: [0, 30, 45, 89].map((frame) => ({ sceneId: 'intro', frame })),
      width: 160,
      determinism: true,
    });
    expect(preview.valid).toBe(true);
    expect(preview.samples.map((s: { status: string }) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
  }, 180000);
});
