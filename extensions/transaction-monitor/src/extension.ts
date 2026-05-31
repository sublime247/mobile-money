import * as vscode from "vscode";
import { WebSocket } from "ws";
import { LogViewProvider } from "./LogViewProvider";

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  const provider = new LogViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LogViewProvider.viewType,
      provider,
    ),
  );

  const connect = () => {
    const config = vscode.workspace.getConfiguration("transactionMonitor");
    const wsUrl = config.get<string>("wsUrl") || "ws://localhost:3000";

    if (ws) {
      ws.close();
    }

    try {
      ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        console.log("Connected to backend WebSocket");
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
        // Optional: subscribe to all if the backend supports a "monitor" mode
        // ws?.send(JSON.stringify({ type: 'subscribe', data: { all: true } }));
      });

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          provider.addLog(message);
        } catch (e) {
          provider.addLog({
            type: "RAW",
            data: data.toString(),
            status: "INFO",
          });
        }
      });

      ws.on("close", () => {
        console.log("WebSocket closed");
        scheduleReconnect();
      });

      ws.on("error", (err) => {
        console.error("WebSocket error:", err);
        scheduleReconnect();
      });
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (!reconnectTimer) {
      reconnectTimer = setInterval(connect, 5000);
    }
  };

  // Initial connection
  connect();

  // Re-connect if configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("transactionMonitor.wsUrl")) {
        connect();
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      if (ws) ws.close();
      if (reconnectTimer) clearInterval(reconnectTimer);
    },
  });
}

export function deactivate() {
  if (ws) {
    ws.close();
  }
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
  }
}
