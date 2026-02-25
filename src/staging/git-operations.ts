/**
 * Git operations for file-level and hunk-level stage/unstage
 */

import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as VSCodeGit from '../vendors/git';
import { ParsedDiff, Hunk, parseDiff, buildPatch } from './diff-parser';

function getGitAPI(): VSCodeGit.API {
  const vscodeGit = vscode.extensions.getExtension('vscode.git');
  if (!vscodeGit?.exports.getAPI(1)) {
    throw new Error('Git extension is not enabled');
  }
  return vscodeGit.exports.getAPI(1);
}

export async function getRepository(
  uri?: vscode.Uri,
): Promise<VSCodeGit.Repository> {
  const git = getGitAPI();
  if (git.repositories.length === 0) {
    throw new Error('No git repository found');
  }
  if (uri) {
    const repo = git.getRepository(uri);
    if (repo) return repo;
  }
  return git.repositories[0];
}

/**
 * Stage a file (file-level)
 */
export async function stageFile(
  repo: VSCodeGit.Repository,
  fileUri: vscode.Uri,
): Promise<void> {
  const root = repo.rootUri.fsPath;
  const filePath = path.relative(root, fileUri.fsPath);
  const result = spawnSync('git', ['add', '--', filePath], { cwd: root });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || 'Failed to stage file');
  }
  await repo.status();
}

/**
 * Unstage a file (file-level)
 */
export async function unstageFile(
  repo: VSCodeGit.Repository,
  fileUri: vscode.Uri,
): Promise<void> {
  const root = repo.rootUri.fsPath;
  const filePath = path.relative(root, fileUri.fsPath);
  const result = spawnSync('git', ['reset', 'HEAD', '--', filePath], {
    cwd: root,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || 'Failed to unstage file');
  }
  await repo.status();
}

/**
 * Stage all files
 */
export async function stageAllFiles(repo: VSCodeGit.Repository): Promise<void> {
  const root = repo.rootUri.fsPath;
  const result = spawnSync('git', ['add', '-A'], { cwd: root });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || 'Failed to stage all files');
  }
  await repo.status();
}

/**
 * Unstage all files
 */
export async function unstageAllFiles(
  repo: VSCodeGit.Repository,
): Promise<void> {
  const root = repo.rootUri.fsPath;
  const result = spawnSync('git', ['reset', 'HEAD'], { cwd: root });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || 'Failed to unstage all files');
  }
  await repo.status();
}

/**
 * Discard changes for a file (revert to HEAD / remove untracked)
 */
export async function discardFile(
  repo: VSCodeGit.Repository,
  fileUri: vscode.Uri,
  status: string,
): Promise<void> {
  const root = repo.rootUri.fsPath;
  const filePath = path.relative(root, fileUri.fsPath);
  const fullPath = path.join(root, filePath);
  const fs = require('fs');

  if (status === 'U') {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } else {
    const result = spawnSync(
      'git',
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath],
      {
        cwd: root,
      },
    );
    if (result.status !== 0) {
      const fallback = spawnSync('git', ['checkout', 'HEAD', '--', filePath], {
        cwd: root,
      });
      if (fallback.status !== 0) {
        throw new Error(result.stderr?.toString() || 'Failed to discard file');
      }
    }
  }
  await repo.status();
}

/**
 * Stage a hunk (hunk-level) - applies patch to index
 */
export async function stageHunk(
  repo: VSCodeGit.Repository,
  filePath: string,
  hunk: Hunk,
  header: string,
): Promise<void> {
  const root = repo.rootUri.fsPath;
  const fullPath = path.join(root, filePath);

  const patch = buildPatch(header, [hunk]);
  const patchPath = path.join(root, '.git-tools-hunk.patch');
  const fs = require('fs');
  fs.writeFileSync(patchPath, patch, 'utf8');

  try {
    const result = spawnSync('git', ['apply', '--cached', patchPath], {
      cwd: root,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Failed to stage hunk');
    }
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      // ignore
    }
  }
  await repo.status();
}

/**
 * Unstage a hunk (hunk-level) - applies reverse patch to index
 */
export async function unstageHunk(
  repo: VSCodeGit.Repository,
  filePath: string,
  hunk: Hunk,
  header: string,
): Promise<void> {
  const root = repo.rootUri.fsPath;

  const patch = buildPatch(header, [hunk]);
  const patchPath = path.join(root, '.git-tools-hunk.patch');
  const fs = require('fs');
  fs.writeFileSync(patchPath, patch, 'utf8');

  try {
    const result = spawnSync(
      'git',
      ['apply', '--cached', '--reverse', patchPath],
      {
        cwd: root,
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Failed to unstage hunk');
    }
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      // ignore
    }
  }
  await repo.status();
}

/**
 * Discard a hunk (hunk-level) - applies reverse patch to working tree
 */
export async function discardHunk(
  repo: VSCodeGit.Repository,
  filePath: string,
  hunk: Hunk,
  header: string,
): Promise<void> {
  const root = repo.rootUri.fsPath;

  const patch = buildPatch(header, [hunk]);
  const patchPath = path.join(root, '.git-tools-hunk.patch');
  const fs = require('fs');
  fs.writeFileSync(patchPath, patch, 'utf8');

  try {
    const result = spawnSync('git', ['apply', '--reverse', patchPath], {
      cwd: root,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Failed to discard hunk');
    }
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      // ignore
    }
  }
  await repo.status();
}

/**
 * Get unstaged diff for a file (working tree vs index)
 */
export async function getUnstagedDiff(
  repo: VSCodeGit.Repository,
  filePath: string,
): Promise<string> {
  return repo.diffIndexWithHEAD(filePath);
}

/**
 * Get staged diff for a file (index vs HEAD)
 */
export async function getStagedDiff(
  repo: VSCodeGit.Repository,
  filePath: string,
): Promise<string> {
  return repo.diffIndexWithHEAD(filePath);
}

/**
 * Get diff for a file - staged (index vs HEAD) or unstaged (working tree vs index)
 */
export async function getFileDiff(
  repo: VSCodeGit.Repository,
  filePath: string,
  staged: boolean,
): Promise<{ diff: string; parsed: ParsedDiff | null }> {
  const root = repo.rootUri.fsPath;
  let diff: string;
  if (staged) {
    diff = await repo.diffIndexWithHEAD(filePath);
  } else {
    try {
      const result = spawnSync('git', ['diff', '--', filePath], {
        cwd: root,
        encoding: 'utf8',
      });
      diff = result.stdout || '';
    } catch {
      diff = '';
    }
  }
  const parsed = parseDiff(diff, filePath);
  return { diff, parsed };
}
