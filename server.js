const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ---------------- TOKEN SECURITY ----------------

const TOKEN_SECRET = process.env.TOKEN_SECRET || "CHANGE_ME_TO_SOMETHING_RANDOM";
const SAVE_FILE = "./profile.json";

// base64url helpers
function b64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

// load/save profile from disk
function loadProfile() {
  try {
    const txt = fs.readFileSync(SAVE_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
function saveProfile(profile) {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(profile, null, 2));
  } catch (e) {
    console.error("Failed to save profile:", e);
  }
}

// default profile
function defaultUserProfile() {
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

// current active profile (one per server instance)
let currentProfile = loadProfile() || defaultUserProfile();

// encode profile into signed token
function encodeToken(profile) {
  const payload = { ...profile };
  if (!payload.tokenId) {
    payload.tokenId = crypto.randomBytes(16).toString("hex");
  }
  const json = JSON.stringify(payload);
  const data = b64urlEncode(Buffer.from(json, "utf8"));
  const sig = b64urlEncode(
    crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest()
  );
  return `${data}.${sig}`;
}

// decode + verify token
function decodeToken(token) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;

  const expectedSig = b64urlEncode(
    crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest()
  );
  if (sig !== expectedSig) return null;

  try {
    const json = b64urlDecode(data).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------- USER / ICE ENDPOINTS ----------------

app.get("/user", (req, res) => {
  res.json(currentProfile || defaultUserProfile());
});

app.get("/v6/user", (req, res) => {
  res.json(currentProfile || defaultUserProfile());
});

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

app.get("/iceServers", (req, res) => {
  res.json(ICE_SERVERS);
});

// ---------------- IMPORT / EXPORT TOKEN ----------------

app.post("/importUser", (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== "string") {
    return res.status(400).json({ success: false, error: "Missing token" });
  }

  const profile = decodeToken(token);
  if (!profile) {
    return res.status(400).json({ success: false, error: "Invalid or edited token" });
  }

  currentProfile = profile;
  saveProfile(currentProfile);
  return res.json({ success: true });
});

app.get("/exportUser", (req, res) => {
  const profile = currentProfile || defaultUserProfile();
  const token = encodeToken(profile);
  res.json({ token });
});

// ---------------- UPDATE USER (garage, settings, stats, etc.) ----------------

function applyProfileUpdate(update) {
  if (!currentProfile) currentProfile = defaultUserProfile();
  currentProfile = {
    ...currentProfile,
    ...update,
    stats: { ...(currentProfile.stats || {}), ...(update.stats || {}) },
    settings: { ...(currentProfile.settings || {}), ...(update.settings || {}) }
  };
  saveProfile(currentProfile);
}

app.post("/updateUser", (req, res) => {
  const update = req.body || {};
  applyProfileUpdate(update);
  res.json({ success: true });
});

app.post("/v6/updateUser", (req, res) => {
  const update = req.body || {};
  applyProfileUpdate(update);
  res.json({ success: true });
});

// ---------------- HTTP STUBS FOR WS PATHS ----------------

app.get("/multiplayer/host", (req, res) => {
  res.status(426).send("Upgrade Required");
});

app.get("/multiplayer/join", (req, res) => {
  res.status(426).send("Upgrade Required");
});

// ---------------- WEBSOCKET UPGRADE ----------------

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

// ---------------- ROOM / SESSION STATE ----------------

const rooms = new Map();      // roomKey -> { host, sessions: Set<sessionId> }
const sessions = new Map();   // sessionId -> { roomKey, host, join }
const joinByWs = new Map();   // joinWs -> sessionId

// ---------------- ROUTING ----------------

wss.on("connection", (ws) => {
  if (ws.path.startsWith("/multiplayer/host")) handleHost(ws);
  else if (ws.path.startsWith("/multiplayer/join")) handleJoin(ws);
});

// ---------------- HOST HANDLER ----------------

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
        key: crypto.randomBytes(32).toString("hex"),
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

// ---------------- JOIN HANDLER ----------------

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

      const sessionId = crypto.randomBytes(8).toString("hex");
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
