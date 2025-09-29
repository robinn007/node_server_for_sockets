const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const bodyParser = require("body-parser"); // Add body-parser for JSON POST requests

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost",
    methods: ["GET", "POST"],
  },
});

// Middleware to parse JSON POST requests
app.use(bodyParser.json());

// MySQL connection pool
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "student_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test MySQL connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log("MySQL Connected successfully");
    connection.release();
  } catch (err) {
    console.error("MySQL Connection failed:", err);
    process.exit(1);
  }
}
testConnection();

// Serve static files from client folder
app.use(express.static("../client"));

// Track connections and last activity
let userConnBucket = {}; // { email: [socketId1, socketId2, ...] }
let connections = {}; // { socketId: email }
let lastActivity = {}; // { email: timestamp }
let groupRooms = {}; // { groupId: [socketId1, socketId2, ...] }
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

// Function to mark user as offline after inactivity
async function markOffline(email) {
  try {
    const [result] = await pool.execute(
      "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
      ["offline", email]
    );
    if (result.affectedRows > 0) {
      console.log(`Marked ${email} as offline due to inactivity`);
      io.emit("status_update", { email, status: "offline" });
    }
  } catch (err) {
    console.error(`Error marking ${email} as offline:`, err);
  }
}

// Function to get group members
async function getGroupMembers(groupId) {
  try {
    const [rows] = await pool.execute(
      "SELECT email FROM group_members WHERE group_id = ? AND is_active = 1", // CHANGED: member_email -> email (also in SELECT)
      [groupId]
    );
    return rows.map((row) => row.email);
  } catch (err) {
    console.error(`Error getting group members for group ${groupId}:`, err);
    return [];
  }
}

// Function to get sender name
async function getSenderName(email) {
  try {
    const [rows] = await pool.execute(
      "SELECT name FROM students WHERE email = ? AND is_deleted = 0",
      [email]
    );
    return rows.length > 0 ? rows[0].name : email;
  } catch (err) {
    console.error(`Error getting sender name for ${email}:`, err);
    return email;
  }
}

// Check for inactive users
setInterval(() => {
  const now = Date.now();
  for (const email in lastActivity) {
    if (now - lastActivity[email] > INACTIVITY_TIMEOUT) {
      if (userConnBucket[email] && userConnBucket[email].length === 0) {
        markOffline(email);
        delete lastActivity[email];
      }
    }
  }
}, 60 * 1000); // Check every minute

// Handle group creation notification from PHP backend
app.post("/emit_group_created", async (req, res) => {
  const { group_id, name, description, created_by, members, member_count } =
    req.body;
  console.log(`Received group creation request for group ${group_id}`);

  try {
    // Emit group_created event to creator and members
    const allMembers = [...members, created_by]; // Include creator
    const roomName = `group_${group_id}`;

    // Join all members to the group room
    for (const email of allMembers) {
      if (userConnBucket[email]) {
        for (const socketId of userConnBucket[email]) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.join(roomName);
            console.log(`${email} joined group room: ${roomName}`);

            // Update groupRooms tracking
            if (!groupRooms[group_id]) {
              groupRooms[group_id] = [];
            }
            if (!groupRooms[group_id].includes(socketId)) {
              groupRooms[group_id].push(socketId);
            }
          }
        }
      }
    }

    // Broadcast group creation to all members
    io.to(roomName).emit("group_created", {
      group_id: parseInt(group_id),
      name,
      description,
      created_by,
      members,
      member_count,
    });

    console.log(`Emitted group_created event to room: ${roomName}`);
    res.json({ success: true, message: "Group creation event emitted" });
  } catch (err) {
    console.error("Error processing group creation:", err);
    res
      .status(500)
      .json({ success: false, message: "Error emitting group creation event" });
  }
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // User login
  socket.on("user_login", async (data) => {
    const { email } = data;
    console.log(`Login event from ${email} on socket ${socket.id}`);

    try {
      const [result] = await pool.execute(
        "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
        ["online", email]
      );

      if (result.affectedRows > 0) {
        console.log(`Updated status to online for ${email}`);
        io.emit("status_update", { email, status: "online" });

        // Track user's socket connection
        if (!userConnBucket[email]) {
          userConnBucket[email] = [];
        }
        if (!userConnBucket[email].includes(socket.id)) {
          userConnBucket[email].push(socket.id);
        }
        connections[socket.id] = email;
        lastActivity[email] = Date.now();

        // Join user to their group rooms
        const [groups] = await pool.execute(
          "SELECT group_id FROM group_members WHERE email = ? AND is_active = 1", // CHANGED: member_email -> email
          [email]
        );

        for (const group of groups) {
          const roomName = `group_${group.group_id}`;
          socket.join(roomName);
          console.log(`${email} joined group room: ${roomName}`);

          // Track group room members
          if (!groupRooms[group.group_id]) {
            groupRooms[group.group_id] = [];
          }
          if (!groupRooms[group.group_id].includes(socket.id)) {
            groupRooms[group.group_id].push(socket.id);
          }
        }
      } else {
        console.log(`No student found for ${email}`);
      }
    } catch (err) {
      console.error("Error updating login status:", err);
    }
  });

  // User heartbeat
  socket.on("user_heartbeat", async (data) => {
    const { email } = data;
    console.log(`Heartbeat from ${email} on socket ${socket.id}`);
    if (userConnBucket[email]) {
      lastActivity[email] = Date.now();
      try {
        const [result] = await pool.execute(
          "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
          ["online", email]
        );
        if (result.affectedRows > 0) {
          console.log(`Confirmed online status for ${email}`);
          io.emit("status_update", { email, status: "online" });
        }
      } catch (err) {
        console.error("Error processing heartbeat:", err);
      }
    }
  });

  // User logout
  socket.on("user_logout", async (data) => {
    const { email } = data;
    console.log(`Logout event from ${email} on socket ${socket.id}`);

    try {
      const [result] = await pool.execute(
        "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
        ["offline", email]
      );

      if (result.affectedRows > 0) {
        console.log(`Updated status to offline for ${email}`);
        io.emit("status_update", { email, status: "offline" });

        // Remove socket from userConnBucket
        if (userConnBucket[email]) {
          userConnBucket[email] = userConnBucket[email].filter(
            (id) => id !== socket.id
          );
          if (userConnBucket[email].length === 0) {
            delete userConnBucket[email];
            delete lastActivity[email];
          }
        }

        // Remove from group rooms
        for (const groupId in groupRooms) {
          groupRooms[groupId] = groupRooms[groupId].filter(
            (id) => id !== socket.id
          );
          if (groupRooms[groupId].length === 0) {
            delete groupRooms[groupId];
          }
        }

        delete connections[socket.id];
      } else {
        console.log(`No student found for ${email}`);
      }
    } catch (err) {
      console.error("Error updating logout status:", err);
    }
  });

  // Direct chat message (existing functionality)
  socket.on("chat_message", async (data) => {
    const { sender_email, receiver_email, message } = data;
    console.log(
      `Chat message from ${sender_email} to ${receiver_email}: ${message}`
    );

    try {
      const [result] = await pool.execute(
        "INSERT INTO messages (sender_email, receiver_email, message, message_type, created_at) VALUES (?, ?, ?, ?, NOW())",
        [sender_email, receiver_email, message, "direct"]
      );

      if (result.affectedRows > 0) {
        console.log(`Stored direct message from ${sender_email}`);
        io.emit("chat_message", {
          sender_email,
          receiver_email,
          message,
          message_type: "direct",
          created_at: new Date(),
        });
      } else {
        console.error(`Failed to store direct message from ${sender_email}`);
      }
    } catch (err) {
      console.error("Error storing direct chat message:", err);
    }
  });

  // Group chat message (new functionality)
  socket.on("group_message", async (data) => {
    const { sender_email, group_id, message } = data;
    console.log(
      `Group message from ${sender_email} to group ${group_id}: ${message}`
    );

    try {
      // Verify user is a member of the group
      const [memberCheck] = await pool.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1", // CHANGED: member_email -> email
        [group_id, sender_email]
      );

      if (memberCheck.length === 0) {
        console.log(
          `User ${sender_email} is not a member of group ${group_id}`
        );
        return;
      }

      // Store the group message
      const [result] = await pool.execute(
        "INSERT INTO messages (sender_email, group_id, message, message_type, created_at) VALUES (?, ?, ?, ?, NOW())",
        [sender_email, group_id, message, "group"]
      );

      if (result.affectedRows > 0) {
        console.log(
          `Stored group message from ${sender_email} to group ${group_id}`
        );

        // Get sender name
        const senderName = await getSenderName(sender_email);

        // Update group's last activity
        await pool.execute(
          "UPDATE groups SET updated_at = NOW() WHERE id = ?",
          [group_id]
        );

        // Emit to all group members
        const roomName = `group_${group_id}`;
        io.to(roomName).emit("group_message", {
          sender_email,
          group_id: parseInt(group_id),
          message,
          message_type: "group",
          sender_name: senderName,
          created_at: new Date(),
        });

        console.log(`Group message broadcasted to room: ${roomName}`);
      } else {
        console.error(`Failed to store group message from ${sender_email}`);
      }
    } catch (err) {
      console.error("Error storing group chat message:", err);
    }
  });

  // Join group room
  socket.on("join_group", async (data) => {
    const { email, group_id } = data;
    console.log(`${email} requesting to join group ${group_id}`);

    try {
      // Verify user is a member of the group
      const [memberCheck] = await pool.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1", // CHANGED: member_email -> email
        [group_id, email]
      );

      if (memberCheck.length > 0) {
        const roomName = `group_${group_id}`;
        socket.join(roomName);
        console.log(`${email} joined group room: ${roomName}`);

        // Track group room members
        if (!groupRooms[group_id]) {
          groupRooms[group_id] = [];
        }
        if (!groupRooms[group_id].includes(socket.id)) {
          groupRooms[group_id].push(socket.id);
        }
      } else {
        console.log(`${email} is not a member of group ${group_id}`);
      }
    } catch (err) {
      console.error("Error joining group:", err);
    }
  });

  // Leave group room
  socket.on("leave_group", (data) => {
    const { group_id } = data;
    const roomName = `group_${group_id}`;
    socket.leave(roomName);
    console.log(`Socket ${socket.id} left group room: ${roomName}`);

    // Remove from group room tracking
    if (groupRooms[group_id]) {
      groupRooms[group_id] = groupRooms[group_id].filter(
        (id) => id !== socket.id
      );
      if (groupRooms[group_id].length === 0) {
        delete groupRooms[group_id];
      }
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const email = connections[socket.id];

    if (email) {
      // Remove socket from bucket
      if (userConnBucket[email]) {
        userConnBucket[email] = userConnBucket[email].filter(
          (id) => id !== socket.id
        );
        if (userConnBucket[email].length === 0) {
          // Delay marking offline to allow for quick reconnects
          setTimeout(() => {
            if (userConnBucket[email]?.length === 0) {
              markOffline(email);
              delete lastActivity[email];
              delete userConnBucket[email];
            }
          }, 10000); // 10-second grace period
        }
      }

      // Remove from group rooms
      for (const groupId in groupRooms) {
        groupRooms[groupId] = groupRooms[groupId].filter(
          (id) => id !== socket.id
        );
        if (groupRooms[groupId].length === 0) {
          delete groupRooms[groupId];
        }
      }

      delete connections[socket.id];
    }
  });
});

// Start server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on http://localhost:${PORT}`);
  console.log("Group chat functionality enabled");
});
