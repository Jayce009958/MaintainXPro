import pool from "./db.js";

async function inspectSchema() {
  try {
    console.log("\n=== DATABASE INFORMATION ===");

    const databaseResult = await pool.query(
      "SELECT current_database() AS database_name",
    );

    console.log("Database", databaseResult.rows[0].database_name);

    console.log("\n=== TABLE COLUMN ===");

    const columnsResult = await pool.query(`
            SELECT
        table_name,
        ordinal_position,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'equipment',
          'maintenance_schedules',
          'users',
          'work_orders'
        )
      ORDER BY table_name, ordinal_position;`);

    console.table(columnsResult.rows);

    console.log("\n=== PRIMARY KEYS AND FOREIGN KEY ===");

    const constrainResult = await pool.query(`
        SELECT
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column
      FROM information_schema.table_constraints AS tc
      LEFT JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.table_name = kcu.table_name
      LEFT JOIN information_schema.constraint_column_usage AS ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name IN (
          'equipment',
          'maintenance_schedules',
          'users',
          'work_orders'
        )
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
      ORDER BY tc.table_name, tc.constraint_type;`);

    console.table(constrainResult.rows);
  } catch (error) {
    console.error("Schema inspection failed:", error.message);
  } finally {
    await pool.end();
  }
}

inspectSchema();
