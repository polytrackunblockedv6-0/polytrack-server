const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// roomKey -> { host, sessions: Set<sessionId> }
const rooms = new Map();
// sessionId -> { roomKey, host, join }
const sessions = new Map();
// join ws -> sessionId
const joinByWs = new Map();

// ---------------- USER / ICE ----------------

function userProfile() {
  return {
    nickname: "Guest",
    uncensoredNickname: "Guest",
    countryCode: null,
    carStyle: "{\"bodyColor\":\"#ffffff\",\"wheelColor\":\"#000000\",\"spoiler\":false}",
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

app.get("/user", (req, res) => res.json(userProfile()));
app.get("/v6/user", (req, res) => res.json(userProfile()));

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
app.get("/iceServers", (req, res) => res.json(ICE_SERVERS));

// ---------------- HTTP STUBS ----------------

app.get("/multiplayer/host", (req, res) => res.status(426).send("Upgrade Required"));
app.get("/multiplayer/join", (req, res) => res.status(426).send("Upgrade Required"));

// ---------------- UPGRADE ----------------

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

// ---------------- ROUTING ----------------

wss.on("connection", (ws) => {
  if (ws.path.startsWith("/multiplayer/host")) handleHost(ws);
  else if (ws.path.startsWith("/multiplayer/join")) handleJoin(ws);
});

// ---------------- HOST ----------------

function handleHost(ws) {
  let roomKey = null;

  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Host: createInvite
    if (data.type === "createInvite") {
      roomKey = Math.random().toString(36).slice(2, 10).toUpperCase();
      rooms.set(roomKey, { host: ws, sessions: new Set() });
      console.log("Room created:", roomKey);

      const resp = {
        type: "createInvite",
        inviteCode: roomKey,
        key: Math.random().toString(36).slice(2), // arbitrary hash
        timeoutMilliseconds: 3600000,
        censoredNickname: data.nickname || "Anonymous"
      };

      ws.send(JSON.stringify(resp));
      return;
    }

    // Host: acceptJoin -> to specific join
    if (data.type === "acceptJoin") {
      const sessionId = data.session;
      const session = sessions.get(sessionId);
      if (!session || session.host !== ws) return;

      const msg = {
        type: "acceptJoin",
        answer: data.answer,
        mods: data.mods || [],
        isModsVanillaCompatible: data.isModsVanillaCompatible ?? true,
        clientId: data.clientId
      };

      if (session.join.readyState === WebSocket.OPEN) {
        session.join.send(JSON.stringify(msg));
      }
      return;
    }

    // Host: iceCandidate -> to join
    if (data.type === "iceCandidate") {
      const sessionId = data.session;
      const session = sessions.get(sessionId);
      if (!session || session.host !== ws) return;

      const msg = {
        type: "iceCandidate",
        candidate: data.candidate || null
      };

      if (session.join.readyState === WebSocket.OPEN) {
        session.join.send(JSON.stringify(msg));
      }
      return;
    }

    // Host: joinDisconnect -> to join
    if (data.type === "joinDisconnect") {
      const sessionId = data.session;
      const session = sessions.get(sessionId);
      if (!session || session.host !== ws) return;

      const msg = {
        type: "joinDisconnect",
        session: sessionId
      };

      if (session.join.readyState === WebSocket.OPEN) {
        session.join.send(JSON.stringify(msg));
        session.join.close();
      }
      cleanupSession(sessionId);
      return;
    }
  });

  ws.on("close", () => {
    if (!roomKey) return;
    const room = rooms.get(roomKey);
    if (room) {
      for (const sessionId of room.sessions) {
        const session = sessions.get(sessionId);
        if (session && session.join.readyState === WebSocket.OPEN) {
          session.join.close();
        }
        sessions.delete(sessionId);
      }
      rooms.delete(roomKey);
    }
    console.log("Room closed:", roomKey);
  });
}

// ---------------- JOIN ----------------

function handleJoin(ws) {
  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // First message: inviteCode + offer
    if ("inviteCode" in data && "offer" in data) {
      const roomKey = String(data.inviteCode);
      const room = rooms.get(roomKey);
      if (!room) {
        ws.close();
        return;
      }

      const sessionId = Math.random().toString(36).slice(2, 11);
      sessions.set(sessionId, { roomKey, host: room.host, join: ws });
      room.sessions.add(sessionId);
      joinByWs.set(ws, sessionId);

      const msg = {
        type: "joinInvite",
        session: sessionId,
        offer: data.offer,
        mods: data.mods || [],
        isModsVanillaCompatible: data.isModsVanillaCompatible ?? true,
        nickname: data.nickname,
        countryCode: data.countryCode ?? null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      };

      if (room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify(msg));
      }
      return;
    }

    // Subsequent: candidate from join -> to host
    if ("candidate" in data) {
      const sessionId = joinByWs.get(ws);
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;

      const msg = {
        type: "iceCandidate",
        session: sessionId,
        candidate: data.candidate || null
      };

      if (session.host.readyState === WebSocket.OPEN) {
        session.host.send(JSON.stringify(msg));
      }
      return;
    }
  });

  ws.on("close", () => {
    const sessionId = joinByWs.get(ws);
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) {
      joinByWs.delete(ws);
      return;
    }

    const msg = {
      type: "joinDisconnect",
      session: sessionId
    };

    if (session.host.readyState === WebSocket.OPEN) {
      session.host.send(JSON.stringify(msg));
    }

    cleanupSession(sessionId);
    joinByWs.delete(ws);
  });
}

// ---------------- CLEANUP ----------------

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const room = rooms.get(session.roomKey);
  if (room) {
    room.sessions.delete(sessionId);
  }

  sessions.delete(sessionId);
}

// ---------------- START ----------------

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on", PORT));
