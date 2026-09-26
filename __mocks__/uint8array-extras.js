// Mock for uint8array-extras to avoid ESM import issues in Jest
module.exports = {
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
  uint8ArrayToBase64: (arr) => Buffer.from(arr).toString("base64"),
  base64ToUint8Array: (b64) => new Uint8Array(Buffer.from(b64, "base64")),
};
