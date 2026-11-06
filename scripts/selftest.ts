// Data-layer self test. Run against a COPY of ~/.claude via CLAUDE_CONFIG_DIR:
//   node scripts/build-selftest.mjs && set CLAUDE_CONFIG_DIR=... && electron dist/selftest.js
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listProjects } from '../src/main/scanner';
import { loadSession, getRecord, saveSession, checkSave, listBackups, restoreBackup, previewReplace, applyReplace, forkSession, getApiRequest } from '../src/main/session';
import { exportBundle, readBundleManifest, importBundle } from '../src/main/transfer';
import { projectsDir } from '../src/main/paths';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.length);
let failures = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

async function main() {
  const loadOnly = process.env.SELFTEST_LOAD_ONLY;
  if (loadOnly) {
    const t0 = Date.now();
    const projects = listProjects();
    console.log(`listProjects: ${projects.length} projects, ${projects.reduce((a, p) => a + p.sessions.length, 0)} sessions in ${Date.now() - t0}ms`);
    for (const p of projects) for (const s of p.sessions) console.log(`  ${p.displayName.padEnd(22)} ${s.titleSource.padEnd(8)} ${s.title.slice(0, 60)}`);
    const t1 = Date.now();
    const s = await loadSession(loadOnly);
    const payload = JSON.stringify(s).length;
    console.log(`loadSession(${path.basename(loadOnly)}): ${s.records.length} records in ${Date.now() - t1}ms, payload ${(payload / 1e6).toFixed(1)} MB, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    console.log('issues:', s.issues.map((i) => i.message));
    const byType = new Map<string, number>();
    const byKey = new Map<string, number>();
    for (const r of s.records) {
      byType.set(r.type, (byType.get(r.type) || 0) + JSON.stringify(r).length);
      if (r.data && typeof r.data === 'object') for (const k of Object.keys(r.data)) byKey.set(k, (byKey.get(k) || 0) + JSON.stringify(r.data[k]).length);
      byKey.set('(truncated paths)', (byKey.get('(truncated paths)') || 0) + JSON.stringify(r.truncated).length);
    }
    console.log('by type', [...byType].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${(v / 1e6).toFixed(1)}MB`).join(' '));
    console.log('by key', [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}=${(v / 1e6).toFixed(1)}MB`).join(' '));
    return;
  }

  if (!process.env.CLAUDE_CONFIG_DIR) {
    console.error('Refusing to run: the self test edits transcripts. Set CLAUDE_CONFIG_DIR to a COPY of your .claude folder.');
    failures++;
    return;
  }
  const projects = listProjects();
  check('listProjects finds 3 projects', projects.length === 3, projects.map((p) => `${p.displayName}(${p.sessions.length})`).join(', '));
  const arena = projects.find((p) => p.dirName === 'D--Git-arena-survivor')!;
  check('project cwd detected', arena.cwd === 'D:\\Git\\arena-survivor', arena.cwd);
  check('memory listed', arena.memoryFiles.length === 2);
  const file = arena.sessions[0].file;
  const origSha = sha(file);
  const origLines = lines(file);

  const s = await loadSession(file);
  check('record count == line count', s.records.length === origLines.length, `${s.records.length}`);
  const rr = await getRecord(file, 5);
  check('getRecord returns exact line', rr.json === origLines[5]);

  // no-op save is byte identical
  let res = await saveSession({ file, expected: { size: s.size, mtimeMs: s.mtimeMs }, edits: [], deletes: [] });
  check('no-op save ok', res.ok, res.error);
  check('no-op save byte identical', sha(file) === origSha);

  // edit a tool result + delete an assistant text record in the chain
  const s2 = await loadSession(file);
  const trIdx = s2.records.findIndex((r) => r.type === 'user' && Array.isArray(r.data?.message?.content) && r.data.message.content[0]?.type === 'tool_result');
  const tr = (await getRecord(file, trIdx)).data;
  tr.message.content[0].content = 'EDITED RESULT renamed-file.ts';
  const delIdx = s2.records.findIndex((r, k) => k > trIdx && r.type === 'assistant' && r.data?.message?.content?.[0]?.type === 'text');
  const delRec = (await getRecord(file, delIdx)).data;
  const childIdx = s2.records.findIndex((r) => r.parentUuid === delRec.uuid);
  res = await saveSession({ file, expected: { size: s2.size, mtimeMs: s2.mtimeMs }, edits: [{ i: trIdx, json: JSON.stringify(tr) }], deletes: [delIdx] });
  check('edit+delete save ok', res.ok, res.error);
  const after = lines(file);
  check('one line removed', after.length === origLines.length - 1);
  check('edited line contains new text', after[trIdx].includes('EDITED RESULT renamed-file.ts'));
  const child = JSON.parse(after[childIdx - 1]);
  check('child re-linked to deleted record parent', child.parentUuid === delRec.parentUuid, `${child.parentUuid} vs ${delRec.parentUuid}`);
  let untouched = 0, total = 0;
  for (let k = 0; k < origLines.length; k++) {
    if (k === trIdx || k === delIdx || k === childIdx) continue;
    total++;
    if (after[k > delIdx ? k - 1 : k] === origLines[k]) untouched++;
  }
  check('all other lines byte identical', untouched === total, `${untouched}/${total}`);

  // conflict detection
  res = await saveSession({ file, expected: { size: 1, mtimeMs: 1 }, edits: [], deletes: [] });
  check('stale save is refused as conflict', !res.ok && !!res.conflict);
  // invalid json refused
  const s3 = await loadSession(file);
  res = await saveSession({ file, expected: { size: s3.size, mtimeMs: s3.mtimeMs }, edits: [{ i: 0, json: '{broken' }], deletes: [] });
  check('invalid JSON edit refused, file untouched', !res.ok && lines(file).length === after.length);

  // backups + restore
  const backups = await listBackups(file);
  check('backups exist (no-op saves make none)', backups.length >= 1, String(backups.length));
  const firstBackup = backups[backups.length - 1];
  res = await restoreBackup(file, firstBackup.path);
  check('restore ok', res.ok);
  check('restored file identical to original', sha(file) === origSha);

  // replace: text mode
  const s4 = await loadSession(file);
  const pv = await previewReplace(file, [{ from: 'arena-survivor', to: 'arena-thriver' }], { mode: 'text', variants: false, wholeSegment: false });
  check('text replace preview finds hits', pv.occurrences > 0, `${pv.occurrences} in ${pv.linesAffected}`);
  res = await applyReplace(file, [{ from: 'arena-survivor', to: 'arena-thriver' }], { mode: 'text', variants: false, wholeSegment: false }, { size: s4.size, mtimeMs: s4.mtimeMs });
  check('text replace applied', res.ok && fs.readFileSync(file, 'utf8').indexOf('arena-survivor') === -1);
  check('replaced file still valid JSONL', lines(file).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  await restoreBackup(file, (await listBackups(file))[0].path);
  check('restore after replace identical', sha(file) === origSha);

  // path-aware replace
  const pv2 = await previewReplace(file, [{ from: 'D:\\Git\\arena-survivor', to: 'E:\\Work\\arena' }], { mode: 'path', variants: true, wholeSegment: true });
  check('path replace preview finds hits', pv2.occurrences > 0, `${pv2.occurrences}`);
  console.log('   sample:', pv2.samples[0]?.before.slice(0, 120), '\n        → ', pv2.samples[0]?.after.slice(0, 120));
  // regex
  const pv3 = await previewReplace(file, [{ from: 'src/(\\w+)\\.ts', to: 'lib/$1.ts' }], { mode: 'regex', variants: false, wholeSegment: false });
  check('regex preview runs', pv3.occurrences >= 0, `${pv3.occurrences}`);

  // fork
  const fk = await forkSession(file, 40, 'Fork test');
  const fl = lines(fk.file!);
  check('fork ends with its own title record', JSON.parse(fl[fl.length - 1]).customTitle === 'Fork test', String(fl.length));
  check('fork uses new session id', fl.every((l) => !l.includes(path.basename(file, '.jsonl'))));
  fs.unlinkSync(fk.file!);

  // API request reconstruction
  const web = projects.find((p) => p.dirName === 'D--SVN-WebApp')!;
  const ws = await loadSession(web.sessions[0].file);
  const reqs = ws.records.filter((r) => r.type === 'api-request');
  const last = reqs[reqs.length - 1];
  const view = await getApiRequest(web.sessions[0].file, last.data.id);
  check('api request reconstructed', view.messages.length > 10 && view.missingBlobs === 0, `${view.messages.length} msgs, missing ${view.missingBlobs}`);

  // export + import with remap
  const fsProj = projects.find((p) => p.dirName === 'D--Git-FileShare')!;
  const zipPath = path.join(path.dirname(projectsDir()), 'bundle.zip');
  const ex = exportBundle({ projectDir: fsProj.dirName, sessionIds: fsProj.sessions.map((x) => x.id), includeMemory: true, includeSidecars: true }, zipPath);
  check('export ok', ex.ok && fs.existsSync(zipPath));
  const man = readBundleManifest(zipPath);
  check('manifest ok', man.sessions.length === 1, man.project.cwd);
  const imp = await importBundle({
    bundlePath: zipPath, targetCwd: 'E:\\Work\\FileShare',
    pairs: [{ from: man.project.cwd!, to: 'E:\\Work\\FileShare' }, { from: 'D--Git-FileShare', to: 'E--Work-FileShare' }],
    options: { mode: 'path', variants: true, wholeSegment: true }, conflict: 'new-id', includeMemory: true, overwriteMemory: false,
  });
  check('import ok', imp.ok && imp.imported.length === 1, imp.error || `${imp.imported[0]?.replacements} replacements`);
  const impFile = imp.imported[0].file;
  const txt = fs.readFileSync(impFile, 'utf8');
  check('imported into encoded folder', path.basename(path.dirname(impFile)) === 'E--Work-FileShare');
  const leftovers = (txt.match(/D:\\\\Git\\\\FileShare(?![A-Za-z0-9_-])/gi) || []).length + (txt.match(/D:\/Git\/FileShare(?![A-Za-z0-9_-])/gi) || []).length;
  check('no old cwd left (escaped or forward)', leftovers === 0, `${leftovers} left`);
  check('imported file valid JSONL', lines(impFile).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  check('sidecar copied', fs.existsSync(path.join(path.dirname(impFile), imp.imported[0].newId)));

  // local clone with new id into same project
  const clone = await importBundle({
    localSource: { projectDir: arena.dirName, sessionIds: [arena.sessions[0].id] }, targetCwd: 'D:\\Git\\arena-survivor',
    pairs: [], options: { mode: 'path', variants: true, wholeSegment: true }, conflict: 'new-id', includeMemory: true, overwriteMemory: false,
  });
  check('local clone gets new id on conflict', clone.ok && clone.imported[0].newId !== clone.imported[0].oldId);
  const cl = lines(clone.imported[0].file);
  check('clone has no old id', cl.every((l) => !l.includes(clone.imported[0].oldId)));
  check('clone memory merge skipped existing', clone.memoryWritten.length === 0);

  // ---------------------------------------------------------------- integrity checks
  {
    const sha0 = sha(file);
    const base = lines(file);
    const s5 = await loadSession(file);
    const exp = () => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs }; };
    const resultIdx = s5.records.findIndex((r, k) => k > 200 && r.type === 'user' && r.data?.message?.content?.[0]?.type === 'tool_result');

    // deleting only a tool result must be refused
    const chk = await checkSave({ file, expected: exp(), edits: [], deletes: [resultIdx] });
    check('check: deleting a lone tool result is flagged', chk.problems.some((p) => p.key.startsWith('use-no-result')), chk.problems.map((p) => p.key).join(','));
    check('check: dry run leaves file untouched', sha(file) === sha0);
    let r = await saveSession({ file, expected: exp(), edits: [], deletes: [resultIdx] });
    check('save refused when it breaks tool pairing', !r.ok && !!r.report?.problems.length && sha(file) === sha0, r.error);
    r = await saveSession({ file, expected: exp(), edits: [], deletes: [resultIdx], acceptProblems: true });
    check('save anyway writes', r.ok && lines(file).length === base.length - 1);
    await restoreBackup(file, (await listBackups(file))[0].path);
    check('restored after forced save', sha(file) === sha0);

    // edit a prompt mid-conversation with thinking cleanup
    const promptIdx = s5.records.findIndex((x, k) => k > 300 && x.type === 'user' && typeof x.data?.message?.content === 'string' && !x.data?.isMeta);
    const prompt = (await getRecord(file, promptIdx)).data;
    prompt.message.content += '\n\nExtra context added later.';
    const thinkingAfter = base.slice(promptIdx).filter((l) => l.includes('"type":"thinking"')).length;
    const chk2 = await checkSave({ file, expected: exp(), edits: [{ i: promptIdx, json: JSON.stringify(prompt) }], deletes: [], stripThinking: false });
    check('check: reports thinking affected by an edit', chk2.firstChange === promptIdx && chk2.thinkingBlocksAffected > 0 && chk2.problems.length === 0, `first=${chk2.firstChange} affected=${chk2.thinkingBlocksAffected} records-with-thinking-after=${thinkingAfter}`);
    r = await saveSession({ file, expected: exp(), edits: [{ i: promptIdx, json: JSON.stringify(prompt) }], deletes: [], stripThinking: true });
    const after = lines(file);
    check('save with thinking cleanup ok', r.ok && (r.report?.thinkingBlocksRemoved ?? 0) > 0, `removed ${r.report?.thinkingBlocksRemoved}`);
    check('no thinking left after the edit', after.slice(promptIdx).every((l) => !l.includes('"type":"thinking"')));
    check('thinking before the edit kept', after.slice(0, promptIdx).join('\n') === base.slice(0, promptIdx).join('\n'));
    const uuids = new Set(after.map((l) => JSON.parse(l).uuid).filter(Boolean));
    const origUuids = new Set(base.map((l) => JSON.parse(l).uuid).filter(Boolean));
    const broken = after.map((l) => JSON.parse(l)).filter((o) => o.parentUuid && !uuids.has(o.parentUuid) && origUuids.has(o.parentUuid));
    check('chain intact after removing thinking records', broken.length === 0, `${broken.length} dangling`);
    const s6 = await loadSession(file);
    check('reloaded session has no new orphan notes', s6.issues.filter((x) => x.message.includes('tool call')).length === s5.issues.filter((x) => x.message.includes('tool call')).length);
    await restoreBackup(file, (await listBackups(file))[0].path);
    check('restored after thinking cleanup', sha(file) === sha0);

    // replace with thinking cleanup
    const pv = await previewReplace(file, [{ from: 'arena-survivor', to: 'arena-x' }], { mode: 'text', variants: false, wholeSegment: false, stripThinking: true });
    check('replace preview reports thinking removal', (pv.report?.thinkingBlocksRemoved ?? 0) > 0, `${pv.report?.thinkingBlocksRemoved}`);
    check('replace preview introduces no problems', pv.report?.problems.length === 0);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
}

app.whenReady().then(main).catch((e) => { console.error(e); failures++; }).finally(() => app.exit(failures ? 1 : 0));
