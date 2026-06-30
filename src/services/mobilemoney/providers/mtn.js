"use strict";
var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value);
          });
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator["throw"](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done
          ? resolve(result.value)
          : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  };
var __generator =
  (this && this.__generator) ||
  function (thisArg, body) {
    var _ = {
        label: 0,
        sent: function () {
          if (t[0] & 1) throw t[1];
          return t[1];
        },
        trys: [],
        ops: [],
      },
      f,
      y,
      t,
      g = Object.create(
        (typeof Iterator === "function" ? Iterator : Object).prototype,
      );
    return (
      (g.next = verb(0)),
      (g["throw"] = verb(1)),
      (g["return"] = verb(2)),
      typeof Symbol === "function" &&
        (g[Symbol.iterator] = function () {
          return this;
        }),
      g
    );
    function verb(n) {
      return function (v) {
        return step([n, v]);
      };
    }
    function step(op) {
      if (f) throw new TypeError("Generator is already executing.");
      while ((g && ((g = 0), op[0] && (_ = 0)), _))
        try {
          if (
            ((f = 1),
            y &&
              (t =
                op[0] & 2
                  ? y["return"]
                  : op[0]
                    ? y["throw"] || ((t = y["return"]) && t.call(y), 0)
                    : y.next) &&
              !(t = t.call(y, op[1])).done)
          )
            return t;
          if (((y = 0), t)) op = [op[0] & 2, t.value];
          switch (op[0]) {
            case 0:
            case 1:
              t = op;
              break;
            case 4:
              _.label++;
              return { value: op[1], done: false };
            case 5:
              _.label++;
              y = op[1];
              op = [0];
              continue;
            case 7:
              op = _.ops.pop();
              _.trys.pop();
              continue;
            default:
              if (
                !((t = _.trys), (t = t.length > 0 && t[t.length - 1])) &&
                (op[0] === 6 || op[0] === 2)
              ) {
                _ = 0;
                continue;
              }
              if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) {
                _.label = op[1];
                break;
              }
              if (op[0] === 6 && _.label < t[1]) {
                _.label = t[1];
                t = op;
                break;
              }
              if (t && _.label < t[2]) {
                _.label = t[2];
                _.ops.push(op);
                break;
              }
              if (t[2]) _.ops.pop();
              _.trys.pop();
              continue;
          }
          op = body.call(thisArg, _);
        } catch (e) {
          op = [6, e];
          y = 0;
        } finally {
          f = t = 0;
        }
      if (op[0] & 5) throw op[1];
      return { value: op[0] ? op[1] : void 0, done: true };
    }
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.MTNProvider = void 0;
var axios_1 = require("axios");
var crypto_1 = require("crypto");
var MTNProvider = /** @class */ (function () {
  function MTNProvider() {
    this.baseUrl = "https://sandbox.momodeveloper.mtn.com";
    this.apiKey = process.env.MTN_API_KEY || "";
    this.apiSecret = process.env.MTN_API_SECRET || "";
    this.subscriptionKey = process.env.MTN_SUBSCRIPTION_KEY || "";
    this.environment = process.env.MTN_TARGET_ENVIRONMENT || "sandbox";
    if (process.env.MTN_BASE_URL) {
      this.baseUrl = process.env.MTN_BASE_URL;
    }
  }
  MTNProvider.prototype.getAccessToken = function () {
    return __awaiter(this, void 0, void 0, function () {
      var response, token;
      var _a;
      return __generator(this, function (_b) {
        switch (_b.label) {
          case 0:
            return [
              4 /*yield*/,
              axios_1.default.post(
                "".concat(this.baseUrl, "/collection/token/"),
                undefined,
                {
                  headers: {
                    Authorization:
                      "Basic " +
                      Buffer.from(
                        "".concat(this.apiKey, ":").concat(this.apiSecret),
                      ).toString("base64"),
                    "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                  },
                },
              ),
            ];
          case 1:
            response = _b.sent();
            token =
              (_a = response.data) === null || _a === void 0
                ? void 0
                : _a.access_token;
            if (!token || typeof token !== "string") {
              throw new Error(
                "MTN token response did not include access_token",
              );
            }
            return [2 /*return*/, token];
        }
      });
    });
  };
  MTNProvider.prototype.getOperationalBalance = function () {
    return __awaiter(this, void 0, void 0, function () {
      var token, response, availableRaw, availableBalance, error_1;
      var _a, _b;
      return __generator(this, function (_c) {
        switch (_c.label) {
          case 0:
            _c.trys.push([0, 3, , 4]);
            return [4 /*yield*/, this.getAccessToken()];
          case 1:
            token = _c.sent();
            return [
              4 /*yield*/,
              axios_1.default.get(
                "".concat(this.baseUrl, "/disbursement/v1_0/account/balance"),
                {
                  headers: {
                    Authorization: "Bearer ".concat(token),
                    "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                    "X-Target-Environment": this.environment,
                  },
                },
              ),
            ];
          case 2:
            response = _c.sent();
            availableRaw =
              (_b =
                (_a = response.data.availableBalance) !== null && _a !== void 0
                  ? _a
                  : response.data.balance) !== null && _b !== void 0
                ? _b
                : 0;
            availableBalance =
              typeof availableRaw === "number"
                ? availableRaw
                : Number.parseFloat(String(availableRaw));
            if (!Number.isFinite(availableBalance)) {
              throw new Error("Invalid MTN balance response");
            }
            return [
              2 /*return*/,
              {
                success: true,
                data: {
                  availableBalance: availableBalance,
                  currency: response.data.currency || "XAF",
                },
              },
            ];
          case 3:
            error_1 = _c.sent();
            return [2 /*return*/, { success: false, error: error_1 }];
          case 4:
            return [2 /*return*/];
        }
      });
    });
  };
  MTNProvider.prototype.requestPayment = function (phoneNumber, amount) {
    return __awaiter(this, void 0, void 0, function () {
      var response, error_2;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            _a.trys.push([0, 2, , 3]);
            return [
              4 /*yield*/,
              axios_1.default.post(
                "".concat(this.baseUrl, "/collection/v1_0/requesttopay"),
                {
                  amount: amount,
                  currency: "EUR",
                  externalId: (0, crypto_1.randomUUID)(),
                  payer: { partyIdType: "MSISDN", partyId: phoneNumber },
                  payerMessage: "Payment for Stellar deposit",
                  payeeNote: "Deposit",
                },
                {
                  headers: {
                    "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                    "X-Target-Environment": "sandbox",
                  },
                },
              ),
            ];
          case 1:
            response = _a.sent();
            return [2 /*return*/, { success: true, data: response.data }];
          case 2:
            error_2 = _a.sent();
            return [2 /*return*/, { success: false, error: error_2 }];
          case 3:
            return [2 /*return*/];
        }
      });
    });
  };
  MTNProvider.prototype.sendPayout = function (_phoneNumber, _amount) {
    return __awaiter(this, void 0, void 0, function () {
      return __generator(this, function (_a) {
        return [2 /*return*/, { success: true }];
      });
    });
  };
  MTNProvider.prototype.getTransactionStatus = function (referenceId) {
    return __awaiter(this, void 0, void 0, function () {
      var token, response, providerStatus, _a;
      var _b, _c;
      return __generator(this, function (_d) {
        switch (_d.label) {
          case 0:
            _d.trys.push([0, 3, , 4]);
            return [4 /*yield*/, this.getAccessToken()];
          case 1:
            token = _d.sent();
            return [
              4 /*yield*/,
              axios_1.default.get(
                ""
                  .concat(this.baseUrl, "/collection/v1_0/requesttopay/")
                  .concat(encodeURIComponent(referenceId)),
                {
                  headers: {
                    Authorization: "Bearer ".concat(token),
                    "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                    "X-Target-Environment": this.environment,
                  },
                },
              ),
            ];
          case 2:
            response = _d.sent();
            providerStatus = String(
              (_c =
                (_b = response.data) === null || _b === void 0
                  ? void 0
                  : _b.status) !== null && _c !== void 0
                ? _c
                : "",
            ).toUpperCase();
            if (providerStatus === "SUCCESSFUL")
              return [2 /*return*/, { status: "completed" }];
            if (providerStatus === "FAILED")
              return [2 /*return*/, { status: "failed" }];
            if (providerStatus === "PENDING")
              return [2 /*return*/, { status: "pending" }];
            return [2 /*return*/, { status: "unknown" }];
          case 3:
            _a = _d.sent();
            return [2 /*return*/, { status: "unknown" }];
          case 4:
            return [2 /*return*/];
        }
      });
    });
  };
  return MTNProvider;
})();
exports.MTNProvider = MTNProvider;
