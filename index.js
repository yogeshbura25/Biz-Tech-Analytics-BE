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

// Enable SSL for Neon DB (or require ssl if URL indicates it)
if (dbConfig.connectionString && dbConfig.connectionString.includes('neon.tech') && !dbConfig.ssl) {
    dbConfig.ssl = { rejectUnauthorized: false };
} else if (dbConfig.host && dbConfig.host.includes('neon.tech')) {
    dbConfig.ssl = { rejectUnauthorized: false };
}

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

    for (let i = 1; i <= 6; i++) {
        await pool.query(
            `INSERT INTO workers (worker_id, name) VALUES ($1, $2)`,
            [`W${i}`, `Worker ${i}`]
        );

        await pool.query(
            `INSERT INTO workstations (station_id, name) VALUES ($1, $2)`,
            [`S${i}`, `Station ${i}`]
        );
    }

    // Insert Dummy Events for API tests
    const now = new Date();
    const eventQueries = [];

    // Generate events for workers 1 to 6
    for (let i = 1; i <= 6; i++) {
        const worker = `W${i}`;
        const station = `S${i}`;
        
        // Randomize some start time up to 1 hour ago
        let timeOffset = -3600 - Math.floor(Math.random() * 1800); 
        
        // Event type 1: working
        eventQueries.push({ worker, station, type: 'working', count: 0, timeOffset });
        
        // Event type 2: product_count
        timeOffset += 300 + Math.floor(Math.random() * 300); // 5-10 minutes later
        eventQueries.push({ worker, station, type: 'product_count', count: Math.floor(Math.random() * 5) + 5, timeOffset });
        
        // Event type 3: idle
        timeOffset += 300 + Math.floor(Math.random() * 300); // 5-10 minutes later
        eventQueries.push({ worker, station, type: 'idle', count: 0, timeOffset });
        
        // Back to working
        timeOffset += 120 + Math.floor(Math.random() * 180); // 2-5 mins later
        eventQueries.push({ worker, station, type: 'working', count: 0, timeOffset });
        
        // Another product count
        timeOffset += 600 + Math.floor(Math.random() * 600); // 10-20 mins later
        eventQueries.push({ worker, station, type: 'product_count', count: Math.floor(Math.random() * 15) + 10, timeOffset });
    }

    for (const ev of eventQueries) {
        const evTime = new Date(now.getTime() + ev.timeOffset * 1000);
        await pool.query(
            `INSERT INTO events (timestamp, worker_id, workstation_id, event_type, confidence, count)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [evTime, ev.worker, ev.station, ev.type, 0.95, ev.count]
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