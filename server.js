import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync("parking.db");
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS spots (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, type TEXT NOT NULL CHECK(type IN ('compact','standard','ev')), level INTEGER NOT NULL DEFAULT 1, occupied INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS stays (id INTEGER PRIMARY KEY, plate TEXT NOT NULL, driver_name TEXT NOT NULL, vehicle_type TEXT NOT NULL CHECK(vehicle_type IN ('compact','standard','ev')), spot_id INTEGER NOT NULL REFERENCES spots(id), check_in TEXT NOT NULL, check_out TEXT, fee INTEGER, created_by INTEGER REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS rates (vehicle_type TEXT PRIMARY KEY CHECK(vehicle_type IN ('compact','standard','ev')), first_hour INTEGER NOT NULL, additional_hour INTEGER NOT NULL, daily_cap INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS stays_plate ON stays(plate);
  CREATE INDEX IF NOT EXISTS stays_open ON stays(check_out);
`);
const spotColumns = db.prepare("PRAGMA table_info(spots)").all();
if (!spotColumns.some((column) => column.name === "level")) {
  db.exec("ALTER TABLE spots ADD COLUMN level INTEGER NOT NULL DEFAULT 1");
  db.exec(
    "UPDATE spots SET level=CASE WHEN code LIKE 'EV-%' THEN 3 WHEN code LIKE 'S-%' THEN 2 ELSE 1 END",
  );
}
const seed = db.prepare("SELECT COUNT(*) AS n FROM spots").get();
if (!seed.n) {
  const insert = db.prepare("INSERT INTO spots (code,type,level) VALUES (?,?,?)");
  [
    ["C-01", "compact", 1],
    ["C-02", "compact", 1],
    ["S-01", "standard", 2],
    ["S-02", "standard", 2],
    ["S-03", "standard", 2],
    ["EV-01", "ev", 3],
    ["EV-02", "ev", 3],
  ].forEach((s) => insert.run(...s));
}
const rateCount = db.prepare("SELECT COUNT(*) AS n FROM rates").get();
if (!rateCount.n) {
  const insertRate = db.prepare(
    "INSERT INTO rates(vehicle_type,first_hour,additional_hour,daily_cap) VALUES(?,?,?,?)",
  );
  [
    ["compact", 200, 120, 2400],
    ["standard", 200, 120, 2400],
    ["ev", 200, 120, 2400],
  ].forEach((rate) => insertRate.run(...rate));
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const body = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        const error = new Error("Invalid JSON");
        error.status = 400;
        reject(error);
      }
    });
  });
const feeFor = (checkIn, vehicleType, checkOut = new Date()) => {
  const rate = db
    .prepare("SELECT first_hour, additional_hour, daily_cap FROM rates WHERE vehicle_type=?")
    .get(vehicleType);
  if (!rate) throw new Error("No rate configured for this vehicle type");
  const hours = Math.max(
    1,
    Math.ceil((new Date(checkOut) - new Date(checkIn)) / 3600000),
  );
  return Math.min(
    rate.daily_cap,
    rate.first_hour + Math.max(0, hours - 1) * rate.additional_hour,
  );
};
const rateType = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (["compact", "small", "mini"].includes(normalized)) return "compact";
  if (["standard", "regular", "normal"].includes(normalized)) return "standard";
  if (["ev", "electric", "electricvehicle", "charging"].includes(normalized))
    return "ev";
  return null;
};
const rateNumber = (value) => {
  const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};
const cleanRateCard = (text) => {
  const source = String(text || "").trim();
  if (!source) return { rates: [], rejected: ["No rate-card data provided"] };
  let rows;
  try {
    const parsed = JSON.parse(source);
    rows = Array.isArray(parsed) ? parsed : parsed.rates;
  } catch {
    rows = source
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => line.split(/[,;|\t]/).map((value) => value.trim()));
  }
  if (!Array.isArray(rows)) return { rates: [], rejected: ["Rate card must be rows or a JSON array"] };
  const first = rows[0];
  const hasHeader = Array.isArray(first)
    ? first.some((value) => /type|vehicle|first|additional|extra|cap/i.test(value))
    : first && typeof first === "object";
  const headers = hasHeader && Array.isArray(first)
    ? first.map((value) => String(value).toLowerCase().replace(/[^a-z]/g, ""))
    : ["vehicletype", "firsthour", "additionalhour", "dailycap"];
  const dataRows = hasHeader && Array.isArray(first) ? rows.slice(1) : rows;
  const rates = [], rejected = [], seen = new Set();
  for (const row of dataRows) {
    const rawValues = Array.isArray(row)
      ? Object.fromEntries(headers.map((header, index) => [header, row[index]]))
      : row || {};
    const values = Object.fromEntries(
      Object.entries(rawValues).map(([key, value]) => [
        key.toLowerCase().replace(/[^a-z]/g, ""),
        value,
      ]),
    );
    const vehicleType = rateType(values.vehicletype || values.type || values.vehicle);
    const firstHour = rateNumber(values.firsthour || values.startingrate || values.base);
    const additionalHour = rateNumber(values.additionalhour || values.extrahour || values.hourlyrate || values.additional);
    const dailyCap = rateNumber(values.dailycap || values.maxdaily || values.cap);
    if (!vehicleType || firstHour === null || additionalHour === null || dailyCap === null || dailyCap < firstHour) {
      rejected.push(Array.isArray(row) ? row.join(" | ") : "Invalid rate row");
      continue;
    }
    if (seen.has(vehicleType)) {
      rejected.push(`${vehicleType}: duplicate row`);
      continue;
    }
    seen.add(vehicleType);
    rates.push({ vehicle_type: vehicleType, first_hour: firstHour, additional_hour: additionalHour, daily_cap: dailyCap });
  }
  return { rates, rejected };
};
const activeSql = `SELECT stays.*, spots.code spot_code, spots.type spot_type, spots.level spot_level FROM stays JOIN spots ON spots.id=stays.spot_id WHERE check_out IS NULL`;

async function api(req, res, url) {
  const p = url.pathname,
    method = req.method;
  if (method === "POST" && p === "/clock") {
    const b = await body(req);
    const requestedNow = new Date(b.now);
    if (!b.now || Number.isNaN(requestedNow.getTime()))
      return json(res, 400, { error: "A valid now timestamp is required" });
    const now = requestedNow.toISOString();
    const cutoffMs = 24 * 60 * 60 * 1000;
    db.exec("BEGIN IMMEDIATE");
    try {
      const openStays = db.prepare(activeSql).all();
      const overdue = openStays.filter(
        (stay) => requestedNow - new Date(stay.check_in) > cutoffMs,
      );
      const closed = [];
      for (const stay of overdue) {
        const fee = feeFor(stay.check_in, stay.vehicle_type, now);
        db.prepare(
          "UPDATE stays SET check_out=?,fee=? WHERE id=? AND check_out IS NULL",
        ).run(now, fee, stay.id);
        db.prepare("UPDATE spots SET occupied=0 WHERE id=?").run(stay.spot_id);
        closed.push({
          ...stay,
          check_out: now,
          fee,
          hours: Math.max(
            1,
            Math.ceil((requestedNow - new Date(stay.check_in)) / 3600000),
          ),
        });
      }
      db.exec("COMMIT");
      return json(res, 200, { now, closed, closed_count: closed.length });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (method === "POST" && p === "/api/auth/register") {
    const b = await body(req);
    if (!b.name || !b.email || !b.password)
      return json(res, 400, { error: "Name, email and password are required" });
    try {
      const r = db
        .prepare("INSERT INTO users(name,email,password) VALUES(?,?,?)")
        .run(b.name, b.email.toLowerCase(), b.password);
      return json(res, 201, {
        id: Number(r.lastInsertRowid),
        name: b.name,
        email: b.email,
      });
    } catch {
      return json(res, 409, {
        error: "An account with this email already exists",
      });
    }
  }
  if (method === "POST" && p === "/api/auth/login") {
    const b = await body(req);
    const u = db
      .prepare("SELECT id,name,email FROM users WHERE email=? AND password=?")
      .get((b.email || "").toLowerCase(), b.password);
    return u
      ? json(res, 200, { user: u })
      : json(res, 401, { error: "Incorrect email or password" });
  }
  if (method === "GET" && p === "/api/rates") {
    return json(res, 200, db.prepare("SELECT vehicle_type,first_hour,additional_hour,daily_cap,updated_at FROM rates ORDER BY vehicle_type").all());
  }
  if (method === "POST" && p === "/api/rates/import") {
    const b = await body(req);
    const cleaned = cleanRateCard(b.text || b.data || "");
    if (!cleaned.rates.length)
      return json(res, 400, {
        error: "No valid rate rows found",
        rejected: cleaned.rejected,
      });
    db.exec("BEGIN IMMEDIATE");
    try {
      const saveRate = db.prepare(
        "INSERT INTO rates(vehicle_type,first_hour,additional_hour,daily_cap,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(vehicle_type) DO UPDATE SET first_hour=excluded.first_hour, additional_hour=excluded.additional_hour, daily_cap=excluded.daily_cap, updated_at=CURRENT_TIMESTAMP",
      );
      cleaned.rates.forEach((rate) =>
        saveRate.run(
          rate.vehicle_type,
          rate.first_hour,
          rate.additional_hour,
          rate.daily_cap,
        ),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return json(res, 200, {
      imported: cleaned.rates,
      rejected: cleaned.rejected,
      rates: db.prepare("SELECT vehicle_type,first_hour,additional_hour,daily_cap,updated_at FROM rates ORDER BY vehicle_type").all(),
    });
  }
  if (method === "GET" && p === "/api/spots") {
    const type = url.searchParams.get("type");
    const rows = type
      ? db.prepare("SELECT * FROM spots WHERE type=? ORDER BY code").all(type)
      : db.prepare("SELECT * FROM spots ORDER BY code").all();
    return json(res, 200, rows);
  }
  if (method === "GET" && p === "/api/spots/availability") {
    const rows = db
      .prepare(
        "SELECT type, COUNT(*) total, SUM(CASE WHEN occupied=0 THEN 1 ELSE 0 END) available FROM spots GROUP BY type",
      )
      .all();
    return json(res, 200, rows);
  }
  if (method === "GET" && p === "/api/stays") {
    const q = (url.searchParams.get("q") || "").toUpperCase();
    const status = url.searchParams.get("status") || "all",
      sort = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1),
      limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 10),
      );
    let where = [],
      params = [];
    if (q) {
      where.push("UPPER(stays.plate) LIKE ?");
      params.push("%" + q + "%");
    }
    if (status === "active") where.push("check_out IS NULL");
    if (status === "closed") where.push("check_out IS NOT NULL");
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";
    const count = db
      .prepare(`SELECT COUNT(*) total FROM stays ${clause}`)
      .get(...params).total;
    const rows = db
      .prepare(
        `SELECT stays.*,spots.code spot_code,spots.type spot_type,spots.level spot_level FROM stays JOIN spots ON spots.id=stays.spot_id ${clause} ORDER BY check_in ${sort} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, (page - 1) * limit);
    return json(res, 200, {
      data: rows,
      page,
      limit,
      total: Number(count),
      pages: Math.ceil(count / limit),
    });
  }
  if (method === "POST" && p === "/api/stays/check-in") {
    const b = await body(req);
    const plate = (b.plate || "").trim().toUpperCase();
    if (
      !plate ||
      !b.driver_name ||
      !["compact", "standard", "ev"].includes(b.vehicle_type)
    )
      return json(res, 400, {
        error: "Plate, driver name and valid vehicle type are required",
      });
    db.exec("BEGIN IMMEDIATE");
    try {
      const spot = db.prepare("SELECT * FROM spots WHERE id=?").get(b.spot_id);
      if (!spot) {
        db.exec("ROLLBACK");
        return json(res, 404, { error: "Parking spot not found" });
      }
      if (spot.occupied) {
        db.exec("ROLLBACK");
        return json(res, 409, {
          error: "That spot was just taken. Choose another.",
        });
      }
      if (b.vehicle_type === "ev" && spot.type !== "ev") {
        db.exec("ROLLBACK");
        return json(res, 400, {
          error: "EVs must be assigned an EV charging spot",
        });
      }
      const duplicate = db
        .prepare("SELECT id FROM stays WHERE plate=? AND check_out IS NULL")
        .get(plate);
      if (duplicate) {
        db.exec("ROLLBACK");
        return json(res, 409, { error: "This vehicle is already checked in" });
      }
      const r = db
        .prepare(
          "INSERT INTO stays(plate,driver_name,vehicle_type,spot_id,check_in,created_by) VALUES(?,?,?,?,?,?)",
        )
        .run(
          plate,
          b.driver_name,
          b.vehicle_type,
          b.spot_id,
          new Date().toISOString(),
          b.user_id || null,
        );
      db.prepare("UPDATE spots SET occupied=1 WHERE id=?").run(b.spot_id);
      db.exec("COMMIT");
      return json(
        res,
        201,
        db.prepare(activeSql + " AND stays.id=?").get(r.lastInsertRowid),
      );
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const transferMatch = p.match(/^\/api\/stays\/(\d+)\/transfer$/);
  if (method === "POST" && transferMatch) {
    const b = await body(req);
    const plate = (b.plate || "").trim().toUpperCase();
    if (!plate) return json(res, 400, { error: "A new plate is required" });
    db.exec("BEGIN IMMEDIATE");
    try {
      const stayId = Number(transferMatch[1]);
      const stay = db.prepare(activeSql + " AND stays.id=?").get(stayId);
      if (!stay) {
        db.exec("ROLLBACK");
        return json(res, 404, { error: "Active stay not found" });
      }
      const duplicate = db
        .prepare("SELECT id FROM stays WHERE plate=? AND check_out IS NULL AND id<>?")
        .get(plate, stayId);
      if (duplicate) {
        db.exec("ROLLBACK");
        return json(res, 409, {
          error: "The new plate already has an open stay",
        });
      }
      db.prepare("UPDATE stays SET plate=? WHERE id=? AND check_out IS NULL").run(
        plate,
        stayId,
      );
      db.exec("COMMIT");
      return json(res, 200, db.prepare(activeSql + " AND stays.id=?").get(stayId));
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const match = p.match(/^\/api\/stays\/(\d+)\/check-out$/);
  if (method === "POST" && match) {
    const stay = db
      .prepare(activeSql + " AND stays.id=?")
      .get(Number(match[1]));
    if (!stay) return json(res, 404, { error: "Active stay not found" });
    const now = new Date().toISOString(),
      fee = feeFor(stay.check_in, stay.vehicle_type, now);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE stays SET check_out=?,fee=? WHERE id=?").run(
        now,
        fee,
        stay.id,
      );
      db.prepare("UPDATE spots SET occupied=0 WHERE id=?").run(stay.spot_id);
      db.exec("COMMIT");
      return json(res, 200, {
        ...stay,
        check_out: now,
        fee,
        hours: Math.max(
          1,
          Math.ceil((new Date(now) - new Date(stay.check_in)) / 3600000),
        ),
      });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return json(res, 404, { error: "API endpoint not found" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/") || url.pathname === "/clock")
      return await api(req, res, url);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = join(process.cwd(), "public", file);
    if (!path.startsWith(join(process.cwd(), "public")))
      return json(res, 403, { error: "Forbidden" });
    await stat(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch (e) {
    if (e.code === "ENOENT") return json(res, 404, { error: "Not found" });
    if (!e.status || e.status >= 500) console.error(e);
    json(res, e.status || 500, { error: e.message || "Server error" });
  }
});
server.listen(PORT, () =>
  console.log(`ParkWise is running at http://localhost:${PORT}`),
);
