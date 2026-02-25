/**
 * Webview provider for SourceTree-like Stage/Unstage UI
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as VSCodeGit from '../vendors/git';
import {
  getRepository,
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  discardFile,
  stageHunk,
  unstageHunk,
  discardHunk,
  getFileDiff,
} from './git-operations';

type MessageFromWebview =
  | { type: 'stageFile'; uri: string }
  | { type: 'unstageFile'; uri: string }
  | { type: 'stageAll' }
  | { type: 'unstageAll' }
  | { type: 'discardFile'; uri: string; status: string }
  | { type: 'stageHunk'; uri: string; hunkIndex: number }
  | { type: 'unstageHunk'; uri: string; hunkIndex: number }
  | { type: 'discardHunk'; uri: string; hunkIndex: number }
  | { type: 'selectFile'; uri: string; staged?: boolean }
  | { type: 'openFile'; uri: string }
  | { type: 'refresh' };

type MessageToWebview =
  | { type: 'update'; data: ViewData }
  | { type: 'error'; message: string };

interface ViewData {
  stagedFiles: FileEntry[];
  unstagedFiles: FileEntry[];
  selectedFile: SelectedFile | null;
}

interface FileEntry {
  uri: string;
  path: string;
  status: string;
}

interface SelectedFile {
  uri: string;
  path: string;
  staged: boolean;
  diff: string;
  hunks: Array<{
    index: number;
    header: string;
    content: string;
    newStart: number;
    newCount: number;
  }>;
}

function getChangeStatus(change: VSCodeGit.Change): string {
  const statusMap: Record<number, string> = {
    0: 'M', // INDEX_MODIFIED
    1: 'A', // INDEX_ADDED
    2: 'D', // INDEX_DELETED
    3: 'R', // INDEX_RENAMED
    4: 'C', // INDEX_COPIED
    5: 'M', // MODIFIED
    6: 'D', // DELETED
    7: 'U', // UNTRACKED
    8: '?', // INTENT_TO_ADD
  };
  return statusMap[change.status as number] ?? '?';
}

async function loadViewData(
  repo: VSCodeGit.Repository,
  selectedUri?: string,
  selectedStaged?: boolean,
): Promise<ViewData> {
  const root = repo.rootUri.fsPath;

  const stagedFiles: FileEntry[] = repo.state.indexChanges.map((c) => ({
    uri: c.uri.toString(),
    path: path.relative(root, c.uri.fsPath),
    status: getChangeStatus(c),
  }));

  const unstagedFiles: FileEntry[] = [
    ...repo.state.workingTreeChanges,
    ...repo.state.mergeChanges,
  ].map((c) => ({
    uri: c.uri.toString(),
    path: path.relative(root, c.uri.fsPath),
    status: getChangeStatus(c),
  }));

  let selectedFile: SelectedFile | null = null;
  if (selectedUri && selectedStaged !== undefined) {
    const filePath = path.relative(root, vscode.Uri.parse(selectedUri).fsPath);
    const { diff, parsed } = await getFileDiff(repo, filePath, selectedStaged);
    selectedFile = {
      uri: selectedUri,
      path: filePath,
      staged: selectedStaged,
      diff,
      hunks: parsed?.hunks ?? [],
    };
  }

  return { stagedFiles, unstagedFiles, selectedFile };
}

export class StagingViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _repo?: VSCodeGit.Repository;
  private _selectedUri?: string;
  private _selectedStaged?: boolean;
  private _stateListener?: vscode.Disposable;
  private _visibilityListener?: vscode.Disposable;
  private _refreshInFlight = false;
  private _refreshPending = false;
  private _refreshPendingSyncStatus = false;
  private _suppressNextStateChange = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    this._visibilityListener?.dispose();
    this._visibilityListener = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._refresh(true);
      }
    });
    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(this._handleMessage.bind(this));
    this._refresh(true);
  }

  private async _handleMessage(message: MessageFromWebview): Promise<void> {
    try {
      const repo = await getRepository();
      this._repo = repo;

      switch (message.type) {
        case 'stageFile': {
          await stageFile(repo, vscode.Uri.parse(message.uri));
          this._refresh();
          break;
        }
        case 'unstageFile': {
          await unstageFile(repo, vscode.Uri.parse(message.uri));
          this._refresh();
          break;
        }
        case 'stageAll': {
          await stageAllFiles(repo);
          this._refresh();
          break;
        }
        case 'unstageAll': {
          await unstageAllFiles(repo);
          this._refresh();
          break;
        }
        case 'discardFile': {
          const confirmDiscard = 'Discard';
          const selected = await vscode.window.showWarningMessage(
            '변경 내용을 되돌리시겠습니까? 이 작업은 취소할 수 없습니다.',
            { modal: true },
            confirmDiscard,
          );
          if (selected !== confirmDiscard) {
            break;
          }
          await discardFile(
            repo,
            vscode.Uri.parse(message.uri),
            message.status,
          );
          this._selectedUri = undefined;
          this._selectedStaged = undefined;
          this._refresh();
          break;
        }
        case 'stageHunk': {
          const filePath = path.relative(
            repo.rootUri.fsPath,
            vscode.Uri.parse(message.uri).fsPath,
          );
          const { parsed } = await getFileDiff(repo, filePath, false);
          if (parsed && parsed.hunks[message.hunkIndex]) {
            await stageHunk(
              repo,
              filePath,
              parsed.hunks[message.hunkIndex],
              parsed.header,
            );
            this._selectedUri = message.uri;
            this._selectedStaged = false;
            this._refresh();
          }
          break;
        }
        case 'unstageHunk': {
          const filePath = path.relative(
            repo.rootUri.fsPath,
            vscode.Uri.parse(message.uri).fsPath,
          );
          const { parsed } = await getFileDiff(repo, filePath, true);
          if (parsed && parsed.hunks[message.hunkIndex]) {
            await unstageHunk(
              repo,
              filePath,
              parsed.hunks[message.hunkIndex],
              parsed.header,
            );
            this._selectedUri = message.uri;
            this._selectedStaged = true;
            this._refresh();
          }
          break;
        }
        case 'discardHunk': {
          const filePath = path.relative(
            repo.rootUri.fsPath,
            vscode.Uri.parse(message.uri).fsPath,
          );
          const { parsed } = await getFileDiff(repo, filePath, false);
          if (parsed && parsed.hunks[message.hunkIndex]) {
            await discardHunk(
              repo,
              filePath,
              parsed.hunks[message.hunkIndex],
              parsed.header,
            );
            this._selectedUri = message.uri;
            this._selectedStaged = false;
            this._refresh();
          }
          break;
        }
        case 'selectFile': {
          this._selectedUri = message.uri;
          this._selectedStaged = message.staged ?? false;
          this._refresh();
          break;
        }
        case 'refresh':
          this._refresh();
          break;
        case 'openFile': {
          const parsed = vscode.Uri.parse(message.uri);
          const uri =
            parsed.scheme === 'file' ? vscode.Uri.file(parsed.fsPath) : parsed;
          try {
            await vscode.commands.executeCommand('vscode.open', uri);
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(
              `파일을 열 수 없습니다: ${path.basename(uri.fsPath)}. ${err}`,
            );
          }
          break;
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this._view?.webview.postMessage({
        type: 'error',
        message: err.message,
      } as MessageToWebview);
    }
  }

  private async _refresh(syncStatus = false): Promise<void> {
    if (!this._view) return;
    if (this._refreshInFlight) {
      this._refreshPending = true;
      this._refreshPendingSyncStatus =
        this._refreshPendingSyncStatus || syncStatus;
      return;
    }
    this._refreshInFlight = true;
    let nextSyncStatus = syncStatus;
    try {
      do {
        this._refreshPending = false;
        this._refreshPendingSyncStatus = false;
        try {
          const repo = this._repo ?? (await getRepository());
          if (repo !== this._repo) {
            this._stateListener?.dispose();
            this._repo = repo;
            this._stateListener = repo.state.onDidChange(() => {
              if (this._suppressNextStateChange) {
                this._suppressNextStateChange = false;
                return;
              }
              this._refresh();
            });
          }
          if (nextSyncStatus) {
            this._suppressNextStateChange = true;
            await repo.status();
          }
          const data = await loadViewData(
            repo,
            this._selectedUri,
            this._selectedStaged,
          );
          this._view?.webview.postMessage({
            type: 'update',
            data,
          } as MessageToWebview);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          this._view?.webview.postMessage({
            type: 'error',
            message: err.message,
          } as MessageToWebview);
        }
        nextSyncStatus = this._refreshPendingSyncStatus;
      } while (this._refreshPending);
    } finally {
      this._refreshInFlight = false;
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stage / Unstage</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .section {
      margin-bottom: 12px;
    }
    .section-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      padding: 4px 0;
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .file-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 4px;
      gap: 8px;
    }
    .file-item:hover { background: var(--vscode-list-hoverBackground); }
    .file-item.selected { background: var(--vscode-list-activeSelectionBackground); }
    .file-item .status {
      font-size: 10px;
      min-width: 14px;
      color: var(--vscode-descriptionForeground);
    }
    .file-item .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-actions {
      display: flex;
      gap: 4px;
      opacity: 0.8;
    }
    .btn {
      padding: 2px 8px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn:hover { opacity: 0.9; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-discard { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
    .diff-container {
      border-top: 1px solid var(--vscode-widget-border);
      margin-top: 12px;
      padding-top: 12px;
    }
    .diff-file-name {
      font-weight: 600;
      margin-bottom: 8px;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    .diff-file-name:hover { color: var(--vscode-textLink-activeForeground); }
    .hunk {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .hunk-header {
      padding: 6px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hunk-actions { display: flex; gap: 6px; }
    .hunk-content {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      max-height: 240px;
      overflow: auto;
      border-collapse: collapse;
    }
    .diff-table { width: 100%; border-collapse: collapse; }
    .diff-table td { padding: 0 8px; vertical-align: top; white-space: pre-wrap; word-break: break-all; }
    .diff-line-num { width: 1%; min-width: 3em; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
    .diff-line-num-old { background: rgba(255, 100, 100, 0.2); }
    .diff-line-num-new { background: rgba(100, 255, 100, 0.2); }
    .diff-line-add { background: rgba(0, 200, 0, 0.2); }
    .diff-line-remove { background: rgba(200, 0, 0, 0.2); }
    .diff-line-context { background: transparent; }
    .diff-gutter { width: 1%; min-width: 1.2em; text-align: center; font-weight: bold; }
    .diff-gutter-add { color: #2ea043; }
    .diff-gutter-remove { color: #cf222e; }
    .empty-state { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
    .error { color: var(--vscode-errorForeground); padding: 8px; }
  </style>
</head>
<body>
  <div id="error" class="error" style="display:none"></div>
  <div class="section">
    <div class="section-header">
      <span class="section-title">Staged files</span>
      <button class="btn btn-secondary" id="unstage-all-btn">Unstage All</button>
    </div>
    <ul id="staged-list" class="file-list"></ul>
  </div>
  <div class="section">
    <div class="section-header">
      <span class="section-title">Unstaged files</span>
      <button class="btn" id="stage-all-btn">Stage All</button>
    </div>
    <ul id="unstaged-list" class="file-list"></ul>
  </div>
  <div id="diff-container" class="diff-container" style="display:none">
    <div class="diff-file-name" id="diff-file-name"></div>
    <div id="hunks-container"></div>
  </div>
  <div id="empty-state" class="empty-state">Select a file to view diff</div>
  <script>
    const vscode = acquireVsCodeApi();
    const stagedList = document.getElementById('staged-list');
    const unstagedList = document.getElementById('unstaged-list');
    const diffContainer = document.getElementById('diff-container');
    const diffFileName = document.getElementById('diff-file-name');
    const hunksContainer = document.getElementById('hunks-container');
    const emptyState = document.getElementById('empty-state');
    const errorEl = document.getElementById('error');

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    function parseDiffLines(content) {
      const lines = content.split('\\n');
      if (lines.length === 0) return [];
      const headerMatch = lines[0].match(/@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/);
      let oldNum = headerMatch ? parseInt(headerMatch[1], 10) : 0;
      let newNum = headerMatch ? parseInt(headerMatch[3], 10) : 0;
      const result = [];
      for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const first = raw.charAt(0);
        const text = raw.length > 1 ? raw.substring(1) : '';
        if (first === '-') {
          result.push({ type: 'remove', oldNum: oldNum++, newNum: '', text: text });
        } else if (first === '+') {
          result.push({ type: 'add', oldNum: '', newNum: newNum++, text: text });
        } else {
          result.push({ type: 'context', oldNum: oldNum++, newNum: newNum++, text: first === ' ' ? raw.substring(1) : raw });
        }
      }
      return result;
    }
    function renderDiffLine(parsed) {
      const rowCls = parsed.type === 'add' ? 'diff-line-add' : parsed.type === 'remove' ? 'diff-line-remove' : 'diff-line-context';
      const gutterCls = parsed.type === 'add' ? 'diff-gutter-add' : parsed.type === 'remove' ? 'diff-gutter-remove' : '';
      const oldNumCls = parsed.type === 'remove' ? 'diff-line-num diff-line-num-old' : 'diff-line-num';
      const newNumCls = parsed.type === 'add' ? 'diff-line-num diff-line-num-new' : 'diff-line-num';
      const sign = parsed.type === 'add' ? '+' : parsed.type === 'remove' ? '-' : ' ';
      return '<tr class="' + rowCls + '">' +
        '<td class="' + oldNumCls + '">' + (parsed.oldNum !== '' ? parsed.oldNum : '') + '</td>' +
        '<td class="' + newNumCls + '">' + (parsed.newNum !== '' ? parsed.newNum : '') + '</td>' +
        '<td class="diff-gutter ' + gutterCls + '">' + escapeHtml(sign) + '</td>' +
        '<td class="diff-content">' + escapeHtml(parsed.text) + '</td></tr>';
    }

    function renderFileList(files, staged) {
      const list = staged ? stagedList : unstagedList;
      list.innerHTML = files.map(f => {
        const stageBtn = staged
          ? '<button class="btn btn-secondary" data-action="unstage" data-uri="' + escapeHtml(f.uri) + '">Unstage</button>'
          : '<button class="btn" data-action="stage" data-uri="' + escapeHtml(f.uri) + '">Stage</button>';
        const discardBtn = !staged
          ? '<button class="btn btn-discard" data-action="discard" data-uri="' + escapeHtml(f.uri) + '" data-status="' + escapeHtml(f.status) + '">Discard</button>'
          : '';
        return '<li class="file-item" data-uri="' + escapeHtml(f.uri) + '" data-staged="' + staged + '">' +
          '<span class="status">' + escapeHtml(f.status) + '</span>' +
          '<span class="path">' + escapeHtml(f.path) + '</span>' +
          '<span class="file-actions">' + stageBtn + discardBtn + '</span></li>';
      }).join('');
    }

    function renderDiff(selected) {
      if (!selected) {
        diffContainer.style.display = 'none';
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';
      diffContainer.style.display = 'block';
      diffFileName.textContent = selected.path + ' (' + (selected.staged ? 'staged' : 'unstaged') + ')';
      diffFileName.dataset.uri = selected.uri;
      hunksContainer.innerHTML = selected.hunks.map((hunk, i) => {
        const btnLabel = selected.staged ? 'Unstage hunk' : 'Stage hunk';
        const btnAction = selected.staged ? 'unstageHunk' : 'stageHunk';
        const discardBtn = !selected.staged
          ? '<button class="btn btn-discard" data-action="discardHunk" data-hunk-index="' + i + '">Discard hunk</button>'
          : '';
        const parsedLines = parseDiffLines(hunk.content);
        const rows = parsedLines.map(renderDiffLine).join('');
        return '<div class="hunk" data-hunk-index="' + i + '">' +
          '<div class="hunk-header">' +
          '<span>Hunk ' + (i + 1) + ': Lines ' + hunk.newStart + '-' + (hunk.newStart + hunk.newCount - 1) + '</span>' +
          '<span class="hunk-actions">' +
          '<button class="btn" data-action="' + btnAction + '" data-hunk-index="' + i + '">' + btnLabel + '</button>' +
          discardBtn +
          '</span></div>' +
          '<div class="hunk-content"><table class="diff-table"><tbody>' + rows + '</tbody></table></div></div>';
      }).join('');
    }

    function bindEvents() {
      document.getElementById('stage-all-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'stageAll' });
      });
      document.getElementById('unstage-all-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'unstageAll' });
      });
      stagedList.addEventListener('click', (e) => {
        const item = e.target.closest('.file-item');
        const btn = e.target.closest('[data-action]');
        if (btn && btn.dataset.action === 'unstage') {
          e.stopPropagation();
          vscode.postMessage({ type: 'unstageFile', uri: btn.dataset.uri });
        } else if (btn && btn.dataset.action === 'discard') {
          e.stopPropagation();
          vscode.postMessage({ type: 'discardFile', uri: btn.dataset.uri, status: btn.dataset.status });
        } else if (item) {
          vscode.postMessage({ type: 'selectFile', uri: item.dataset.uri, staged: item.dataset.staged === 'true' });
        }
      });
      unstagedList.addEventListener('click', (e) => {
        const item = e.target.closest('.file-item');
        const btn = e.target.closest('[data-action]');
        if (btn && btn.dataset.action === 'stage') {
          e.stopPropagation();
          vscode.postMessage({ type: 'stageFile', uri: btn.dataset.uri });
        } else if (btn && btn.dataset.action === 'discard') {
          e.stopPropagation();
          vscode.postMessage({ type: 'discardFile', uri: btn.dataset.uri, status: btn.dataset.status });
        } else if (item) {
          vscode.postMessage({ type: 'selectFile', uri: item.dataset.uri, staged: item.dataset.staged === 'true' });
        }
      });
      hunksContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (btn && (btn.dataset.action === 'stageHunk' || btn.dataset.action === 'unstageHunk' || btn.dataset.action === 'discardHunk')) {
          const uri = window._selectedFile?.uri;
          if (uri) {
            vscode.postMessage({
              type: btn.dataset.action,
              uri,
              hunkIndex: parseInt(btn.dataset.hunkIndex, 10),
            });
          }
        }
      });
      diffFileName.addEventListener('click', () => {
        if (window._selectedFile) {
          vscode.postMessage({ type: 'openFile', uri: window._selectedFile.uri });
        }
      });
    }

    window._selectedFile = null;
    bindEvents();
    vscode.postMessage({ type: 'refresh' });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'update') {
        errorEl.style.display = 'none';
        renderFileList(msg.data.stagedFiles, true);
        renderFileList(msg.data.unstagedFiles, false);
        window._selectedFile = msg.data.selectedFile;
        renderDiff(msg.data.selectedFile);
        [stagedList, unstagedList].forEach(list => {
          list.querySelectorAll('.file-item').forEach(el => {
            const uri = el.dataset.uri;
            const staged = el.dataset.staged === 'true';
            el.classList.toggle('selected', window._selectedFile && window._selectedFile.uri === uri && window._selectedFile.staged === staged);
          });
        });
      } else if (msg.type === 'error') {
        errorEl.textContent = msg.message;
        errorEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }
}
