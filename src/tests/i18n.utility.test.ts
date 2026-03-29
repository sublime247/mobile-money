import { NextFunction, Request, Response } from "express";
import {
  i18nMiddleware,
  resolveLocaleFromRequest,
  translate,
} from "../utils/i18n";

describe("i18n utility", () => {
  it("resolves the highest quality supported Accept-Language", () => {
    const req = {
      headers: {
        "accept-language": "sw;q=0.6, fr;q=0.9, en;q=0.8",
      },
    } as Request;

    expect(resolveLocaleFromRequest(req)).toBe("fr");
  });

  it("falls back to english for unsupported languages", () => {
    const req = {
      headers: {
        "accept-language": "de-DE,de;q=0.8",
      },
    } as Request;

    expect(resolveLocaleFromRequest(req)).toBe("en");
  });

  it("attaches locale to request and response locals", () => {
    const req = {
      headers: {
        "accept-language": "sw",
      },
    } as Request;
    const res = {
      locals: {},
    } as Response;
    const next = jest.fn() as NextFunction;

    i18nMiddleware(req, res, next);

    expect(req.locale).toBe("sw");
    expect(res.locals.locale).toBe("sw");
    expect(next).toHaveBeenCalled();
  });

  it("translates known keys and falls back to english resources", () => {
    expect(translate("errors.INVALID_INPUT", "sw")).toBe("Ingizo si sahihi");
    expect(translate("errors.INVALID_INPUT", "de")).toBe(
      "Invalid input provided",
    );
  });
});
