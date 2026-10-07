import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
await mkdir('artifacts/selector-check', { recursive: true });
const bundle = path.resolve('artifacts/selector-check/fixture.js'),
  main = path.resolve('artifacts/selector-check/main.cjs');
await build({
  entryPoints: ['scripts/fixtures/workbench-selector.tsx'],
  bundle: true,
  outfile: bundle,
  format: 'iife',
  globalName: 'selectorFixture',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
});
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});try{await window.loadURL('data:text/html,<html><body></body></html>');const value=await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(bundle)},'utf8')+';selectorFixture.run()');fs.writeFileSync(${JSON.stringify(path.resolve('artifacts/selector-check/report.json'))},JSON.stringify(value,null,2));console.log(JSON.stringify(value));app.exit(0);}catch(error){console.error(error);app.exit(1);}});`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [main], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const timer = setTimeout(() => {
  child.kill();
}, 30000);
const code = await new Promise((resolve) => {
  child.on('error', (error) => {
    console.error(error);
    resolve(1);
  });
  child.on('exit', (code) => resolve(code ?? 1));
});
clearTimeout(timer);
process.exitCode = code;
