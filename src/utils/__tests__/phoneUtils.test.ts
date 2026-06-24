import { formatPhoneForProvider } from "../phoneUtils";

describe("formatPhoneForProvider", () => {
  it("normalizes Airtel Cameroon numbers to national format", () => {
    expect(formatPhoneForProvider("+237670000000", "airtel")).toBe("670000000");
    expect(formatPhoneForProvider("237670000000", "airtel")).toBe("670000000");
    expect(formatPhoneForProvider("670000000", "airtel")).toBe("670000000");
  });

  it("keeps E.164 format for other providers", () => {
    expect(formatPhoneForProvider("+237670000000", "mtn")).toBe("+237670000000");
  });
});
