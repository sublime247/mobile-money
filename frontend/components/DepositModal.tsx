import React, { useState, useEffect, useRef, useCallback } from "react";

export type ModalTheme = "light" | "dark" | "system";

export interface Sep24CompletionEvent {
  type?: string;
  status: "success" | "completed" | "pending" | "error" | "failed";
  transaction?: {
    id?: string;
    status?: string;
    amount_in?: string;
    amount_out?: string;
    asset_code?: string;
    [key: string]: unknown;
  };
  message?: string;
  [key: string]: unknown;
}

export interface DepositModalProps {
  /** Controls modal visibility */
  isOpen: boolean;
  /** Callback fired when user closes or dismisses the modal */
  onClose: () => void;
  /** SEP-24 interactive deposit URL returned by the anchor */
  interactiveUrl: string;
  /** Callback fired when interactive deposit completes successfully */
  onSuccess?: (event: Sep24CompletionEvent) => void;
  /** Callback fired if deposit encounters an error or failure message */
  onError?: (error: unknown) => void;
  /** General message event callback */
  onMessage?: (event: MessageEvent) => void;
  /** Display mode: secure embedded iframe or popup window. Defaults to 'iframe' */
  mode?: "iframe" | "popup";
  /** Initial theme mode. Defaults to 'system' */
  theme?: ModalTheme;
  /** Optional callback fired when theme changes */
  onThemeChange?: (theme: "light" | "dark") => void;
  /** Trusted origins allowed to post messages to this modal. If empty, interactiveUrl origin is used */
  trustedOrigins?: string[];
  /** Modal header title. Defaults to 'Mobile Deposit' */
  title?: string;
  /** Asset code being deposited (e.g., 'USDC', 'EURC', 'XLM') */
  assetCode?: string;
  /** Estimated deposit amount */
  amount?: string;
  /** Additional container CSS classes */
  className?: string;
}

export const DepositModal: React.FC<DepositModalProps> = ({
  isOpen,
  onClose,
  interactiveUrl,
  onSuccess,
  onError,
  onMessage,
  mode = "iframe",
  theme = "system",
  onThemeChange,
  trustedOrigins,
  title = "Mobile Money Deposit",
  assetCode,
  amount,
  className = "",
}) => {
  // Theme state
  const [currentTheme, setCurrentTheme] = useState<"light" | "dark">(() => {
    if (theme === "dark" || theme === "light") return theme;
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  });

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [currentMode, setCurrentMode] = useState<"iframe" | "popup">(mode);
  const popupRef = useRef<Window | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Sync prop theme changes
  useEffect(() => {
    if (theme === "dark" || theme === "light") {
      setCurrentTheme(theme);
    }
  }, [theme]);

  // Compute allowed origin from interactiveUrl
  const allowedOrigin = useCallback((): string | null => {
    if (!interactiveUrl) return null;
    try {
      const parsed = new URL(interactiveUrl);
      return parsed.origin;
    } catch {
      return null;
    }
  }, [interactiveUrl]);

  // Toggle theme handler
  const handleToggleTheme = () => {
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    setCurrentTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  // Open popup handler
  const openPopupWindow = useCallback(() => {
    if (!interactiveUrl) return;
    const width = 500;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(
      interactiveUrl,
      "sep24_deposit_window",
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,status=no`,
    );
    popupRef.current = popup;
  }, [interactiveUrl]);

/**
 * Validate an event origin against trusted origins using strict URL parsing
 * to prevent incomplete URL substring sanitization vulnerabilities.
 */
export function isTrustedOrigin(
  eventOrigin: string,
  trustedOrigins?: string[],
): boolean {
  if (!trustedOrigins || trustedOrigins.length === 0) return true;
  for (const trusted of trustedOrigins) {
    if (trusted === "*") return true;
    try {
      const trustedUrl = new URL(trusted);
      const eventUrl = new URL(eventOrigin);
      if (
        trustedUrl.protocol === eventUrl.protocol &&
        trustedUrl.host === eventUrl.host
      ) {
        return true;
      }
    } catch {
      if (trusted === eventOrigin) {
        return true;
      }
    }
  }
  return false;
}

  // Handle postMessage events
  useEffect(() => {
    if (!isOpen) return;

    const handleMessage = (event: MessageEvent) => {
      // Validate origin strictly without substring matching
      const origin = allowedOrigin();
      const validOrigins = trustedOrigins || (origin ? [origin] : []);

      if (
        validOrigins.length > 0 &&
        !isTrustedOrigin(event.origin, validOrigins)
      ) {
        // Discard messages from untrusted origins
        return;
      }

      onMessage?.(event);

      let payload = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          // Plain string message, keep as is
        }
      }

      if (!payload || typeof payload !== "object") return;

      const typedPayload = payload as Sep24CompletionEvent;

      // Detect SEP-24 / Stellar completion signals
      const isSuccess =
        typedPayload.status === "success" ||
        typedPayload.status === "completed" ||
        typedPayload.type === "sep24" ||
        typedPayload.type === "stellar_wave" ||
        typedPayload.transaction?.status === "completed" ||
        typedPayload.transaction?.status === "pending_user_transfer_start";

      const isError =
        typedPayload.status === "error" ||
        typedPayload.status === "failed" ||
        typedPayload.transaction?.status === "error";

      if (isSuccess) {
        onSuccess?.(typedPayload);
      } else if (isError) {
        onError?.(typedPayload);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [isOpen, allowedOrigin, trustedOrigins, onSuccess, onError, onMessage]);

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Handle mode switch to popup on mount if requested
  useEffect(() => {
    if (isOpen && currentMode === "popup") {
      openPopupWindow();
    }
  }, [isOpen, currentMode, openPopupWindow]);

  if (!isOpen) return null;

  // Append theme parameter to URL if applicable
  const getThemeAwareUrl = (): string => {
    if (!interactiveUrl) return "";
    try {
      const url = new URL(interactiveUrl);
      url.searchParams.set("theme", currentTheme);
      return url.toString();
    } catch {
      return interactiveUrl;
    }
  };

  const isDark = currentTheme === "dark";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sep24-modal-title"
      className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 p-0 sm:p-4 ${className}`}
    >
      {/* Modal Card */}
      <div
        className={`relative w-full max-w-full sm:max-w-lg md:max-w-xl h-[92vh] sm:h-[680px] max-h-[95vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl transition-all overflow-hidden border ${
          isDark
            ? "bg-gray-900 text-gray-100 border-gray-800"
            : "bg-white text-gray-900 border-gray-200"
        }`}
      >
        {/* Header Bar */}
        <header
          className={`flex items-center justify-between px-4 py-3.5 border-b select-none ${
            isDark
              ? "border-gray-800 bg-gray-900/90"
              : "border-gray-100 bg-gray-50/90"
          }`}
        >
          <div className="flex items-center space-x-2.5 truncate">
            {/* Mobile Money Icon */}
            <div
              className={`p-1.5 rounded-lg flex items-center justify-center ${
                isDark ? "bg-blue-600/20 text-blue-400" : "bg-blue-50 text-blue-600"
              }`}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div className="truncate">
              <h2
                id="sep24-modal-title"
                className="text-base font-semibold truncate leading-tight"
              >
                {title}
              </h2>
              {(assetCode || amount) && (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {amount ? `${amount} ` : ""}
                  {assetCode || ""}
                </p>
              )}
            </div>
          </div>

          {/* Action buttons: Popup Mode Toggle, Theme Toggle, Close Button */}
          <div className="flex items-center space-x-1.5">
            {/* Mode switcher (iframe / popup) */}
            <button
              type="button"
              id="sep24-popup-toggle"
              onClick={() => {
                if (currentMode === "iframe") {
                  setCurrentMode("popup");
                  openPopupWindow();
                } else {
                  setCurrentMode("iframe");
                }
              }}
              title={
                currentMode === "iframe"
                  ? "Open in popup window"
                  : "Switch to embedded view"
              }
              aria-label="Toggle popup window mode"
              className={`p-2 rounded-lg text-xs font-medium transition-colors ${
                isDark
                  ? "hover:bg-gray-800 text-gray-400 hover:text-gray-200"
                  : "hover:bg-gray-200 text-gray-500 hover:text-gray-800"
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </button>

            {/* Dark / Light Theme Toggle */}
            <button
              type="button"
              id="sep24-theme-toggle"
              onClick={handleToggleTheme}
              title={`Switch to ${isDark ? "light" : "dark"} mode`}
              aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
              className={`p-2 rounded-lg transition-colors ${
                isDark
                  ? "hover:bg-gray-800 text-yellow-400"
                  : "hover:bg-gray-200 text-gray-600"
              }`}
            >
              {isDark ? (
                // Sun Icon for Dark Mode
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              ) : (
                // Moon Icon for Light Mode
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
              )}
            </button>

            {/* Close Button */}
            <button
              type="button"
              id="sep24-close-btn"
              onClick={onClose}
              aria-label="Close deposit modal"
              className={`p-2 rounded-lg transition-colors ${
                isDark
                  ? "hover:bg-gray-800 text-gray-400 hover:text-white"
                  : "hover:bg-gray-200 text-gray-500 hover:text-gray-900"
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="relative flex-1 w-full bg-gray-50 dark:bg-gray-950 overflow-hidden">
          {currentMode === "popup" ? (
            /* Popup Active State Card */
            <div className="flex flex-col items-center justify-center h-full p-6 text-center space-y-4">
              <div
                className={`p-4 rounded-full ${
                  isDark ? "bg-blue-900/30 text-blue-400" : "bg-blue-50 text-blue-600"
                }`}
              >
                <svg
                  className="w-8 h-8 animate-pulse"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </div>
              <h3 className="text-base font-semibold">Deposit Flow Active in Popup</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
                Please complete the mobile deposit in the opened browser window. This modal will automatically detect completion.
              </p>
              <div className="pt-2 flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={openPopupWindow}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
                >
                  Re-open Window
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentMode("iframe")}
                  className={`px-4 py-2 text-xs font-medium rounded-lg border transition ${
                    isDark
                      ? "border-gray-700 text-gray-300 hover:bg-gray-800"
                      : "border-gray-300 text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  Switch to Embedded Iframe
                </button>
              </div>
            </div>
          ) : (
            /* Secure Embedded Iframe */
            <>
              {/* Loading Indicator */}
              {isLoading && (
                <div
                  id="sep24-loading-spinner"
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 dark:bg-gray-900/80 backdrop-blur-xs"
                >
                  <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  <p className="mt-3 text-xs font-medium text-gray-500 dark:text-gray-400">
                    Loading secure deposit portal...
                  </p>
                </div>
              )}

              {/* Error Message Fallback */}
              {iframeError && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-gray-900">
                  <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full mb-3">
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <p className="text-sm font-semibold text-red-600 dark:text-red-400 mb-1">
                    Failed to Load Deposit Portal
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 max-w-xs">
                    {iframeError}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setIframeError(null);
                      setIsLoading(true);
                      if (iframeRef.current) {
                        iframeRef.current.src = getThemeAwareUrl();
                      }
                    }}
                    className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Secure Iframe */}
              <iframe
                ref={iframeRef}
                id="sep24-deposit-iframe"
                src={getThemeAwareUrl()}
                title="SEP-24 Interactive Deposit"
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                allow="camera; microphone; payment; clipboard-write"
                onLoad={() => setIsLoading(false)}
                onError={() => {
                  setIsLoading(false);
                  setIframeError("Unable to establish secure connection to provider webview.");
                }}
                className="w-full h-full border-0 block"
              />
            </>
          )}
        </div>

        {/* Footer Security Badging */}
        <footer
          className={`flex items-center justify-between px-4 py-2 border-t text-[11px] ${
            isDark
              ? "border-gray-800 bg-gray-900 text-gray-500"
              : "border-gray-100 bg-gray-50 text-gray-400"
          }`}
        >
          <span className="flex items-center space-x-1">
            <svg
              className="w-3.5 h-3.5 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
            <span>Encrypted SEP-24 Tunnel</span>
          </span>
          <span>Stellar Wave Mobile Money</span>
        </footer>
      </div>
    </div>
  );
};

export default DepositModal;
