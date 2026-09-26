import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

export type TrackerStep = "initiated" | "ussd_prompted" | "confirmed" | "stellar_minted";
export type TrackerStatus = "active" | "completed" | "timed_out" | "failed";

export interface TransactionStepInfo {
  key: TrackerStep;
  title: string;
  description: string;
}

export const TRANSACTION_STEPS: TransactionStepInfo[] = [
  {
    key: "initiated",
    title: "Initiated",
    description: "Transaction submitted to mobile money gateway",
  },
  {
    key: "ussd_prompted",
    title: "USSD Prompted",
    description: "Check phone screen and enter your mobile money PIN",
  },
  {
    key: "confirmed",
    title: "Confirmed",
    description: "Funds received from mobile operator",
  },
  {
    key: "stellar_minted",
    title: "Stellar Minted",
    description: "Tokens minted & credited on the Stellar ledger",
  },
];

export interface TransactionEventPayload {
  step: TrackerStep;
  status: TrackerStatus;
  transactionId: string;
  stellarTxHash?: string;
  amount?: string;
  asset?: string;
  provider?: string;
  message?: string;
  timestamp?: number;
}

export interface TransactionTrackerProps {
  transactionId: string;
  wsUrl?: string;
  sseUrl?: string;
  timeoutSeconds?: number;
  initialStep?: TrackerStep;
  provider?: "mtn" | "airtel" | "orange" | "mpesa";
  theme?: "light" | "dark";
  onComplete?: (payload: TransactionEventPayload) => void;
  onError?: (error: Error | string) => void;
  onTimeout?: () => void;
  onRetry?: () => void;
}

export const TransactionTracker: React.FC<TransactionTrackerProps> = ({
  transactionId,
  wsUrl,
  sseUrl,
  timeoutSeconds = 180,
  initialStep = "initiated",
  provider = "mtn",
  theme = "light",
  onComplete,
  onError,
  onTimeout,
  onRetry,
}) => {
  const [currentStep, setCurrentStep] = useState<TrackerStep>(initialStep);
  const [status, setStatus] = useState<TrackerStatus>("active");
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [stellarTxHash, setStellarTxHash] = useState<string | undefined>();
  const [statusMessage, setStatusMessage] = useState<string>("Waiting for gateway response...");
  const [reconnectAttempts, setReconnectAttempts] = useState<number>(0);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Step indices
  const stepKeys = useMemo(() => TRANSACTION_STEPS.map((s) => s.key), []);
  const currentStepIndex = stepKeys.indexOf(currentStep);

  // Format seconds to mm:ss
  const formatTime = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Provider specific prompt hints
  const getProviderPromptHint = (prov: string): string => {
    switch (prov.toLowerCase()) {
      case "mtn":
        return "MTN Mobile Money: Dial *126# or check your screen for the MoMo approval prompt.";
      case "orange":
        return "Orange Money: Dial #150*50# to authorize the pending debit.";
      case "airtel":
        return "Airtel Money: Check your handset for the automatic PIN authorization flash prompt.";
      case "mpesa":
        return "M-Pesa: Enter your M-Pesa PIN on the STK push screen to authorize payment.";
      default:
        return "Please inspect your mobile device and approve the transaction prompt.";
    }
  };

  // Handle incoming transaction state update
  const handleStateUpdate = useCallback(
    (payload: TransactionEventPayload) => {
      if (payload.step) {
        setCurrentStep(payload.step);
      }
      if (payload.stellarTxHash) {
        setStellarTxHash(payload.stellarTxHash);
      }
      if (payload.message) {
        setStatusMessage(payload.message);
      }
      if (payload.status === "completed" || payload.step === "stellar_minted") {
        setStatus("completed");
        onComplete?.(payload);
      } else if (payload.status === "failed") {
        setStatus("failed");
        onError?.(payload.message || "Transaction marked as failed by provider");
      }
    },
    [onComplete, onError]
  );

  // Timer interval & timeout handling
  useEffect(() => {
    if (status !== "active") {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => {
        const next = prev + 1;
        if (next >= timeoutSeconds) {
          setStatus("timed_out");
          setStatusMessage("Payment request timed out waiting for provider confirmation.");
          onTimeout?.();
          if (timerRef.current) clearInterval(timerRef.current);
        }
        return next;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status, timeoutSeconds, onTimeout]);

  // Connect WebSocket with exponential backoff reconnection
  const connectWebSocket = useCallback(() => {
    if (!wsUrl || typeof WebSocket === "undefined") {
      return;
    }

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        setReconnectAttempts(0);
        socket.send(
          JSON.stringify({
            action: "subscribe",
            transactionId,
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const data: TransactionEventPayload = JSON.parse(event.data);
          if (data.transactionId === transactionId) {
            handleStateUpdate(data);
          }
        } catch {
          // Ignore invalid JSON messages
        }
      };

      socket.onerror = () => {
        setIsConnected(false);
      };

      socket.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        // Reconnection logic: Exponential backoff up to 5 attempts
        if (status === "active") {
          setReconnectAttempts((prev) => {
            if (prev < 5) {
              const delay = Math.min(1000 * Math.pow(2, prev), 16000);
              reconnectTimeoutRef.current = setTimeout(() => {
                connectWebSocket();
              }, delay);
              return prev + 1;
            }
            return prev;
          });
        }
      };
    } catch {
      setIsConnected(false);
    }
  }, [wsUrl, transactionId, handleStateUpdate, status]);

  // Connect SSE fallback
  const connectSSE = useCallback(() => {
    if (!sseUrl || typeof EventSource === "undefined") {
      return;
    }

    try {
      const eventSource = new EventSource(`${sseUrl}?transactionId=${encodeURIComponent(transactionId)}`);
      sseRef.current = eventSource;

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data: TransactionEventPayload = JSON.parse(event.data);
          handleStateUpdate(data);
        } catch {
          // Ignore parsing error
        }
      };

      eventSource.onerror = () => {
        setIsConnected(false);
        eventSource.close();
      };
    } catch {
      setIsConnected(false);
    }
  }, [sseUrl, transactionId, handleStateUpdate]);

  // Initial connection
  useEffect(() => {
    if (wsUrl) {
      connectWebSocket();
    } else if (sseUrl) {
      connectSSE();
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connectWebSocket, connectSSE, wsUrl, sseUrl]);

  const isDark = theme === "dark";

  return (
    <div
      data-testid="transaction-tracker"
      className={`w-full max-w-xl mx-auto rounded-2xl border p-6 shadow-xl transition-colors duration-200 ${
        isDark ? "bg-gray-900 border-gray-800 text-gray-100" : "bg-white border-gray-200 text-gray-900"
      }`}
    >
      {/* Header with Title and Elapsed Time Counter */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200 dark:border-gray-800">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Payment Status</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Ref: <span className="font-mono">{transactionId}</span>
          </p>
        </div>

        {/* Elapsed Timer Counter */}
        <div
          data-testid="elapsed-timer"
          className={`flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold ${
            status === "completed"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : status === "timed_out" || status === "failed"
              ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
              : "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 animate-pulse"
          }`}
        >
          <span className="w-2 h-2 rounded-full bg-current" />
          <span>{formatTime(elapsedSeconds)}</span>
        </div>
      </div>

      {/* Reconnection notification if disconnected */}
      {reconnectAttempts > 0 && status === "active" && (
        <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 flex items-center justify-between">
          <span>Reconnecting to live payment feed (attempt {reconnectAttempts}/5)...</span>
          <span className="animate-spin">⟳</span>
        </div>
      )}

      {/* Step by Step Progress Progression */}
      <div className="mt-6 space-y-6">
        {TRANSACTION_STEPS.map((step, idx) => {
          const isDone = currentStepIndex > idx || status === "completed";
          const isCurrent = currentStepIndex === idx && status === "active";
          const isFailedOrTimedOut = (status === "timed_out" || status === "failed") && currentStepIndex === idx;

          return (
            <div key={step.key} className="flex items-start space-x-4">
              {/* Step indicator Circle */}
              <div className="flex flex-col items-center">
                <div
                  data-testid={`step-circle-${step.key}`}
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                    isDone
                      ? "bg-emerald-600 text-white shadow-md shadow-emerald-500/20"
                      : isFailedOrTimedOut
                      ? "bg-rose-600 text-white shadow-md shadow-rose-500/20"
                      : isCurrent
                      ? "bg-blue-600 text-white ring-4 ring-blue-500/20 animate-pulse shadow-md"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 border border-gray-300 dark:border-gray-700"
                  }`}
                >
                  {isDone ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isFailedOrTimedOut ? (
                    <span>✕</span>
                  ) : (
                    <span>{idx + 1}</span>
                  )}
                </div>

                {/* Vertical Progress Bar between steps */}
                {idx < TRANSACTION_STEPS.length - 1 && (
                  <div
                    className={`w-0.5 h-10 mt-2 transition-colors duration-300 ${
                      isDone ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-800"
                    }`}
                  />
                )}
              </div>

              {/* Step Details */}
              <div className="flex-1 pt-1">
                <div className="flex items-center justify-between">
                  <h3
                    className={`font-semibold text-sm ${
                      isDone
                        ? "text-emerald-700 dark:text-emerald-400"
                        : isCurrent
                        ? "text-blue-600 dark:text-blue-400 font-bold"
                        : isFailedOrTimedOut
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-gray-400 dark:text-gray-500"
                    }`}
                  >
                    {step.title}
                  </h3>
                  {isCurrent && (
                    <span className="text-xs font-medium text-blue-600 dark:text-blue-400 animate-pulse">
                      In Progress...
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                  {step.description}
                </p>

                {/* Specific Provider Hints on USSD Prompt */}
                {isCurrent && step.key === "ussd_prompted" && (
                  <div
                    data-testid="ussd-hint"
                    className="mt-2 p-2.5 rounded-lg text-xs bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-900/50"
                  >
                    <p className="font-semibold">{getProviderPromptHint(provider)}</p>
                    <p className="mt-1 text-blue-600 dark:text-blue-400">
                      Do not close or reload this window until PIN authorization completes.
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Stellar Minted Hash Details */}
      {status === "completed" && (
        <div
          data-testid="completion-card"
          className="mt-6 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200"
        >
          <div className="flex items-center space-x-2">
            <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h4 className="font-bold text-sm">Payment Confirmed & Tokens Minted</h4>
          </div>
          {stellarTxHash && (
            <p className="text-xs mt-2 font-mono break-all text-emerald-800 dark:text-emerald-300">
              Stellar Tx: {stellarTxHash}
            </p>
          )}
        </div>
      )}

      {/* Failure & Timeout Resolution Instructions */}
      {(status === "timed_out" || status === "failed") && (
        <div
          data-testid="failure-instructions"
          className="mt-6 p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-900 dark:text-rose-200"
        >
          <div className="flex items-center space-x-2">
            <span className="text-rose-600 text-lg">⚠️</span>
            <h4 className="font-bold text-sm">
              {status === "timed_out" ? "Transaction Confirmation Timed Out" : "Transaction Failed"}
            </h4>
          </div>
          <p className="text-xs mt-2 text-rose-700 dark:text-rose-300">{statusMessage}</p>

          {/* Actionable Resolution Steps */}
          <div className="mt-3 text-xs space-y-1.5 text-rose-800 dark:text-rose-200">
            <p className="font-semibold text-rose-900 dark:text-rose-100">Recommended Resolution:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Check your handset screen to ensure the USSD prompt was not dismissed.</li>
              <li>Verify that your mobile money balance covers the transaction and network fee.</li>
              <li>If your account was already debited, your tokens will be minted automatically within 5 minutes.</li>
              <li>You can safely retry or contact support with reference ID: <span className="font-mono font-bold">{transactionId}</span>.</li>
            </ul>
          </div>

          {/* Retry Button */}
          {onRetry && (
            <button
              data-testid="retry-button"
              onClick={onRetry}
              className="mt-4 w-full py-2 px-4 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs transition-colors shadow-sm"
            >
              Retry Payment
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TransactionTracker;
