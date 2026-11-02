import "dotenv/config";
import pool from "./db.js";

try {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      current_schema() AS schema_name,
      current_setting('search_path') AS search_path,
      to_regclass('public.users') AS users_table
  `);

  console.log("Database connection details:");
  console.log(result.rows[0]);

  await pool.end();
} catch (error) {
  console.error("Database test failed:", error.message);
  await pool.end();
  process.exitCode = 1;
}
