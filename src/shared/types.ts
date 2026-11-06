// Types shared between the main process and the renderer.

export interface SessionSummary {
  id: string;
  file: string;
  projectDir: string;
  title: string;
  titleSource: 'desktop' | 'custom' | 'ai' | 'agent' | 'prompt' | 'none';
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  size: number;
  mtimeMs: number;
  createdAt?: string;
  hasSidecar: boolean;
  subagentCount: number;
  live: boolean;
  desktopSessionId?: string;
  model?: string;
}

export interface ProjectSummary {
  dirName: string;
  path: string;
  displayName: string;
  cwd?: string;
  kind: 'code' | 'scratch';
  sessions: SessionSummary[];
  memoryFiles: string[];
  lastActivity: number;
  totalSize: number;
}

export interface LightRecord {
  /** zero-based line index in the jsonl file */
  i: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  ts?: string;
  /** The record with long strings shortened */
  data: any;
  /** JSON paths ("a/b/0/c") of strings that were shortened */
  truncated: string[];
  bytes: number;
  parseError?: string;
}

export interface SessionStats {
  records: number;
  user: number;
  assistant: number;
  toolUses: number;
  outputTokens: number;
  lastContextTokens: number;
  models: string[];
  cwds: string[];
  branches: string[];
  versions: string[];
  apiRequests: number;
}

export interface SessionIssue {
  level: 'warn' | 'error';
  i?: number;
  message: string;
}

export interface LoadedSession {
  file: string;
  id: string;
  size: number;
  mtimeMs: number;
  records: LightRecord[];
  stats: SessionStats;
  issues: SessionIssue[];
  live: boolean;
  subagents: { file: string; id: string; description?: string; agentType?: string; toolUseId?: string }[];
}

export interface RecordEdit {
  i: number;
  /** full replacement JSON for the line */
  json: string;
}

export interface SaveRequest {
  file: string;
  expected: { size: number; mtimeMs: number };
  edits: RecordEdit[];
  deletes: number[];
  /** overwrite even if the file changed on disk */
  force?: boolean;
  /** remove thinking blocks from the first change onward (their signatures no longer match) */
  stripThinking?: boolean;
  /** save even if the change introduces conversation problems */
  acceptProblems?: boolean;
}

export interface IntegrityProblem {
  key: string;
  level: 'warn' | 'error';
  i?: number;
  message: string;
}

export interface ChangeReport {
  /** problems the change introduces (not present before) */
  problems: IntegrityProblem[];
  /** problems already in the file before the change */
  existingProblems: number;
  /** first line whose model-visible content changes */
  firstChange: number | null;
  changedLines: number;
  replacements: number;
  thinkingBlocksRemoved: number;
  /** thinking blocks after the first change, whether or not they are being removed */
  thinkingBlocksAffected: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  backupPath?: string;
  changedLines?: number;
  /** set when the save was refused because it would break the conversation */
  report?: ChangeReport;
}

export interface BackupInfo {
  path: string;
  createdAt: number;
  size: number;
  label: string;
}

export interface PathPair {
  from: string;
  to: string;
}

export interface ReplaceOptions {
  /** 'path' = path-aware (variants, segment boundaries), 'text' = literal text, 'regex' = JS regular expression */
  mode?: 'path' | 'text' | 'regex';
  /** also match / vs \ variants, lowercase drive letter and /c/... git-bash style */
  variants: boolean;
  /** do not match when the next character continues a path segment name */
  wholeSegment: boolean;
  caseInsensitive?: boolean;
  /** limit to specific record line indexes (undefined = whole session) */
  onlyLines?: number[];
  /** remove thinking blocks from the first changed message onward */
  stripThinking?: boolean;
}

export interface ReplacePreview {
  linesAffected: number;
  occurrences: number;
  samples: { i: number; before: string; after: string }[];
  report?: ChangeReport;
}

export interface BundleManifest {
  format: 'claude-history-bundle';
  version: 1;
  exportedAt: string;
  source: { host: string; home: string; platform: string; claudeDir: string };
  project: { dirName: string; cwd?: string; displayName: string };
  sessions: { id: string; title: string; cwd?: string; size: number }[];
  includesMemory: boolean;
  memoryFiles: string[];
}

export interface ExportRequest {
  projectDir: string;
  sessionIds: string[];
  includeMemory: boolean;
  includeSidecars: boolean;
}

export interface ImportRequest {
  bundlePath?: string;
  /** clone a local session instead of a bundle */
  localSource?: { projectDir: string; sessionIds: string[] };
  targetCwd: string;
  pairs: PathPair[];
  options: ReplaceOptions;
  conflict: 'new-id' | 'overwrite' | 'skip';
  includeMemory: boolean;
  overwriteMemory: boolean;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  targetDir?: string;
  imported: { oldId: string; newId: string; file: string; replacements: number; thinkingBlocksRemoved: number }[];
  memoryWritten: string[];
  skipped: string[];
}

export interface ApiRequestView {
  id: string;
  timestamp?: string;
  params: any;
  messages: any[];
  missingBlobs: number;
}

export interface Api {
  claudeDir(): Promise<string>;
  listProjects(): Promise<ProjectSummary[]>;
  loadSession(file: string): Promise<LoadedSession>;
  getRecord(file: string, i: number): Promise<{ json: string; data: any }>;
  saveSession(req: SaveRequest): Promise<SaveResult>;
  checkSave(req: SaveRequest): Promise<ChangeReport>;
  forkSession(file: string, uptoIndex: number, title: string): Promise<{ ok: boolean; file?: string; id?: string; error?: string }>;
  listBackups(file: string): Promise<BackupInfo[]>;
  restoreBackup(file: string, backupPath: string): Promise<SaveResult>;
  previewReplace(file: string, pairs: PathPair[], options: ReplaceOptions): Promise<ReplacePreview>;
  applyReplace(file: string, pairs: PathPair[], options: ReplaceOptions, expected: { size: number; mtimeMs: number }): Promise<SaveResult>;
  getApiRequest(file: string, requestId: string): Promise<ApiRequestView>;
  readMemory(projectDir: string, name: string): Promise<string>;
  writeMemory(projectDir: string, name: string, content: string): Promise<SaveResult>;
  exportBundle(req: ExportRequest): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
  pickBundle(): Promise<{ path: string; manifest: BundleManifest } | null>;
  importBundle(req: ImportRequest): Promise<ImportResult>;
  homeDir(): Promise<string>;
  encodeProjectDir(cwd: string): Promise<string>;
  revealInExplorer(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onLoadProgress(cb: (p: { file: string; fraction: number }) => void): () => void;
}
