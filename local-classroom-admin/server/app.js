const path = require("path");
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const { port } = require("./config");
const apiRouter = require("./routes/api");
require("./db");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server running." });
});

app.use("/api", apiRouter);
app.use("/", express.static(path.resolve(process.cwd(), "client")));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, message: "API endpoint not found." });
  }
  return res.sendFile(path.resolve(process.cwd(), "client", "index.html"));
});

app.listen(port, () => {
  console.log(`Local Classroom Admin running on http://localhost:${port}`);
});
