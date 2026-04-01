const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// In-memory room storage
// key -> { host: WebSocket, joins: WebSocket[] }
const rooms = new Map();

// ------------------------------------------------------
// USER PROFILE ENDPOINTS (REQUIRED BY POLYTRACK)
// ------------------------------------------------------

// Accepts: /user, /user?version=..., /user?userToken=...
app.get("/user", (req, res) => {
  res.json({
    nickname: "Guest",
    uncensoredNickname: "Guest",
    mods: [],
    isModsVanillaCompatible: true
  });
});

// Accepts: /v6/user, /v6/user?version=..., etc.
app.get("/v6/user", (req, res) => {
  res.json({
    nickname: "Guest",
    uncensoredNickname: "Guest",
    mods: [],
    isModsVanillaCompatible: true
  });
});

// ------------------------------------------------------
// ICE SERVERS ENDPOINT
// ------------------------------------------------------
app.get("/iceServers", (req, res) => {
  res.json([
    { urls: "stun:stun.l.google.com:19302" }
  ]);
});

// ------------------------------------------------------
// WEBSOCKET UPGRADE HANDLER
// ------------------------------------------------------
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";

  // Accept both new and old paths
  if (
    url.startsWith("/multiplayer/host") ||
    url.startsWith("/multiplayer/join") ||
    url.startsWith("/v6/multiplayer/host") ||
    url.startsWith("/v6/multiplayer/join")
  ) {
    wss.handleUpgrade(req, socket, head, ws => {
      // Normalize path so handlers work
      ws.path = url.replace("/v6/", "/");
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ------------------------------------------------------
// WEBSOCKET CONNECTION HANDLER
// ------------------------------------------------------
wss.on("connection", (ws) => {
  if (ws.path.startsWith("/multiplayer/host")) {
    handleHost(ws);
  } else if (ws.path.startsWith("/multiplayer/join")) {
    handleJoin(ws);
  }
});

// ------------------------------------------------------
// HOST HANDLER
// ------------------------------------------------------
function handleHost(ws) {
  let roomKey = null;

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "createInvite") {
      roomKey = String(data.key);
      rooms.set(roomKey, { host: ws, joins: [] });
      console.log("Room created:", roomKey);
    }
  });

  ws.on("close", () => {
    if (roomKey) {
      rooms.delete(roomKey);
      console.log("Room closed:", roomKey);
    }
  });
}

// ------------------------------------------------------
// JOIN HANDLER
// ------------------------------------------------------
function handleJoin(ws) {
  let roomKey = null;

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "requestJoin") {
      roomKey = String(data.key);
      const room = rooms.get(roomKey);

      if (!room) {
        ws.send(JSON.stringify({
          type: "declineJoin",
          reason: "SessionFull"
        }));
        ws.close();
        return;
      }

      const clientId = room.joins.length + 1;
      room.joins.push(ws);

      ws.send(JSON.stringify({
        type: "acceptJoin",
        answer: data.offer || "",
        mods: [],
        isModsVanillaCompatible: true,
        clientId
      }));
    }
  });

  ws.on("close", () => {
    if (roomKey) {
      const room = rooms.get(roomKey);
      if (room) {
        room.joins = room.joins.filter(j => j !== ws);
      }
    }
  });
}

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on", PORT));
