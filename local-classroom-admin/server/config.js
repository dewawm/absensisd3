const path = require("path");
require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  lateCutoff: process.env.LATE_CUTOFF || "07:30",
  waApiUrl: process.env.WA_API_URL || "",
  waApiToken: process.env.WA_API_TOKEN || "",
  waSender: process.env.WA_SENDER || "",
  dbPath: path.resolve(process.cwd(), "data", "classroom.db")
};
