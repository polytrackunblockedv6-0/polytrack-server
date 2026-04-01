const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const rooms = new Map(); // roomKey -> { host, joins: [] }

// ------------------------------------------------------
// USER PROFILE
// ------------------------------------------------------
function userProfile() {
  return {
    nickname: "Guest",
    uncensoredNickname: "Guest",
    countryCode: null,
    carStyle: "{\"bodyColor\":\"#ffffff\",\"wheelColor\":\"#000000\",\"spoiler\":false}",

    // IMPORTANT: client uses this to derive internal state
    userTokenHash: Math.random().toString(36).slice(2, 11),

    isVerifier: false,
    unverifiedRecordings: [],
    isBanned: false,
    isModerator: false,
    mods: [],
    isModsVanillaCompatible: true,
    stats: {},
    settings: {}
  };
}

app.get("/user", (req, res) => {
  res.json(userProfile());
});

app.get("/v6/user", (req, res) => {
  res.json(userProfile());
});

// ------------------------------------------------------
// ICE SERVERS
// ------------------------------------------------------
app.get("/iceServers", (req, res) => {
  res.json([{ urls: "stun:stun.l.google.com:19302" }]);
});

// ------------------------------------------------------
// OPTIONAL: HTTP stubs for multiplayer paths
// ------------------------------------------------------
app.get("/multiplayer/host", (req, res) => {
  res.status(426).send("Upgrade Required");
});

app.get("/multiplayer/join", (req, res) => {
  res.status(426).send("Upgrade Required");
});

// ------------------------------------------------------
// WEBSOCKET UPGRADE HANDLER
// ------------------------------------------------------
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";

  if (
    url.startsWith("/multiplayer/host") ||
    url.startsWith("/multiplayer/join") ||
    url.startsWith("/v6/multiplayer/host") ||
    url.startsWith("/v6/multiplayer/join")
  ) {
    wss.handleUpgrade(req, socket, head, ws => {
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
  if (ws.path.startsWith("/multiplayer/host")) handleHost(ws);
  else if (ws.path.startsWith("/multiplayer/join")) handleJoin(ws);
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
      // Client may send null key initially – generate one if needed
      roomKey = data.key || Math.random().toString(36).slice(2, 11);

      rooms.set(roomKey, { host: ws, joins: [] });
      console.log("Room created:", roomKey);

      // Respond in the exact shape the client expects
      const response = {
        version: "0.6.0",
        type: "createInvite",
        inviteCode: roomKey,          // what the UI shows
        key: roomKey,                 // stored internally by client
        timeoutMilliseconds: null,    // no auto-timeout
        censoredNickname: null,       // or a string if you want
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      };

      ws.send(JSON.stringify(response));
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
// JOIN HANDLER (minimal: accept or decline)
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
          version: "0.6.0",
          type: "declineJoin",
          reason: "SessionFull"
        }));
        ws.close();
        return;
      }

      const clientId = room.joins.length + 1;
      room.joins.push(ws);

      // Minimal acceptJoin – enough for the client to proceed
      ws.send(JSON.stringify({
        version: "0.6.0",
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
      if (room) room.joins = room.joins.filter(j => j !== ws);
    }
  });
}

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on", PORT));
