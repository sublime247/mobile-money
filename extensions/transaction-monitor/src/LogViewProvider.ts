import * as vscode from "vscode";

export class LogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "transaction-monitor.liveLogs";

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case "colorSelected": {
          vscode.window.activeTextEditor?.insertSnippet(
            new vscode.SnippetString(`#${data.value}`),
          );
          break;
        }
      }
    });
  }

  public addLog(log: any) {
    if (this._view) {
      this._view.show?.(true); // `show` is not always available on all types of views, but for WebviewView it works.
      this._view.webview.postMessage({ type: "addLog", log });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Live Logs</title>
                <style>
                    :root {
                        --bg-color: #0d1117;
                        --card-bg: #161b22;
                        --border-color: #30363d;
                        --text-main: #c9d1d9;
                        --text-muted: #8b949e;
                        --accent-blue: #58a6ff;
                        --status-success: #3fb950;
                        --status-error: #f85149;
                        --status-pending: #d29922;
                    }

                    body {
                        background-color: var(--bg-color);
                        color: var(--text-main);
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        margin: 0;
                        padding: 12px;
                        overflow-x: hidden;
                    }

                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 16px;
                        padding-bottom: 8px;
                        border-bottom: 1px solid var(--border-color);
                    }

                    .header h2 {
                        font-size: 14px;
                        font-weight: 600;
                        margin: 0;
                        color: var(--accent-blue);
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                    }

                    .status-indicator {
                        display: flex;
                        align-items: center;
                        font-size: 11px;
                        color: var(--text-muted);
                    }

                    .status-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background-color: var(--status-pending);
                        margin-right: 6px;
                        box-shadow: 0 0 8px var(--status-pending);
                    }

                    .status-dot.connected {
                        background-color: var(--status-success);
                        box-shadow: 0 0 8px var(--status-success);
                    }

                    .logs-container {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }

                    .log-entry {
                        background-color: var(--card-bg);
                        border: 1px solid var(--border-color);
                        border-radius: 6px;
                        padding: 10px;
                        font-size: 12px;
                        animation: slideIn 0.3s ease-out;
                        transition: transform 0.2s, border-color 0.2s;
                    }

                    .log-entry:hover {
                        transform: translateX(4px);
                        border-color: var(--accent-blue);
                    }

                    @keyframes slideIn {
                        from { opacity: 0; transform: translateY(10px); }
                        to { opacity: 1; transform: translateY(0); }
                    }

                    .log-header {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 6px;
                    }

                    .log-type {
                        font-weight: bold;
                        color: var(--accent-blue);
                    }

                    .log-time {
                        color: var(--text-muted);
                        font-size: 10px;
                    }

                    .log-body {
                        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
                        word-break: break-all;
                        white-space: pre-wrap;
                        color: var(--text-main);
                    }

                    .status-tag {
                        display: inline-block;
                        padding: 2px 6px;
                        border-radius: 12px;
                        font-size: 10px;
                        font-weight: 600;
                        margin-top: 4px;
                    }

                    .status-tag.completed { background: rgba(63, 185, 80, 0.15); color: var(--status-success); }
                    .status-tag.failed { background: rgba(248, 81, 73, 0.15); color: var(--status-error); }
                    .status-tag.pending { background: rgba(210, 153, 34, 0.15); color: var(--status-pending); }

                    .empty-state {
                        text-align: center;
                        color: var(--text-muted);
                        margin-top: 40px;
                        font-style: italic;
                    }
                </style>
			</head>
			<body>
				<div class="header">
                    <h2>Live Activity</h2>
                    <div class="status-indicator">
                        <div id="statusDot" class="status-dot"></div>
                        <span id="statusText">Connecting...</span>
                    </div>
                </div>

                <div id="logs" class="logs-container">
                    <div class="empty-state">Waiting for transactions...</div>
                </div>

				<script>
					const vscode = acquireVsCodeApi();
                    const logsContainer = document.getElementById('logs');
                    const statusDot = document.getElementById('statusDot');
                    const statusText = document.getElementById('statusText');

					window.addEventListener('message', event => {
						const message = event.data;
						switch (message.type) {
							case 'addLog':
								appendLog(message.log);
								break;
                            case 'updateStatus':
                                updateStatus(message.status);
                                break;
						}
					});

                    function updateStatus(status) {
                        if (status === 'connected') {
                            statusDot.classList.add('connected');
                            statusText.textContent = 'Live';
                        } else {
                            statusDot.classList.remove('connected');
                            statusText.textContent = 'Disconnected';
                        }
                    }

                    function appendLog(log) {
                        const emptyState = logsContainer.querySelector('.empty-state');
                        if (emptyState) emptyState.remove();

                        const entry = document.createElement('div');
                        entry.className = 'log-entry';
                        
                        const time = new Date().toLocaleTimeString();
                        const statusClass = log.status?.toLowerCase() || 'pending';
                        
                        entry.innerHTML = \`
                            <div class="log-header">
                                <span class="log-type">\${log.type || 'TRANSACTION'}</span>
                                <span class="log-time">\${time}</span>
                            </div>
                            <div class="log-body">\${JSON.stringify(log.data || log, null, 2)}</div>
                            <span class="status-tag \${statusClass}">\${log.status || 'PENDING'}</span>
                        \`;

                        logsContainer.prepend(entry);
                        
                        // Keep only last 50 logs
                        if (logsContainer.children.length > 50) {
                            logsContainer.removeChild(logsContainer.lastChild);
                        }
                    }

                    // For prototyping: mark as connected immediately if this was just a UI refresh
                    // In real extension, the status comes from extension.ts
                    // updateStatus('connected');
				</script>
			</body>
			</html>`;
  }
}
