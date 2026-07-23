import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const COMMAND_ID = 'stageMirror.restoreWorkingTreeFromHead';
const CONFIRMATION_MESSAGE =
  'This will replace the selected files in the Working Tree with their HEAD versions. Staged changes will remain unchanged.';

interface ResourceLike {
  readonly resourceUri: {
    readonly fsPath: unknown;
  };
}

interface RepositoryGroup {
  readonly root: string;
  readonly paths: string[];
}

interface RestoreFailure {
  readonly fileCount: number;
  readonly message: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Stage Mirror');
  const command = vscode.commands.registerCommand(
    COMMAND_ID,
    async (...resources: unknown[]) => {
      try {
        await restoreSelectedFiles(resources, output);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        output.appendLine(`Unexpected error: ${message}`);
        await vscode.window.showErrorMessage(`Stage Mirror failed: ${message}`);
      }
    },
  );

  context.subscriptions.push(output, command);
}

async function restoreSelectedFiles(
  resources: readonly unknown[],
  output: vscode.OutputChannel,
): Promise<void> {
  const files = collectFilePaths(resources);
  if (files.length === 0) {
    await vscode.window.showWarningMessage('Stage Mirror: No valid SCM files were selected.');
    return;
  }

  if (!(await confirmRestore())) {
    return;
  }

  const { groups, failures } = await groupFilesByRepository(files);
  let restoredCount = 0;

  for (const group of groups) {
    try {
      await runGit([
        '-C',
        group.root,
        'restore',
        '--source=HEAD',
        '--worktree',
        '--',
        ...group.paths,
      ]);
      restoredCount += group.paths.length;
    } catch (error: unknown) {
      failures.push({
        fileCount: group.paths.length,
        message: getErrorMessage(error),
      });
    }
  }

  if (restoredCount > 0) {
    await refreshGitSourceControl(output);
  }

  if (failures.length > 0) {
    showFailures(output, failures);
    const failedCount = failures.reduce((total, failure) => total + failure.fileCount, 0);
    await vscode.window.showErrorMessage(
      `Stage Mirror restored ${restoredCount} of ${files.length} files; ${failedCount} failed. ${failures[0]?.message ?? ''} See Output > Stage Mirror for details.`,
    );
    return;
  }

  const showSuccess = vscode.workspace
    .getConfiguration('stageMirror')
    .get<boolean>('showSuccessNotification', true);
  if (showSuccess) {
    await vscode.window.showInformationMessage(
      `Stage Mirror restored ${files.length} ${files.length === 1 ? 'file' : 'files'} from HEAD. Staged changes remain unchanged.`,
    );
  }
}

function collectFilePaths(resources: readonly unknown[]): string[] {
  const pending = [...resources];
  const files: string[] = [];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const resource = pending.shift();
    if (isUnknownArray(resource)) {
      pending.unshift(...resource);
      continue;
    }

    if (!isResource(resource)) {
      continue;
    }

    const filePath = resource.resourceUri.fsPath;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      continue;
    }

    const key = process.platform === 'win32'
      ? path.normalize(filePath).toLowerCase()
      : path.normalize(filePath);
    if (!seen.has(key)) {
      seen.add(key);
      files.push(filePath);
    }
  }

  return files;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isResource(value: unknown): value is ResourceLike {
  if (typeof value !== 'object' || value === null || !('resourceUri' in value)) {
    return false;
  }

  const uri = value.resourceUri;
  return typeof uri === 'object' && uri !== null && 'fsPath' in uri;
}

async function groupFilesByRepository(files: readonly string[]): Promise<{
  groups: RepositoryGroup[];
  failures: RestoreFailure[];
}> {
  const groups = new Map<string, RepositoryGroup>();
  const failures: RestoreFailure[] = [];

  for (const file of files) {
    try {
      const root = await findRepositoryRoot(file);
      const relativePath = path.relative(root, file);
      if (
        relativePath.length === 0 ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(`Selected file is outside the detected repository: ${file}`);
      }

      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      const existingGroup = groups.get(key);
      if (existingGroup === undefined) {
        groups.set(key, {
          root,
          paths: [relativePath.split(path.sep).join('/')],
        });
      } else {
        existingGroup.paths.push(relativePath.split(path.sep).join('/'));
      }
    } catch (error: unknown) {
      failures.push({ fileCount: 1, message: `${file}: ${getErrorMessage(error)}` });
    }
  }

  return { groups: [...groups.values()], failures };
}

async function findRepositoryRoot(file: string): Promise<string> {
  const startingDirectory = await nearestExistingDirectory(path.dirname(file));
  const output = await runGit([
    '-C',
    startingDirectory,
    'rev-parse',
    '--show-toplevel',
  ]);
  const root = output.replace(/[\r\n]+$/u, '');
  if (root.length === 0) {
    throw new Error('Git returned an empty repository root.');
  }

  return root;
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  let current = directory;

  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) {
        return current;
      }
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent directory found for ${directory}`);
    }
    current = parent;
  }
}

function runGit(arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      arguments_,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(new Error(stderr.trim() || error.message, { cause: error }));
        }
      },
    );
  });
}

async function confirmRestore(): Promise<boolean> {
  const enabled = vscode.workspace
    .getConfiguration('stageMirror')
    .get<boolean>('confirmBeforeRestore', true);
  if (!enabled) {
    return true;
  }

  const action = 'Restore Working Tree';
  const response = await vscode.window.showWarningMessage(
    CONFIRMATION_MESSAGE,
    { modal: true },
    action,
  );
  return response === action;
}

async function refreshGitSourceControl(output: vscode.OutputChannel): Promise<void> {
  try {
    if ((await vscode.commands.getCommands(true)).includes('git.refresh')) {
      await vscode.commands.executeCommand('git.refresh');
    }
  } catch (error: unknown) {
    output.appendLine(`Optional Git refresh failed: ${getErrorMessage(error)}`);
  }
}

function showFailures(
  output: vscode.OutputChannel,
  failures: readonly RestoreFailure[],
): void {
  output.appendLine(`[${new Date().toISOString()}] Restore failures:`);
  for (const failure of failures) {
    output.appendLine(failure.message);
  }
  output.appendLine('');
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
