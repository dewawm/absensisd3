const jwt = require("jsonwebtoken");
const db = require("../db");
const { jwtSecret } = require("../config");

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, message: "Unauthorized." });

  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = db
      .prepare("SELECT id, username, full_name, email, role, is_active FROM users WHERE id = ?")
      .get(payload.userId);
    if (!user || !user.is_active) {
      return res.status(401).json({ ok: false, message: "Session invalid." });
    }
    req.user = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      role: user.role
    };
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: "Token invalid." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, message: "Forbidden." });
    }
    return next();
  };
}

module.exports = { authRequired, requireRole };
