const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// roomKey -> { host, joins: Set<ws> }
const rooms = new Map();
// join ws -> { roomKey, host, pendingCandidates: [] }
const joinState = new Map();

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

    // createInvite from host
    if (data.type === "createInvite") {
      roomKey = Math.random().toString(36).slice(2, 10).toUpperCase();
      rooms.set(roomKey, { host: ws, joins: new Set() });
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

    // acceptJoin from host -> to join
    if (data.type === "acceptJoin") {
      // in original protocol, this goes to the single join currently connecting
      // we just broadcast to all joins in this room that are waiting
      const room = rooms.get(roomKey);
      if (!room) return;

      const msg = {
        type: "acceptJoin",
        answer: data.answer,
        mods: data.mods || [],
        isModsVanillaCompatible: data.isModsVanillaCompatible ?? true,
        clientId: data.clientId
      };

      for (const j of room.joins) {
        j.send(JSON.stringify(msg));
      }
      return;
    }

    // iceCandidate from host -> to join
    if (data.type === "iceCandidate") {
      const room = rooms.get(roomKey);
      if (!room) return;

      const msg = {
        type: "iceCandidate",
        candidate: data.candidate || null
      };

      for (const j of room.joins) {
        j.send(JSON.stringify(msg));
      }
      return;
    }
  });

  ws.on("close", () => {
    if (roomKey) {
      const room = rooms.get(roomKey);
      if (room) {
        for (const j of room.joins) j.close();
        rooms.delete(roomKey);
      }
      console.log("Room closed:", roomKey);
    }
  });
}

// ---------------- JOIN ----------------

function handleJoin(ws) {
  joinState.set(ws, { roomKey: null });

  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // first message: inviteCode + offer
    if ("inviteCode" in data && "offer" in data) {
      const roomKey = String(data.inviteCode);
      const room = rooms.get(roomKey);
      if (!room) {
        ws.close();
        return;
      }

      room.joins.add(ws);
      joinState.set(ws, { roomKey });

      // forward offer to host as if it were the original server
      const msg = {
        type: "joinInvite",
        // original server also sends mods, etc. to host;
        // but host code you showed only cares about type/offer/nickname/etc.
        session: null, // your client ignores this in join side
        offer: data.offer,
        mods: data.mods || [],
        isModsVanillaCompatible: data.isModsVanillaCompatible ?? true,
        nickname: data.nickname,
        countryCode: data.countryCode ?? null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      };

      room.host.send(JSON.stringify(msg));
      return;
    }

    // candidate from join -> to host
    if ("candidate" in data) {
      const st = joinState.get(ws);
      if (!st || !st.roomKey) return;
      const room = rooms.get(st.roomKey);
      if (!room) return;

      const msg = {
        type: "iceCandidate",
        candidate: data.candidate || null
      };

      room.host.send(JSON.stringify(msg));
      return;
    }
  });

  ws.on("close", () => {
    const st = joinState.get(ws);
    if (!st) return;
    const room = rooms.get(st.roomKey);
    if (room) {
      room.joins.delete(ws);
    }
    joinState.delete(ws);
  });
}

// ---------------- START ----------------

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on", PORT));
