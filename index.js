import express from "express";
import pool from "./db.js";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import "dotenv/config";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";

const app = express();
const port = process.env.PORT || 3000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // Allo 5 login attemps
  message: "Too many login attemps. Please try again in 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Body-parser middleware
app.use(express.urlencoded({ extended: true }));

// Configure EJS
app.set("view engine", "ejs");

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use(express.static("public"));

// Configure PostgreSQL session storage
const PgSession = connectPgSimple(session);

const sessionStore = new PgSession({
  pool: pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
});

// Configure Express Sessions
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from the environment variable.");
}

app.use(
  session({
    name: "maintainxpro.sid",
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

// Protect routes that require login
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }

    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).render("403", {
        message:
          "Access denied. You do not have permission to perform this action.",
      });
    }

    next();
  };
}

async function authorizedWorkOrderEdit(req, res, next) {
  // Admin and Maintenance Managers can edit any work order.
  if (
    req.session.user.role === "Admin" ||
    req.session.user.role === "Maintenance Manager"
  ) {
    return next();
  }

  // Only Technician can proceed to the assignment check.
  if (req.session.user.role !== "Technician") {
    return res.status(403).render("403", {
      message: "Access denied.",
    });
  }

  try {
    const workOrderId = Number(req.params.id);

    if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
      return res.status(404).render("404");
    }

    const result = await pool.query(
      "SELECT assigned_to FROM work_orders WHERE id = $1",
      [workOrderId],
    );

    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    const assignedTo = result.rows[0].assigned_to;
    const currentUserId = req.session.user.id;

    if (Number(assignedTo) !== Number(currentUserId)) {
      return res.status(403).render("403", {
        message:
          "Access denied. You can only edit work orders assigned to you.",
      });
    }

    next();
  } catch (error) {
    console.error("Error checking work order premission:", error);
    next(error);
  }
}

// Home Rooute
app.get("/", (req, res) => {
  res.render("home");
});

// Dashboard Route
app.get("/dashboard", requireAuth, async (req, res, next) => {
  try {
    const equipmentResult = await pool.query("SELECT COUNT(*) FROM equipment");

    const openWorkOrdersResult = await pool.query(
      "SELECT COUNT(*) FROM work_orders WHERE status = $1",
      ["Open"],
    );

    const completedWorkOrdersResult = await pool.query(
      "SELECT COUNT(*) FROM work_orders WHERE status = $1",
      ["Completed"],
    );

    const maintenanceSchedulesResult = await pool.query(
      "SELECT COUNT(*) FROM maintenance_schedules",
    );

    // Get the 5 most recent work orders
    const recentWorkOrdersResult = await pool.query(
      "SELECT * FROM work_orders ORDER BY id DESC LIMIT 5",
    );

    const maintenanceOverviewResult = await pool.query(`
        SELECT 
          ms.id, 
          ms.title, 
          TO_CHAR(ms.next_maintenance_date, 'YYYY-MM-DD') AS next_maintenance_date,
          e.equipment_code, 
          e.name AS equipment_name 
        FROM maintenance_schedules AS ms 
        INNER JOIN equipment AS e 
          ON ms.equipment_id = e.id 
        ORDER BY ms.next_maintenance_date ASC 
        LIMIT 3
      `);

    res.render("dashboard", {
      totalEquipment: Number(equipmentResult.rows[0].count),
      openWorkOrders: Number(openWorkOrdersResult.rows[0].count),
      completedWorkOrders: Number(completedWorkOrdersResult.rows[0].count),
      totalMaintenanceSchedules: Number(
        maintenanceSchedulesResult.rows[0].count,
      ),
      recentWorkOrders: recentWorkOrdersResult.rows,
      maintenanceOverview: maintenanceOverviewResult.rows,
    });
  } catch (error) {
    console.error("Dashboard error:", error.message);
    next(error);
  }
});

// Equipment Mangement Page
app.get("/equipment", requireAuth, async (req, res, next) => {
  const search = req.query.search?.trim() || "";
  const category = req.query.category?.trim() || "";
  const status = req.query.status?.trim() || "";

  try {
    const result = await pool.query(
      `SELECT * FROM equipment WHERE (equipment_code ILIKE $1 OR name ILIKE $1) AND ($2 = '' OR 
      category = $2) AND ($3 = '' OR status = $3) ORDER BY id ASC`,
      [`%${search}%`, category, status],
    );

    // Calcualte statics for all equipment records

    const statisticsResult = await pool.query(
      `SELECT COUNT(*) AS total, 
      COUNT(*) FILTER (WHERE status = 'Operational') AS operational, 
      COUNT(*) FILTER (WHERE status = 'Under Maintenance') AS under_maintenance, 
      COUNT(*) FILTER (WHERE status = 'Out of Service') AS out_of_service FROM equipment`,
    );

    res.render("equipment", {
      equipment: result.rows,
      statistics: statisticsResult.rows[0],
      success: req.query.success,
      search,
      category,
      status,
    });
  } catch (error) {
    console.error("Error fetching equipment:", error.message);
    next(error);
  }
});

// Display the edit equipment
app.get("/equipment/:id/edit", requireAuth, async (req, res, next) => {
  try {
    const equipmentId = Number(req.params.id);

    // Retrieve the selected equipment record
    const result = await pool.query("SELECT * FROM equipment WHERE id = $1", [
      equipmentId,
    ]);

    // Check whether the equipment exist
    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    // Display the edit form with the existing equipment data
    res.render("edit-equipment", {
      equipment: result.rows[0],
    });
  } catch (error) {
    console.error("Error fetching equipment for editting:", error.message);
    next(error);
  }
});

// Update an existing equipment record
app.post(
  "/equipment/:id/edit",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    try {
      const equipmentId = Number(req.params.id);

      const { equipment_code, name, category, location, status } = req.body;

      // Validate required fields
      if (
        !Number.isInteger(equipmentId) ||
        equipmentId <= 0 ||
        !equipment_code?.trim() ||
        !name?.trim() ||
        !status?.trim()
      ) {
        return res.status(400).send("Invalid equipment information.");
      }

      // Update the equipment record in the PostgreSQL
      const result = await pool.query(
        `UPDATE equipment
       SET equipment_code = $1,
           name = $2,
           category = $3,
           location = $4,
           status = $5
       WHERE id = $6
       RETURNING id`,
        [
          equipment_code?.trim(),
          name.trim(),
          category?.trim() || null,
          location?.trim() || null,
          status.trim(),
          equipmentId,
        ],
      );

      // Check whether the equipment exist
      if (result.rows.length === 0) {
        return res.status(404).render("404");
      }

      // Return to the inventory after a successful update
      res.redirect("/equipment?success=updated");
    } catch (error) {
      console.error("Error updating equipment:", error.message);

      // Handle duplicate equipment code
      if (
        error.code === "23505" &&
        error.constraint === "equipment_equipment_code_key"
      ) {
        return res
          .status(409)
          .send(
            "This equipment code already exist, Please use different code.",
          );
      }

      next(error);
    }
  },
);

// Add equipment route
app.get(
  "/equipment/new",
  requireRole("Admin", "Maintenance Manager"),
  (req, res) => {
    res.render("add-equipment", {
      error: null,
    });
  },
);

// Save new equipment to database
app.post(
  "/equipment/new",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    try {
      const { equipment_code, name, category, location, status } = req.body;

      // Validate required fields
      if (!equipment_code?.trim() || !name?.trim() || !status?.trim()) {
        return res.status(400).render("add-equipment", {
          error: "Equipment code, name, and status are required.",
          formData: req.body,
        });
      }

      // Insert the new equipment in PostgreSQL
      await pool.query(
        `INSERT INTO equipment (equipment_code, name, category, location, status) 
      VALUES ($1, $2, $3, $4, $5)`,
        [
          equipment_code.trim(),
          name.trim(),
          category?.trim() || null,
          location?.trim() || null,
          status.trim(),
        ],
      );

      // Return to the equiment inventory
      res.redirect("/equipment?success=created");
    } catch (error) {
      console.error("Error saving erquipment:", error.message);

      // Handle duplicate equipment codes.
      if (
        error.code === "23505" &&
        error.constraint === "equipment_equipment_code_key"
      ) {
        return res.status(409).render("add-equipment", {
          error:
            "This equipment code already exists. Please use a different code.",
          formData: req.body,
        });
      }

      //  Handle other database errors
      next(error);
    }
  },
);

// Delete equipment
app.post(
  "/equipment/:id/delete",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const equipmentId = Number(req.params.id);

    // Validate the equipment ID
    if (!Number.isInteger(equipmentId) || equipmentId <= 0) {
      return res.status(400).send("Invalid equipment ID");
    }

    try {
      // Check whether the equipment exists
      const equipmentResult = await pool.query(
        "SELECT id FROM equipment WHERE id = $1",
        [equipmentId],
      );

      if (equipmentResult.rows.length === 0) {
        return res.status(404).render("404");
      }

      // Check for associated maintenance schedules
      const scheduleResult = await pool.query(
        `SELECT COUNT(*)::int AS count
       FROM maintenance_schedules
       WHERE equipment_id = $1`,
        [equipmentId],
      );

      // Check for associated work orders
      const workOrdersResult = await pool.query(
        `SELECT COUNT(*)::int AS count
       FROM work_orders
       WHERE equipment_id = $1`,
        [equipmentId],
      );

      const scheduleCount = scheduleResult.rows[0].count;
      const workOrderCount = workOrdersResult.rows[0].count;

      // Prevent deletion if related records exist
      if (scheduleCount > 0 || workOrderCount > 0) {
        return res
          .status(409)
          .send(
            "This equipment cannot be deleted because it has associated maintenance schedules or work orders.",
          );
      }

      // Delete the equipment
      await pool.query("DELETE FROM equipment WHERE id = $1", [equipmentId]);

      // Return to equipment page
      res.redirect("/equipment?success=deleted");
    } catch (error) {
      console.error("Error deleting equipment", error.message);

      // Handle cases where related records prevent deletion
      if (error.code === "23503") {
        return res
          .status(409)
          .send("Equipment cannot be deleted because related records exist.");
      }

      next(error);
    }
  },
);

// Equipment Details Page
app.get("/equipment/:id", requireAuth, async (req, res, next) => {
  const equipmentId = Number(req.params.id);

  if (!Number.isInteger(equipmentId) || equipmentId <= 0) {
    return res.status(400).send("Invalid euipment ID.");
  }

  try {
    const result = await pool.query(
      `SELECT *
       FROM equipment
       WHERE id = $1`,
      [equipmentId],
    );

    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    res.render("equipment-details", {
      equipment: result.rows[0],
    });
  } catch (error) {
    console.error("Error fetching equipment details:", error.message);
    next(error);
  }
});

// Maintenance Schedule Route
app.get("/maintenance-schedules", requireAuth, async (req, res, next) => {
  const search = req.query.search?.trim() || "";

  const allowedFrequencies = [
    "Daily",
    "Weekly",
    "Monthly",
    "Quarterly",
    "Semi-annually",
    "Annually",
  ];

  const frequencyInput = req.query.frequency?.trim() || "";

  const frequency = allowedFrequencies.includes(frequencyInput)
    ? frequencyInput
    : "";

  const allowedStatuses = ["Overdue", "Due Soon", "Upcoming"];

  const statusInput = req.query.status?.trim() || "";

  const status = allowedStatuses.includes(statusInput) ? statusInput : "";

  try {
    const result = await pool.query(
      `SELECT
        ms.id,
        ms.equipment_id,
        ms.title,
        ms.frequency,
        TO_CHAR(ms.next_maintenance_date, 'YYYY-MM-DD') AS next_maintenance_date,
        ms.created_at,
        e.equipment_code,
        e.name AS equipment_name
      FROM maintenance_schedules AS ms
      INNER JOIN equipment AS e
        ON ms.equipment_id = e.id
      WHERE (
        ms.title ILIKE $1
        OR e.equipment_code ILIKE $1
        OR e.name ILIKE $1
      )
      AND ($2 = '' OR ms.frequency = $2)
      AND (
        $3 = ''
        OR (
          $3 = 'Overdue'
          AND ms.next_maintenance_date < CURRENT_DATE
        )
        OR (
          $3 = 'Due Soon'
          AND ms.next_maintenance_date >= CURRENT_DATE
          AND ms.next_maintenance_date <= CURRENT_DATE + 8
        )
        OR (
          $3 = 'Upcoming'
          AND ms.next_maintenance_date > CURRENT_DATE + 8
        )
      )
      ORDER BY ms.next_maintenance_date ASC`,
      [`%${search}%`, frequency, status],
    );

    res.render("maintenance-schedules", {
      schedules: result.rows,
      success: req.query.success,
      currentUser: req.session.user,
      search,
      frequency,
      status,
    });
  } catch (error) {
    console.error("Error fetching maintenance schedules:", error.message);

    next(error);
  }
});

// Add maintenance schedule route
app.get(
  "/maintenance-schedules/new",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, equipment_code, name
       FROM equipment
       ORDER BY equipment_code ASC`,
      );

      res.render("add-maintenance-schedule", {
        equipment: result.rows,
      });
    } catch (error) {
      console.error("Error loading equipment:", error.message);
      next(error);
    }
  },
);

// add maintenance schedule route
app.post(
  "/maintenance-schedules/new",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const { equipment_id, title, frequency, next_maintenance_date } = req.body;

    const equipmentId = Number(equipment_id);
    const allowFrequencies = [
      "Daily",
      "Weekly",
      "Monthly",
      "Quarterly",
      "Semi-annually",
      "Annually",
    ];

    if (
      !Number.isInteger(equipmentId) ||
      equipmentId <= 0 ||
      !title?.trim() ||
      title.trim().length > 255 ||
      !allowFrequencies.includes(frequency) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(next_maintenance_date || "")
    ) {
      return res.status(400).send("Invalid maintenance schedule information.");
    }

    // Check wheter the data is a real calendar date.
    const parsedDate = new Date(`${next_maintenance_date}T00:00:00Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== next_maintenance_date
    ) {
      return res.status(400).send("Invalid maintenance date.");
    }

    try {
      const equipmentResult = await pool.query(
        "SELECT id FROM equipment WHERE id = $1",
        [equipmentId],
      );

      if (equipmentResult.rows.length === 0) {
        return res.status(400).send("The selected equipment does not exist.");
      }

      await pool.query(
        `INSERT INTO maintenance_schedules
      (equipment_id, title, frequency, next_maintenance_date)
      VALUES ($1, $2, $3, $4)`,
        [equipmentId, title.trim(), frequency, next_maintenance_date],
      );

      res.redirect("/maintenance-schedules?success=created");
    } catch (error) {
      console.error("Error creating maintenance schedules:", error.message);
      next(error);
    }
  },
);

// Edit maintenance schedule route
app.get(
  "/maintenance-schedules/:id/edit",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const scheduleId = Number(req.params.id);

    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
      return res.status(400).send("Invalid maintenance schedule ID.");
    }

    try {
      const scheduleResult = await pool.query(
        `SELECT *
      FROM maintenance_schedules
      WHERE id = $1`,
        [scheduleId],
      );

      if (scheduleResult.rows.length === 0) {
        return res.status(404).render("404");
      }

      const equipmentResult = await pool.query(
        `SELECT id, equipment_code, name
       FROM equipment
       ORDER BY equipment_code ASC`,
      );

      res.render("edit-maintenance-schedule", {
        schedule: scheduleResult.rows[0],
        equipment: equipmentResult.rows,
      });
    } catch (error) {
      console.error("Error loading maintenance result:", error.message);
      next(error);
    }
  },
);

// Maintenance schedule edit post route
app.post(
  "/maintenance-schedules/:id/edit",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const scheduleId = Number(req.params.id);

    const { equipment_id, title, frequency, next_maintenance_date } = req.body;

    const equipmentId = Number(equipment_id);

    const allowFrequencies = [
      "Daily",
      "Weekly",
      "Monthly",
      "Quarterly",
      "Semi-annually",
      "Annually",
    ];

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const dateParts = (next_maintenance_date || "").split("-").map(Number);
    const parsedDate = new Date(
      Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]),
    );

    const validDate =
      datePattern.test(next_maintenance_date || "") &&
      parsedDate.getUTCFullYear() === dateParts[0] &&
      parsedDate.getUTCMonth() === dateParts[1] - 1 &&
      parsedDate.getUTCDate() === dateParts[2];

    if (
      !Number.isInteger(scheduleId) ||
      scheduleId <= 0 ||
      !Number.isInteger(equipmentId) ||
      equipmentId <= 0 ||
      !title?.trim() ||
      title.trim().length > 255 ||
      !allowFrequencies.includes(frequency) ||
      !validDate
    ) {
      return res.status(400).send("Invalid maintenance schedule information.");
    }

    try {
      const equipmentResult = await pool.query(
        "SELECT id FROM equipment WHERE id = $1",
        [equipmentId],
      );

      if (equipmentResult.rows.length === 0) {
        return res.status(400).send("The selected equipment does not exist.");
      }

      const result = await pool.query(
        `UPDATE maintenance_schedules
       SET equipment_id = $1,
           title = $2,
           frequency = $3,
           next_maintenance_date = $4
       WHERE id = $5
       RETURNING id`,
        [
          equipmentId,
          title.trim(),
          frequency,
          next_maintenance_date,
          scheduleId,
        ],
      );

      if (result.rows.length === 0) {
        return res.status(400).send("Maintenance schedule not found.");
      }

      res.redirect("/maintenance-schedules");
    } catch (error) {
      console.error("Error updating maintenance schedule:", error.message);
      next(error);
    }
  },
);

// Maintenance Schedule Delete Route
app.post(
  "/maintenance-schedules/:id/delete",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const scheduleId = Number(req.params.id);

    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
      return res.status(400).send("Invalid maintenance schedule ID.");
    }

    try {
      const result = await pool.query(
        `DELETE FROM maintenance_schedules
       WHERE id = $1
       RETURNING id`,
        [scheduleId],
      );

      if (result.rows.length === 0) {
        return res.status(404).render("404");
      }

      res.redirect("/maintenance-schedules?success=deleted");
    } catch (error) {
      console.error("Error deleting maintenance schedule:", error.message);
      next(error);
    }
  },
);

// Work orders route
app.get("/work-orders", requireAuth, async (req, res, next) => {
  const search = req.query.search?.trim() || "";

  const allowedPriorities = ["Low", "Medium", "High"];
  const allowedStatuses = ["Open", "In Progress", "Completed"];

  const priorityInput = req.query.priority?.trim() || "";
  const statusInput = req.query.status?.trim() || "";

  const priority = allowedPriorities.includes(priorityInput)
    ? priorityInput
    : "";

  const status = allowedStatuses.includes(statusInput) ? statusInput : "";

  try {
    const result = await pool.query(
      `SELECT
        wo.id,
        wo.title,
        wo.description,
        wo.assigned_to,
        wo.priority,
        wo.status,
        wo.due_date,
        wo.created_at,
        e.equipment_code,
        e.name AS equipment_name,
        u.full_name AS assigned_technician
      FROM work_orders AS wo
      LEFT JOIN equipment AS e
        ON wo.equipment_id = e.id
      LEFT JOIN users AS u
        ON wo.assigned_to = u.id
      WHERE wo.title ILIKE $1
        AND ($2 = '' OR wo.priority = $2)
        AND ($3 = '' OR wo.status = $3)
      ORDER BY wo.id DESC`,
      [`%${search}%`, priority, status],
    );

    res.render("work-orders", {
      workOrders: result.rows,
      currentUser: req.session.user,
      success: req.query.success,
      search,
      priority,
      status,
    });
  } catch (error) {
    console.error("Error fetching work orders:", error.message);
    next(error);
  }
});

// Display the Add Work Order form Route
app.get(
  "/work-orders/new",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    try {
      const result = await pool.query(`
      SELECT id, equipment_code, name
      FROM equipment
      ORDER BY equipment_code ASC
    `);

      res.render("add-work-order", {
        equipment: result.rows,
      });
    } catch (error) {
      console.error("Error loading work order form:", error.message);
      next(error);
    }
  },
);

// Create a new work order
app.post(
  "/work-orders/new",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const { title, description, equipment_id, priority, status, due_date } =
      req.body;

    // Validate required fields
    if (
      !title?.trim() ||
      title.trim().length > 200 ||
      !["Low", "Medium", "High"].includes(priority) ||
      !["Open", "In Progress", "Completed"].includes(status)
    ) {
      return res.status(400).send("Invalid work order information.");
    }

    // Validate equipment ID when provided
    let equipmentId = null;

    if (equipment_id) {
      const parsedEquipmentId = Number(equipment_id);

      if (!Number.isInteger(parsedEquipmentId) || parsedEquipmentId <= 0) {
        return res.status(400).send("Invalid equipment selection");
      }

      equipmentId = parsedEquipmentId;
    }

    // Validate due date when provided
    let dueDate = null;

    if (due_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
        return res.status(400).send("Invalid due date.");
      }

      const parsedDate = new Date(`${due_date}T00:00:00Z`);

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== due_date
      ) {
        return res.status(400).send("Invalid due date.");
      }

      dueDate = due_date;
    }

    try {
      // Confirm that the selected equipment exists
      if (equipmentId !== null) {
        const equipmentResult = await pool.query(
          "SELECT id FROM equipment WHERE id = $1",
          [equipmentId],
        );

        if (equipmentResult.rows.length === 0) {
          return res.status(400).send("Selected equipment does not exist.");
        }
      }

      // Save the work order
      await pool.query(
        `INSERT INTO work_orders
        (title, description, equipment_id, priority, status, due_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          title.trim(),
          description?.trim() || null,
          equipmentId,
          priority,
          status,
          dueDate,
        ],
      );

      res.redirect("/work-orders?success=created");
    } catch (error) {
      console.error("Error creating work order:", error.message);
      next(error);
    }
  },
);

// Display the Edit Work Order Form
app.get(
  "/work-orders/:id/edit",
  requireAuth,
  authorizedWorkOrderEdit,
  async (req, res, next) => {
    const workOrderId = Number(req.params.id);

    if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
      return res.status(400).send("Invalid work order ID.");
    }

    try {
      // Retrieve the selected work order
      const workOrderResult = await pool.query(
        "SELECT * FROM work_orders WHERE id = $1",
        [workOrderId],
      );

      if (workOrderResult.rows.length === 0) {
        return res.status(404).render("404");
      }

      // Retrieve available equipment
      const equipmentResult = await pool.query(
        `SELECT id, equipment_code, name
         FROM equipment
         ORDER BY equipment_code ASC`,
      );

      // Retrieve registered technicians
      const techniciansResult = await pool.query(
        `SELECT id, full_name
         FROM users
         WHERE role = $1
         ORDER BY full_name ASC`,
        ["Technician"],
      );

      // Display the edit form
      res.render("edit-work-order", {
        workOrder: workOrderResult.rows[0],
        equipment: equipmentResult.rows,
        technicians: techniciansResult.rows,
        user: req.session.user,
      });
    } catch (error) {
      console.error("Error loading work order:", error.message);
      next(error);
    }
  },
);

// Update an Existing Work Order

app.post(
  "/work-orders/:id/edit",
  requireAuth,
  authorizedWorkOrderEdit,
  async (req, res, next) => {
    const userRole = req.session.user.role;
    const workOrderId = Number(req.params.id);

    const isManager =
      userRole === "Admin" || userRole === "Maintenance Manager";

    try {
      const {
        title,
        description,
        equipment_id,
        assigned_to,
        priority,
        status,
        due_date,
      } = req.body;

      const allowedStatuses = ["Open", "In Progress", "Completed"];
      const allowedPriorities = ["Low", "Medium", "High"];

      // Validate the requested status.
      if (!allowedStatuses.includes(status)) {
        return res.status(400).send("Invalid work order status.");
      }

      // Only Admin and Maintenance Manager can mark work orders Completed.
      if (!isManager && status === "Completed") {
        return res.status(403).render("403", {
          message:
            "Only Admin or Maintenance Manager can complete work orders.",
        });
      }

      // Technicians can update only the status of their assigned work orders.
      if (!isManager) {
        const result = await pool.query(
          `UPDATE work_orders
          SET status = $1
          WHERE id = $2
          AND assigned_to = $3
          RETURNING id`,
          [status, workOrderId, Number(req.session.user.id)],
        );

        if (result.rows.length === 0) {
          return res.status(404).render("404");
        }

        return res.redirect("/work-orders?success=updated");
      }

      // Validate all fields for Admin and Maintenance Manager.
      if (
        !title?.trim() ||
        title.trim().length > 200 ||
        !description?.trim() ||
        !Number.isInteger(Number(equipment_id)) ||
        Number(equipment_id) <= 0 ||
        !Number.isInteger(Number(assigned_to)) ||
        Number(assigned_to) <= 0 ||
        !allowedPriorities.includes(priority)
      ) {
        return res.status(400).send("Invalid work order information.");
      }

      // Validate the due date when provided.
      let dueDate = null;

      if (due_date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
          return res.status(400).send("Invalid due date");
        }

        const parsedDate = new Date(`${due_date}T00:00:00Z`);

        if (
          Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== due_date
        ) {
          return res.status(400).send("Invalid due date.");
        }

        dueDate = due_date;
      }

      // Confirm the selected equipment exists.
      const equipmentResult = await pool.query(
        "SELECT id FROM equipment WHERE id = $1",
        [Number(equipment_id)],
      );

      if (equipmentResult.rows.length === 0) {
        return res.status(400).send("Selected equipment does not exist.");
      }

      // Confirm the assigned user exists and is a Technician.
      const technicianResult = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND role = $2",
        [Number(assigned_to), "Technician"],
      );

      if (technicianResult.rows.length === 0) {
        return res.status(400).send("Selected technician does not exist.");
      }

      const updateResult = await pool.query(
        `UPDATE work_orders
         SET title = $1,
             description = $2,
             equipment_id = $3,
             assigned_to = $4,
             priority = $5,
             status = $6,
             due_date = $7
         WHERE id = $8
         RETURNING id`,
        [
          title.trim(),
          description.trim(),
          Number(equipment_id),
          Number(assigned_to),
          priority,
          status,
          dueDate,
          workOrderId,
        ],
      );

      if (updateResult.rows.length === 0) {
        return res.status(404).render("404");
      }

      res.redirect("/work-orders?success=updated");
    } catch (error) {
      console.error("Error updating work order:", error);
      next(error);
    }
  },
);

// Delete a Work Order
app.post(
  "/work-orders/:id/delete",
  requireRole("Admin", "Maintenance Manager"),
  async (req, res, next) => {
    const workOrderId = Number(req.params.id);

    if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
      return res.status(400).send("Invalid work order ID.");
    }

    try {
      const result = await pool.query(
        "DELETE FROM work_orders WHERE id = $1 RETURNING id",
        [workOrderId],
      );

      if (result.rows.length === 0) {
        return res.status(404).render("404");
      }

      res.redirect("/work-orders?success=deleted");
    } catch (error) {
      console.error("Error deleting work order:", error.message);
      next(error);
    }
  },
);

// Users Page Route
app.get("/users", requireRole("Admin"), async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        full_name,
        email,
        role,
        created_at
      FROM users
      ORDER BY id DESC
    `);

    res.render("users", {
      users: result.rows,
      success: req.query.success,
    });
  } catch (error) {
    console.error("Error fetching users:", error.message);
    next(error);
  }
});

// Display Add User Page Route
app.get("/users/new", requireRole("Admin"), (req, res) => {
  res.render("add-user", {
    error: null,
    formData: {
      full_name: "",
      email: "",
      role: "Technician",
    },
  });
});

// Show the edit user page route
app.get("/users/:id/edit", requireRole("Admin"), async (req, res, next) => {
  const userId = Number(req.params.id);

  // Validate the id user
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("invalid user ID.");
  }

  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role
      FROM users
      WHERE id = $1`,
      [userId],
    );

    // Check if the user exists
    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    res.render("edit-user", {
      user: result.rows[0],
      error: null,
    });
  } catch (error) {
    console.error("Error fetching user.", error);
    next(error);
  }
});

// Update an existing user
app.post("/users/:id/edit", requireRole("Admin"), async (req, res, next) => {
  const userId = Number(req.params.id);
  const { full_name, email, role, password } = req.body;

  // Prevent an Admin from changing their own role
  if (
    userId === Number(req.session.user.id) &&
    role !== req.session.user.role
  ) {
    return res.status(403).render("403", {
      message: "You cannot change your own account role.",
    });
  }

  const formData = {
    full_name: full_name?.trim() || "",
    email: email?.trim() || "",
    role: role || "",
  };

  const allowedRoles = ["Admin", "Maintenance Manager", "Technician"];

  // Validate the user ID
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("Invalid user ID");
  }

  //  Validate submitted information
  if (
    !formData.full_name ||
    formData.full_name.length > 150 ||
    !formData.email ||
    formData.email.length > 255 ||
    !allowedRoles.includes(formData.role) ||
    (password && password.length < 8)
  ) {
    return res.status(400).render("edit-user", {
      user: { id: userId, ...formData },
      error:
        "Please provide valid information. New password must contain at least 8 characters.",
    });
  }

  try {
    // Check wheter another user already uses this email
    const existingUser = await pool.query(
      `SELECT id 
      FROM users
      WHERE LOWER(email) = LOWER($1)
        AND id <> $2`,
      [formData.email, userId],
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).render("edit-user", {
        user: { id: userId, ...formData },
        error: "This email address is already registered.",
      });
    }

    let result;

    if (password) {
      // Hash the new password
      const passwordHash = await bcrypt.hash(password, 12);

      // Update user details and password
      result = await pool.query(
        `UPDATE users
        SET full_name = $1,
            email = $2,
            role = $3,
            password_hash = $4
        WHERE id = $5
        RETURNING id`,
        [
          formData.full_name,
          formData.email,
          formData.role,
          passwordHash,
          userId,
        ],
      );
    } else {
      // Update details without changing the password
      result = await pool.query(
        `UPDATE users
        SET full_name = $1,
            email = $2,
            role = $3
        WHERE id = $4
        RETURNING id`,
        [formData.full_name, formData.email, formData.role, userId],
      );
    }

    // Check whether the user exists
    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    res.redirect("/users?success=updated");
  } catch (error) {
    console.error("Error updating user:", error);
    next(error);
  }
});

// Delete an existing user
app.post("/users/:id/delete", requireRole("Admin"), async (req, res, next) => {
  const userId = Number(req.params.id);

  // Validate the user ID.
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("Invalid User ID.");
  }

  try {
    // Check whether the target user is an Administrator.
    const targetUser = await pool.query(
      "SELECT id, role FROM users WHERE id = $1",
      [userId],
    );

    if (targetUser.rows.length === 0) {
      return res.status(400).send("User not found.");
    }

    // if the target is an Administrator, count all Administrator.
    if (targetUser.rows[0].role === "Admin") {
      const adminCount = await pool.query(
        "SELECT COUNT(*) AS total FROM users WHERE role = $1",
        ["Admin"],
      );

      // Prevent deletion of the last Administrator.
      if (Number(adminCount.rows[0].total) <= 1) {
        return res.status(403).render("403", {
          message: "You cannot delete the last Administrator.",
        });
      }
    }

    // Delete the user after the checks pass.
    const result = await pool.query(
      `DELETE FROM users
      WHERE id = $1
      RETURNING id`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).render("404");
    }

    res.redirect("/users?success=deleted");
  } catch (error) {
    console.error("Error deleting user:", error);
    next(error);
  }
});

// Create a New user
app.post("/users/new", requireRole("Admin"), async (req, res, next) => {
  const { full_name, email, password, role } = req.body;

  const formData = {
    full_name: full_name?.trim() || "",
    email: email?.trim() || "",
    role: role || "Technician",
  };

  const allowedRoles = ["Admin", "Maintenance Manager", "Technician"];

  // Validate the submitted information
  if (
    !formData.full_name ||
    formData.full_name.length > 150 ||
    !formData.email ||
    formData.email.length > 255 ||
    !password ||
    password.length < 8 ||
    !allowedRoles.includes(formData.role)
  ) {
    return res.status(400).render("add-user", {
      error:
        "Please provide valid information. Password must contain at least 8 charactes.",
      formData,
    });
  }

  try {
    // Check whether the email already exists
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [formData.email],
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).render("add-user", {
        error: "This email address is already registered.",
        formData,
      });
    }

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 12);

    // Save the new user
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
        VALUES ($1, $2, $3, $4)`,
      [formData.full_name, formData.email, passwordHash, formData.role],
    );

    // Redirect after successful creation
    res.redirect("/users?success=created");
  } catch (error) {
    console.error("Error creating user:", error);
    next(error);
  }
});

// Display the login page
app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  res.render("login", {
    error: null,
  });
});

// Process login credentials
app.post("/login", loginLimiter, async (req, res, next) => {
  const email = req.body.email?.trim() || "";
  const password = req.body.password || "";

  // Basic input validation
  if (!email || !password) {
    return res.status(400).render("login", {
      error: "Please enter your email and password.",
    });
  }

  try {
    // Find the user by email
    const result = await pool.query(
      `SELECT id, full_name, email, password_hash, role
      FROM users
      WHERE LOWER(email) = LOWER($1)`,
      [email],
    );

    const user = result.rows[0];

    // Rejects unknown emails
    if (!user) {
      return res.status(401).render("login", {
        error: "Invalid email or password.",
      });
    }

    // Verify the password against its bcrypt hash
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).render("login", {
        error: "Invalid email or password.",
      });
    }

    // Credentials are valid: create a new session
    req.session.regenerate((error) => {
      if (error) {
        console.error("Error creating login session:", error);
        return next(error);
      }

      // Store only the information needed for the logged-in user
      req.session.user = {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      };

      // Save the session before redirecting
      req.session.save((error) => {
        if (error) {
          console.error("Error saving login session:", error);
          return next(error);
        }

        return res.redirect("/dashboard");
      });
    });
  } catch (error) {
    console.error("Error verfying login:", error);
    next(error);
  }
});

// Logout Route
app.post("/logout", requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Error logging out:", error);
      return next(error);
    }

    res.clearCookie("maintainxpro.sid");
    res.redirect("/login");
  });
});

// Handle pages that do not exist
app.use((req, res) => {
  res.status(404).render("404");
});

// Handle unexpected server errors
app.use((error, req, res, next) => {
  console.error("Server Error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).render("500", {
    message: "An expected error occured. Please try again later.",
  });
});

// Start the Server
app.listen(port, () => {
  console.log(`MaintainXPro server is running on http://localhost: ${port}`);
});
