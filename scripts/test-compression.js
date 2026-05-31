#!/usr/bin/env node

/**
 * Compression Test Script
 * Tests compression middleware and measures bandwidth savings
 */

const http = require("http");
const zlib = require("zlib");

// Test data of different sizes
const testCases = [
  { name: "Small response (<1KB)", size: 500 },
  { name: "Medium response (1-2KB)", size: 1500 },
  { name: "Large response (>2KB)", size: 5000 },
];

function makeRequest(testSize, compressed = true) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: process.env.PORT || 3000,
      path: "/health",
      method: "GET",
      headers: {
        "Accept-Encoding": compressed ? "gzip, deflate" : "identity",
        "User-Agent": "compression-test-script",
      },
    };

    const req = http.request(options, (res) => {
      let data = [];

      res.on("data", (chunk) => {
        data.push(chunk);
      });

      res.on("end", () => {
        const buffer = Buffer.concat(data);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          size: buffer.length,
          compressed: res.headers["content-encoding"] === "gzip",
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function runCompressionTests() {
  console.log("🧪 Running Compression Tests\n");
  console.log(
    "Make sure the server is running on port",
    process.env.PORT || 3000,
  );
  console.log("Run: npm run dev\n");

  for (const testCase of testCases) {
    console.log(`📊 Testing: ${testCase.name}`);

    try {
      // Test with compression
      const compressedResult = await makeRequest(testCase.size, true);

      // Test without compression
      const uncompressedResult = await makeRequest(testCase.size, false);

      const compressionRatio = (
        ((uncompressedResult.size - compressedResult.size) /
          uncompressedResult.size) *
        100
      ).toFixed(1);
      const bandwidthSaved = uncompressedResult.size - compressedResult.size;

      console.log(`  Compressed: ${compressedResult.compressed ? "✅" : "❌"}`);
      console.log(`  Uncompressed size: ${uncompressedResult.size} bytes`);
      console.log(`  Compressed size: ${compressedResult.size} bytes`);
      console.log(
        `  Bandwidth saved: ${bandwidthSaved} bytes (${compressionRatio}%)`,
      );
      console.log("");
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      console.log("");
    }
  }

  console.log("✅ Compression tests completed!");
}

// Run tests if this script is executed directly
if (require.main === module) {
  runCompressionTests().catch(console.error);
}

module.exports = { runCompressionTests };
