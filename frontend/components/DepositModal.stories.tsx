import type { Meta, StoryObj } from "@storybook/react";
import { DepositModal, DepositModalProps } from "./DepositModal";

const meta: Meta<typeof DepositModal> = {
  title: "Components/DepositModal",
  component: DepositModal,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Open-source React component embedding the SEP-24 interactive deposit webview with responsive mobile styling, dark/light theme toggle, and postMessage event handling.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    mode: {
      control: "radio",
      options: ["iframe", "popup"],
      description: "Embed method for the SEP-24 interactive webview",
    },
    theme: {
      control: "radio",
      options: ["light", "dark", "system"],
      description: "Color theme mode",
    },
    onClose: { action: "onClose" },
    onSuccess: { action: "onSuccess" },
    onError: { action: "onError" },
  },
};

export default meta;
type Story = StoryObj<typeof DepositModal>;

export const Default: Story = {
  args: {
    isOpen: true,
    interactiveUrl: "https://bridge.stellarwave.io/sep24/interactive/flow?token=mock-token",
    title: "Mobile Money Deposit",
    assetCode: "USDC",
    amount: "50.00",
    mode: "iframe",
    theme: "light",
  },
};

export const DarkTheme: Story = {
  args: {
    isOpen: true,
    interactiveUrl: "https://bridge.stellarwave.io/sep24/interactive/flow?token=mock-token",
    title: "M-Pesa Deposit",
    assetCode: "XAF",
    amount: "25,000",
    mode: "iframe",
    theme: "dark",
  },
};

export const PopupMode: Story = {
  args: {
    isOpen: true,
    interactiveUrl: "https://bridge.stellarwave.io/sep24/interactive/flow?token=mock-token",
    title: "Orange Money Deposit (Popup Mode)",
    assetCode: "EURC",
    amount: "100.00",
    mode: "popup",
    theme: "dark",
  },
};

export const MobileResponsiveView: Story = {
  args: {
    isOpen: true,
    interactiveUrl: "https://bridge.stellarwave.io/sep24/interactive/flow?token=mock-token",
    title: "MTN MoMo Instant Deposit",
    assetCode: "USDC",
    amount: "10.00",
    mode: "iframe",
    theme: "light",
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
};
