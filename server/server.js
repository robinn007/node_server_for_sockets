const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(bodyParser.json());

// MySQL pool
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "student_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection
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

// Serve static files
app.use(express.static("../client"));

// Connection tracking
let userConnBucket = {}; // { email: [socketId1, socketId2] }
let connections = {}; // { socketId: email }
let lastActivity = {}; // { email: timestamp }
let groupRooms = {}; // { groupId: [socketId1, socketId2] }
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 min

// Mark user offline
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

// Get sender name
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

// Inactivity checker
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
}, 60 * 1000);

// === API ENDPOINTS ===

// Group creation (from PHP backend)
app.post("/emit_group_created", async (req, res) => {
  const { group_id, name, description, created_by, members, member_count } =
    req.body;
  console.log(`Received group creation request for group ${group_id}`);

  try {
    const allMembers = [...members, created_by];
    const roomName = `group_${group_id}`;

    for (const email of allMembers) {
      if (userConnBucket[email]) {
        for (const socketId of userConnBucket[email]) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.join(roomName);
            console.log(`${email} joined group room: ${roomName}`);

            if (!groupRooms[group_id]) groupRooms[group_id] = [];
            if (!groupRooms[group_id].includes(socketId)) {
              groupRooms[group_id].push(socketId);
            }
          }
        }
      }
    }

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

// File message (from PHP backend)
app.post("/emit_file_message", async (req, res) => {
  const {
    id,
    original_filename,
    file_size,
    file_type,
    sender_email,
    sender_name,
    receiver_email,
    group_id,
    message,
    message_type,
    created_at,
  } = req.body;

  console.log(
    `Received file message from ${sender_email} - File: ${original_filename}`
  );

  try {
    if (message_type === "group" && group_id) {
      const roomName = `group_${group_id}`;
      io.to(roomName).emit("group_message", {
        sender_email,
        sender_name,
        group_id: parseInt(group_id),
        message,
        message_type: "group",
        has_attachment: 1,
        file_attachment_id: id,
        file_data: {
          id,
          original_filename,
          file_size,
          file_type,
        },
        created_at: created_at || new Date(),
      });

      console.log(`File message broadcasted to group room: ${roomName}`);
    } else if (message_type === "direct" && receiver_email) {
      io.emit("chat_message", {
        sender_email,
        receiver_email,
        message,
        message_type: "direct",
        has_attachment: 1,
        file_attachment_id: id,
        file_data: {
          id,
          original_filename,
          file_size,
          file_type,
        },
        created_at: created_at || new Date(),
      });

      console.log(`File message sent from ${sender_email} to ${receiver_email}`);
    }

    res.json({ success: true, message: "File message emitted" });
  } catch (err) {
    console.error("Error processing file message:", err);
    res
      .status(500)
      .json({ success: false, message: "Error emitting file message" });
  }
});

// === SOCKET.IO HANDLERS ===
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // User login
  socket.on("user_login", async ({ email }) => {
    console.log(`Login event from ${email} on socket ${socket.id}`);

    try {
      const [result] = await pool.execute(
        "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
        ["online", email]
      );

      if (result.affectedRows > 0) {
        io.emit("status_update", { email, status: "online" });

        if (!userConnBucket[email]) userConnBucket[email] = [];
        if (!userConnBucket[email].includes(socket.id)) {
          userConnBucket[email].push(socket.id);
        }
        connections[socket.id] = email;
        lastActivity[email] = Date.now();

        const [groups] = await pool.execute(
          "SELECT group_id FROM group_members WHERE email = ? AND is_active = 1",
          [email]
        );

        for (const group of groups) {
          const roomName = `group_${group.group_id}`;
          socket.join(roomName);
          console.log(`${email} joined group room: ${roomName}`);

          if (!groupRooms[group.group_id]) groupRooms[group.group_id] = [];
          if (!groupRooms[group.group_id].includes(socket.id)) {
            groupRooms[group.group_id].push(socket.id);
          }
        }
      }
    } catch (err) {
      console.error("Error updating login status:", err);
    }
  });

  // Heartbeat
  socket.on("user_heartbeat", async ({ email }) => {
    if (userConnBucket[email]) {
      lastActivity[email] = Date.now();
      try {
        const [result] = await pool.execute(
          "UPDATE students SET status = ? WHERE email = ? AND is_deleted = 0",
          ["online", email]
        );
        if (result.affectedRows > 0) {
          io.emit("status_update", { email, status: "online" });
        }
      } catch (err) {
        console.error("Error processing heartbeat:", err);
      }
    }
  });

  // Direct chat
  socket.on("chat_message", async ({ sender_email, receiver_email, message }) => {
    try {
      const [result] = await pool.execute(
        "INSERT INTO messages (sender_email, receiver_email, message, message_type, created_at) VALUES (?, ?, ?, ?, NOW())",
        [sender_email, receiver_email, message, "direct"]
      );

      if (result.affectedRows > 0) {
        io.emit("chat_message", {
          sender_email,
          receiver_email,
          message,
          message_type: "direct",
          created_at: new Date(),
        });
      }
    } catch (err) {
      console.error("Error storing direct chat message:", err);
    }
  });

  // Group chat
  socket.on("group_message", async ({ sender_email, group_id, message }) => {
    try {
      const [memberCheck] = await pool.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1",
        [group_id, sender_email]
      );

      if (memberCheck.length === 0) return;

      const [result] = await pool.execute(
        "INSERT INTO messages (sender_email, group_id, message, message_type, created_at) VALUES (?, ?, ?, ?, NOW())",
        [sender_email, group_id, message, "group"]
      );

      if (result.affectedRows > 0) {
        const senderName = await getSenderName(sender_email);
        await pool.execute("UPDATE groups SET updated_at = NOW() WHERE id = ?", [
          group_id,
        ]);

        const roomName = `group_${group_id}`;
        io.to(roomName).emit("group_message", {
          sender_email,
          group_id: parseInt(group_id),
          message,
          message_type: "group",
          sender_name: senderName,
          created_at: new Date(),
        });
      }
    } catch (err) {
      console.error("Error storing group chat message:", err);
    }
  });

  // Typing start
  socket.on("typing_start", async (data) => {
    const { sender_email, receiver_email, group_id, type } = data;

    if (type === "group" && group_id) {
      const [memberCheck] = await pool.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1",
        [group_id, sender_email]
      );
      if (memberCheck.length > 0) {
        const senderName = await getSenderName(sender_email);
        const roomName = `group_${group_id}`;
        socket.to(roomName).emit("typing_start", {
          sender_email,
          sender_name: senderName,
          group_id: parseInt(group_id),
          type: "group",
        });
      }
    } else if (type === "direct" && receiver_email) {
      if (userConnBucket[receiver_email]) {
        const senderName = await getSenderName(sender_email);
        for (const socketId of userConnBucket[receiver_email]) {
          io.to(socketId).emit("typing_start", {
            sender_email,
            sender_name: senderName,
            receiver_email,
            type: "direct",
          });
        }
      }
    }
  });

  // Typing stop
  socket.on("typing_stop", async (data) => {
    const { sender_email, receiver_email, group_id, type } = data;

    if (type === "group" && group_id) {
      const [memberCheck] = await pool.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1",
        [group_id, sender_email]
      );
      if (memberCheck.length > 0) {
        const roomName = `group_${group_id}`;
        socket.to(roomName).emit("typing_stop", {
          sender_email,
          group_id: parseInt(group_id),
          type: "group",
        });
      }
    } else if (type === "direct" && receiver_email) {
      if (userConnBucket[receiver_email]) {
        for (const socketId of userConnBucket[receiver_email]) {
          io.to(socketId).emit("typing_stop", {
            sender_email,
            receiver_email,
            type: "direct",
          });
        }
      }
    }
  });

  // Join group
  socket.on("join_group", async ({ email, group_id }) => {
    const [memberCheck] = await pool.execute(
      "SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND is_active = 1",
      [group_id, email]
    );
    if (memberCheck.length > 0) {
      const roomName = `group_${group_id}`;
      socket.join(roomName);
      if (!groupRooms[group_id]) groupRooms[group_id] = [];
      if (!groupRooms[group_id].includes(socket.id)) {
        groupRooms[group_id].push(socket.id);
      }
    }
  });

  // Leave group
  socket.on("leave_group", ({ group_id }) => {
    const roomName = `group_${group_id}`;
    socket.leave(roomName);
    if (groupRooms[group_id]) {
      groupRooms[group_id] = groupRooms[group_id].filter(
        (id) => id !== socket.id
      );
      if (groupRooms[group_id].length === 0) delete groupRooms[group_id];
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    const email = connections[socket.id];
    if (email) {
      if (userConnBucket[email]) {
        userConnBucket[email] = userConnBucket[email].filter(
          (id) => id !== socket.id
        );
        if (userConnBucket[email].length === 0) {
          setTimeout(() => {
            if (userConnBucket[email]?.length === 0) {
              markOffline(email);
              delete lastActivity[email];
              delete userConnBucket[email];
            }
          }, 10000);
        }
      }
      for (const groupId in groupRooms) {
        groupRooms[groupId] = groupRooms[groupId].filter(
          (id) => id !== socket.id
        );
        if (groupRooms[groupId].length === 0) delete groupRooms[groupId];
      }
      delete connections[socket.id];
    }
  });
});

// Start server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on http://localhost:${PORT}`);
  console.log("Group chat, typing indicators, and file messages enabled");
});
