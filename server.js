const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// In-memory user storage (no database)
const userData = {
  carStyle: "{\"bodyColor\":\"#ffffff\",\"wheelColor\":\"#000000\",\"spoiler\":false}"
};

// ------------------------------------------------------
// USER PROFILE ENDPOINTS
// ------------------------------------------------------

function userProfile() {
  return {
    nickname: "Guest",
    uncensoredNickname: "Guest",

    countryCode: null,
    carStyle: userData.carStyle,   // <-- now dynamic
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
// SAVE CAR STYLE ENDPOINT
// ------------------------------------------------------

app.post("/saveCarStyle", (req, res) => {
  const { carStyle } = req.body;

  if (typeof carStyle !== "string") {
    return res.status(400).json({ error: "carStyle must be a string" });
  }

  userData.carStyle = carStyle;  // <-- save it
  console.log("Saved car style:", carStyle);

  res.json({ success: true });
});

// ------------------------------------------------------
// ICE SERVERS
// ------------------------------------------------------
app.get("/iceServers", (req, res) => {
  res.json([{ urls: "stun:stun.l.google.com:19302" }]);
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
      if (room) room.joins = room.joins.filter(j => j !== ws);
    }
  });
}

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on", PORT));
