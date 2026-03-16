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

type LayoutMode = 'sidebar' | 'editor';

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
    const selectedEntries = selectedStaged ? stagedFiles : unstagedFiles;
    const selectedEntry = selectedEntries.find(
      (file) => file.uri === selectedUri,
    );
    if (selectedEntry) {
      const filePath = path.relative(
        root,
        vscode.Uri.parse(selectedUri).fsPath,
      );
      const { diff, parsed } = await getFileDiff(
        repo,
        filePath,
        selectedStaged,
      );
      selectedFile = {
        uri: selectedUri,
        path: filePath,
        staged: selectedStaged,
        diff,
        hunks: parsed?.hunks ?? [],
      };
    }
  }

  return { stagedFiles, unstagedFiles, selectedFile };
}

export class StagingViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private _repo?: VSCodeGit.Repository;
  private _selectedUri?: string;
  private _selectedStaged?: boolean;
  private _stateListener?: vscode.Disposable;
  private _visibilityListener?: vscode.Disposable;
  private readonly _webviews = new Set<vscode.Webview>();
  private _refreshInFlight = false;
  private _refreshPending = false;
  private _refreshPendingSyncStatus = false;
  private _suppressNextStateChange = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public showEditorPanel(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      void this._refresh(true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'git-tools.stagingEditor',
      'Stage / Unstage',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      },
    );
    this._panel = panel;
    this._registerWebview(panel.webview, 'editor');
    panel.onDidDispose(() => {
      this._unregisterWebview(panel.webview);
      if (this._panel === panel) {
        this._panel = undefined;
      }
    });
    void this._refresh(true);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    if (this._view && this._view.webview !== webviewView.webview) {
      this._unregisterWebview(this._view.webview);
    }
    this._view = webviewView;
    this._visibilityListener?.dispose();
    this._visibilityListener = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this._refresh(true);
      }
    });
    this._registerWebview(webviewView.webview, 'sidebar');
    void this._refresh(true);
  }

  private _registerWebview(
    webview: vscode.Webview,
    layoutMode: LayoutMode,
  ): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webview.html = this._getHtml(webview, layoutMode);
    webview.onDidReceiveMessage(this._handleMessage.bind(this));
    this._webviews.add(webview);
  }

  private _unregisterWebview(webview: vscode.Webview): void {
    this._webviews.delete(webview);
  }

  private _broadcastMessage(message: MessageToWebview): void {
    for (const webview of this._webviews) {
      void webview.postMessage(message);
    }
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
      this._broadcastMessage({
        type: 'error',
        message: err.message,
      } as MessageToWebview);
    }
  }

  private async _refresh(syncStatus = false): Promise<void> {
    if (this._webviews.size === 0) return;
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
          if (!data.selectedFile) {
            this._selectedUri = undefined;
            this._selectedStaged = undefined;
          }
          this._broadcastMessage({
            type: 'update',
            data,
          } as MessageToWebview);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          this._broadcastMessage({
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

  private _getHtml(webview: vscode.Webview, layoutMode: LayoutMode): string {
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
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      min-height: 100vh;
    }
    .app {
      min-height: 100vh;
      padding: 8px;
    }
    .layout {
      display: block;
    }
    .file-column, .diff-column {
      min-height: 0;
    }
    .layout-divider {
      display: none;
    }
    .section {
      margin-bottom: 12px;
    }
    .section-panel {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
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
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editor-inactiveSelectionBackground);
      gap: 8px;
    }
    .section-body {
      min-height: 0;
      overflow: auto;
      padding: 6px;
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .file-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
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
      flex-shrink: 0;
    }
    .file-item .status.status-modified {
      color: var(--vscode-textLink-foreground);
    }
    .file-item .status.status-deleted {
      color: var(--vscode-errorForeground);
    }
    .file-item .status.status-untracked {
      color: var(--vscode-testing-iconPassed, #2ea043);
    }
    .file-item .path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-actions {
      display: flex;
      gap: 4px;
      opacity: 0.85;
      flex-shrink: 0;
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
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-discard {
      background: var(--vscode-errorForeground);
      color: var(--vscode-editor-background);
    }
    .diff-column {
      margin-top: 12px;
    }
    .diff-container {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      min-height: 320px;
    }
    .diff-file-name {
      font-weight: 600;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .diff-file-name:hover { color: var(--vscode-textLink-activeForeground); }
    #hunks-container {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px;
    }
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
      gap: 8px;
    }
    .hunk-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .hunk-content {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      min-height: 180px;
      overflow: auto;
      border-collapse: collapse;
    }
    .hunk-resize-handle {
      height: 10px;
      cursor: ns-resize;
      background: var(--vscode-editorWidget-border, var(--vscode-widget-border));
      border-top: 1px solid var(--vscode-widget-border);
    }
    .hunk-resize-handle:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
    }
    .diff-table td {
      padding: 0 8px;
      vertical-align: top;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-line-num {
      width: 1%;
      min-width: 3em;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      user-select: none;
    }
    .diff-line-num-old { background: rgba(255, 100, 100, 0.2); }
    .diff-line-num-new { background: rgba(100, 255, 100, 0.2); }
    .diff-line-add { background: rgba(0, 200, 0, 0.2); }
    .diff-line-remove { background: rgba(200, 0, 0, 0.2); }
    .diff-line-context { background: transparent; }
    .diff-gutter {
      width: 1%;
      min-width: 1.2em;
      text-align: center;
      font-weight: bold;
    }
    .diff-gutter-add { color: #2ea043; }
    .diff-gutter-remove { color: #cf222e; }
    .empty-state {
      color: var(--vscode-descriptionForeground);
      padding: 16px;
      text-align: center;
      border: 1px dashed var(--vscode-widget-border);
      border-radius: 6px;
      min-height: 240px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .error {
      color: var(--vscode-errorForeground);
      padding: 0 0 8px;
    }
    body.editor-layout .app {
      padding: 12px;
    }
    body.editor-layout .layout {
      display: grid;
      grid-template-columns: minmax(260px, var(--file-column-width, 320px)) 8px minmax(320px, 1fr);
      gap: 12px;
      height: calc(100vh - 24px);
      align-items: stretch;
    }
    body.editor-layout .file-column {
      display: grid;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    body.editor-layout .section {
      margin-bottom: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    body.editor-layout .section-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    body.editor-layout .section-body {
      flex: 1;
    }
    body.editor-layout .diff-column {
      margin-top: 0;
      height: 100%;
    }
    body.editor-layout .layout-divider {
      display: block;
      width: 8px;
      border-radius: 999px;
      cursor: col-resize;
      background: var(--vscode-widget-border);
      align-self: stretch;
      margin: 0 -6px;
      position: relative;
    }
    body.editor-layout .layout-divider:hover,
    body.editor-layout .layout-divider.dragging {
      background: var(--vscode-focusBorder);
    }
    body.editor-layout .layout-divider::after {
      content: '';
      position: absolute;
      inset: 0;
      left: 50%;
      width: 2px;
      transform: translateX(-50%);
      background: color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
    }
    body.editor-layout .diff-container {
      height: 100%;
      min-height: 100%;
    }
    body.editor-layout .empty-state {
      min-height: 100%;
    }
  </style>
</head>
<body class="${layoutMode}-layout">
  <div class="app">
    <div id="error" class="error" style="display:none"></div>
    <div class="layout">
      <div class="file-column">
        <div class="section section-panel">
          <div class="section-header">
            <span class="section-title">Staged files</span>
            <button class="btn btn-secondary" id="unstage-all-btn">Unstage All</button>
          </div>
          <div class="section-body">
            <ul id="staged-list" class="file-list"></ul>
          </div>
        </div>
        <div class="section section-panel">
          <div class="section-header">
            <span class="section-title">Unstaged files</span>
            <button class="btn" id="stage-all-btn">Stage All</button>
          </div>
          <div class="section-body">
            <ul id="unstaged-list" class="file-list"></ul>
          </div>
        </div>
      </div>
      <div id="layout-divider" class="layout-divider" title="Drag to resize panes"></div>
      <div class="diff-column">
        <div id="diff-container" class="diff-container" style="display:none">
          <div class="diff-file-name" id="diff-file-name"></div>
          <div id="hunks-container"></div>
        </div>
        <div id="empty-state" class="empty-state">Select a file to view diff</div>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const stagedList = document.getElementById('staged-list');
    const unstagedList = document.getElementById('unstaged-list');
    const diffContainer = document.getElementById('diff-container');
    const diffFileName = document.getElementById('diff-file-name');
    const hunksContainer = document.getElementById('hunks-container');
    const emptyState = document.getElementById('empty-state');
    const errorEl = document.getElementById('error');
    const layout = document.querySelector('.layout');
    const layoutDivider = document.getElementById('layout-divider');
    const initialState = vscode.getState() || {};
    const MIN_HUNK_HEIGHT = 180;
    const DEFAULT_HUNK_HEIGHT = 240;
    const MAX_HUNK_HEIGHT = 720;
    const MIN_FILE_COLUMN_WIDTH = 260;
    const DEFAULT_FILE_COLUMN_WIDTH = 320;

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    function getSelectedFileKey(selected) {
      return selected ? selected.uri + ':' + selected.staged : null;
    }

    function persistState() {
      vscode.setState({
        scrollByFile: window._scrollByFile,
        heightByFile: window._heightByFile,
        fileColumnWidth: window._fileColumnWidth,
      });
    }

    function clampFileColumnWidth(width) {
      const maxWidth = Math.max(
        MIN_FILE_COLUMN_WIDTH,
        Math.floor((window.innerWidth || 1200) * 0.55),
      );
      return Math.max(
        MIN_FILE_COLUMN_WIDTH,
        Math.min(maxWidth, Math.round(width)),
      );
    }

    function applyFileColumnWidth(width, shouldPersist = true) {
      if (!document.body.classList.contains('editor-layout')) return;
      const nextWidth = clampFileColumnWidth(width);
      window._fileColumnWidth = nextWidth;
      layout.style.setProperty('--file-column-width', nextWidth + 'px');
      if (shouldPersist) {
        persistState();
      }
    }

    function clampHunkHeight(height) {
      return Math.max(
        MIN_HUNK_HEIGHT,
        Math.min(MAX_HUNK_HEIGHT, Math.round(height)),
      );
    }

    function getStoredHunkHeights(selected = window._selectedFile) {
      const fileKey = getSelectedFileKey(selected);
      return fileKey ? window._heightByFile[fileKey] || {} : {};
    }

    function getAutoHunkHeight(hunkCount) {
      const viewportHeight = window.innerHeight || 800;
      const availableHeight = Math.max(DEFAULT_HUNK_HEIGHT, viewportHeight - 320);
      if (hunkCount <= 1) {
        return clampHunkHeight(Math.min(availableHeight, 520));
      }
      if (hunkCount === 2) {
        return clampHunkHeight(Math.min(Math.floor(availableHeight / 2), 420));
      }
      if (hunkCount === 3) {
        return clampHunkHeight(Math.min(Math.floor(availableHeight / 3), 320));
      }
      return DEFAULT_HUNK_HEIGHT;
    }

    function getHunkHeight(selected, hunkIndex) {
      const storedHeight = getStoredHunkHeights(selected)[hunkIndex];
      if (storedHeight) {
        return clampHunkHeight(storedHeight);
      }
      const hunkCount = selected?.hunks?.length || 0;
      return getAutoHunkHeight(hunkCount);
    }

    function setHunkHeight(hunkIndex, height, selected = window._selectedFile) {
      const fileKey = getSelectedFileKey(selected);
      if (!fileKey) return;
      window._heightByFile[fileKey] = window._heightByFile[fileKey] || {};
      const nextHeight = clampHunkHeight(height);
      window._heightByFile[fileKey][hunkIndex] = nextHeight;
      const contentEl = hunksContainer.querySelector(
        '.hunk[data-hunk-index="' + hunkIndex + '"] .hunk-content',
      );
      if (contentEl) {
        contentEl.style.height = nextHeight + 'px';
      }
      persistState();
    }

    function captureHunkScrollState(selected = window._selectedFile) {
      const fileKey = getSelectedFileKey(selected);
      if (!fileKey) return;

      const scrollState = {};
      hunksContainer.querySelectorAll('.hunk').forEach((hunkEl) => {
        const hunkIndex = hunkEl.dataset.hunkIndex;
        const contentEl = hunkEl.querySelector('.hunk-content');
        if (hunkIndex !== undefined && contentEl) {
          scrollState[hunkIndex] = contentEl.scrollTop;
        }
      });
      window._scrollByFile[fileKey] = scrollState;
      persistState();
    }

    function restoreHunkScrollState(selected) {
      const fileKey = getSelectedFileKey(selected);
      const scrollState = fileKey ? window._scrollByFile[fileKey] || {} : {};
      hunksContainer.querySelectorAll('.hunk').forEach((hunkEl) => {
        const hunkIndex = hunkEl.dataset.hunkIndex;
        const contentEl = hunkEl.querySelector('.hunk-content');
        if (!contentEl) return;
        contentEl.scrollTop = Number(scrollState[hunkIndex] || 0);
      });
    }

    function parseDiffLines(content) {
      const lines = content.split('\\n');
      if (lines.length === 0) return [];
      const headerMatch = lines[0].match(
        /@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/,
      );
      let oldNum = headerMatch ? parseInt(headerMatch[1], 10) : 0;
      let newNum = headerMatch ? parseInt(headerMatch[3], 10) : 0;
      const result = [];
      for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const first = raw.charAt(0);
        const text = raw.length > 1 ? raw.substring(1) : '';
        if (first === '-') {
          result.push({ type: 'remove', oldNum: oldNum++, newNum: '', text });
        } else if (first === '+') {
          result.push({ type: 'add', oldNum: '', newNum: newNum++, text });
        } else {
          result.push({
            type: 'context',
            oldNum: oldNum++,
            newNum: newNum++,
            text: first === ' ' ? raw.substring(1) : raw,
          });
        }
      }
      return result;
    }

    function renderDiffLine(parsed) {
      const rowCls =
        parsed.type === 'add'
          ? 'diff-line-add'
          : parsed.type === 'remove'
            ? 'diff-line-remove'
            : 'diff-line-context';
      const gutterCls =
        parsed.type === 'add'
          ? 'diff-gutter-add'
          : parsed.type === 'remove'
            ? 'diff-gutter-remove'
            : '';
      const oldNumCls =
        parsed.type === 'remove'
          ? 'diff-line-num diff-line-num-old'
          : 'diff-line-num';
      const newNumCls =
        parsed.type === 'add'
          ? 'diff-line-num diff-line-num-new'
          : 'diff-line-num';
      const sign = parsed.type === 'add' ? '+' : parsed.type === 'remove' ? '-' : ' ';
      return (
        '<tr class="' +
        rowCls +
        '">' +
        '<td class="' +
        oldNumCls +
        '">' +
        (parsed.oldNum !== '' ? parsed.oldNum : '') +
        '</td>' +
        '<td class="' +
        newNumCls +
        '">' +
        (parsed.newNum !== '' ? parsed.newNum : '') +
        '</td>' +
        '<td class="diff-gutter ' +
        gutterCls +
        '">' +
        escapeHtml(sign) +
        '</td>' +
        '<td class="diff-content">' +
        escapeHtml(parsed.text) +
        '</td></tr>'
      );
    }

    function renderFileList(files, staged) {
      const list = staged ? stagedList : unstagedList;
      list.innerHTML = files
        .map((f) => {
          const statusClass =
            f.status === 'M'
              ? 'status-modified'
              : f.status === 'D'
                ? 'status-deleted'
                : f.status === 'U'
                  ? 'status-untracked'
                  : '';
          const stageBtn = staged
            ? '<button class="btn btn-secondary" data-action="unstage" data-uri="' +
              escapeHtml(f.uri) +
              '">Unstage</button>'
            : '<button class="btn" data-action="stage" data-uri="' +
              escapeHtml(f.uri) +
              '">Stage</button>';
          const discardBtn = !staged
            ? '<button class="btn btn-discard" data-action="discard" data-uri="' +
              escapeHtml(f.uri) +
              '" data-status="' +
              escapeHtml(f.status) +
              '">Discard</button>'
            : '';
          return (
            '<li class="file-item" data-uri="' +
            escapeHtml(f.uri) +
            '" data-staged="' +
            staged +
            '">' +
            '<span class="status ' +
            statusClass +
            '">' +
            escapeHtml(f.status) +
            '</span>' +
            '<span class="path">' +
            escapeHtml(f.path) +
            '</span>' +
            '<span class="file-actions">' +
            stageBtn +
            discardBtn +
            '</span></li>'
          );
        })
        .join('');
    }

    function renderDiff(selected) {
      if (!selected) {
        diffContainer.style.display = 'none';
        emptyState.style.display = 'flex';
        hunksContainer.innerHTML = '';
        return;
      }
      emptyState.style.display = 'none';
      diffContainer.style.display = 'flex';
      diffFileName.textContent =
        selected.path + ' (' + (selected.staged ? 'staged' : 'unstaged') + ')';
      diffFileName.dataset.uri = selected.uri;
      hunksContainer.innerHTML = selected.hunks
        .map((hunk, i) => {
          const btnLabel = selected.staged ? 'Unstage hunk' : 'Stage hunk';
          const btnAction = selected.staged ? 'unstageHunk' : 'stageHunk';
          const hunkHeight = getHunkHeight(selected, i);
          const discardBtn = !selected.staged
            ? '<button class="btn btn-discard" data-action="discardHunk" data-hunk-index="' +
              i +
              '">Discard hunk</button>'
            : '';
          const parsedLines = parseDiffLines(hunk.content);
          const rows = parsedLines.map(renderDiffLine).join('');
          return (
            '<div class="hunk" data-hunk-index="' +
            i +
            '">' +
            '<div class="hunk-header">' +
            '<span>Hunk ' +
            (i + 1) +
            ': Lines ' +
            hunk.newStart +
            '-' +
            (hunk.newStart + hunk.newCount - 1) +
            '</span>' +
            '<span class="hunk-actions">' +
            '<button class="btn" data-action="' +
            btnAction +
            '" data-hunk-index="' +
            i +
            '">' +
            btnLabel +
            '</button>' +
            discardBtn +
            '</span></div>' +
            '<div class="hunk-content" style="height:' +
            hunkHeight +
            'px"><table class="diff-table"><tbody>' +
            rows +
            '</tbody></table></div>' +
            '<div class="hunk-resize-handle" data-hunk-index="' +
            i +
            '" title="Drag to resize"></div></div>'
          );
        })
        .join('');
      restoreHunkScrollState(selected);
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
          vscode.postMessage({
            type: 'discardFile',
            uri: btn.dataset.uri,
            status: btn.dataset.status,
          });
        } else if (item) {
          vscode.postMessage({
            type: 'selectFile',
            uri: item.dataset.uri,
            staged: item.dataset.staged === 'true',
          });
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
          vscode.postMessage({
            type: 'discardFile',
            uri: btn.dataset.uri,
            status: btn.dataset.status,
          });
        } else if (item) {
          vscode.postMessage({
            type: 'selectFile',
            uri: item.dataset.uri,
            staged: item.dataset.staged === 'true',
          });
        }
      });
      hunksContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (
          btn &&
          (btn.dataset.action === 'stageHunk' ||
            btn.dataset.action === 'unstageHunk' ||
            btn.dataset.action === 'discardHunk')
        ) {
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
      hunksContainer.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.hunk-resize-handle');
        if (!handle || !window._selectedFile) return;

        e.preventDefault();
        const hunkEl = handle.closest('.hunk');
        const contentEl = hunkEl && hunkEl.querySelector('.hunk-content');
        if (!contentEl) return;

        const hunkIndex = parseInt(handle.dataset.hunkIndex, 10);
        const startY = e.clientY;
        const startHeight = contentEl.getBoundingClientRect().height;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (moveEvent) => {
          const delta = moveEvent.clientY - startY;
          setHunkHeight(hunkIndex, startHeight + delta);
        };
        const onMouseUp = () => {
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
      if (layoutDivider) {
        layoutDivider.addEventListener('mousedown', (e) => {
          if (!document.body.classList.contains('editor-layout')) return;

          e.preventDefault();
          layoutDivider.classList.add('dragging');
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';

          const onMouseMove = (moveEvent) => {
            const rect = layout.getBoundingClientRect();
            const nextWidth = moveEvent.clientX - rect.left;
            applyFileColumnWidth(nextWidth);
          };
          const onMouseUp = () => {
            layoutDivider.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });
      }
      diffFileName.addEventListener('click', () => {
        if (window._selectedFile) {
          vscode.postMessage({ type: 'openFile', uri: window._selectedFile.uri });
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        if (!window._selectedFile) return;

        const list = window._selectedFile.staged ? stagedList : unstagedList;
        const items = Array.from(list.querySelectorAll('.file-item'));
        if (items.length === 0) return;

        const currentIndex = items.findIndex(
          (el) => el.dataset.uri === window._selectedFile.uri,
        );
        if (currentIndex < 0) return;

        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = currentIndex + delta;
        if (nextIndex < 0 || nextIndex >= items.length) return;

        e.preventDefault();
        const nextEl = items[nextIndex];
        vscode.postMessage({
          type: 'selectFile',
          uri: nextEl.dataset.uri,
          staged: nextEl.dataset.staged === 'true',
        });
        nextEl.scrollIntoView({ block: 'nearest' });
      });
    }

    window._selectedFile = null;
    window._scrollByFile = initialState.scrollByFile || {};
    window._heightByFile = initialState.heightByFile || {};
    window._fileColumnWidth =
      initialState.fileColumnWidth || DEFAULT_FILE_COLUMN_WIDTH;
    applyFileColumnWidth(window._fileColumnWidth, false);
    bindEvents();
    vscode.postMessage({ type: 'refresh' });

    hunksContainer.addEventListener(
      'scroll',
      (e) => {
        if (!e.target.classList.contains('hunk-content')) return;
        captureHunkScrollState();
      },
      true,
    );

    window.addEventListener('resize', () => {
      applyFileColumnWidth(window._fileColumnWidth, false);
      if (!window._selectedFile) return;
      captureHunkScrollState();
      renderDiff(window._selectedFile);
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'update') {
        captureHunkScrollState();
        errorEl.style.display = 'none';
        renderFileList(msg.data.stagedFiles, true);
        renderFileList(msg.data.unstagedFiles, false);
        window._selectedFile = msg.data.selectedFile;
        renderDiff(msg.data.selectedFile);
        [stagedList, unstagedList].forEach((list) => {
          list.querySelectorAll('.file-item').forEach((el) => {
            const uri = el.dataset.uri;
            const staged = el.dataset.staged === 'true';
            el.classList.toggle(
              'selected',
              window._selectedFile &&
                window._selectedFile.uri === uri &&
                window._selectedFile.staged === staged,
            );
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
