"use strict";
var __extends =
  (this && this.__extends) ||
  (function () {
    var extendStatics = function (d, b) {
      extendStatics =
        Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array &&
          function (d, b) {
            d.__proto__ = b;
          }) ||
        function (d, b) {
          for (var p in b)
            if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
        };
      return extendStatics(d, b);
    };
    return function (d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError(
          "Class extends value " + String(b) + " is not a constructor or null",
        );
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype =
        b === null
          ? Object.create(b)
          : ((__.prototype = b.prototype), new __());
    };
  })();
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
exports.MobileMoneyService = void 0;
var metrics_1 = require("../../utils/metrics");
var circuitBreaker_1 = require("../../utils/circuitBreaker");
var isCircuitBreakerOpenError =
  circuitBreaker_1.isCircuitBreakerOpenError ||
  function () {
    return false;
  };
var retry_1 = require("../retry");
var MobileMoneyError = /** @class */ (function (_super) {
  __extends(MobileMoneyError, _super);
  function MobileMoneyError(code, message, originalError) {
    var _this = _super.call(this, message) || this;
    _this.code = code;
    _this.originalError = originalError;
    _this.name = "MobileMoneyError";
    return _this;
  }
  return MobileMoneyError;
})(Error);
/**
 * Lazy provider factory
 * Heavy modules are loaded ONLY when needed
 */
function loadProvider(key) {
  return __awaiter(this, void 0, void 0, function () {
    var _a, mod, mod, mod;
    return __generator(this, function (_b) {
      switch (_b.label) {
        case 0:
          switch (key) {
            case "mtn":
              return [3 /*break*/, 1];
            case "airtel":
              return [3 /*break*/, 3];
            case "orange":
              return [3 /*break*/, 5];
            case "vodacom":
              return [3 /*break*/, 10];
            case "mock":
              return [3 /*break*/, 8];
            case "moov":
              return [3 /*break*/, 12];
          }
          return [3 /*break*/, 7];
        case 1:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/mtn");
            }),
          ];
        case 2:
          mod = _b.sent();
          return [2 /*return*/, new mod.MTNProvider()];
        case 3:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/airtel");
            }),
          ];
        case 4:
          mod = _b.sent();
          return [2 /*return*/, new mod.AirtelService()];
        case 5:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/orange");
            }),
          ];
        case 6:
          mod = _b.sent();
          return [2 /*return*/, new mod.OrangeProvider()];
        case 7:
          throw new Error("Unknown provider: ".concat(key));
        case 8:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/mock");
            }),
          ];
        case 9:
          mod = _b.sent();
          return [2 /*return*/, new mod.MockProvider()];
        case 10:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/vodacom");
            }),
          ];
        case 11:
          mod = _b.sent();
          return [2 /*return*/, new mod.VodacomProvider()];
        case 12:
          return [
            4 /*yield*/,
            Promise.resolve().then(function () {
              return require("./providers/moov");
            }),
          ];
        case 13:
          mod = _b.sent();
          return [2 /*return*/, new mod.MoovProvider()];
      }
    });
  });
}
var MobileMoneyService = /** @class */ (function () {
  function MobileMoneyService(providers) {
    this.failoverHistory = new Map();
    this.providers = new Map();
    // Allow dependency injection for tests; otherwise use lazy loading
    if (providers) {
      this.providers = providers;
    }
  }
  MobileMoneyService.prototype.failoverEnabled = function () {
    var envVal = process.env.PROVIDER_FAILOVER_ENABLED;
    if (envVal !== undefined) {
      return String(envVal).toLowerCase() === "true";
    }
    return true; // Default to true so DB-driven fallback applies
  };
  /**
   * Returns an ordered array of fallback providers for a given primary provider.
   * Checks (in order):
   *   1. DB provider_settings.fallback_order (comma-separated)
   *   2. PROVIDER_FAILOVER_CHAIN_<PROVIDER> env var (comma-separated)
   *   3. PROVIDER_BACKUP_<PROVIDER> env var (single, backward compatible)
   * Returns an empty array if no fallback is configured.
   */
  MobileMoneyService.prototype.getFailoverChain = function (primary) {
    try {
      var settings;
      try {
        settings =
          require("../providerSettingsService").providerSettingsService.cache.get(
            "provider_setting_" + primary.toLowerCase(),
          );
      } catch (e) {
        // The static cache.get might fail if providerSettingsService isn't initialized yet
        settings = null;
      }
      if (settings && settings.fallback_order) {
        var parts = settings.fallback_order
          .split(",")
          .map(function (s) {
            return s.trim().toLowerCase();
          })
          .filter(Boolean);
        if (parts.length > 0) return parts;
      }
    } catch (e) {
      console.error("Failed to read providerSettings cache", e);
    }
    var chainEnvKey = "PROVIDER_FAILOVER_CHAIN_".concat(primary.toUpperCase());
    var chainVal = process.env[chainEnvKey];
    if (chainVal) {
      var parts = chainVal
        .split(",")
        .map(function (s) {
          return s.trim().toLowerCase();
        })
        .filter(Boolean);
      if (parts.length > 0) return parts;
    }
    var backCompatKey = "PROVIDER_BACKUP_".concat(primary.toUpperCase());
    var val = process.env[backCompatKey];
    return val ? [val.toLowerCase()] : [];
  };
  MobileMoneyService.prototype.recordFailover = function (provider) {
    var _a;
    var now = Date.now();
    var arr =
      (_a = this.failoverHistory.get(provider)) !== null && _a !== void 0
        ? _a
        : [];
    arr.push(now);
    this.failoverHistory.set(provider, arr.slice(-100));
  };
  MobileMoneyService.prototype.checkRepeatedFailovers = function (provider) {
    var _a;
    var WINDOW_MS = 60 * 60 * 1000;
    var THRESHOLD = 3;
    var now = Date.now();
    var arr =
      (_a = this.failoverHistory.get(provider)) !== null && _a !== void 0
        ? _a
        : [];
    var recent = arr.filter(function (t) {
      return now - t <= WINDOW_MS;
    });
    return recent.length >= THRESHOLD;
  };
  MobileMoneyService.prototype.notifyRepeatedFailovers = function (provider) {
    console.error(
      "Failover alert: provider=".concat(
        provider,
        " experienced repeated failovers",
      ),
    );
    metrics_1.providerFailoverAlerts.inc({ provider: provider });
  };
  MobileMoneyService.prototype.getProviderOrThrow = function (providerKey) {
    return __awaiter(this, void 0, void 0, function () {
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            if (this.providers.has(providerKey)) {
              return [2 /*return*/, this.providers.get(providerKey)];
            }
            return [4 /*yield*/, loadProvider(providerKey)];
          case 1:
            return [2 /*return*/, _a.sent()];
        }
      });
    });
  };
  MobileMoneyService.prototype.callProvider = function (
    provider,
    op,
    phoneNumber,
    amount,
  ) {
    return __awaiter(this, void 0, void 0, function () {
      return __generator(this, function (_a) {
        if (op === "requestPayment") {
          return [2 /*return*/, provider.requestPayment(phoneNumber, amount)];
        }
        return [2 /*return*/, provider.sendPayout(phoneNumber, amount)];
      });
    });
  };
  MobileMoneyService.prototype.getOperationType = function (op) {
    return op === "requestPayment" ? "payment" : "payout";
  };
  MobileMoneyService.prototype.buildProviderFailureMessage = function (
    providerKey,
    error,
    phase,
  ) {
    var reason =
      error instanceof Error && error.message
        ? error.message
        : "provider operation failed";
    return ""
      .concat(phase, " provider '")
      .concat(providerKey, "' failed: ")
      .concat(reason);
  };
  /**
   * Executes a provider operation with automatic failover across a configured chain.
   *
   * @param op            The operation type ("requestPayment" or "sendPayout")
   * @param providerKey   The provider to attempt
   * @param phoneNumber   The phone number
   * @param amount        The amount
   * @param allowFailover Whether to attempt failover on transient errors
   * @param _chain        (internal) Pre-resolved failover chain from the initial call
   * @param _attempted    (internal) Providers already attempted in this chain
   */
  MobileMoneyService.prototype.executeProviderOperation = function (
    op,
    providerKey,
    phoneNumber,
    amount,
    allowFailover,
    _chain,
    _attempted,
  ) {
    return __awaiter(this, void 0, void 0, function () {
      var provider, operationType, chain, attempted, error_1;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            if (process.env.IS_SANDBOX === "true" && providerKey !== "mock") {
              throw new Error(
                "SANDBOX_SECURITY_FAULT: External provider '".concat(
                  providerKey,
                  "' is hard-blocked in Sandbox mode.",
                ),
              );
            }
            return [4 /*yield*/, this.getProviderOrThrow(providerKey)];
          case 1:
            provider = _a.sent();
            operationType = this.getOperationType(op);
            if (process.env.IS_SANDBOX === "true" && providerKey === "mock") {
              return [
                2 /*return*/,
                {
                  success: true,
                  provider: "mock",
                  data: {
                    transactionId: "sandbox-auto-".concat(Date.now()),
                    status: "SUCCESSFUL",
                    isSandboxAutoApproved: true,
                  },
                },
              ];
            }
            // Resolve the failover chain once from the primary provider
            // Internal recursive calls pass _chain and _attempted to continue the same sequence
            if (_chain) {
              chain = _chain;
              attempted = _attempted || [];
            } else {
              chain =
                allowFailover && this.failoverEnabled()
                  ? this.getFailoverChain(providerKey)
                  : [];
              attempted = [];
            }
            _a.label = 2;
          case 2:
            _a.trys.push([2, 4, , 5]);
            return [
              4 /*yield*/,
              (0, circuitBreaker_1.executeWithCircuitBreaker)({
                provider: providerKey,
                operation: op,
                execute: function () {
                  return __awaiter(_this, void 0, void 0, function () {
                    var result;
                    return __generator(this, function (_a) {
                      switch (_a.label) {
                        case 0:
                          return [
                            4 /*yield*/,
                            this.callProvider(
                              provider,
                              op,
                              phoneNumber,
                              amount,
                            ),
                          ];
                        case 1:
                          result = _a.sent();
                          return [
                            2 /*return*/,
                            result.success
                              ? {
                                  success: true,
                                  provider: providerKey,
                                  data: result.data,
                                }
                              : {
                                  success: false,
                                  provider: providerKey,
                                  error: result.error,
                                },
                          ];
                      }
                    });
                  });
                },
                fallback:
                  chain.length > 0
                    ? function (error) {
                        return __awaiter(_this, void 0, void 0, function () {
                          var isTransient,
                            isBreakerOpen,
                            nextIdx,
                            nextProvider,
                            failoverLogMsg;
                          return __generator(this, function (_a) {
                            // Circuit breaker open is always a transient condition worth failing over
                            isBreakerOpen = isCircuitBreakerOpenError(error);
                            isTransient =
                              isBreakerOpen ||
                              (0, retry_1.isTransientError)(error, providerKey);
                            if (!isTransient) {
                              console.warn(
                                "Not failing over: non-transient error from "
                                  .concat(providerKey, ": ")
                                  .concat(
                                    error instanceof Error
                                      ? error.message
                                      : String(error),
                                  ),
                              );
                              throw error;
                            }
                            attempted.push(providerKey);
                            nextIdx = -1;
                            for (var i = 0; i < chain.length; i++) {
                              if (attempted.indexOf(chain[i]) === -1) {
                                nextIdx = i;
                                break;
                              }
                            }
                            if (nextIdx === -1) {
                              failoverLogMsg =
                                "All failover providers exhausted for "
                                  .concat(providerKey, ". Attempted: ")
                                  .concat(attempted.join(", "));
                              console.error(failoverLogMsg);
                              throw new Error(failoverLogMsg);
                            }
                            nextProvider = chain[nextIdx];
                            console.warn(
                              "Failing over from "
                                .concat(providerKey, " to ")
                                .concat(nextProvider, " for ")
                                .concat(op, " (attempt ")
                                .concat(attempted.length, "/")
                                .concat(chain.length, ")"),
                            );
                            metrics_1.providerFailoverTotal.inc({
                              type: operationType,
                              from_provider: providerKey,
                              to_provider: nextProvider,
                              reason: String(error).slice(0, 100),
                            });
                            this.recordFailover(providerKey);
                            if (this.checkRepeatedFailovers(providerKey)) {
                              this.notifyRepeatedFailovers(providerKey);
                            }
                            return [
                              2 /*return*/,
                              this.executeProviderOperation(
                                op,
                                nextProvider,
                                phoneNumber,
                                amount,
                                true,
                                chain,
                                attempted,
                              ),
                            ];
                          });
                        });
                      }
                    : undefined,
              }),
            ];
          case 3:
            return [2 /*return*/, _a.sent()];
          case 4:
            error_1 = _a.sent();
            metrics_1.transactionTotal.inc({
              type: operationType,
              provider: providerKey,
              status: "failure",
            });
            metrics_1.transactionErrorsTotal.inc({
              type: operationType,
              provider: providerKey,
              error_type: allowFailover
                ? "provider_or_exception"
                : "backup_failure",
            });
            throw new MobileMoneyError(
              "PROVIDER_ERROR",
              this.buildProviderFailureMessage(
                providerKey,
                error_1,
                allowFailover ? "primary" : "backup",
              ),
              error_1,
            );
          case 5:
            return [2 /*return*/];
        }
      });
    });
  };
  MobileMoneyService.prototype.initiatePayment = function (
    provider,
    phoneNumber,
    amount,
  ) {
    return __awaiter(this, void 0, void 0, function () {
      var providerKey, result;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            providerKey = provider.toLowerCase();
            return [
              4 /*yield*/,
              this.executeProviderOperation(
                "requestPayment",
                providerKey,
                phoneNumber,
                amount,
                true,
              ),
            ];
          case 1:
            result = _a.sent();
            if (result.success) {
              metrics_1.transactionTotal.inc({
                type: "payment",
                provider: result.provider,
                status: "success",
              });
              return [
                2 /*return*/,
                {
                  success: true,
                  data: result.data,
                  providerResponseTimeMs: result.providerResponseTimeMs,
                },
              ];
            }
            throw new MobileMoneyError(
              "PROVIDER_ERROR",
              "Payment failed for provider '".concat(providerKey, "'"),
              result.error,
            );
        }
      });
    });
  };
  MobileMoneyService.prototype.sendPayout = function (
    provider,
    phoneNumber,
    amount,
  ) {
    return __awaiter(this, void 0, void 0, function () {
      var providerKey, result;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            providerKey = provider.toLowerCase();
            return [
              4 /*yield*/,
              this.executeProviderOperation(
                "sendPayout",
                providerKey,
                phoneNumber,
                amount,
                true,
              ),
            ];
          case 1:
            result = _a.sent();
            if (result.success) {
              metrics_1.transactionTotal.inc({
                type: "payout",
                provider: result.provider,
                status: "success",
              });
              return [
                2 /*return*/,
                {
                  success: true,
                  data: result.data,
                  providerResponseTimeMs: result.providerResponseTimeMs,
                },
              ];
            }
            throw new MobileMoneyError(
              "PROVIDER_ERROR",
              "Payout failed for provider '".concat(providerKey, "'"),
              result.error,
            );
        }
      });
    });
  };
  MobileMoneyService.prototype.getFailoverStats = function () {
    var stats = {};
    for (
      var _i = 0, _a = this.failoverHistory.entries();
      _i < _a.length;
      _i++
    ) {
      var _b = _a[_i],
        provider = _b[0],
        history_1 = _b[1];
      stats[provider] = {
        failover_count: history_1.length,
        last_failover: history_1.at(-1),
      };
    }
    return stats;
  };
  MobileMoneyService.prototype.sendBatchPayout = function (provider, items) {
    return __awaiter(this, void 0, void 0, function () {
      var providerKey,
        MAX_BATCH_SIZE,
        providerInstance,
        results,
        _i,
        items_1,
        item,
        result_1,
        startTime_1,
        result,
        responseTimeMs,
        successCount,
        failureCount,
        i,
        i,
        error_2,
        errorMessage;
      var _this = this;
      return __generator(this, function (_a) {
        switch (_a.label) {
          case 0:
            providerKey = provider.toLowerCase();
            MAX_BATCH_SIZE = 50;
            if (items.length === 0) {
              return [2 /*return*/, { success: true, results: [] }];
            }
            if (items.length > MAX_BATCH_SIZE) {
              return [
                2 /*return*/,
                {
                  success: false,
                  results: items.map(function (item) {
                    return {
                      referenceId: item.referenceId,
                      success: false,
                      error: "Batch size exceeds maximum of ".concat(
                        MAX_BATCH_SIZE,
                      ),
                    };
                  }),
                  error: new Error(
                    "Batch size "
                      .concat(items.length, " exceeds maximum of ")
                      .concat(MAX_BATCH_SIZE),
                  ),
                },
              ];
            }
            _a.label = 1;
          case 1:
            _a.trys.push([1, 6, , 7]);
            return [4 /*yield*/, this.getProviderOrThrow(providerKey)];
          case 2:
            providerInstance = _a.sent();
            if (!providerInstance.sendBatchPayout) {
              // Fallback: process individually if batch not supported
              console.warn(
                "Provider '".concat(
                  providerKey,
                  "' does not support batch payout, falling back to individual processing",
                ),
              );
              results = [];
              ((_i = 0), (items_1 = items));
              _a.label = 3;
            }
          case 3:
            if (!(_i < items_1.length)) return [3 /*break*/, 5];
            item = items_1[_i];
            return [
              4 /*yield*/,
              this.sendPayout(providerKey, item.phoneNumber, item.amount),
            ];
          case 4:
            result_1 = _a.sent();
            results.push({
              referenceId: item.referenceId,
              success: true,
              providerReference: result_1.data
                ? String(result_1.data.referenceId || "")
                : undefined,
            });
            _i++;
            return [3 /*break*/, 3];
          case 5:
            return [
              2 /*return*/,
              {
                success: results.some(function (r) {
                  return r.success;
                }),
                results: results,
              },
            ];
          case 6:
            error_2 = _a.sent();
            errorMessage =
              error_2 instanceof Error
                ? error_2.message
                : "Batch payout failed";
            metrics_1.transactionErrorsTotal.inc({
              type: "payout",
              provider: providerKey,
              error_type: "batch_payout_error",
            });
            return [
              2 /*return*/,
              {
                success: false,
                results: items.map(function (item) {
                  return {
                    referenceId: item.referenceId,
                    success: false,
                    error: errorMessage,
                  };
                }),
                error: error_2,
              },
            ];
          case 7:
            startTime_1 = Date.now();
            return [
              4 /*yield*/,
              (0, circuitBreaker_1.executeWithCircuitBreaker)({
                provider: providerKey,
                operation: "sendBatchPayout",
                execute: function () {
                  return __awaiter(_this, void 0, void 0, function () {
                    return __generator(this, function (_a) {
                      return [
                        2 /*return*/,
                        providerInstance.sendBatchPayout(items),
                      ];
                    });
                  });
                },
              }),
            ];
          case 8:
            result = _a.sent();
            responseTimeMs = Date.now() - startTime_1;
            successCount = result.results
              ? result.results.filter(function (r) {
                  return r.success;
                }).length
              : 0;
            failureCount = result.results
              ? result.results.filter(function (r) {
                  return !r.success;
                }).length
              : 0;
            for (i = 0; i < successCount; i++) {
              metrics_1.transactionTotal.inc({
                type: "payout",
                provider: providerKey,
                status: "success",
              });
            }
            for (i = 0; i < failureCount; i++) {
              metrics_1.transactionTotal.inc({
                type: "payout",
                provider: providerKey,
                status: "failure",
              });
            }
            console.log(
              "[BatchPayout] Provider="
                .concat(providerKey, " processed ")
                .concat(items.length, " items: ")
                .concat(successCount, " success, ")
                .concat(failureCount, " failed (")
                .concat(responseTimeMs, "ms)"),
            );
            return [2 /*return*/, result];
          case 9:
            return [2 /*return*/];
        }
      });
    });
  };
  return MobileMoneyService;
})();
exports.MobileMoneyService = MobileMoneyService;
