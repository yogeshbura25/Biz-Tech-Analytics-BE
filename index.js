require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

//PostgreSQL connection
const dbConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
    }
    : {
        user: process.env.PGUSER || process.env.PG_USER,
        host: process.env.PGHOST || process.env.PG_HOST,
        database: process.env.PGDATABASE || process.env.PG_DATABASE,
        password: process.env.PGPASSWORD || process.env.PG_PASSWORD,
        port: Number(process.env.PGPORT || process.env.PG_PORT) || 5432,
    };



const pool = new Pool(dbConfig);

//Create Tables
const initDB = async () => {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id VARCHAR PRIMARY KEY,
      name VARCHAR
    );

    CREATE TABLE IF NOT EXISTS workstations (
      station_id VARCHAR PRIMARY KEY,
      name VARCHAR
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP,
      worker_id VARCHAR,
      workstation_id VARCHAR,
      event_type VARCHAR,
      confidence FLOAT,
      count INT DEFAULT 0
    );
  `);
};

//Seed Data (6 workers + 6 stations)
const seedData = async () => {
    await pool.query(`DELETE FROM workers`);
    await pool.query(`DELETE FROM workstations`);
    await pool.query(`DELETE FROM events`);

    // Fixed Workers & Stations
    const workers = [
        { id: "W1", name: "Alice" },
        { id: "W2", name: "Bob" },
        { id: "W3", name: "Charlie" },
        { id: "W4", name: "David" },
        { id: "W5", name: "Eva" },
        { id: "W6", name: "Frank" }
    ];

    const stations = [
        { id: "S1", name: "Cutting" },
        { id: "S2", name: "Assembly" },
        { id: "S3", name: "Packaging" },
        { id: "S4", name: "Inspection" },
        { id: "S5", name: "Labeling" },
        { id: "S6", name: "Dispatch" }
    ];

    for (const w of workers) {
        await pool.query(
            `INSERT INTO workers (worker_id, name) VALUES ($1, $2)`,
            [w.id, w.name]
        );
    }

    for (const s of stations) {
        await pool.query(
            `INSERT INTO workstations (station_id, name) VALUES ($1, $2)`,
            [s.id, s.name]
        );
    }

    //Hardcoded Events (NO randomness)
    const events = [
        // Worker 4
        ["2025-01-01 09:00:00", "W4", "S4", "working", 0.92, 0],
        ["2025-01-01 09:08:00", "W4", "S4", "product_count", 0.88, 25],
        ["2025-01-01 09:18:00", "W4", "S4", "product_count", 0.91, 30],
        ["2025-01-01 09:28:00", "W4", "S4", "idle", 0.85, 0],
        ["2025-01-01 09:40:00", "W4", "S4", "working", 0.93, 0],
        ["2025-01-01 10:00:00", "W4", "S4", "product_count", 0.90, 45],

        // Worker 5
        ["2025-01-01 09:00:00", "W5", "S5", "working", 0.94, 0],
        ["2025-01-01 09:10:00", "W5", "S5", "product_count", 0.89, 20],
        ["2025-01-01 09:20:00", "W5", "S5", "product_count", 0.87, 35],
        ["2025-01-01 09:30:00", "W5", "S5", "idle", 0.82, 0],
        ["2025-01-01 09:45:00", "W5", "S5", "working", 0.91, 0],
        ["2025-01-01 10:05:00", "W5", "S5", "product_count", 0.93, 50],

        // Worker 6
        ["2025-01-01 09:00:00", "W6", "S6", "working", 0.96, 0],
        ["2025-01-01 09:15:00", "W6", "S6", "product_count", 0.90, 40],
        ["2025-01-01 09:30:00", "W6", "S6", "product_count", 0.88, 60],
        ["2025-01-01 09:45:00", "W6", "S6", "idle", 0.80, 0],
        ["2025-01-01 10:00:00", "W6", "S6", "working", 0.92, 0],
        ["2025-01-01 10:20:00", "W6", "S6", "product_count", 0.95, 80],
    ];

    for (const e of events) {
        await pool.query(
            `INSERT INTO events (timestamp, worker_id, workstation_id, event_type, confidence, count)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            e
        );
    }
};

//API: Ingest Event
app.post("/events", async (req, res) => {
    try {
        console.log("BODY:", req.body);

        const {
            timestamp,
            worker_id,
            workstation_id,
            event_type,
            confidence,
            count
        } = req.body;
        console.log("timestamp", timestamp);

        await pool.query(
            `INSERT INTO events (timestamp, worker_id, workstation_id, event_type, confidence, count)
       VALUES (COALESCE($1::TIMESTAMP, NOW()), $2, $3, $4, $5, $6)`,
            [
                timestamp || null,
                worker_id || null,
                workstation_id || null,
                event_type || null,
                confidence ?? 0,
                count ?? 0
            ]
        );

        res.json({ message: "Event stored" });
    } catch (err) {
        console.error("Insert error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

//Helper: Calculate Metrics
const calculateMetrics = (events) => {
    let totalActive = 0;
    let totalIdle = 0;
    let totalProduction = 0;

    for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];

        const diff = (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000; // seconds

        if (prev.event_type === "working") totalActive += diff;
        if (prev.event_type === "idle") totalIdle += diff;
    }

    events.forEach((e) => {
        if (e.event_type === "product_count") {
            totalProduction += e.count || 0;
        }
    });

    const totalTime = totalActive + totalIdle;

    return {
        active_time: totalActive,
        idle_time: totalIdle,
        utilization: totalTime ? (totalActive / totalTime) * 100 : 0,
        total_units: totalProduction,
        units_per_hour: totalTime
            ? totalProduction / (totalTime / 3600)
            : 0,
    };
};

//API: Get Metrics
app.get("/metrics", async (req, res) => {
    try {
        const { worker_id, station_id } = req.query;

        let query = `SELECT * FROM events`;
        let values = [];

        if (worker_id) {
            query += ` WHERE worker_id = $1 ORDER BY timestamp ASC`;
            values = [worker_id];
        } else if (station_id) {
            query += ` WHERE workstation_id = $1 ORDER BY timestamp ASC`;
            values = [station_id];
        } else {
            query += ` ORDER BY timestamp ASC`;
        }

        const result = await pool.query(query, values);
        const events = result.rows;

        const metrics = calculateMetrics(events);

        res.json({
            metrics,
            total_events: events.length,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error calculating metrics" });
    }
});

//Factory-level metrics
app.get("/metrics/factory", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM events ORDER BY timestamp ASC`
        );

        const metrics = calculateMetrics(result.rows);

        res.json(metrics);
    } catch (err) {
        res.status(500).json({ error: "Error" });
    }
});

//Reset & Seed API
app.post("/seed", async (req, res) => {
    try {
        await seedData();
        res.json({ message: "Seeded successfully" });
    } catch (err) {
        res.status(500).json({ error: "Seeding failed" });
    }
});

app.get("/", (req, res) => {
    res.json({ message: "OK" });
});


//Start Server
const start = async () => {
    await initDB();
    await seedData();

    const PORT = Number(process.env.PORT) || 8080;
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
};

start();