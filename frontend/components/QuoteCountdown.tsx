import React, { useEffect, useState } from "react";
import { secondsRemaining, startCountdown } from "./quoteCountdown";

export interface QuoteCountdownProps {
  /** `expires_at` from the SEP-38 firm quote response. */
  expiresAt: string;
  /** Total validity of the quote in seconds, used to size the progress ring. */
  totalSeconds: number;
  /** Server-vs-client clock difference in ms (see `computeClockOffset`). */
  clockOffsetMs?: number;
  /** Called once when the quote expires. */
  onExpire?: () => void;
  /** Called when the user clicks "Refresh quote". */
  onRefresh: () => void;
  /** Label for the submit button. */
  submitLabel?: string;
  /** Called when the user submits while the quote is still valid. */
  onSubmit?: () => void;
  className?: string;
}

const SIZE = 64;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const QuoteCountdown: React.FC<QuoteCountdownProps> = ({
  expiresAt,
  totalSeconds,
  clockOffsetMs = 0,
  onExpire,
  onRefresh,
  submitLabel = "Confirm",
  onSubmit,
  className,
}) => {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    secondsRemaining(expiresAt, clockOffsetMs),
  );

  useEffect(
    () =>
      startCountdown({
        expiresAt,
        clockOffsetMs,
        onTick: setSecondsLeft,
        onExpire: () => onExpire?.(),
      }),
    [expiresAt, clockOffsetMs],
  );

  const expired = secondsLeft <= 0;
  const fraction =
    totalSeconds > 0 ? Math.min(1, secondsLeft / totalSeconds) : 0;
  const color = expired ? "#dc2626" : secondsLeft <= 10 ? "#f59e0b" : "#16a34a";

  return (
    <div className={className} role="timer" aria-live="polite">
      <div style={{ position: "relative", width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
          />
        </svg>
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {secondsLeft}s
        </span>
      </div>

      {expired && (
        <p style={{ color: "#dc2626", margin: "8px 0" }}>
          This quote has expired. Refresh to get a new price.
        </p>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={expired} onClick={onSubmit}>
          {submitLabel}
        </button>
        {expired && (
          <button type="button" onClick={onRefresh}>
            Refresh quote
          </button>
        )}
      </div>
    </div>
  );
};

export default QuoteCountdown;
