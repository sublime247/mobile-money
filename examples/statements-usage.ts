/**
 * Monthly Account Statements PDF Generator - Usage Examples
 *
 * This example demonstrates how to use the statements API to generate
 * professional PDF statements for users.
 */

import axios from "axios";
import fs from "fs";

const API_BASE_URL = "http://localhost:3000/api";

// Example: Download monthly statement for a user
async function downloadMonthlyStatement(
  authToken: string,
  year: number,
  month: number,
  outputPath: string,
) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/statements/monthly/${year}/${month}`,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        responseType: "arraybuffer", // Important for binary PDF data
      },
    );

    // Save PDF to file
    fs.writeFileSync(outputPath, response.data);
    console.log(`Statement saved to: ${outputPath}`);

    return {
      success: true,
      filename: outputPath,
      size: response.data.length,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("API Error:", error.response?.status, error.response?.data);
      return {
        success: false,
        error: error.response?.data?.error || "Unknown error",
      };
    }
    throw error;
  }
}

// Example: Stream PDF directly to client (Express.js)
function streamStatementToClient(req: any, res: any) {
  const { year, month } = req.params;
  const authToken = req.headers.authorization;

  axios
    .get(`${API_BASE_URL}/statements/monthly/${year}/${month}`, {
      headers: { Authorization: authToken },
      responseType: "stream",
    })
    .then((response) => {
      // Forward headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        response.headers["content-disposition"],
      );

      // Pipe the PDF stream to client
      response.data.pipe(res);
    })
    .catch((error) => {
      res.status(error.response?.status || 500).json({
        error: error.response?.data?.error || "Failed to generate statement",
      });
    });
}

// Example usage
async function main() {
  const authToken = "your-jwt-token-here";
  const year = 2024;
  const month = 1; // January
  const outputPath = `./statement-${year}-${month.toString().padStart(2, "0")}.pdf`;

  const result = await downloadMonthlyStatement(
    authToken,
    year,
    month,
    outputPath,
  );

  if (result.success) {
    console.log("✅ Statement generated successfully!");
    console.log(`📄 File: ${result.filename}`);
    console.log(`📊 Size: ${(result.size / 1024).toFixed(2)} KB`);
  } else {
    console.error("❌ Failed to generate statement:", result.error);
  }
}

// Uncomment to run the example
// main().catch(console.error);

export { downloadMonthlyStatement, streamStatementToClient };
