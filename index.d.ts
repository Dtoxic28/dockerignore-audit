export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  composeTarget?: string;
  source?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface ContextFile {
  path: string;
  absolute: string;
  type: 'file' | 'symlink' | 'other';
  size: number;
  ignored: boolean;
  included: boolean;
}

export interface IgnoreRule {
  line: number;
  pattern: string;
  negative: boolean;
  matches: number;
  effects: number;
  used: boolean;
}

export interface AuditStats {
  totalFiles: number;
  totalBytes: number;
  includedFiles: number;
  includedBytes: number;
  ignoredFiles: number;
  ignoredBytes: number;
  largestDirectories: Array<{ path: string; files: number; bytes: number }>;
}

export interface AuditReport {
  context: string;
  dockerfile: string | null;
  composeTargets?: string[];
  ignoreFile: string | null;
  stats: AuditStats;
  rules: IgnoreRule[];
  diagnostics: Diagnostic[];
  files: ContextFile[];
  baselineSuppressed?: number;
}

export interface AuditOptions {
  context?: string;
  dockerfile?: string;
  maxBytes?: number;
  maxFiles?: number;
  ignoreCodes?: string[];
}

export type ComposeAuditOptions = Omit<AuditOptions, 'dockerfile'> & {
  composeFiles: string[];
};

export interface PathExplanation {
  path: string;
  ignored: boolean;
  included: boolean;
  rule: null | { line: number; pattern: string; negative: boolean; source: string | null };
}

export function auditProject(options?: AuditOptions): Promise<AuditReport[]>;
export function auditContext(options?: AuditOptions): Promise<AuditReport>;
export function auditCompose(options: ComposeAuditOptions): Promise<AuditReport[]>;
export function discoverDockerfiles(context?: string): Promise<string[]>;
export function explainPath(report: AuditReport, pathname: string): PathExplanation;
export function toSarif(reports: AuditReport[]): Record<string, unknown>;
