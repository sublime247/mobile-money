import type { Meta, StoryObj } from "@storybook/react";
import { PhoneInput } from "./PhoneInput";

const meta: Meta<typeof PhoneInput> = {
  title: "Components/PhoneInput",
  component: PhoneInput,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
  argTypes: {
    defaultCountry: {
      control: "select",
      options: ["CM", "SN", "CI", "NG", "KE", "GH"],
    },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof PhoneInput>;

export const DefaultCameroon: Story = {
  args: {
    defaultCountry: "CM",
    label: "Cameroon Mobile Money Number",
    placeholder: "671 23 45 67",
  },
};

export const NigeriaMTN: Story = {
  args: {
    defaultCountry: "NG",
    label: "Nigeria Phone Number",
    defaultValue: "8031234567",
  },
};

export const KenyaMpesa: Story = {
  args: {
    defaultCountry: "KE",
    label: "Kenya M-Pesa Number",
    defaultValue: "712345678",
  },
};

export const SenegalOrange: Story = {
  args: {
    defaultCountry: "SN",
    label: "Senegal Orange Money",
    defaultValue: "771234567",
  },
};

export const IvoryCoastMoov: Story = {
  args: {
    defaultCountry: "CI",
    label: "Ivory Coast Mobile Money",
    defaultValue: "0102030405",
  },
};

export const GhanaMTN: Story = {
  args: {
    defaultCountry: "GH",
    label: "Ghana MTN MoMo Number",
    defaultValue: "241234567",
  },
};
