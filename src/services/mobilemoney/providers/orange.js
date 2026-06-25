"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrangeProvider = void 0;
var axios_1 = require("axios");
var fs = require("fs");
var path = require("path");
var DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;
var DEFAULT_REFRESH_SKEW_MS = 60 * 1000;
var OrangeProvider = /** @class */ (function () {
    function OrangeProvider(options) {
        if (options === void 0) { options = {}; }
        var _a, _b, _c, _d;
        this.session = null;
        this.sessionPromise = null;
        this.apiToken = null;
        this.apiTokenExpiry = 0;
        this.clock = (_a = options.clock) !== null && _a !== void 0 ? _a : Date.now;
        this.config = this.buildConfig(options);
        this.mode = this.resolveMode();
        this.client =
            (_b = options.httpClient) !== null && _b !== void 0 ? _b : axios_1.default.create({
                baseURL: this.config.webBaseUrl,
                timeout: this.config.requestTimeoutMs,
                maxRedirects: 0,
                validateStatus: function () { return true; },
            });
        this.directClient =
            (_c = options.directHttpClient) !== null && _c !== void 0 ? _c : axios_1.default.create({
                baseURL: this.config.directBaseUrl,
                timeout: this.config.requestTimeoutMs,
                validateStatus: function () { return true; },
            });
        if (this.config.proxyBaseUrl) {
            this.proxyClient =
                (_d = options.proxyHttpClient) !== null && _d !== void 0 ? _d : axios_1.default.create({
                    baseURL: this.config.proxyBaseUrl,
                    timeout: this.config.requestTimeoutMs,
                    validateStatus: function () { return true; },
                });
        }
    }
    OrangeProvider.prototype.requestPayment = function (phoneNumber, amount) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, this.executeOperation("payment", phoneNumber, String(amount))];
            });
        });
    };
    OrangeProvider.prototype.sendPayout = function (phoneNumber, amount) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, this.executeOperation("payout", phoneNumber, String(amount))];
            });
        });
    };
    OrangeProvider.prototype.checkStatus = function (reference) {
        return __awaiter(this, void 0, void 0, function () {
            var response_1, response_2, response, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 6, , 7]);
                        if (!(this.mode === "proxy")) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.sendRequest(this.proxyClient, {
                                method: "GET",
                                url: this.formatPath(this.config.statusPath, reference),
                                headers: this.config.proxySecret
                                    ? { "X-Orange-Proxy-Secret": this.config.proxySecret }
                                    : undefined,
                            })];
                    case 1:
                        response_1 = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response_1, reference)];
                    case 2:
                        if (!(this.mode === "direct")) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.requestDirect({
                                method: "GET",
                                url: this.formatPath(this.config.directStatusPath, reference),
                            })];
                    case 3:
                        response_2 = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response_2, reference)];
                    case 4: return [4 /*yield*/, this.requestWithSession({
                            method: "GET",
                            url: this.formatPath(this.config.statusPath, reference),
                        }, "payment")];
                    case 5:
                        response = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response, reference)];
                    case 6:
                        error_1 = _a.sent();
                        return [2 /*return*/, { success: false, error: error_1, reference: reference }];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    OrangeProvider.prototype.buildConfig = function (options) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29;
        return {
            mode: (_a = options.mode) !== null && _a !== void 0 ? _a : process.env.ORANGE_MODE,
            webBaseUrl: (_d = (_c = (_b = options.webBaseUrl) !== null && _b !== void 0 ? _b : options.baseUrl) !== null && _c !== void 0 ? _c : process.env.ORANGE_WEB_BASE_URL) !== null && _d !== void 0 ? _d : "",
            directBaseUrl: (_g = (_f = (_e = options.directBaseUrl) !== null && _e !== void 0 ? _e : options.baseUrl) !== null && _f !== void 0 ? _f : process.env.ORANGE_BASE_URL) !== null && _g !== void 0 ? _g : "https://sandbox.orange.com",
            loginPath: (_j = (_h = options.loginPath) !== null && _h !== void 0 ? _h : process.env.ORANGE_LOGIN_PATH) !== null && _j !== void 0 ? _j : "/login",
            refreshPath: (_l = (_k = options.refreshPath) !== null && _k !== void 0 ? _k : process.env.ORANGE_REFRESH_PATH) !== null && _l !== void 0 ? _l : "/session/refresh",
            paymentPath: (_o = (_m = options.paymentPath) !== null && _m !== void 0 ? _m : process.env.ORANGE_PAYMENT_PATH) !== null && _o !== void 0 ? _o : "/transactions/collections",
            payoutPath: (_q = (_p = options.payoutPath) !== null && _p !== void 0 ? _p : process.env.ORANGE_PAYOUT_PATH) !== null && _q !== void 0 ? _q : "/transactions/payouts",
            statusPath: (_s = (_r = options.statusPath) !== null && _r !== void 0 ? _r : process.env.ORANGE_STATUS_PATH) !== null && _s !== void 0 ? _s : "/transactions/:reference",
            directAuthPath: (_u = (_t = options.directAuthPath) !== null && _t !== void 0 ? _t : process.env.ORANGE_DIRECT_AUTH_PATH) !== null && _u !== void 0 ? _u : "/oauth/token",
            directPaymentPath: (_w = (_v = options.directPaymentPath) !== null && _v !== void 0 ? _v : process.env.ORANGE_DIRECT_PAYMENT_PATH) !== null && _w !== void 0 ? _w : "/v1/payments/collect",
            directPayoutPath: (_y = (_x = options.directPayoutPath) !== null && _x !== void 0 ? _x : process.env.ORANGE_DIRECT_PAYOUT_PATH) !== null && _y !== void 0 ? _y : "/v1/payments/disburse",
            directStatusPath: (_0 = (_z = options.directStatusPath) !== null && _z !== void 0 ? _z : process.env.ORANGE_DIRECT_STATUS_PATH) !== null && _0 !== void 0 ? _0 : "/v1/payments/:reference",
            username: (_3 = (_2 = (_1 = options.username) !== null && _1 !== void 0 ? _1 : process.env.ORANGE_USERNAME) !== null && _2 !== void 0 ? _2 : process.env.ORANGE_API_KEY) !== null && _3 !== void 0 ? _3 : "",
            password: (_6 = (_5 = (_4 = options.password) !== null && _4 !== void 0 ? _4 : process.env.ORANGE_PASSWORD) !== null && _5 !== void 0 ? _5 : process.env.ORANGE_API_SECRET) !== null && _6 !== void 0 ? _6 : "",
            apiKey: (_8 = (_7 = options.apiKey) !== null && _7 !== void 0 ? _7 : process.env.ORANGE_API_KEY) !== null && _8 !== void 0 ? _8 : "",
            apiSecret: (_10 = (_9 = options.apiSecret) !== null && _9 !== void 0 ? _9 : process.env.ORANGE_API_SECRET) !== null && _10 !== void 0 ? _10 : "",
            usernameField: (_12 = (_11 = options.usernameField) !== null && _11 !== void 0 ? _11 : process.env.ORANGE_USERNAME_FIELD) !== null && _12 !== void 0 ? _12 : "username",
            passwordField: (_14 = (_13 = options.passwordField) !== null && _13 !== void 0 ? _13 : process.env.ORANGE_PASSWORD_FIELD) !== null && _14 !== void 0 ? _14 : "password",
            csrfField: (_16 = (_15 = options.csrfField) !== null && _15 !== void 0 ? _15 : process.env.ORANGE_CSRF_FIELD) !== null && _16 !== void 0 ? _16 : "_csrf",
            currency: (_18 = (_17 = options.currency) !== null && _17 !== void 0 ? _17 : process.env.ORANGE_CURRENCY) !== null && _18 !== void 0 ? _18 : "XAF",
            sessionStorePath: (_19 = options.sessionStorePath) !== null && _19 !== void 0 ? _19 : process.env.ORANGE_SESSION_STORE_PATH,
            sessionTtlMs: Number((_21 = (_20 = options.sessionTtlMs) !== null && _20 !== void 0 ? _20 : process.env.ORANGE_SESSION_TTL_MS) !== null && _21 !== void 0 ? _21 : DEFAULT_SESSION_TTL_MS),
            refreshSkewMs: Number((_23 = (_22 = options.refreshSkewMs) !== null && _22 !== void 0 ? _22 : process.env.ORANGE_REFRESH_SKEW_MS) !== null && _23 !== void 0 ? _23 : DEFAULT_REFRESH_SKEW_MS),
            requestTimeoutMs: Number((_25 = (_24 = options.requestTimeoutMs) !== null && _24 !== void 0 ? _24 : process.env.ORANGE_REQUEST_TIMEOUT_MS) !== null && _25 !== void 0 ? _25 : 30000),
            maxAttempts: Number((_27 = (_26 = options.maxAttempts) !== null && _26 !== void 0 ? _26 : process.env.ORANGE_MAX_ATTEMPTS) !== null && _27 !== void 0 ? _27 : 3),
            proxyBaseUrl: (_28 = options.proxyBaseUrl) !== null && _28 !== void 0 ? _28 : process.env.ORANGE_PROXY_URL,
            proxySecret: (_29 = options.proxySecret) !== null && _29 !== void 0 ? _29 : process.env.ORANGE_PROXY_SECRET,
        };
    };
    OrangeProvider.prototype.sendRequest = function (client, request) {
        return __awaiter(this, void 0, void 0, function () {
            var method, url, config, data;
            var _a;
            return __generator(this, function (_b) {
                if (client.request) {
                    return [2 /*return*/, client.request(request)];
                }
                method = ((_a = request.method) !== null && _a !== void 0 ? _a : "GET").toUpperCase();
                url = request.url;
                if (!url) {
                    throw new Error("Orange request URL is required");
                }
                config = __assign(__assign({}, request), { timeout: request.timeout == null ? this.config.requestTimeoutMs : request.timeout });
                delete config.method;
                delete config.url;
                if (method === "GET" && client.get) {
                    delete config.data;
                    return [2 /*return*/, client.get(url, config)];
                }
                if (method === "POST" && client.post) {
                    data = config.data;
                    delete config.data;
                    return [2 /*return*/, client.post(url, data, config)];
                }
                throw new Error("Orange HTTP client does not support ".concat(method));
            });
        });
    };
    OrangeProvider.prototype.resolveMode = function () {
        if (this.config.proxyBaseUrl) {
            return "proxy";
        }
        if (this.config.mode === "direct" || this.config.mode === "web") {
            return this.config.mode;
        }
        if (this.config.webBaseUrl &&
            (this.config.username || this.config.sessionStorePath)) {
            return "web";
        }
        return "direct";
    };
    OrangeProvider.prototype.executeOperation = function (operation, phoneNumber, amount) {
        return __awaiter(this, void 0, void 0, function () {
            var reference, response, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 6, , 7]);
                        if (!(this.mode === "proxy")) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.executeViaProxy(operation, phoneNumber, amount)];
                    case 1: return [2 /*return*/, _a.sent()];
                    case 2:
                        if (!(this.mode === "direct")) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.executeViaDirectApi(operation, phoneNumber, amount)];
                    case 3: return [2 /*return*/, _a.sent()];
                    case 4:
                        this.assertWebConfig();
                        reference = this.createReference(operation);
                        return [4 /*yield*/, this.requestWithSession({
                                method: "POST",
                                url: operation === "payment"
                                    ? this.config.paymentPath
                                    : this.config.payoutPath,
                                data: {
                                    amount: amount,
                                    currency: this.config.currency,
                                    msisdn: phoneNumber,
                                    reference: reference,
                                },
                            }, operation)];
                    case 5:
                        response = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response, reference)];
                    case 6:
                        error_2 = _a.sent();
                        return [2 /*return*/, { success: false, error: error_2 }];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    OrangeProvider.prototype.executeViaProxy = function (operation, phoneNumber, amount) {
        return __awaiter(this, void 0, void 0, function () {
            var reference, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        reference = this.createReference(operation);
                        return [4 /*yield*/, this.sendRequest(this.proxyClient, {
                                method: "POST",
                                url: operation === "payment"
                                    ? this.config.paymentPath
                                    : this.config.payoutPath,
                                headers: this.config.proxySecret
                                    ? { "X-Orange-Proxy-Secret": this.config.proxySecret }
                                    : undefined,
                                data: {
                                    amount: amount,
                                    currency: this.config.currency,
                                    msisdn: phoneNumber,
                                    reference: reference,
                                },
                            })];
                    case 1:
                        response = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response, reference)];
                }
            });
        });
    };
    OrangeProvider.prototype.executeViaDirectApi = function (operation, phoneNumber, amount) {
        return __awaiter(this, void 0, void 0, function () {
            var reference, endpoint, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        reference = this.createReference(operation);
                        endpoint = operation === "payment"
                            ? this.config.directPaymentPath
                            : this.config.directPayoutPath;
                        return [4 /*yield*/, this.requestDirect({
                                method: "POST",
                                url: endpoint,
                                data: operation === "payment"
                                    ? {
                                        reference: reference,
                                        subscriber: { msisdn: phoneNumber },
                                        transaction: {
                                            amount: parseFloat(amount),
                                            currency: this.config.currency,
                                            id: reference,
                                        },
                                    }
                                    : {
                                        reference: reference,
                                        payee: { msisdn: phoneNumber },
                                        transaction: {
                                            amount: parseFloat(amount),
                                            currency: this.config.currency,
                                            id: reference,
                                        },
                                    },
                            })];
                    case 1:
                        response = _a.sent();
                        return [2 /*return*/, this.toProviderResult(response, reference)];
                }
            });
        });
    };
    OrangeProvider.prototype.requestDirect = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var lastResponse, lastError, attempt, token, requestHeaders, response, error_3;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        lastResponse = null;
                        attempt = 1;
                        _c.label = 1;
                    case 1:
                        if (!(attempt <= this.config.maxAttempts)) return [3 /*break*/, 10];
                        _c.label = 2;
                    case 2:
                        _c.trys.push([2, 7, , 9]);
                        return [4 /*yield*/, this.authenticateDirect()];
                    case 3:
                        token = _c.sent();
                        requestHeaders = ((_a = request.headers) !== null && _a !== void 0 ? _a : {});
                        return [4 /*yield*/, this.sendRequest(this.directClient, __assign(__assign({}, request), { headers: __assign(__assign({}, requestHeaders), { Authorization: "Bearer ".concat(token), "Content-Type": (_b = requestHeaders["Content-Type"]) !== null && _b !== void 0 ? _b : "application/json" }) }))];
                    case 4:
                        response = _c.sent();
                        if (response.status === 401 || response.status === 403) {
                            this.apiToken = null;
                            lastResponse = response;
                            return [3 /*break*/, 9];
                        }
                        if (!(response.status >= 500 && attempt < this.config.maxAttempts)) return [3 /*break*/, 6];
                        lastResponse = response;
                        return [4 /*yield*/, this.delay(attempt)];
                    case 5:
                        _c.sent();
                        return [3 /*break*/, 9];
                    case 6: return [2 /*return*/, response];
                    case 7:
                        error_3 = _c.sent();
                        lastError = error_3;
                        if (attempt >= this.config.maxAttempts) {
                            throw error_3;
                        }
                        return [4 /*yield*/, this.delay(attempt)];
                    case 8:
                        _c.sent();
                        return [3 /*break*/, 9];
                    case 9:
                        attempt++;
                        return [3 /*break*/, 1];
                    case 10:
                        if (lastResponse) {
                            return [2 /*return*/, lastResponse];
                        }
                        throw lastError !== null && lastError !== void 0 ? lastError : new Error("Orange direct API request failed");
                }
            });
        });
    };
    OrangeProvider.prototype.authenticateDirect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var authHeader, response, data;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.apiToken && this.clock() < this.apiTokenExpiry) {
                            return [2 /*return*/, this.apiToken];
                        }
                        if (this.config.mode === "direct") {
                            this.assertDirectConfig();
                        }
                        authHeader = "Basic " +
                            Buffer.from("".concat(this.config.apiKey, ":").concat(this.config.apiSecret)).toString("base64");
                        return [4 /*yield*/, this.sendRequest(this.directClient, {
                                method: "POST",
                                url: this.config.directAuthPath,
                                headers: {
                                    Authorization: authHeader,
                                    "Content-Type": "application/x-www-form-urlencoded",
                                },
                                data: "grant_type=client_credentials",
                            })];
                    case 1:
                        response = _b.sent();
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error("Orange direct auth failed with status ".concat(response.status));
                        }
                        data = response.data;
                        if (!data.access_token) {
                            throw new Error("Orange direct auth did not return access_token");
                        }
                        this.apiToken = data.access_token;
                        this.apiTokenExpiry =
                            this.clock() + ((_a = data.expires_in) !== null && _a !== void 0 ? _a : 3600) * 1000 - 5000;
                        return [2 /*return*/, this.apiToken];
                }
            });
        });
    };
    OrangeProvider.prototype.requestWithSession = function (request, operation) {
        return __awaiter(this, void 0, void 0, function () {
            var lastResponse, lastError, attempt, session, requestHeaders, response, error_4;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        lastResponse = null;
                        attempt = 1;
                        _d.label = 1;
                    case 1:
                        if (!(attempt <= this.config.maxAttempts)) return [3 /*break*/, 10];
                        return [4 /*yield*/, this.ensureSession(attempt > 1)];
                    case 2:
                        session = _d.sent();
                        requestHeaders = ((_a = request.headers) !== null && _a !== void 0 ? _a : {});
                        _d.label = 3;
                    case 3:
                        _d.trys.push([3, 7, , 9]);
                        return [4 /*yield*/, this.sendRequest(this.client, __assign(__assign({}, request), { headers: __assign(__assign({}, requestHeaders), { Cookie: this.serializeCookies(session), "X-CSRF-Token": (_b = session.csrfToken) !== null && _b !== void 0 ? _b : "", "Idempotency-Key": (_c = requestHeaders["Idempotency-Key"]) !== null && _c !== void 0 ? _c : this.getRequestReference(request, operation) }) }))];
                    case 4:
                        response = _d.sent();
                        this.captureSession(response, session);
                        if (this.isSessionExpiredResponse(response)) {
                            this.session = null;
                            lastResponse = response;
                            return [3 /*break*/, 9];
                        }
                        if (!(response.status >= 500 && attempt < this.config.maxAttempts)) return [3 /*break*/, 6];
                        lastResponse = response;
                        return [4 /*yield*/, this.delay(attempt)];
                    case 5:
                        _d.sent();
                        return [3 /*break*/, 9];
                    case 6: return [2 /*return*/, response];
                    case 7:
                        error_4 = _d.sent();
                        lastError = error_4;
                        if (attempt >= this.config.maxAttempts) {
                            throw error_4;
                        }
                        return [4 /*yield*/, this.delay(attempt)];
                    case 8:
                        _d.sent();
                        return [3 /*break*/, 9];
                    case 9:
                        attempt++;
                        return [3 /*break*/, 1];
                    case 10:
                        if (lastResponse) {
                            return [2 /*return*/, lastResponse];
                        }
                        throw lastError !== null && lastError !== void 0 ? lastError : new Error("Orange request failed");
                }
            });
        });
    };
    OrangeProvider.prototype.ensureSession = function () {
        return __awaiter(this, arguments, void 0, function (forceLogin) {
            var cached;
            var _a;
            if (forceLogin === void 0) { forceLogin = false; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!forceLogin) {
                            cached = (_a = this.session) !== null && _a !== void 0 ? _a : this.loadSession();
                            if (cached && !this.isExpired(cached)) {
                                this.session = cached;
                                if (this.shouldRefresh(cached)) {
                                    return [2 /*return*/, this.refreshSession(cached)];
                                }
                                return [2 /*return*/, cached];
                            }
                        }
                        if (!this.sessionPromise || forceLogin) {
                            this.sessionPromise = this.login();
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, , 3, 4]);
                        return [4 /*yield*/, this.sessionPromise];
                    case 2: return [2 /*return*/, _b.sent()];
                    case 3:
                        this.sessionPromise = null;
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    OrangeProvider.prototype.login = function () {
        return __awaiter(this, void 0, void 0, function () {
            var loginPage, initialSession, csrfToken, payload, loginResponse, session;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, this.sendRequest(this.client, {
                            method: "GET",
                            url: this.config.loginPath,
                        })];
                    case 1:
                        loginPage = _c.sent();
                        initialSession = this.captureSession(loginPage);
                        csrfToken = (_a = this.extractCsrfToken(loginPage)) !== null && _a !== void 0 ? _a : initialSession.csrfToken;
                        payload = new URLSearchParams();
                        payload.set(this.config.usernameField, this.config.username);
                        payload.set(this.config.passwordField, this.config.password);
                        if (csrfToken) {
                            payload.set(this.config.csrfField, csrfToken);
                        }
                        return [4 /*yield*/, this.sendRequest(this.client, {
                                method: "POST",
                                url: this.config.loginPath,
                                headers: __assign({ "Content-Type": "application/x-www-form-urlencoded", Cookie: this.serializeCookies(initialSession) }, (csrfToken ? { "X-CSRF-Token": csrfToken } : {})),
                                data: payload.toString(),
                            })];
                    case 2:
                        loginResponse = _c.sent();
                        if (loginResponse.status < 200 || loginResponse.status >= 300) {
                            throw new Error("Orange login failed with status ".concat(loginResponse.status));
                        }
                        session = this.captureSession(loginResponse, initialSession);
                        session.csrfToken = (_b = this.extractCsrfToken(loginResponse)) !== null && _b !== void 0 ? _b : csrfToken;
                        this.session = this.ensureExpiresAt(session);
                        this.persistSession(this.session);
                        return [2 /*return*/, this.session];
                }
            });
        });
    };
    OrangeProvider.prototype.refreshSession = function (session) {
        return __awaiter(this, void 0, void 0, function () {
            var response, _a;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.sendRequest(this.client, {
                                method: "POST",
                                url: this.config.refreshPath,
                                headers: __assign({ Cookie: this.serializeCookies(session) }, (session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {})),
                            })];
                    case 1:
                        response = _c.sent();
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error("Orange refresh failed with status ".concat(response.status));
                        }
                        this.captureSession(response, session);
                        session.csrfToken = (_b = this.extractCsrfToken(response)) !== null && _b !== void 0 ? _b : session.csrfToken;
                        this.session = this.ensureExpiresAt(session);
                        this.persistSession(this.session);
                        return [2 /*return*/, this.session];
                    case 2:
                        _a = _c.sent();
                        this.session = null;
                        return [2 /*return*/, this.login()];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    OrangeProvider.prototype.captureSession = function (response, existing) {
        var _a, _b, _c;
        var session = existing !== null && existing !== void 0 ? existing : {
            cookies: {},
            expiresAt: this.clock() + this.config.sessionTtlMs,
            authenticatedAt: this.clock(),
        };
        for (var _i = 0, _d = this.getSetCookieHeaders(response); _i < _d.length; _i++) {
            var cookie = _d[_i];
            var parsed = this.parseSetCookie(cookie);
            if (parsed) {
                session.cookies[parsed.name] = {
                    value: parsed.value,
                    expiresAt: parsed.expiresAt,
                };
            }
        }
        session.csrfToken = (_a = this.extractCsrfToken(response)) !== null && _a !== void 0 ? _a : session.csrfToken;
        session.expiresAt =
            (_c = (_b = this.getEarliestCookieExpiry(session)) !== null && _b !== void 0 ? _b : session.expiresAt) !== null && _c !== void 0 ? _c : this.clock() + this.config.sessionTtlMs;
        return session;
    };
    OrangeProvider.prototype.loadSession = function () {
        if (!this.config.sessionStorePath) {
            return null;
        }
        try {
            if (!fs.existsSync(this.config.sessionStorePath)) {
                return null;
            }
            var raw = fs.readFileSync(this.config.sessionStorePath, "utf8");
            var parsed = JSON.parse(raw);
            if (!parsed.cookies || !parsed.expiresAt || this.isExpired(parsed)) {
                return null;
            }
            return parsed;
        }
        catch (_a) {
            return null;
        }
    };
    OrangeProvider.prototype.persistSession = function (session) {
        if (!this.config.sessionStorePath) {
            return;
        }
        var dir = path.dirname(this.config.sessionStorePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.config.sessionStorePath, JSON.stringify(session), {
            mode: 384,
        });
    };
    OrangeProvider.prototype.serializeCookies = function (session) {
        var now = this.clock();
        return Object.entries(session.cookies)
            .filter(function (_a) {
            var cookie = _a[1];
            return !cookie.expiresAt || cookie.expiresAt > now;
        })
            .map(function (_a) {
            var name = _a[0], cookie = _a[1];
            return "".concat(name, "=").concat(cookie.value);
        })
            .join("; ");
    };
    OrangeProvider.prototype.parseSetCookie = function (header) {
        var _a = header.split(";").map(function (part) { return part.trim(); }), pair = _a[0], attributes = _a.slice(1);
        var separator = pair.indexOf("=");
        if (separator <= 0) {
            return null;
        }
        var cookie = {
            name: pair.slice(0, separator),
            value: pair.slice(separator + 1),
        };
        for (var _i = 0, attributes_1 = attributes; _i < attributes_1.length; _i++) {
            var attribute = attributes_1[_i];
            var _b = attribute.split("="), key = _b[0], value = _b[1];
            if (key.toLowerCase() === "expires" && value) {
                var expiresAt = Date.parse(value);
                if (!Number.isNaN(expiresAt)) {
                    cookie.expiresAt = expiresAt;
                }
            }
            if (key.toLowerCase() === "max-age" && value) {
                var seconds = Number(value);
                if (!Number.isNaN(seconds)) {
                    cookie.expiresAt = this.clock() + seconds * 1000;
                }
            }
        }
        return cookie;
    };
    OrangeProvider.prototype.getSetCookieHeaders = function (response) {
        var _a;
        var headers = response.headers;
        var value = (_a = headers["set-cookie"]) !== null && _a !== void 0 ? _a : headers["Set-Cookie"];
        if (!value) {
            return [];
        }
        return Array.isArray(value) ? value : [value];
    };
    OrangeProvider.prototype.extractCsrfToken = function (response) {
        var _a, _b, _c;
        var headers = response.headers;
        var headerToken = (_a = headers["x-csrf-token"]) !== null && _a !== void 0 ? _a : headers["X-CSRF-Token"];
        if (headerToken) {
            return headerToken;
        }
        if (typeof response.data !== "string") {
            return undefined;
        }
        var html = response.data;
        var metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
        var inputMatch = html.match(/<input[^>]+name=["'](?:_csrf|csrf_token|csrf)["'][^>]+value=["']([^"']+)["']/i);
        var reversedInputMatch = html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["'](?:_csrf|csrf_token|csrf)["']/i);
        return (_c = (_b = metaMatch === null || metaMatch === void 0 ? void 0 : metaMatch[1]) !== null && _b !== void 0 ? _b : inputMatch === null || inputMatch === void 0 ? void 0 : inputMatch[1]) !== null && _c !== void 0 ? _c : reversedInputMatch === null || reversedInputMatch === void 0 ? void 0 : reversedInputMatch[1];
    };
    OrangeProvider.prototype.ensureExpiresAt = function (session) {
        if (!session.expiresAt || session.expiresAt <= this.clock()) {
            session.expiresAt = this.clock() + this.config.sessionTtlMs;
        }
        return session;
    };
    OrangeProvider.prototype.getEarliestCookieExpiry = function (session) {
        var expiries = Object.values(session.cookies)
            .map(function (cookie) { return cookie.expiresAt; })
            .filter(function (expiresAt) { return Boolean(expiresAt); });
        return expiries.length > 0 ? Math.min.apply(Math, expiries) : undefined;
    };
    OrangeProvider.prototype.isExpired = function (session) {
        return session.expiresAt <= this.clock();
    };
    OrangeProvider.prototype.shouldRefresh = function (session) {
        return session.expiresAt - this.clock() <= this.config.refreshSkewMs;
    };
    OrangeProvider.prototype.isSessionExpiredResponse = function (response) {
        var _a;
        if ([401, 403, 419, 440].includes(response.status)) {
            return true;
        }
        var headers = response.headers;
        var location = (_a = headers["location"]) !== null && _a !== void 0 ? _a : headers["Location"];
        return Boolean(location === null || location === void 0 ? void 0 : location.includes(this.config.loginPath));
    };
    OrangeProvider.prototype.toProviderResult = function (response, reference) {
        var _a;
        var status = (_a = response.status) !== null && _a !== void 0 ? _a : 200;
        if (status >= 200 && status < 300) {
            return { success: true, data: response.data, reference: reference };
        }
        return {
            success: false,
            reference: reference,
            error: {
                status: status,
                data: response.data,
            },
        };
    };
    OrangeProvider.prototype.assertWebConfig = function () {
        if (!this.config.webBaseUrl) {
            throw new Error("ORANGE_WEB_BASE_URL is required for web session mode");
        }
        if (!this.config.username || !this.config.password) {
            throw new Error("ORANGE_USERNAME/ORANGE_PASSWORD or ORANGE_API_KEY/ORANGE_API_SECRET are required");
        }
    };
    OrangeProvider.prototype.assertDirectConfig = function () {
        if (!this.config.apiKey || !this.config.apiSecret) {
            throw new Error("ORANGE_API_KEY and ORANGE_API_SECRET are required");
        }
    };
    OrangeProvider.prototype.createReference = function (operation) {
        return "ORANGE-".concat(operation.toUpperCase(), "-").concat(this.clock());
    };
    OrangeProvider.prototype.getRequestReference = function (request, operation) {
        var _a;
        var data = request.data;
        return (_a = data === null || data === void 0 ? void 0 : data.reference) !== null && _a !== void 0 ? _a : this.createReference(operation);
    };
    OrangeProvider.prototype.formatPath = function (template, reference) {
        return template.includes(":reference")
            ? template.replace(":reference", encodeURIComponent(reference))
            : "".concat(template.replace(/\/$/, ""), "/").concat(encodeURIComponent(reference));
    };
    OrangeProvider.prototype.delay = function (attempt) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, new Promise(function (resolve) {
                            return setTimeout(resolve, Math.min(250 * attempt, 1000));
                        })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    return OrangeProvider;
}());
exports.OrangeProvider = OrangeProvider;
