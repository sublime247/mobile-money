// Mock for uint8array-extras to avoid ESM import issues in Jest
module.exports = {
  isUint8Array: require("node:util").types.isUint8Array,
  concatUint8Arrays: (arrays) => {
    const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  },
  areUint8ArraysEqual: (a, b) => {
    if (a.byteLength !== b.byteLength) return false;
    return a.every((val, i) => val === b[i]);
  },
  compareUint8Arrays: (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  },
  uint8ArrayToString: (arr) => Buffer.from(arr).toString("utf-8"),
  stringToUint8Array: (str) => new Uint8Array(Buffer.from(str, "utf-8")),
  uint8ArrayToHex: (arr) => Buffer.from(arr).toString("hex"),
  hexToUint8Array: (hex) => {
    if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(hex)) {
      throw new TypeError("Invalid hex string");
    }
    return new Uint8Array(Buffer.from(hex, "hex"));
  },
  uint8ArrayToBase64: (arr) => Buffer.from(arr).toString("base64"),
  base64ToUint8Array: (b64) => new Uint8Array(Buffer.from(b64, "base64")),
};
