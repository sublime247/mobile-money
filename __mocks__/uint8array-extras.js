"use strict";

function isUint8Array(value) {
  return value instanceof Uint8Array;
}

function areUint8ArraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function uint8ArrayToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function hexToUint8Array(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function uint8ArrayToString(bytes) {
  return Buffer.from(bytes).toString("utf8");
}

function stringToUint8Array(str) {
  return new Uint8Array(Buffer.from(str, "utf8"));
}

function concatUint8Arrays(arrays, totalLength) {
  return new Uint8Array(Buffer.concat(arrays.map((a) => Buffer.from(a)), totalLength));
}

function compareUint8Arrays(a, b) {
  return Buffer.from(a).compare(Buffer.from(b));
}

module.exports = {
  isUint8Array,
  areUint8ArraysEqual,
  uint8ArrayToHex,
  hexToUint8Array,
  uint8ArrayToString,
  stringToUint8Array,
  concatUint8Arrays,
  compareUint8Arrays,
};
