import React from "react";
import { TransactionTracker, TransactionTrackerProps } from "./TransactionTracker";

export default {
  title: "Components/TransactionTracker",
  component: TransactionTracker,
  argTypes: {
    theme: {
      control: { type: "radio" },
      options: ["light", "dark"],
    },
    provider: {
      control: { type: "select" },
      options: ["mtn", "airtel", "orange", "mpesa"],
    },
    initialStep: {
      control: { type: "select" },
      options: ["initiated", "ussd_prompted", "confirmed", "stellar_minted"],
    },
  },
};

type Story = {
  args: TransactionTrackerProps;
};

export const Initiated: Story = {
  args: {
    transactionId: "tx-momo-123456",
    provider: "mtn",
    initialStep: "initiated",
    timeoutSeconds: 180,
  },
};

export const USSDPrompted: Story = {
  args: {
    transactionId: "tx-momo-789012",
    provider: "orange",
    initialStep: "ussd_prompted",
    timeoutSeconds: 180,
  },
};

export const Confirmed: Story = {
  args: {
    transactionId: "tx-momo-345678",
    provider: "airtel",
    initialStep: "confirmed",
    timeoutSeconds: 180,
  },
};

export const StellarMintedCompleted: Story = {
  args: {
    transactionId: "tx-momo-901234",
    provider: "mpesa",
    initialStep: "stellar_minted",
    timeoutSeconds: 180,
  },
};

export const DarkTheme: Story = {
  args: {
    transactionId: "tx-momo-dark-555",
    provider: "mtn",
    initialStep: "ussd_prompted",
    theme: "dark",
    timeoutSeconds: 180,
  },
};

export const TimedOutWithInstructions: Story = {
  args: {
    transactionId: "tx-momo-timeout-999",
    provider: "orange",
    initialStep: "ussd_prompted",
    timeoutSeconds: 1,
    onRetry: () => alert("Retry payment triggered"),
  },
};
