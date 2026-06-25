import React, { useEffect, useRef, useState } from 'react';

/**
 * Embeds the Apollo Sandbox (Explorer) via the CDN embed script.
 * This avoids adding a heavy npm dependency — the Apollo team publishes
 * a lightweight embed helper at https://embeddable-sandbox.cdn.apollographql.com.
 *
 * Developers can switch the endpoint URL to point at their local or
 * staging Mobile Money GraphQL server.
 */

const DEFAULT_ENDPOINT = 'http://localhost:4000/graphql';

const DEFAULT_DOCUMENT = `# Welcome to the Mobile Money GraphQL Playground!
# Try running one of these example queries:

# ── Fetch your current user ──────────────────
query Me {
  me {
    id
    subject
  }
}

# ── List recent transactions ─────────────────
# query RecentTransactions {
#   transactions(limit: 10, offset: 0) {
#     id
#     referenceNumber
#     type
#     amount
#     phoneNumber
#     provider
#     status
#     createdAt
#   }
# }

# ── Look up a single transaction ─────────────
# query GetTransaction {
#   transaction(id: "txn_abc123") {
#     id
#     referenceNumber
#     providerReference
#     type
#     amount
#     phoneNumber
#     provider
#     stellarAddress
#     status
#     tags
#     retryCount
#     createdAt
#     jobProgress
#   }
# }

# ── Initiate a deposit ───────────────────────
# mutation InitiateDeposit {
#   deposit(input: {
#     amount: "5000"
#     phoneNumber: "+256700000000"
#     provider: "MTN"
#     stellarAddress: "GABCDEF..."
#   }) {
#     transactionId
#     referenceNumber
#     status
#     jobId
#   }
# }

# ── Open a dispute ───────────────────────────
# mutation OpenNewDispute {
#   openDispute(input: {
#     transactionId: "txn_abc123"
#     reason: "Amount not received"
#     reportedBy: "customer@example.com"
#   }) {
#     id
#     transactionId
#     reason
#     status
#     createdAt
#   }
# }
`;

export default function GraphQLPlayground(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [inputValue, setInputValue] = useState(DEFAULT_ENDPOINT);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Clear previous embed
    containerRef.current.innerHTML = '';
    setLoaded(false);

    // Load the Apollo Sandbox embed script
    const script = document.createElement('script');
    script.src = 'https://embeddable-sandbox.cdn.apollographql.com/_latest/embeddable-sandbox.umd.production.min.js';
    script.async = true;
    script.onload = () => {
      // @ts-expect-error — loaded from CDN script, not typed
      if (window.EmbeddedSandbox) {
        // @ts-expect-error — loaded from CDN script, not typed
        new window.EmbeddedSandbox({
          target: '#graphql-playground-container',
          initialEndpoint: endpoint,
          initialState: {
            document: DEFAULT_DOCUMENT,
            displayOptions: {
              theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
            },
          },
          includeCookies: false,
        });
        setLoaded(true);
      }
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup script on unmount
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, [endpoint]);

  const handleEndpointChange = () => {
    const trimmed = inputValue.trim();
    if (trimmed && trimmed !== endpoint) {
      setEndpoint(trimmed);
    }
  };

  return (
    <div className="graphql-playground-wrapper">
      {/* ── Configuration Bar ─────────────────────────────────── */}
      <div className="graphql-config-bar">
        <div className="graphql-config-bar__header">
          <div className="graphql-config-bar__badge">
            <span className="graphql-config-bar__dot" />
            GraphQL Playground
          </div>
          <button
            className="graphql-config-bar__toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand settings' : 'Collapse settings'}
          >
            {collapsed ? '▼ Show Settings' : '▲ Hide Settings'}
          </button>
        </div>

        {!collapsed && (
          <div className="graphql-config-bar__body">
            <p className="graphql-config-bar__hint">
              Point this to your running Mobile Money GraphQL server.
              Default: <code>{DEFAULT_ENDPOINT}</code>
            </p>
            <div className="graphql-config-bar__controls">
              <label htmlFor="graphql-endpoint-input" className="graphql-config-bar__label">
                Endpoint URL
              </label>
              <div className="graphql-config-bar__input-group">
                <input
                  id="graphql-endpoint-input"
                  type="url"
                  className="graphql-config-bar__input"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleEndpointChange();
                  }}
                  placeholder="http://localhost:4000/graphql"
                />
                <button
                  className="graphql-config-bar__button"
                  onClick={handleEndpointChange}
                  disabled={inputValue.trim() === endpoint}
                >
                  Connect
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Sandbox Container ─────────────────────────────────── */}
      {!loaded && (
        <div className="graphql-playground-loading">
          <div className="graphql-playground-loading__spinner" />
          <span>Loading Apollo Sandbox…</span>
        </div>
      )}
      <div
        id="graphql-playground-container"
        ref={containerRef}
        className="graphql-playground-embed"
      />
    </div>
  );
}
