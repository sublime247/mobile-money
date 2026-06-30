# Transaction Monitor for Mobile Money

A premium VS Code extension designed to streamline the development and debugging of mobile money transactions.

## Features

### 🚀 Live Activity Stream

Monitor transactions in real-time as they flow through your local development server. No more digging through terminal logs or database tables.

### 🎨 Premium Aesthetics

- **Vibrant Status Indicators**: Instantly distinguish between pending, completed, and failed transactions.
- **Modern Dark UI**: Designed to blend seamlessly with the modern VS Code environment.
- **Smooth Animations**: New logs slide in gracefully, providing a responsive and alive interface.

### 🔍 Deep Insight

- **Rich Data Inspection**: View full transaction payloads with syntax highlighting.
- **Interactive Filtering**: (Planned) Filter by user ID, transaction type, or amount.

## Configuration

The extension works out of the box with default local settings:

- `transactionMonitor.wsUrl`: `ws://localhost:3000`

## Vision: Premium Developer Tooling

We believe that developer tools should be as beautiful as the products they help build. The Transaction Monitor is more than just a log viewer; it's a dedicated workspace for transaction lifecycle management. Future iterations will include:

- **Transaction Replay**: Re-trigger transactions directly from the IDE.
- **Time-Travel Debugging**: Scrub through transaction history to see state changes over time.
- **Direct Link to Code**: Click a transaction to jump to the exact line of code that processed it.
