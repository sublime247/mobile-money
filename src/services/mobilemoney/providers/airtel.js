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
exports.AirtelService = void 0;
var axios_1 = require("axios");
var AirtelService = /** @class */ (function () {
  function AirtelService() {
    this.token = null;
    this.tokenExpiry = 0;
    this.client = axios_1.default.create({
      baseURL: process.env.AIRTEL_BASE_URL,
      timeout: 10000,
    });
  }
  AirtelService.prototype.authenticate = function () {
    return __awaiter(this, void 0, void 0, function () {
      var response, response_1, error_1;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            if (this.token && Date.now() < this.tokenExpiry) {
              return [2 /*return*/, this.token];
            }
            return [
              4 /*yield*/,
              this.client.post("/auth/oauth2/token", null, {
                headers: {
                  "Content-Type": "application/json",
                  Authorization:
                    "Basic " +
                    Buffer.from(
                      ""
                        .concat(process.env.AIRTEL_API_KEY, ":")
                        .concat(process.env.AIRTEL_API_SECRET),
                    ).toString("base64"),
                },
              }),
            ];
          case 1:
            response = _a.sent();
            _a.label = 2;
          case 2:
            _a.trys.push([2, 4, , 5]);
            return [
              4 /*yield*/,
              this.client.post("/auth/oauth2/token", null, {
                headers: {
                  "Content-Type": "application/json",
                  Authorization:
                    "Basic " +
                    Buffer.from(
                      ""
                        .concat(process.env.AIRTEL_API_KEY, ":")
                        .concat(process.env.AIRTEL_API_SECRET),
                    ).toString("base64"),
                },
              }),
            ];
          case 3:
            response_1 = _a.sent();
            this.token = response_1.data.access_token;
            this.tokenExpiry = Date.now() + response_1.data.expires_in * 1000;
            return [2 /*return*/, this.token];
          case 4:
            error_1 = _a.sent();
            console.error("Airtel auth failed", error_1);
            throw new Error("Airtel authentication failed");
          case 5:
            return [2 /*return*/];
        }
      });
    });
  };
  AirtelService.prototype.withRetry = function (fn_1) {
    return __awaiter(this, arguments, void 0, function (fn, retries) {
      var lastError, _loop_1, this_1, i, state_1;
      var _a, _b;
      if (retries === void 0) {
        retries = 3;
      }
      return __generator(this, function (_c) {
        switch (_c.label) {
          case 0:
            _loop_1 = function (i) {
              var _d, err_1, axiosError;
              return __generator(this, function (_e) {
                switch (_e.label) {
                  case 0:
                    _e.trys.push([0, 2, , 5]);
                    _d = {};
                    return [4 /*yield*/, fn()];
                  case 1:
                    return [2 /*return*/, ((_d.value = _e.sent()), _d)];
                  case 2:
                    err_1 = _e.sent();
                    lastError = err_1;
                    axiosError = err_1;
                    if (
                      ((_a = axiosError.response) === null || _a === void 0
                        ? void 0
                        : _a.status) === 401
                    ) {
                      this_1.token = null;
                    }
                    if (
                      !(
                        (((_b = err_1.response) === null || _b === void 0
                          ? void 0
                          : _b.status) &&
                          err_1.response.status >= 500) ||
                        err_1.code === "ECONNABORTED"
                      )
                    )
                      return [3 /*break*/, 4];
                    console.warn(
                      "Retrying Airtel request (".concat(i + 1, ")"),
                    );
                    return [
                      4 /*yield*/,
                      new Promise(function (res) {
                        return setTimeout(res, 1000 * (i + 1));
                      }),
                    ];
                  case 3:
                    _e.sent();
                    return [2 /*return*/, "continue"];
                  case 4:
                    throw err_1;
                  case 5:
                    return [2 /*return*/];
                }
              });
            };
            this_1 = this;
            i = 0;
            _c.label = 1;
          case 1:
            if (!(i < retries)) return [3 /*break*/, 4];
            return [5 /*yield**/, _loop_1(i)];
          case 2:
            state_1 = _c.sent();
            if (typeof state_1 === "object")
              return [2 /*return*/, state_1.value];
            _c.label = 3;
          case 3:
            i++;
            return [3 /*break*/, 1];
          case 4:
            throw lastError;
        }
      });
    });
  };
  /**
   * =========================
   * REQUEST PAYMENT (COLLECTION)
   * =========================
   */
  AirtelService.prototype.requestPayment = function (phoneNumber, amount) {
    return __awaiter(this, void 0, void 0, function () {
      var token, reference;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            return [4 /*yield*/, this.authenticate()];
          case 1:
            token = _a.sent();
            reference = "AIRTEL-".concat(Date.now());
            return [
              2 /*return*/,
              this.withRetry(function () {
                return __awaiter(_this, void 0, void 0, function () {
                  var response, error_2;
                  return __generator(this, function (_a) {
                    switch (_a.label) {
                      case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [
                          4 /*yield*/,
                          this.client.post(
                            "/merchant/v1/payments/",
                            {
                              reference: reference,
                              subscriber: {
                                country: "NG",
                                currency: "NGN",
                                msisdn: phoneNumber,
                              },
                              transaction: {
                                amount: parseFloat(amount),
                                country: "NG",
                                currency: "NGN",
                                id: reference,
                              },
                            },
                            {
                              headers: {
                                Authorization: "Bearer ".concat(token),
                                "X-Country": "NG",
                                "X-Currency": "NGN",
                              },
                            },
                          ),
                        ];
                      case 1:
                        response = _a.sent();
                        return [
                          2 /*return*/,
                          { success: true, data: response.data },
                        ];
                      case 2:
                        error_2 = _a.sent();
                        return [
                          2 /*return*/,
                          { success: false, error: error_2 },
                        ];
                      case 3:
                        return [2 /*return*/];
                    }
                  });
                });
              }),
            ];
        }
      });
    });
  };
  AirtelService.prototype.getTransactionStatus = function (reference) {
    return __awaiter(this, void 0, void 0, function () {
      var result, txStatus, _a;
      var _b, _c, _d, _e;
      return __generator(this, function (_f) {
        switch (_f.label) {
          case 0:
            _f.trys.push([0, 2, , 3]);
            return [4 /*yield*/, this.checkStatus(reference)];
          case 1:
            result = _f.sent();
            if (!result.success) return [2 /*return*/, { status: "unknown" }];
            txStatus = String(
              (_e =
                (_d =
                  (_c =
                    (_b = result.data) === null || _b === void 0
                      ? void 0
                      : _b.data) === null || _c === void 0
                    ? void 0
                    : _c.transaction) === null || _d === void 0
                  ? void 0
                  : _d.status) !== null && _e !== void 0
                ? _e
                : "",
            ).toUpperCase();
            // Airtel status codes: TS = success, TF = failed, TP = pending
            if (txStatus === "TS")
              return [2 /*return*/, { status: "completed" }];
            if (txStatus === "TF") return [2 /*return*/, { status: "failed" }];
            if (txStatus === "TP") return [2 /*return*/, { status: "pending" }];
            return [2 /*return*/, { status: "unknown" }];
          case 2:
            _a = _f.sent();
            return [2 /*return*/, { status: "unknown" }];
          case 3:
            return [2 /*return*/];
        }
      });
    });
  };
  AirtelService.prototype.checkStatus = function (reference) {
    return __awaiter(this, void 0, void 0, function () {
      var token;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            return [4 /*yield*/, this.authenticate()];
          case 1:
            token = _a.sent();
            return [
              2 /*return*/,
              this.withRetry(function () {
                return __awaiter(_this, void 0, void 0, function () {
                  var response, error_3;
                  return __generator(this, function (_a) {
                    switch (_a.label) {
                      case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [
                          4 /*yield*/,
                          this.client.get(
                            "/standard/v1/payments/".concat(reference),
                            {
                              headers: {
                                Authorization: "Bearer ".concat(token),
                                "X-Country": "NG",
                                "X-Currency": "NGN",
                              },
                            },
                          ),
                        ];
                      case 1:
                        response = _a.sent();
                        return [
                          2 /*return*/,
                          { success: true, data: response.data },
                        ];
                      case 2:
                        error_3 = _a.sent();
                        return [
                          2 /*return*/,
                          { success: false, error: error_3 },
                        ];
                      case 3:
                        return [2 /*return*/];
                    }
                  });
                });
              }),
            ];
        }
      });
    });
  };
  AirtelService.prototype.getOperationalBalance = function () {
    return __awaiter(this, void 0, void 0, function () {
      var token;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            return [4 /*yield*/, this.authenticate()];
          case 1:
            token = _a.sent();
            return [
              2 /*return*/,
              this.withRetry(function () {
                return __awaiter(_this, void 0, void 0, function () {
                  var response, rawBalance, availableBalance, error_4;
                  var _a, _b, _c, _d, _e, _f, _g;
                  return __generator(this, function (_h) {
                    switch (_h.label) {
                      case 0:
                        _h.trys.push([0, 2, , 3]);
                        return [
                          4 /*yield*/,
                          this.client.get("/standard/v1/users/balance", {
                            headers: {
                              Authorization: "Bearer ".concat(token),
                              "X-Country": process.env.AIRTEL_COUNTRY || "NG",
                              "X-Currency":
                                process.env.AIRTEL_CURRENCY || "NGN",
                            },
                          }),
                        ];
                      case 1:
                        response = _h.sent();
                        rawBalance =
                          (_f =
                            (_e =
                              (_d =
                                (_b =
                                  (_a = response.data.data) === null ||
                                  _a === void 0
                                    ? void 0
                                    : _a.availableBalance) !== null &&
                                _b !== void 0
                                  ? _b
                                  : (_c = response.data.data) === null ||
                                      _c === void 0
                                    ? void 0
                                    : _c.balance) !== null && _d !== void 0
                                ? _d
                                : response.data.availableBalance) !== null &&
                            _e !== void 0
                              ? _e
                              : response.data.balance) !== null && _f !== void 0
                            ? _f
                            : 0;
                        availableBalance =
                          typeof rawBalance === "number"
                            ? rawBalance
                            : Number.parseFloat(String(rawBalance));
                        if (!Number.isFinite(availableBalance)) {
                          throw new Error("Invalid Airtel balance response");
                        }
                        return [
                          2 /*return*/,
                          {
                            success: true,
                            data: {
                              availableBalance: availableBalance,
                              currency:
                                ((_g = response.data.data) === null ||
                                _g === void 0
                                  ? void 0
                                  : _g.currency) ||
                                response.data.currency ||
                                process.env.AIRTEL_CURRENCY ||
                                "NGN",
                            },
                          },
                        ];
                      case 2:
                        error_4 = _h.sent();
                        return [
                          2 /*return*/,
                          { success: false, error: error_4 },
                        ];
                      case 3:
                        return [2 /*return*/];
                    }
                  });
                });
              }),
            ];
        }
      });
    });
  };
  /**
   * =========================
   * PAYOUT (DISBURSEMENT)
   * =========================
   */
  AirtelService.prototype.sendPayout = function (phoneNumber, amount) {
    return __awaiter(this, void 0, void 0, function () {
      var token, reference;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            return [4 /*yield*/, this.authenticate()];
          case 1:
            token = _a.sent();
            reference = "AIRTEL-PAYOUT-".concat(Date.now());
            return [
              2 /*return*/,
              this.withRetry(function () {
                return __awaiter(_this, void 0, void 0, function () {
                  var response, error_5;
                  return __generator(this, function (_a) {
                    switch (_a.label) {
                      case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [
                          4 /*yield*/,
                          this.client.post(
                            "/standard/v1/disbursements/",
                            {
                              reference: reference,
                              payee: {
                                msisdn: phoneNumber,
                              },
                              transaction: {
                                amount: parseFloat(amount),
                                id: reference,
                              },
                            },
                            {
                              headers: {
                                Authorization: "Bearer ".concat(token),
                                "X-Country": "NG",
                                "X-Currency": "NGN",
                              },
                            },
                          ),
                        ];
                      case 1:
                        response = _a.sent();
                        return [
                          2 /*return*/,
                          { success: true, data: response.data },
                        ];
                      case 2:
                        error_5 = _a.sent();
                        return [
                          2 /*return*/,
                          { success: false, error: error_5 },
                        ];
                      case 3:
                        return [2 /*return*/];
                    }
                  });
                });
              }),
            ];
        }
      });
    });
  };
  return AirtelService;
})();
exports.AirtelService = AirtelService;
